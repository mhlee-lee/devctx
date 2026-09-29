import type { DevctxConfig } from '../config.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import type { Language } from '../types.ts';
import { approxTokens, today } from '../util/text.ts';

/**
 * Decides how each active team item reaches the tools:
 * - core: always-loaded AGENTS.md (budgeted)
 * - scoped: items with path globs (AGENTS.md when small, otherwise per-tool path rules)
 * - onDemand: injected by hooks only when a prompt is relevant
 */
export interface TierPlan {
  core: KnowledgeItem[];
  scoped: KnowledgeItem[];
  onDemand: KnowledgeItem[];
  /** Items that wanted core but did not fit the budget (also listed in onDemand). */
  overflow: KnowledgeItem[];
  /** True when all scoped rules fit `scoped_budget_tokens` and are written into AGENTS.md. */
  scopedInAgents: boolean;
  coreTokens: number;
  scopedTokens: number;
}

/** The rule's end date has passed (the day itself still counts). */
export function isExpired(item: KnowledgeItem, day: string = today()): boolean {
  return item.valid_until !== null && item.valid_until < day;
}

/** Live for delivery: active, team-wide and not past its end date (even before the worker retires it). */
export function isDeliverable(item: KnowledgeItem, day: string = today()): boolean {
  return item.status === 'active' && item.audience === 'team' && !isExpired(item, day);
}

/** A rule the user had to repeat is one the assistant kept missing: give it more weight. */
export function isEscalated(item: KnowledgeItem): boolean {
  return item.violations >= 1 || item.reinforced >= 3;
}

const LABELS: Record<Language, { must: string; applies: string; until: (d: string) => string }> = {
  ko: { must: '(필수) ', applies: '적용', until: (d) => ` (${d}까지)` },
  en: { must: '(must) ', applies: 'applies to', until: (d) => ` (until ${d})` },
};

export function itemLine(item: KnowledgeItem, lang: Language, withScope: boolean): string {
  const l = LABELS[lang];
  const mark = item.enforcement === 'must' ? l.must : '';
  const scope =
    withScope && item.scope.paths.length > 0 ? ` (${l.applies}: ${item.scope.paths.map((p) => `\`${p}\``).join(', ')})` : '';
  // A temporary rule says so: the agent should not generalize it beyond its end date.
  const until = item.valid_until && !item.summary.includes(item.valid_until) ? l.until(item.valid_until) : '';
  // What it depended on is gone from the repository: the agent should confirm before relying on it.
  const stale = item.stale ? ` (${item.stale})` : '';
  return `- ${mark}${item.summary}${until}${scope}${stale}`;
}

/** Possibly outdated (code evidence gone) and not pinned by a person: delivered only on demand. */
function demoted(item: KnowledgeItem): boolean {
  return Boolean(item.stale) && item.tier !== 'core';
}

function byId(a: KnowledgeItem, b: KnowledgeItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function corePriority(a: KnowledgeItem, b: KnowledgeItem): number {
  const keys = (i: KnowledgeItem): (number | string)[] => [
    i.tier === 'core' ? 0 : 1,
    -i.violations,
    i.enforcement === 'must' ? 0 : 1,
    -i.reinforced,
  ];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i] as number;
    const y = kb[i] as number;
    if (x !== y) return x - y;
  }
  // Newer decisions first when everything else is equal.
  return a.source.captured_at < b.source.captured_at ? 1 : a.source.captured_at > b.source.captured_at ? -1 : byId(a, b);
}

export function planTiers(items: readonly KnowledgeItem[], cfg: DevctxConfig): TierPlan {
  const lang = cfg.language;
  const candidates: KnowledgeItem[] = [];
  const scoped: KnowledgeItem[] = [];
  const onDemand: KnowledgeItem[] = [];
  for (const item of items) {
    if (!isDeliverable(item)) continue;
    if (item.tier === 'on-demand' || demoted(item)) onDemand.push(item);
    else if (item.tier === 'core') candidates.push(item);
    else if (item.scope.paths.length > 0) scoped.push(item);
    else if (item.tier === 'scoped') onDemand.push(item);
    else if (item.enforcement === 'info' && !isEscalated(item)) onDemand.push(item);
    else candidates.push(item);
  }
  candidates.sort(corePriority);
  const core: KnowledgeItem[] = [];
  const overflow: KnowledgeItem[] = [];
  let used = 0;
  for (const item of candidates) {
    const cost = approxTokens(itemLine(item, lang, false));
    if (used + cost <= cfg.inject.core_budget_tokens) {
      core.push(item);
      used += cost;
    } else {
      overflow.push(item);
    }
  }
  onDemand.push(...overflow);
  core.sort(byId);
  scoped.sort(byId);
  onDemand.sort(byId);
  const scopedTokens = scoped.reduce((n, i) => n + approxTokens(itemLine(i, lang, true)), 0);
  return {
    core,
    scoped,
    onDemand,
    overflow,
    scopedInAgents: scopedTokens <= cfg.inject.scoped_budget_tokens,
    coreTokens: used,
    scopedTokens,
  };
}
