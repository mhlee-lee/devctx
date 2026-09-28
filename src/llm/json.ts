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
 * Returns undefined when no object parses.
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

/** Last JSON object in JSONL output (e.g. a CLI's final `result` event). */
export function lastJsonLine(raw: string): Record<string, unknown> | null {
  const lines = stripAnsi(raw).split(/\r?\n/).reverse();
  for (const line of lines) {
    const parsed = tryParse(line.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  return null;
}
