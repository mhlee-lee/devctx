import { normalizeForMatch, stripPasted } from '../util/text.ts';

/**
 * An extracted rule is only accepted when its evidence quote really occurs in what the developer
 * wrote (pasted code/logs/quotes excluded). This blocks invented rules and instructions smuggled in
 * through pasted content or tool output.
 */
export function isQuoteValid(message: string, quote: string): boolean {
  const q = normalizeForMatch(quote).replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');
  if (q.length < 4) return false;
  return normalizeForMatch(stripPasted(message)).includes(q);
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
