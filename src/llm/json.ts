import { stripAnsi } from './exec.ts';

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Finds the first balanced JSON object in text (skipping braces inside strings). */
function scanObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
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
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const candidate = scanObject(text, start);
    if (!candidate) break;
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }
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
  let start = text.indexOf('{');
  while (start >= 0) {
    const candidate = scanObject(text, start);
    if (!candidate) break;
    const parsed = tryParse(candidate);
    if (parsed !== undefined) {
      out.push(parsed);
      start = text.indexOf('{', start + candidate.length);
    } else {
      start = text.indexOf('{', start + 1);
    }
  }
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
