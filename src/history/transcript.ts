import fs from 'node:fs';
import { redactSecrets } from '../memory/evidence.ts';
import { truncate } from '../util/text.ts';

/**
 * Best-effort reading of a tool's transcript (JSON lines: Claude Code, Codex and others) for one
 * turn: the shell commands the agent ran and its last reply. Formats differ and change, so this
 * walks every JSON line generically and never throws; the history entry works without it.
 */

export interface TurnTranscript {
  commands: string[];
  lastAssistant: string | null;
}

const EMPTY: TurnTranscript = { commands: [], lastAssistant: null };
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_COMMANDS = 20;

function readTail(file: string, maxBytes: number = TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function timestampOf(o: Obj): number | null {
  for (const key of ['timestamp', 'ts', 'time', 'created_at']) {
    const v = o[key];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

function commandText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    const parts = v as string[];
    // ["bash", "-lc", "npm test"] -> "npm test"
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0] ?? '') && /^-\w*c$/.test(parts[1] ?? '')) return parts[2] ?? null;
    return parts.join(' ').trim() || null;
  }
  return null;
}

function collectCommands(v: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= MAX_COMMANDS * 3) return;
  if (Array.isArray(v)) {
    for (const x of v) collectCommands(x, out, depth + 1);
    return;
  }
  if (!isObj(v)) return;
  for (const [key, value] of Object.entries(v)) {
    if (key === 'command' || key === 'cmd') {
      const c = commandText(value);
      if (c) out.push(c);
    } else if (key === 'arguments' && typeof value === 'string' && value.trim().startsWith('{')) {
      try {
        collectCommands(JSON.parse(value), out, depth + 1);
      } catch {
        // not JSON arguments
      }
    } else if (typeof value === 'object') {
      collectCommands(value, out, depth + 1);
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isObj(c) && (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Assistant prose in a line: `{type:"assistant", message:{content}}` or `{role:"assistant", content}`. */
function assistantText(o: Obj, depth = 0): string {
  if (depth > 4) return '';
  if (o.role === 'assistant' || o.type === 'assistant') {
    const own = textOf(o.content);
    if (own) return own;
  }
  for (const key of ['message', 'payload', 'item', 'data']) {
    const inner = o[key];
    if (isObj(inner)) {
      const t = assistantText(inner, depth + 1);
      if (t) return t;
    }
  }
  return '';
}

/**
 * Lines dated within the turn: from its prompt to its end. The assistant's lines of a turn are all
 * written between the two hook events (same machine clock), so the bounds are exact; any slack
 * would pick up the next turn's reply when the next prompt follows quickly. Undated transcripts give
 * nothing.
 */
export function readTurnTranscript(file: string | null, sinceIso: string, untilIso: string | null = null): TurnTranscript {
  if (!file) return EMPTY;
  const text = readTail(file);
  if (!text) return EMPTY;
  const since = Date.parse(sinceIso);
  const until = untilIso ? Date.parse(untilIso) : Number.POSITIVE_INFINITY;
  const commands: string[] = [];
  let lastAssistant: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const ts = timestampOf(o);
    if (ts === null || ts < since || ts > until) continue;
    collectCommands(o, commands);
    const said = assistantText(o).trim();
    if (said) lastAssistant = said;
  }
  const unique = [...new Set(commands.map((c) => truncate(redactSecrets(c.replace(/\s+/g, ' ')), 200)))].slice(-MAX_COMMANDS);
  return { commands: unique, lastAssistant: lastAssistant ? redactSecrets(lastAssistant) : null };
}

/**
 * The assistant's latest message in a transcript, for tools whose turn-end hook does not pass it.
 * Reads only the last 512 KB from the end backwards (hooks call this for short replies like "응").
 */
export function readLastAssistant(file: string | null): string | null {
  if (!file) return null;
  const text = readTail(file, 512 * 1024);
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    try {
      const o: unknown = JSON.parse(line);
      const said = isObj(o) ? assistantText(o).trim() : '';
      if (said) return said;
    } catch {
      // partial or non-JSON line
    }
  }
  return null;
}
