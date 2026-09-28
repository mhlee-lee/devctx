const HANGUL_RUN = /[\uac00-\ud7a3]+/g;
const WORD_RUN = /[A-Za-z0-9_]+/g;

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Normalization used when checking that an evidence quote really occurs in a message. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function splitIdentifier(word: string): string[] {
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 2);
  const whole = word.toLowerCase();
  return whole.length >= 2 && !parts.includes(whole) ? [whole, ...parts] : parts;
}

/**
 * Tokens for lexical retrieval. ASCII words are split on camelCase/underscores; Hangul runs
 * become character bigrams so "금액은" still matches "금액".
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const normalized = text.normalize('NFKC');
  for (const match of normalized.matchAll(WORD_RUN)) out.push(...splitIdentifier(match[0]));
  for (const match of normalized.matchAll(HANGUL_RUN)) {
    const run = match[0];
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Rough token estimate good enough for budgeting (ASCII ≈ 4 chars/token, Hangul ≈ 1.3 chars/token). */
export function approxTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.3);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Removes content the user pasted rather than wrote: fenced code blocks, quoted lines and very
 * long single lines (logs). Instructions inside pasted content must never become rules.
 */
export function stripPasted(text: string): string {
  const withoutFences = text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ');
  return withoutFences
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line) && line.length <= 400)
    .join('\n')
    .trim();
}

/**
 * ASCII-only slug for file names. Non-ASCII (e.g. Hangul) is dropped on purpose: Unicode file
 * names get NFC/NFD-mangled between macOS and Linux checkouts. The ULID prefix keeps names unique.
 */
export function slugify(text: string, max = 40, fallback = 'item'): string {
  const slug = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Splits prose into sentences on ., !, ?, 。 and line breaks. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\r?\n+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.length > 0);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
