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

// ---------------------------------------------------------------------------------------------
// Command results (session handoff): which checks ran and whether they passed
// ---------------------------------------------------------------------------------------------

export interface CommandCheck {
  /** The test, build or lint part of the command ("npm test", "./gradlew check"). */
  command: string;
  /** Passed (exit code 0), failed, or null when the transcript does not say. */
  ok: boolean | null;
  at: number;
  /** The error's identifier when it failed (see errorSignature). */
  signature?: string | null;
}

/**
 * Commands that check the work: tests, builds, type checks and linters, run directly or through a
 * package script. Reading commands (`cat src/test/x.ts`, `grep test`) do not count.
 */
const CHECK_RUNNER =
  /^(?:\w+=\S*\s+)*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:-s\s+|--silent\s+)?[\w:.-]*(?:test|build|lint|check|typecheck|tsc|bench|verify|ci)[\w:.-]*|(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn)\s+(?:tsc|jest|vitest|eslint|mocha|playwright|biome|prettier\s+--check)\b|node\s+--test|deno\s+(?:test|check|lint)|(?:python3?\s+-m\s+|uv\s+run\s+|poetry\s+run\s+)?(?:pytest|unittest|tox|nox|mypy|ruff|pyright|flake8)\b|go\s+(?:test|vet|build)\b|cargo\s+(?:test|build|check|clippy|nextest)\b|\.?\/?gradlew?\s+[\w:-]*(?:test|build|check|assemble)|mvnw?\s+[\w:-]*(?:test|verify|package|compile)|make\s+[\w-]*(?:test|check|build|lint|ci)\b|ctest\b|tsc\b|eslint\b|rspec\b|bundle\s+exec\s+(?:rspec|rake)|(?:vendor\/bin\/)?phpunit\b|dotnet\s+(?:test|build)\b|swift\s+(?:test|build)\b|xcodebuild\b|mix\s+test\b|flutter\s+test\b|dart\s+test\b)/i;

export interface CheckParts {
  /** The test, build or lint parts of a command line, in order. */
  checks: string[];
  /**
   * The line's exit status says how they went: parts joined only by `&&` (and pipes under
   * `set -o pipefail`). After `| tail`, `|| true` or `; echo` it is another command's status.
   */
  attributable: boolean;
}

/** The checks in a shell command line ("cd app && npm test 2>&1 | tail" → `npm test`, not attributable). */
export function checkParts(command: string): CheckParts {
  const pipefail = /\bset\s+-[a-z]*o\s+pipefail\b/.test(command);
  const tokens = command.split(/\s*(&&|\|\||;|\|)\s*/);
  const checks: string[] = [];
  let attributable = true;
  for (let i = 0; i < tokens.length; i += 2) {
    const part = (tokens[i] ?? '').replace(/\s+\d?>&?\s*\S+/g, '').replace(/\s+/g, ' ').trim();
    const sep = tokens[i + 1];
    // `set -euo pipefail;` only changes how the rest reports.
    if (/^set\s+-/.test(part)) continue;
    if (sep !== undefined && sep !== '&&' && !(sep === '|' && pipefail)) attributable = false;
    if (CHECK_RUNNER.test(part)) checks.push(truncate(part, 80));
  }
  return { checks, attributable };
}

/** The first check part of a shell command line, or null. */
export function checkCommand(command: string): string | null {
  return checkParts(command).checks[0] ?? null;
}

const EXIT_PATTERNS: RegExp[] = [
  /Process exited with code (-?\d+)/, // Codex exec_command
  /(?:completed|exited) with exit code (-?\d+)/, // Copilot CLI bash
  /"exit_code"\s*:\s*(-?\d+)/, // Codex code mode
  /^Exit code:? (-?\d+)/m, // Claude Code Bash errors
];

function resultText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(resultText).join('\n');
  if (isObj(v)) return [v.text, v.content, v.output, v.stdout, v.stderr].map(resultText).join('\n');
  return '';
}

/** Passed, failed or unknown, from whatever the tool recorded about a finished call. */
function outcome(o: Obj): boolean | null {
  if (typeof o.exit_code === 'number') return o.exit_code === 0;
  const text = resultText(o.output ?? o.content ?? o.result ?? '').slice(0, 200_000);
  for (const p of EXIT_PATTERNS) {
    const m = p.exec(text);
    if (m) return Number(m[1]) === 0;
  }
  if (o.is_error === true || o.success === false || /^Script failed/m.test(text)) return false;
  if (o.is_error === false) return true;
  return null;
}

function parseJsonObject(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Shell commands a tool call ran: `command` / `cmd` in its input or arguments (Codex code mode embeds them in a script). */
function callCommands(o: Obj): string[] {
  const out: string[] = [];
  for (const key of ['input', 'arguments']) {
    const v = o[key];
    if (isObj(v)) {
      const c = commandText(v.command ?? v.cmd);
      if (c) out.push(c);
    } else if (typeof v === 'string') {
      const parsed = v.trim().startsWith('{') ? parseJsonObject(v) : null;
      if (parsed) {
        const c = commandText(parsed.command ?? parsed.cmd);
        if (c) out.push(c);
      } else {
        for (const m of v.matchAll(/"(?:cmd|command)"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
          try {
            const c = commandText(JSON.parse(m[1] as string));
            if (c) out.push(c);
          } catch {
            // not a JSON string literal
          }
        }
      }
    }
  }
  return out;
}

export interface CommandRun {
  /** The check part of the command ("npm test"). */
  command: string;
  /** From the exit status, when it can be attributed to this check; otherwise null. */
  ok: boolean | null;
  /**
   * From the output when the exit status cannot say (`| tail`): false when it shows failures,
   * true when it shows a success and no failure, null otherwise. Equal to `ok` when that is known.
   */
  seen: boolean | null;
  at: number;
  /** Error lines from the output (at most 5, secrets masked), for failed runs. */
  excerpt: string | null;
  /** The error's identifier ("TS2345", "ERR_OSSL_EVP_UNSUPPORTED", `Missing script: "test"`). */
  signature: string | null;
}

const FAIL_MARK =
  /(\b[1-9]\d*\s+(?:tests?\s+|specs?\s+)?fail(?:ed|ing|ures?)\b|\bFAILED\b|\bBUILD FAILED\b|^\s*FAIL\s|\berror TS\d+|\bnpm (?:ERR!|error)\b|Traceback \(most recent call last\)|\bpanicked at\b|^\s*error(?:\[E\d+\])?:|^e: )/m;
const PASS_MARK = /(\bBUILD SUCCESSFUL\b|\b\d+\s+(?:tests?\s+)?passed\b|\btests? passed\b|^ok\s+\S+|\bAll tests passed\b|Found 0 errors|\b0 (?:errors|failures|failed)\b)/im;
const ERROR_LINE = /(error|fail|exception|cannot|could not|not found|missing|expected|assert|traceback|panicked|denied|refused|TS\d{4}|ERR_)/i;

/** Exception names too common to identify an error ("TypeError" says little on its own). */
const GENERIC_EXCEPTIONS = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AssertionError', 'AssertionFailedError', 'Exception', 'RuntimeException', 'IllegalStateException', 'IllegalArgumentException', 'ValueError', 'KeyError', 'StandardError']);

/**
 * Codes every failure of a runner or package manager carries, whatever went wrong (a failed
 * assertion, a script that exited non-zero, a failing `:test` task): they identify nothing.
 */
const RUNNER_CODES = /^(ERR_ASSERTION|ERR_TEST_FAILURE|ERR_PNPM_RECURSIVE\w*|ERR_PNPM_\w*_FAIL\w*|ERR_UNHANDLED_REJECTION|ELIFECYCLE|ENOENT|EACCES|EPERM|EEXIST)$/;
const GENERIC_TASK = /(^|:)(test\w*|check|build|assemble|lint\w*|compile\w*|jar|bootJar|classes)$/i;

function specific(signature: string): boolean {
  if (RUNNER_CODES.test(signature)) return false;
  if (signature.startsWith(':') && GENERIC_TASK.test(signature)) return false;
  return true;
}

/**
 * The identifier of an error in command output, specific enough that seeing it again means the
 * same problem: compiler codes, Node/npm codes, a missing script or module, a failing build task,
 * an uncommon exception class. Codes every failure of a runner carries (`ERR_ASSERTION`, `ENOENT`,
 * a failed `:test` task) do not count. Null when nothing specific is there.
 */
export function errorSignature(output: string): string | null {
  const t = output.slice(0, 100_000);
  const patterns: RegExp[] = [
    /\b(TS\d{4,5})\b/g,
    /(Missing script: "[^"\n]{1,60}")/g,
    /(No module named '[^'\n]{1,80}')/g,
    /(Cannot find module '[^'\n]{1,80}')/g,
    /error\[(E\d{4})\]/g,
    /\b(ERR_[A-Z0-9_]{3,})\b/g,
    /Execution failed for task '([^'\n]{2,100})'/g,
    /> Task (:\S{2,100}) FAILED/g,
    /\bnpm (?:ERR!|error) code (E[A-Z]{3,})\b/g,
  ];
  for (const p of patterns) {
    for (const m of t.matchAll(p)) if (m[1] && specific(m[1])) return m[1];
  }
  for (const m of t.matchAll(/\b([A-Z][A-Za-z0-9]{2,}(?:Exception|Error))\b/g)) {
    if (!GENERIC_EXCEPTIONS.has(m[1] as string)) return m[1] as string;
  }
  return null;
}

/** Error lines of a failed run (at most 5, secrets masked). */
function errorExcerpt(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && ERROR_LINE.test(l) && !/^(Wall time|Chunk ID|Original token count|<shellId)/.test(l));
  const picked = [...new Set(lines)].slice(0, 5).map((l) => truncate(l, 200));
  return picked.length > 0 ? redactSecrets(picked.join('\n')) : null;
}

/**
 * Every check (tests, builds, linters) the agent ran between two times, oldest first, with how it
 * went. Best effort over the JSON-lines transcripts of Claude Code (`tool_use` /
 * `tool_result.is_error`), Codex (`call_id`, "Process exited with code N") and Copilot CLI
 * (`toolCallId`, "exit code N"); unknown formats give nothing. Never throws.
 */
export function readCommandRuns(file: string | null, sinceIso: string, untilIso: string | null = null): CommandRun[] {
  if (!file) return [];
  const text = readTail(file);
  if (!text) return [];
  const since = Date.parse(sinceIso);
  const until = untilIso ? Date.parse(untilIso) : Number.POSITIVE_INFINITY;
  const calls = new Map<string, { commands: string[]; at: number }>();
  const results = new Map<string, { ok: boolean | null; text: string }>();
  const visit = (o: Obj, at: number, depth: number): void => {
    if (depth > 6) return;
    const callId = o.type === 'tool_use' && typeof o.id === 'string' ? o.id : typeof o.call_id === 'string' ? o.call_id : typeof o.toolCallId === 'string' ? o.toolCallId : null;
    const isResult = typeof o.tool_use_id === 'string' || (callId !== null && ('output' in o || 'success' in o || 'result' in o || typeof o.exit_code === 'number'));
    if (isResult) {
      const id = typeof o.tool_use_id === 'string' ? o.tool_use_id : (callId as string);
      results.set(id, { ok: outcome(o), text: resultText(o.output ?? o.content ?? o.result ?? '').slice(0, 200_000) });
    } else if (callId) {
      const commands = callCommands(o);
      if (commands.length > 0) calls.set(callId, { commands, at });
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) for (const x of v) if (isObj(x)) visit(x, at, depth + 1);
      if (isObj(v)) visit(v, at, depth + 1);
    }
  };
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
    visit(o, ts, 0);
  }
  const runs: CommandRun[] = [];
  for (const [id, call] of [...calls].sort((a, b) => a[1].at - b[1].at)) {
    const result = results.get(id);
    for (const command of call.commands) {
      const { checks, attributable } = checkParts(command);
      if (checks.length === 0) continue;
      // One status for the call: it says how a check went only when nothing else could have set it
      // (a script that ran several commands, `| tail`, `|| true`). A failure in `a && b` is one of them.
      const single = call.commands.length === 1;
      const known = single && attributable ? (result?.ok ?? null) : null;
      const ok = known === false && checks.length > 1 ? null : known;
      const out = result?.text ?? '';
      let seen = ok;
      if (seen === null && single && checks.length === 1 && out) seen = FAIL_MARK.test(out) ? false : PASS_MARK.test(out) ? true : null;
      const failed = seen === false || ok === false;
      for (const check of checks) {
        runs.push({
          command: redactSecrets(check),
          ok,
          seen,
          at: call.at,
          excerpt: failed && checks.length === 1 ? errorExcerpt(out) : null,
          signature: failed && checks.length === 1 ? errorSignature(out) : null,
        });
      }
    }
  }
  return runs;
}

/**
 * The checks the agent ran between two times, each once (its latest run), with whether it passed
 * when the exit status says so.
 */
export function readCommandChecks(file: string | null, sinceIso: string, untilIso: string | null = null): CommandCheck[] {
  const latest = new Map<string, CommandCheck>();
  for (const run of readCommandRuns(file, sinceIso, untilIso)) {
    latest.delete(run.command);
    latest.set(run.command, { command: run.command, ok: run.ok, at: run.at, signature: run.ok === false ? run.signature : null });
  }
  return [...latest.values()];
}
