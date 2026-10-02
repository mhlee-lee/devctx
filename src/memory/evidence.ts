import { normalizeForMatch, stripPasted } from '../util/text.ts';

/**
 * An extracted rule is only accepted when its evidence quote really occurs in what the developer
 * wrote (pasted code/logs/quotes excluded). This blocks invented rules and instructions smuggled in
 * through pasted content or tool output.
 */
export function isQuoteValid(message: string, quote: string): boolean {
  const q = normalizeForMatch(quote).replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');
  const whole = normalizeForMatch(stripPasted(message));
  // A short quote is only evidence when it is the whole message: a bare "응" accepting a proposal.
  if (q.length < 4) return q.length > 0 && q === whole.replace(/[\s.!~]+$/u, '');
  return whole.includes(q);
}

/** Generic words a Korean statement may add in Latin letters without naming anything new. */
export const GENERIC_TERMS = new Set(
  (
    'api apis ui ux ci cd pr prs id ids url urls uri http https json yaml yml xml csv sql db dto orm sdk cli ide ' +
    'test tests code file files log logs error errors bug fix class type types function method module package repo git ' +
    'commit branch main master merge dev prod build run script config env ok true false null none utf utc'
  ).split(' '),
);

/**
 * Names and numbers in a statement that none of its sources contain. Cheap models sometimes
 * "improve" a rule with a tool, version or name the developer never mentioned (Cognee documents
 * the same drift); such a rule is kept only as a proposal. Korean statements are checked for every
 * Latin word (they are names), English ones only for name-like tokens (camelCase, digits, `./_-+#`).
 */
export function unsupportedTerms(statement: string, sources: readonly (string | null)[]): string[] {
  const haystack = normalizeForMatch(sources.filter(Boolean).join('\n'));
  const korean = /[\uac00-\ud7a3]/.test(statement);
  const out = new Set<string>();
  for (const m of statement.normalize('NFKC').matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._+#-][A-Za-z0-9]+)*[+#]*|\d+(?:\.\d+)+|\d{2,}/g)) {
    const term = m[0];
    const lower = term.toLowerCase();
    const numeric = /^\d/.test(term);
    const nameLike = numeric || /[a-z][A-Z]|[A-Z].*[A-Z]|\d|[._+#-]/.test(term);
    if (!numeric && (lower.length < 2 || GENERIC_TERMS.has(lower))) continue;
    if (!korean && !nameLike) continue;
    if (!haystack.includes(lower)) out.add(term);
  }
  return [...out];
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
];

/** Masks common credential shapes before text leaves the machine or lands in git. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** Removes zero-width and bidi control characters that can hide instructions in rule files. */
export function stripInvisible(text: string): string {
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '');
}
