import { matchAny } from '../util/glob.ts';
import { tokenSet } from '../util/text.ts';
import type { KnowledgeItem } from './types.ts';

const tokenCache = new WeakMap<KnowledgeItem, Set<string>>();

function itemTokens(item: KnowledgeItem): Set<string> {
  let tokens = tokenCache.get(item);
  if (!tokens) {
    tokens = tokenSet([item.title, item.summary, item.scope.topics.join(' '), item.sections.rule].join(' '));
    tokenCache.set(item, tokens);
  }
  return tokens;
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

/** File-like mentions in free text (e.g. `src/billing/Money.kt`, `QuoteService.kt`). */
export function extractPathHints(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w@.\-/]*\/[\w@.\-/]+|[\w-]+\.[A-Za-z][\w]{0,7}\b/g)) {
    const hint = m[0].replace(/^[./]+/, '');
    if (hint.length >= 3 && !/^\d+(\.\d+)*$/.test(hint)) out.add(hint);
  }
  return [...out];
}

export interface Scored {
  item: KnowledgeItem;
  score: number;
}

export function scoreItem(item: KnowledgeItem, query: Set<string>, queryText: string, pathHints: readonly string[]): number {
  let score = similarity(query, itemTokens(item));
  const lower = queryText.toLowerCase();
  let topicBoost = 0;
  for (const topic of item.scope.topics) {
    const t = topic.toLowerCase();
    if (t.length >= 2 && lower.includes(t)) topicBoost += 0.15;
  }
  score += Math.min(0.45, topicBoost);
  if (item.scope.paths.length > 0 && pathHints.some((h) => matchAny(h, item.scope.paths))) score += 0.5;
  return score;
}

export function searchItems(
  items: readonly KnowledgeItem[],
  queryText: string,
  opts: { limit: number; minScore: number; pathHints?: readonly string[] },
): Scored[] {
  const query = tokenSet(queryText);
  const hints = opts.pathHints ?? extractPathHints(queryText);
  return items
    .map((item) => ({ item, score: scoreItem(item, query, queryText, hints) }))
    .filter((s) => s.score >= opts.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
}
