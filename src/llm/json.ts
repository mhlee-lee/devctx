import { stripAnsi } from './exec.ts';

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Finds the first balanced JSON object in text (skipping braces inside strings); returns its end index. */
function scanObject(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      // A wrapped line may end right after a backslash: the escaped character is on the next line.
      if (escaped && (ch === '\n' || ch === '\r')) continue;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Terminal columns of a line: East Asian wide and fullwidth characters take two. */
export function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Narrower output is not taken for terminal wrapping. */
const MIN_WRAP_COLUMNS = 60;

/**
 * Line breaks that split a word: the line is as wide as the widest one (the wrap width) and the
 * word around the break is wider than a line. A word that fits a line moves down whole, so any
 * other break took the place of a space.
 */
function splitBreaks(text: string): Set<number> {
  const lines: { end: number; width: number; tail: number }[] = [];
  const heads = new Map<number, number>();
  let widest = 0;
  for (let start = 0; start <= text.length; ) {
    const end = text.indexOf('\n', start);
    const stop = end < 0 ? text.length : end;
    const line = text.slice(start, text[stop - 1] === '\r' ? stop - 1 : stop);
    const width = displayWidth(line);
    widest = Math.max(widest, width);
    heads.set(start, displayWidth(line.split(' ')[0] ?? ''));
    if (end < 0) break;
    lines.push({ end, width, tail: displayWidth(line.slice(line.lastIndexOf(' ') + 1)) });
    start = end + 1;
  }
  const out = new Set<number>();
  if (widest < MIN_WRAP_COLUMNS) return out;
  for (const l of lines) if (l.width >= widest && l.tail + (heads.get(l.end + 1) ?? 0) > widest) out.add(l.end);
  return out;
}

const HANGUL = /[\uac00-\ud7a3]/;

/**
 * Undoes terminal hard wrapping in one JSON object of a CLI's text output (Copilot CLI cuts lines
 * at 100 columns, inside strings too, and splits a word longer than a line). A JSON string cannot
 * hold a raw line break, so one there came from the wrapping: a split word is joined again, any
 * other break gets back the space it replaced (also between Hangul: Korean text has spaces far
 * more often than once a line). Outside strings a split is joined (a number or keyword).
 */
function unwrapObject(text: string, from: number, to: number, splits: ReadonlySet<number>): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = from; i <= to; i++) {
    const ch = text[i] as string;
    if (ch === '\r' && text[i + 1] === '\n') continue;
    if (ch === '\n') {
      if (!inString) out += splits.has(i) ? '' : '\n';
      else if (!escaped) {
        const prev = out[out.length - 1] ?? '';
        const next = text[i + 1] ?? '';
        const split = splits.has(i) && !(HANGUL.test(prev) && HANGUL.test(next));
        out += split || prev === ' ' || next === ' ' ? '' : ' ';
      }
      continue;
    }
    out += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
  }
  return out;
}

/** Every top-level balanced object that parses, in order (repairing terminal wrapping when needed). */
function* scanObjects(text: string): Generator<unknown> {
  let splits: Set<number> | null = null;
  let start = text.indexOf('{');
  while (start >= 0) {
    const end = scanObject(text, start);
    if (end < 0) return;
    const candidate = text.slice(start, end + 1);
    let parsed = tryParse(candidate);
    if (parsed === undefined && candidate.includes('\n')) {
      splits ??= splitBreaks(text);
      parsed = tryParse(unwrapObject(text, start, end, splits));
    }
    if (parsed !== undefined) {
      yield parsed;
      start = text.indexOf('{', end + 1);
    } else {
      start = text.indexOf('{', start + 1);
    }
  }
}

/**
 * Extracts a JSON object from model output that may be wrapped in prose or code fences.
 * Returns undefined when no object parses. This is the first object found; callers that can
 * check the shape should prefer `jsonCandidates` (a log line or an example object may come first).
 */
export function extractJson(raw: string): unknown {
  const text = stripAnsi(raw).trim();
  if (!text) return undefined;
  const direct = tryParse(text);
  if (direct !== undefined && typeof direct === 'object') return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  for (const parsed of scanObjects(text)) return parsed;
  return undefined;
}

/**
 * Every JSON object in the output, in order of appearance: the whole text, each fenced block, and
 * each top-level balanced object. The caller picks the one that has the expected shape.
 */
export function jsonCandidates(raw: string): unknown[] {
  const text = stripAnsi(raw).trim();
  if (!text) return [];
  const out: unknown[] = [];
  const direct = tryParse(text);
  if (direct !== undefined && typeof direct === 'object' && direct !== null) return [direct];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = tryParse((m[1] ?? '').trim());
    if (fenced !== undefined && typeof fenced === 'object' && fenced !== null) out.push(fenced);
  }
  out.push(...scanObjects(text));
  return out;
}

/**
 * The answer in a CLI's output that has the expected shape: the provider's parsed object first,
 * then every JSON object in the raw text from the last one back (a model's final object is its
 * answer; logs and examples come earlier).
 */
export function pickAnswer<T>(data: unknown, text: string, accept: (value: unknown) => T | null): T | null {
  const first = data === undefined ? null : accept(data);
  if (first !== null) return first;
  const all = jsonCandidates(text);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i] === data) continue;
    const value = accept(all[i]);
    if (value !== null) return value;
  }
  return null;
}

/** Last JSON object in JSONL output (e.g. a CLI's final `result` event). */
export function lastJsonLine(raw: string): Record<string, unknown> | null {
  const lines = stripAnsi(raw).split(/\r?\n/).reverse();
  for (const line of lines) {
    const parsed = tryParse(line.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  return null;
}
