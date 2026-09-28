import { planTiers, itemLine } from '../compile/tiers.ts';
import type { DevctxConfig } from '../config.ts';
import { searchItems } from '../knowledge/retrieve.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import type { Language } from '../types.ts';
import { approxTokens } from '../util/text.ts';

const TEXT: Record<Language, { personal: string; conflict: string; related: string; fresh: string; conflictMark: string }> = {
  ko: {
    personal: '[devctx] 이 사용자의 개인 설정:',
    conflict: '[devctx] 충돌 중인 결정이 있다. 해당 범위를 수정하기 전에 사용자에게 어느 쪽을 따를지 한 번만 확인할 것:',
    related: '[devctx] 이 요청과 관련된 프로젝트 결정 (자동 제공):',
    fresh: '[devctx] 이번 세션에서 새로 기록된 프로젝트 결정:',
    conflictMark: ' (충돌: 사용자 확인 필요)',
  },
  en: {
    personal: "[devctx] This user's personal preferences:",
    conflict: '[devctx] Conflicting decisions exist. Before changing that area, ask the user once which one to follow:',
    related: '[devctx] Project decisions relevant to this request (auto-provided):',
    fresh: '[devctx] Project decisions recorded during this session:',
    conflictMark: ' (conflict: ask the user)',
  },
};

export interface InjectedContext {
  text: string | null;
  ids: string[];
}

function fitBudget(lines: { id: string; line: string }[], budget: number): { id: string; line: string }[] {
  const out: { id: string; line: string }[] = [];
  let used = 0;
  for (const entry of lines) {
    const cost = approxTokens(entry.line);
    if (used + cost > budget) break;
    out.push(entry);
    used += cost;
  }
  return out;
}

/** Injected once per session: personal preferences and unresolved conflicts. */
export function sessionContext(team: readonly KnowledgeItem[], personal: readonly KnowledgeItem[], cfg: DevctxConfig): InjectedContext {
  const t = TEXT[cfg.language];
  let budget = cfg.inject.session_budget_tokens;
  const parts: string[] = [];
  const ids: string[] = [];
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
  addBlock(t.personal, personal.filter((i) => i.status === 'active'), (i) => `- ${i.summary}`);
  addBlock(
    t.conflict,
    team.filter((i) => i.status === 'conflict' && i.audience === 'team'),
    (i) => `- ${i.summary} [${i.id}]`,
  );
  return { text: parts.length > 0 ? parts.join('\n') : null, ids };
}

/**
 * Injected per prompt. Two sources, never repeating an id already injected in this session:
 * 1. items recorded during this session (the tool loaded AGENTS.md before they existed)
 * 2. items not delivered by always-loaded files that match the prompt or the files it mentions
 */
export function promptContext(
  team: readonly KnowledgeItem[],
  prompt: string,
  cfg: DevctxConfig,
  opts: { sessionStartedAt: string | null; alreadyInjected: ReadonlySet<string> },
): InjectedContext {
  const budgetTotal = cfg.inject.prompt_budget_tokens;
  if (budgetTotal <= 0) return { text: null, ids: [] };
  const t = TEXT[cfg.language];
  const lang = cfg.language;
  const skip = opts.alreadyInjected;
  const parts: string[] = [];
  const ids: string[] = [];
  let budget = budgetTotal;

  if (opts.sessionStartedAt) {
    const since = opts.sessionStartedAt;
    const fresh = team.filter(
      (i) => i.status === 'active' && i.audience === 'team' && i.source.captured_at >= since && !skip.has(i.id),
    );
    const fitted = fitBudget(
      fresh.map((i) => ({ id: i.id, line: itemLine(i, lang, true) })),
      budget - approxTokens(t.fresh),
    );
    if (fitted.length > 0) {
      parts.push(t.fresh, ...fitted.map((f) => f.line));
      ids.push(...fitted.map((f) => f.id));
      budget -= approxTokens(t.fresh) + fitted.reduce((n, f) => n + approxTokens(f.line), 0);
    }
  }

  if (prompt.trim()) {
    const plan = planTiers(team, cfg);
    const conflicts = team.filter((i) => i.status === 'conflict' && i.audience === 'team');
    const pool = [...plan.onDemand, ...(plan.scopedInAgents ? [] : plan.scoped), ...conflicts].filter(
      (i) => !skip.has(i.id) && !ids.includes(i.id),
    );
    const hits = pool.length > 0 ? searchItems(pool, prompt, { limit: 8, minScore: 0.12 }) : [];
    const fitted = fitBudget(
      hits.map(({ item }) => ({
        id: item.id,
        line: itemLine(item, lang, true) + (item.status === 'conflict' ? t.conflictMark : ''),
      })),
      budget - approxTokens(t.related),
    );
    if (fitted.length > 0) {
      parts.push(t.related, ...fitted.map((f) => f.line));
      ids.push(...fitted.map((f) => f.id));
    }
  }
  return { text: parts.length > 0 ? parts.join('\n') : null, ids };
}
