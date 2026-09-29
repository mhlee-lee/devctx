import { normalizeForMatch, tokenSet } from '../util/text.ts';

/**
 * Deterministic duplicate check that runs before the judge LLM (Mem0 hashes, Graphiti's
 * normalized-fact fast path, Hindsight's exact-match guard). A restated rule costs no LLM call;
 * anything that differs in a number, version, name or negation is left to the judge, because
 * "Node 18" and "Node 20" look alike to a token overlap but are different rules.
 */

/** Wording without punctuation, quotes, backticks or case. */
export function canonical(text: string): string {
  return normalizeForMatch(text)
    .replace(/[`"'“”‘’()[\]{}]/g, '')
    .replace(/[.,;:!?。、]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Numbers, versions and Latin-letter names: the parts that change what a rule says. */
export function keyTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize('NFKC').matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._+#-][A-Za-z0-9]+)*[+#]*|\d+(?:\.\d+)*/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
}

const NEGATION = /\b(not|never|no|don't|dont|without|avoid|stop)\b|않|말고|말아|말라|마라|금지|없이|지 마|하지마|쓰지마|안 /i;

export function isNegated(text: string): boolean {
  return NEGATION.test(text);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * The two statements say the same rule: identical after normalization, or nearly identical
 * wording (token Jaccard ≥ 0.9) with the same names, numbers and negation.
 */
export function sameRule(a: string, b: string): boolean {
  const ca = canonical(a);
  const cb = canonical(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (isNegated(a) !== isNegated(b) || !sameSet(keyTerms(a), keyTerms(b))) return false;
  const ta = tokenSet(ca);
  const tb = tokenSet(cb);
  return ta.size >= 4 && tb.size >= 4 && jaccard(ta, tb) >= 0.9;
}

/** The statements name different numbers/versions/tools or one negates: never merge them blindly. */
export function differsInSubstance(a: string, b: string): boolean {
  return isNegated(a) !== isNegated(b) || !sameSet(keyTerms(a), keyTerms(b));
}
