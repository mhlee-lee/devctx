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

// A line of code or SQL: ends a statement or opens a block, or closes one, or is a stack frame.
const CODE_END = /(;|\{|\(|\*\/)\s*$/;
const CODE_START = /^\s*([}\])]|at [\w$.<>]+\(.*\)\s*$)/;
// A comment line inside code (SQL, C-style, shebang).
const CODE_COMMENT = /^\s*(--\s|\/\/|\/\*|\*\/|#!)/;
// Pasted review findings: "• 문제: ...", "(2.1절, 4.1절)", "372–378행에서", "L12-L30". Only forms a
// developer does not use for a rule of their own ("• 네이밍: camelCase", "Java 1.8 절대", "20~30행
// 이내" are theirs).
const REVIEW_MARKER = [
  /^\s*[•◦▪▸►‣●○■□◆◇]\s*(현상|문제|문제점|원인|영향|권장|권장\s*사항|제안|수정\s*제안|해결|해결\s*방안|개선|개선\s*방안|이슈|위험|근거|재현|조치|대안|problem|issue|impact|cause|root cause|suggestion|recommendation|proposed fix|fix|risk|severity|evidence)\s*[:：]/i,
  /\(\s*\d+(\.\d+)+절/,
  /\d+\s*[–—-]\s*\d+\s*행(에서|에|의|을|를|은|는|까지)/,
  /\bL\d+\s*[-–]\s*L?\d+\b/,
  /\blines?\s+\d+\s*[-–]\s*\d+\b/i,
];
// The developer calling what they pasted above a review: "이런 리뷰가 있는데", "위 리뷰 반영해줘".
// It only widens a finding already marked above to its whole paragraph: "위 에러 해결해줘" usually
// means the tool's output, and the line above may be the developer's own rule.
const POINTS_ABOVE = [
  /^\s*(이런|이러한|이와\s*같은|위|위의|위에)\s*(코드\s*)?(리뷰|코멘트|피드백|지적)\s*(가|이|를|을|는|은|도|좀)?\s*(있|왔|달렸|받았|봐|보고|확인|반영|참고)/,
  /^\s*(the |this )?(code )?(review|comments?|feedback) above\b/i,
];

function hasHangulOutsideLiterals(line: string): boolean {
  const bare = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '').replace(/(--|\/\/|#).*$/, '');
  return /[\uac00-\ud7a3]/.test(bare);
}

type LineKind = 'blank' | 'prose' | 'comment' | 'code' | 'other';

function lineKind(line: string): LineKind {
  if (!line.trim()) return 'blank';
  if (CODE_COMMENT.test(line)) return 'comment';
  if (hasHangulOutsideLiterals(line)) return 'prose';
  return CODE_END.test(line) || CODE_START.test(line) ? 'code' : 'other';
}

/**
 * Unfenced code or SQL. Between blank lines and Korean prose lines, a run with two code lines (or
 * one and a code comment) that is mostly code is pasted: its code, comments ("-- 앞으로 ..." in a
 * migration is not the developer speaking) and the lines between them. A line introducing the
 * code ("Log errors like this:") and the prose around it stay.
 */
function codeLines(kinds: readonly LineKind[], out: Set<number>): void {
  const runs: { first: number; last: number; code: boolean; commentsOnly: boolean }[] = [];
  let segment: number[] = [];
  const close = (): void => {
    const marked = segment.filter((i) => kinds[i] === 'code' || kinds[i] === 'comment');
    const code = segment.filter((i) => kinds[i] === 'code').length;
    const body = segment.filter((i) => kinds[i] !== 'comment').length;
    if (marked.length > 0) {
      const comments = marked.length - code;
      runs.push({
        first: marked[0] as number,
        last: marked[marked.length - 1] as number,
        code: (code >= 2 || (code >= 1 && comments >= 1)) && code * 2 >= body,
        commentsOnly: code === 0 && body === 0,
      });
    }
    segment = [];
  };
  kinds.forEach((kind, i) => {
    if (kind === 'blank' || kind === 'prose') close();
    else segment.push(i);
  });
  close();
  const between = (a: number, b: number): boolean => kinds.slice(a + 1, b).every((k) => k !== 'prose');
  runs.forEach((r, n) => {
    const prev = runs[n - 1];
    const next = runs[n + 1];
    const nextToCode = (prev?.code && between(prev.last, r.first)) || (next?.code && between(r.last, next.first));
    if (r.code || (r.commentsOnly && nextToCode)) for (let i = r.first; i <= r.last; i++) out.add(i);
  });
}

/**
 * Lines of pasted material that has no fence: code and SQL (see codeLines) and review findings. A
 * paragraph most of whose lines are findings goes whole, and so does one with a finding that the
 * next line calls a review.
 */
function pastedLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  codeLines(lines.map(lineKind), out);
  const paragraphs: number[][] = [];
  let current: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim()) current.push(i);
    else if (current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
  });
  if (current.length > 0) paragraphs.push(current);
  const marked = paragraphs.map((p) => p.filter((i) => REVIEW_MARKER.some((r) => r.test(lines[i] ?? ''))));
  paragraphs.forEach((p, n) => {
    const own = marked[n] ?? [];
    for (const i of own.length * 2 > p.length ? p : own) out.add(i);
    for (const i of p) {
      if (!POINTS_ABOVE.some((r) => r.test(lines[i] ?? ''))) continue;
      const above = p.filter((j) => j < i);
      const block = above.length > 0 ? above : (paragraphs[n - 1] ?? []);
      if (block.some((j) => (above.length > 0 ? own : (marked[n - 1] ?? [])).includes(j))) for (const j of block) out.add(j);
    }
  });
  return out;
}

/**
 * Removes content the user pasted rather than wrote: fenced code blocks, quoted lines, very long
 * single lines (logs), unfenced code and SQL, and pasted review findings. Instructions inside
 * pasted content must never become rules.
 */
export function stripPasted(text: string): string {
  const withoutFences = text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ');
  const lines = withoutFences.split(/\r?\n/);
  const pasted = pastedLines(lines);
  return lines
    .filter((line, i) => !pasted.has(i) && !/^\s*>/.test(line) && line.length <= 400)
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
