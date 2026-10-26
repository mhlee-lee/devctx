import { differsInSubstance } from '../memory/dedupe.ts';
import { searchItems } from './retrieve.ts';
import type { KnowledgeItem } from './types.ts';

export interface OverlapPair {
  a: KnowledgeItem;
  b: KnowledgeItem;
  score: number;
}

/** Wording this alike is what the judge would have been asked to compare. */
export const OVERLAP_MIN_SCORE = 0.6;
/** Nearly the same words: listed even when no tool, number or negation differs (a repeat). */
const OVERLAP_STRONG_SCORE = 1.0;

/**
 * Live rules worded almost alike that still name different tools, numbers or a negation (or are
 * nearly the same words): one may repeat or contradict the other, and nothing compared them (a
 * judge that could not run leaves both active; `devctx status` lists neither as a conflict).
 * Found without a model, so people can look. Open conflicts are left out: they are listed as such.
 */
export function overlappingRules(items: readonly KnowledgeItem[], limit = 10): OverlapPair[] {
  const live = items.filter((i) => (i.status === 'active' || i.status === 'conflict') && !i.held && !i.local);
  const seen = new Set<string>();
  const out: OverlapPair[] = [];
  for (const a of live) {
    const others = live.filter((i) => i.id !== a.id && !a.conflict_with.includes(i.id) && !i.conflict_with.includes(a.id));
    for (const hit of searchItems(others, `${a.summary} ${a.scope.topics.join(' ')}`, { limit: 3, minScore: OVERLAP_MIN_SCORE, pathHints: [] })) {
      const b = hit.item;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(key) || (hit.score < OVERLAP_STRONG_SCORE && !differsInSubstance(a.summary, b.summary))) continue;
      seen.add(key);
      out.push({ a, b, score: hit.score });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}
