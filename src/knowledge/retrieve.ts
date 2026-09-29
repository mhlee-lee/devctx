import { matchAny } from '../util/glob.ts';
import { tokenSet } from '../util/text.ts';
import type { KnowledgeItem } from './types.ts';

/**
 * Lexical retrieval over decisions, no embeddings: IDF-weighted token overlap (the BM25 idea used
 * by Mem0, Hindsight and Graphiti's keyword arms) plus topic and path evidence. IDF is computed
 * over the pool being searched, so words every rule shares ("사용한다", "use") count for little.
 */

const tokenCache = new WeakMap<KnowledgeItem, Set<string>>();

function itemTokens(item: KnowledgeItem): Set<string> {
  let tokens = tokenCache.get(item);
  if (!tokens) {
    tokens = tokenSet([item.title, item.summary, item.scope.topics.join(' '), item.sections.rule].join(' '));
    tokenCache.set(item, tokens);
  }
  return tokens;
}

/** Token weights for one search: ln(1 + N/df); tokens outside the pool get the maximum weight. */
function idfWeights(items: readonly KnowledgeItem[]): (t: string) => number {
  const df = new Map<string, number>();
  for (const item of items) for (const t of itemTokens(item)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, items.length);
  const max = Math.log(1 + n);
  return (t) => {
    const d = df.get(t);
    return d ? Math.log(1 + n / d) : max;
  };
}

function weightedSimilarity(query: Set<string>, doc: Set<string>, w: (t: string) => number): number {
  if (query.size === 0 || doc.size === 0) return 0;
  let inter = 0;
  let qn = 0;
  let dn = 0;
  for (const t of query) {
    const x = w(t);
    qn += x;
    if (doc.has(t)) inter += x;
  }
  for (const t of doc) dn += w(t);
  return qn > 0 && dn > 0 ? inter / Math.sqrt(qn * dn) : 0;
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

export interface ScoreParts {
  /** IDF-weighted token overlap, 0..1. */
  lexical: number;
  /** Item topics named in the query (0.15 each, at most 0.45). */
  topics: number;
  /** A file the query names matches the item's path globs. */
  path: number;
  /** A code symbol the query names is declared in a file the item's path globs cover. */
  code: number;
  /** The query names files and none is in the item's path scope: the score is 0. */
  offScope: boolean;
}

export interface Scored {
  item: KnowledgeItem;
  score: number;
  parts: ScoreParts;
}

export interface SearchOptions {
  limit: number;
  minScore: number;
  /** Files the text names; extracted from the text when omitted. */
  pathHints?: readonly string[];
  /** Files where symbols named in the text are declared (from the code index). */
  codePaths?: readonly string[];
}

function scoreParts(
  item: KnowledgeItem,
  query: Set<string>,
  queryText: string,
  pathHints: readonly string[],
  codePaths: readonly string[],
  w: (t: string) => number,
): ScoreParts {
  const lower = queryText.toLowerCase();
  let topics = 0;
  for (const topic of item.scope.topics) {
    const t = topic.toLowerCase();
    if (t.length >= 2 && lower.includes(t)) topics += 0.15;
  }
  const scoped = item.scope.paths.length > 0;
  const path = scoped && pathHints.some((h) => matchAny(h, item.scope.paths)) ? 0.5 : 0;
  const code = scoped && path === 0 && codePaths.some((p) => matchAny(p, item.scope.paths)) ? 0.35 : 0;
  // The request is about concrete files and none is in this rule's scope: the rule belongs to
  // another area ("packages/api uses zod" is not for packages/web), however similar the words.
  const files = [...pathHints.filter(isFilePath), ...codePaths];
  const offScope = scoped && path === 0 && code === 0 && files.length > 0;
  return { lexical: weightedSimilarity(query, itemTokens(item), w), topics: Math.min(0.45, topics), path, code, offScope };
}

const SOURCE_EXT =
  /\.(kt|kts|java|scala|groovy|go|py|rb|rs|ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|swift|m|mm|c|cc|cpp|h|hpp|cs|fs|php|lua|dart|ex|exs|erl|hs|ml|clj|zig|sh|sql|tf|ya?ml|json|toml|md|css|scss|html)$/i;

/** A mention that is really a file or directory (not "Node.js" or "e.g."). */
function isFilePath(hint: string): boolean {
  if (hint.includes('/')) return true;
  if (/^[A-Z][a-z]+\.js$/.test(hint)) return false; // Node.js, Vue.js, Next.js
  return SOURCE_EXT.test(hint);
}

function total(p: ScoreParts): number {
  return p.offScope ? 0 : p.lexical + p.topics + p.path + p.code;
}

/** All items scored against the text, best first (no threshold, no limit): for explanations. */
export function scoreAll(items: readonly KnowledgeItem[], queryText: string, opts: Omit<SearchOptions, 'limit' | 'minScore'> = {}): Scored[] {
  const query = tokenSet(queryText);
  const hints = opts.pathHints ?? extractPathHints(queryText);
  const codePaths = opts.codePaths ?? [];
  const w = idfWeights(items);
  return items
    .map((item) => {
      const parts = scoreParts(item, query, queryText, hints, codePaths, w);
      return { item, score: total(parts), parts };
    })
    .sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1));
}

export function searchItems(items: readonly KnowledgeItem[], queryText: string, opts: SearchOptions): Scored[] {
  return scoreAll(items, queryText, opts)
    .filter((s) => s.score >= opts.minScore)
    .slice(0, opts.limit);
}
