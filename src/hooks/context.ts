import { sessionRuleLines } from '../compile/render.ts';
import { isExpired, itemLine, planTiers } from '../compile/tiers.ts';
import type { DevctxConfig } from '../config.ts';
import { scoreAll, type ScoreParts } from '../knowledge/retrieve.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import { canonical } from '../memory/dedupe.ts';
import type { Language } from '../types.ts';
import { approxTokens } from '../util/text.ts';

const TEXT: Record<Language, { rules: string; personal: string; conflict: string; related: string; fresh: string; conflictMark: string; recent: (day: string) => string }> = {
  ko: {
    rules: '[devctx] 프로젝트 규칙 (이 저장소의 결정. 이 세션 동안 따른다):',
    personal: '[devctx] 이 사용자의 개인 설정:',
    conflict: '[devctx] 충돌 중인 결정이 있다. 해당 범위를 수정하기 전에 사용자에게 어느 쪽을 따를지 한 번만 확인할 것:',
    related: '[devctx] 이 요청과 관련된 프로젝트 결정 (자동 제공):',
    fresh: '[devctx] 이번 세션에서 새로 기록된 프로젝트 결정:',
    conflictMark: ' (충돌: 사용자 확인 필요)',
    recent: (day) => `[devctx] 최근 ${RECENT_CHANGE_DAYS}일 동안 바뀐 결정 (오늘 ${day}). 코드에 이전 방식이 남아 있어도 새 결정을 따른다:`,
  },
  en: {
    rules: '[devctx] Project rules (decisions of this repository; follow them for this session):',
    personal: "[devctx] This user's personal preferences:",
    conflict: '[devctx] Conflicting decisions exist. Before changing that area, ask the user once which one to follow:',
    related: '[devctx] Project decisions relevant to this request (auto-provided):',
    fresh: '[devctx] Project decisions recorded during this session:',
    conflictMark: ' (conflict: ask the user)',
    recent: (day) => `[devctx] Decisions changed in the last ${RECENT_CHANGE_DAYS} days (today is ${day}). Follow the new one even where the code still shows the old way:`,
  },
};

/** Days a decision that replaced another one is pointed out at session start. */
export const RECENT_CHANGE_DAYS = 7;
const RECENT_CHANGE_LIMIT = 5;

export interface RecentChange {
  item: KnowledgeItem;
  replaced: KnowledgeItem;
}

/**
 * Decisions that replaced a different rule in the last week, newest first. The code still shows
 * the old way for a while (tests in Jest, the old error format), and an agent copying nearby code
 * would follow it, so the session is told which one is current. Carrying the same rule forward (a
 * new end date, a confirmed proposal) is not a change. Computed from the decision files alone.
 */
export function recentChanges(team: readonly KnowledgeItem[], now: Date = new Date()): RecentChange[] {
  const since = new Date(now.getTime() - RECENT_CHANGE_DAYS * 86_400_000).toISOString();
  const byId = new Map(team.map((i) => [i.id, i]));
  const out: RecentChange[] = [];
  for (const item of team) {
    if (item.status !== 'active' || item.audience !== 'team' || item.held || isExpired(item)) continue;
    if (item.supersedes.length === 0 || item.source.captured_at < since) continue;
    const replaced = item.supersedes
      .map((id) => byId.get(id))
      .find((o): o is KnowledgeItem => Boolean(o && !o.held && canonical(o.summary) !== canonical(item.summary)));
    if (replaced) out.push({ item, replaced });
  }
  return out.sort((a, b) => (a.item.source.captured_at < b.item.source.captured_at ? 1 : -1)).slice(0, RECENT_CHANGE_LIMIT);
}

/** Relevance hits below this score are not injected. */
export const PROMPT_MIN_SCORE = 0.12;
const PROMPT_LIMIT = 8;

export interface InjectedContext {
  text: string | null;
  ids: string[];
}

/**
 * Packs lines into a token budget. A line that does not fit is skipped and packing continues
 * with the next one (Hindsight's packing), so one long rule does not crowd out shorter ones.
 */
function fitBudget(lines: { id: string; line: string }[], budget: number): { id: string; line: string }[] {
  const out: { id: string; line: string }[] = [];
  let used = 0;
  for (const entry of lines) {
    const cost = approxTokens(entry.line);
    if (used + cost > budget) continue;
    out.push(entry);
    used += cost;
  }
  return out;
}

const ACK =
  /^(ok(ay)?|k|y(es)?|no?|네|넵|예|응|ㅇㅇ|ㅇㅋ|오케이|좋아(요)?|고마워(요)?|감사(합니다)?|thanks?|thank you|thx|ty|lgtm|done|go( on)?|continue|계속(해)?|진행(해)?|해줘|그래|맞아)[\s.!~?]*$/i;

/**
 * Prompts that never need project decisions: slash commands and shell escapes (the tool handles
 * them itself) and bare acknowledgements ("응", "continue"). Their words would only match rules
 * by accident (OpenViking and Atlas skip them for the same reason).
 */
export function promptKind(prompt: string): 'command' | 'ack' | 'normal' {
  const p = prompt.trim();
  if (/^[/!]/.test(p)) return 'command';
  if (p.length === 0 || ACK.test(p)) return 'ack';
  return 'normal';
}

const NOTICE: Record<Language, string> = {
  ko: '[devctx] 사용자에게 한 번만 알릴 것 (devctx 상태):',
  en: '[devctx] Tell the user once (devctx status):',
};

/**
 * Injected once per session, and the same for the whole session (tools keep their prompt cache):
 * the project rules (always-apply rules, and path rules when they are few), devctx health notices
 * (the agent passes them on), personal preferences, unresolved conflicts and decisions that
 * replaced another one this week. AGENTS.md only points here, so recording a decision never
 * changes a file the tools load with every request.
 */
export function sessionContext(
  team: readonly KnowledgeItem[],
  personal: readonly KnowledgeItem[],
  cfg: DevctxConfig,
  notices: readonly string[] = [],
  now: Date = new Date(),
): InjectedContext {
  const t = TEXT[cfg.language];
  let budget = cfg.inject.session_budget_tokens;
  const parts: string[] = [];
  const ids: string[] = [];
  // Already within inject.core_budget_tokens / scoped_budget_tokens (planTiers).
  const rules = sessionRuleLines(planTiers(team, cfg), cfg.language);
  if (rules.length > 0) {
    parts.push(t.rules, ...rules.map((r) => r.line));
    ids.push(...rules.map((r) => r.id));
  }
  if (notices.length > 0) {
    parts.push(NOTICE[cfg.language], ...notices.map((n) => `- ${n}`));
    budget -= approxTokens([NOTICE[cfg.language], ...notices].join('\n'));
  }
  const addBlock = (header: string, items: readonly KnowledgeItem[], render: (i: KnowledgeItem) => string): void => {
    if (items.length === 0) return;
    const fitted = fitBudget(
      items.map((i) => ({ id: i.id, line: render(i) })),
      budget - approxTokens(header),
    );
    if (fitted.length === 0) return;
    parts.push(header, ...fitted.map((f) => f.line));
    ids.push(...fitted.map((f) => f.id));
    budget -= approxTokens(header) + fitted.reduce((n, f) => n + approxTokens(f.line), 0);
  };
  addBlock(t.personal, personal.filter((i) => i.status === 'active' && !isExpired(i) && !i.local && !i.held), (i) => `- ${i.summary}`);
  addBlock(t.conflict, openConflicts(team), (i) => `- ${i.summary} [${i.id}]`);
  const changes = new Map(recentChanges(team, now).map((c) => [c.item.id, c]));
  addBlock(t.recent(now.toISOString().slice(0, 10)), [...changes.values()].map((c) => c.item), (i) => {
    const c = changes.get(i.id) as RecentChange;
    return `- ${i.source.captured_at.slice(0, 10)}: ${c.replaced.summary} → ${i.summary}`;
  });
  return { text: parts.length > 0 ? parts.join('\n') : null, ids };
}

function openConflicts(team: readonly KnowledgeItem[]): KnowledgeItem[] {
  return team.filter((i) => i.status === 'conflict' && i.audience === 'team' && !isExpired(i) && !i.held);
}

export type TraceOutcome = 'injected' | 'fresh' | 'always loaded' | 'already injected' | 'below threshold' | 'over budget' | 'over limit' | 'skipped prompt';

export interface TraceEntry {
  item: KnowledgeItem;
  score: number;
  parts: ScoreParts | null;
  outcome: TraceOutcome;
}

export interface PromptSelection extends InjectedContext {
  kind: ReturnType<typeof promptKind>;
  /** Every live team item and what happened to it (for `devctx why`). */
  trace: TraceEntry[];
}

export interface PromptOptions {
  sessionStartedAt: string | null;
  alreadyInjected: ReadonlySet<string>;
  /** Files declaring the code symbols the prompt names (code index). */
  codePaths?: readonly string[];
  /**
   * How often the assistant broke each rule on this PC. Such rules are found more easily
   * (ranking only: the session-start rules depend on committed files alone).
   */
  violations?: ReadonlyMap<string, number>;
}

/** Bonus per recorded violation, at most three. */
const VIOLATION_BOOST = 0.1;

/**
 * Injected per prompt. Two sources, never repeating an id already injected in this session:
 * 1. items recorded during this session (the session started before they existed)
 * 2. items not delivered at session start that match the prompt, the files it mentions or
 *    the files declaring the code symbols it mentions
 */
export function selectPromptContext(team: readonly KnowledgeItem[], prompt: string, cfg: DevctxConfig, opts: PromptOptions): PromptSelection {
  const kind = promptKind(prompt);
  const plan = planTiers(team, cfg);
  const live = [...plan.core, ...plan.scoped, ...plan.onDemand, ...openConflicts(team)];
  const trace = new Map<string, TraceEntry>();
  const note = (item: KnowledgeItem, outcome: TraceOutcome, score = 0, parts: ScoreParts | null = null): void => {
    trace.set(item.id, { item, score, parts, outcome });
  };
  const alwaysLoaded = new Set([...plan.core, ...(plan.scopedInAgents ? plan.scoped : [])].map((i) => i.id));
  const result = (text: string | null, ids: string[]): PromptSelection => {
    for (const item of live) if (!trace.has(item.id)) note(item, alwaysLoaded.has(item.id) ? 'always loaded' : 'below threshold');
    return { text, ids, kind, trace: [...trace.values()].sort((a, b) => b.score - a.score) };
  };

  const budgetTotal = cfg.inject.prompt_budget_tokens;
  if (kind === 'command' || budgetTotal <= 0) {
    for (const item of live) note(item, 'skipped prompt');
    return result(null, []);
  }
  const t = TEXT[cfg.language];
  const lang = cfg.language;
  const skip = opts.alreadyInjected;
  const parts: string[] = [];
  const ids: string[] = [];
  let budget = budgetTotal;

  if (opts.sessionStartedAt) {
    const since = opts.sessionStartedAt;
    const fresh = plan.core
      .concat(plan.scoped, plan.onDemand)
      .filter((i) => i.source.captured_at >= since && !skip.has(i.id))
      .sort((a, b) => (a.source.captured_at < b.source.captured_at ? -1 : 1));
    const fitted = fitBudget(
      fresh.map((i) => ({ id: i.id, line: itemLine(i, lang, true) })),
      budget - approxTokens(t.fresh),
    );
    if (fitted.length > 0) {
      parts.push(t.fresh, ...fitted.map((f) => f.line));
      ids.push(...fitted.map((f) => f.id));
      budget -= approxTokens(t.fresh) + fitted.reduce((n, f) => n + approxTokens(f.line), 0);
      for (const f of fitted) note(fresh.find((i) => i.id === f.id) as KnowledgeItem, 'fresh');
    }
  }

  if (kind === 'normal') {
    const pool = [...plan.onDemand, ...(plan.scopedInAgents ? [] : plan.scoped), ...openConflicts(team)].filter((i) => !ids.includes(i.id));
    const scored = scoreAll(pool, prompt, { codePaths: opts.codePaths ?? [] });
    if (opts.violations && opts.violations.size > 0) {
      for (const s of scored) {
        const v = opts.violations.get(s.item.id) ?? 0;
        // Only rules already related to the prompt: a boost must not make an unrelated rule appear.
        if (v > 0 && s.score > 0 && s.parts.lexical + s.parts.topics + s.parts.path + s.parts.code > 0) s.score += VIOLATION_BOOST * Math.min(3, v);
      }
      scored.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1));
    }
    const hits = scored.filter((s) => !skip.has(s.item.id) && s.score >= PROMPT_MIN_SCORE).slice(0, PROMPT_LIMIT);
    const fitted = fitBudget(
      hits.map(({ item }) => ({
        id: item.id,
        line: itemLine(item, lang, true) + (item.status === 'conflict' ? t.conflictMark : ''),
      })),
      budget - approxTokens(t.related),
    );
    const chosen = new Set(fitted.map((f) => f.id));
    for (const s of scored) {
      const outcome: TraceOutcome = chosen.has(s.item.id)
        ? 'injected'
        : skip.has(s.item.id)
          ? 'already injected'
          : s.score < PROMPT_MIN_SCORE
            ? 'below threshold'
            : hits.some((h) => h.item.id === s.item.id)
              ? 'over budget'
              : 'over limit';
      note(s.item, outcome, s.score, s.parts);
    }
    if (fitted.length > 0) {
      parts.push(t.related, ...fitted.map((f) => f.line));
      ids.push(...fitted.map((f) => f.id));
    }
  }
  return result(parts.length > 0 ? parts.join('\n') : null, ids);
}

export function promptContext(team: readonly KnowledgeItem[], prompt: string, cfg: DevctxConfig, opts: PromptOptions): InjectedContext {
  const { text, ids } = selectPromptContext(team, prompt, cfg, opts);
  return { text, ids };
}
