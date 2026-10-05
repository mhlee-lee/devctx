import type { CaseRow, StateDb } from '../state/db.ts';
import type { Language } from '../types.ts';
import { approxTokens, normalizeText, truncate } from '../util/text.ts';
import { readCommandRuns, type CommandRun } from './transcript.ts';

/**
 * Verification cases, without an LLM: a check (test, build, lint) that failed in a session, and
 * whether a later run of the same check in that session passed. AnchorMind links error → fix
 * attempt → verification → resolved; here the verification is the check's own exit status (or its
 * output when a pipe hides the status, marked as inferred). Cases stay on this PC
 * (`state.sqlite`): `search_history` finds them by error text, and a prompt that names an error
 * identifier seen before gets one line about it.
 */

const CURSOR = 'cases_scanned';
const SESSION_CURSOR = 'case_scan:';
/** A failed case of a session quiet for this long is unresolved. */
const OPEN_CASE_MS = 6 * 3_600_000;
const FIRST_SCAN_DAYS = 90;
export const CASE_RETENTION_DAYS = 90;

export interface CaseScan {
  sessions: number;
  opened: number;
  resolved: number;
  closed: number;
}

function apply(db: StateDb, session: string, tool: string, run: CommandRun, out: CaseScan): void {
  const failed = run.ok === false || (run.ok === null && run.seen === false);
  const passed = run.ok === true || (run.ok === null && run.seen === true);
  if (!failed && !passed) return;
  const inferred = run.ok === null;
  const at = new Date(run.at).toISOString();
  const open = db.openCase(session, run.command);
  if (failed) {
    if (open) {
      db.reopenCase(open.id);
      db.updateCaseError(open.id, run.signature, run.excerpt, inferred);
    }
    else {
      db.insertCase({ session, tool, command: run.command, inferred, signature: run.signature, error: run.excerpt, failedAt: at, failPrompt: db.turnAt(session, at).prompt });
      out.opened++;
    }
  } else if (open) {
    db.resolveCase(open.id, at, db.turnAt(session, at), inferred);
    out.resolved++;
  }
}

/**
 * Reads the checks of turns that ended since the last scan (each session from where its previous
 * scan stopped) and records failures and the passes that resolve them. Cheap when nothing is new.
 */
export function processCases(db: StateDb, now: Date = new Date()): CaseScan {
  const out: CaseScan = { sessions: 0, opened: 0, resolved: 0, closed: 0 };
  const cursor = db.kvGet(CURSOR);
  // Sessions overlap: one can end after another's later turn, so look a little before the cursor
  // and let each session's own cursor skip what it already read.
  const floor = cursor ? new Date(Date.parse(cursor) - OPEN_CASE_MS).toISOString() : new Date(now.getTime() - FIRST_SCAN_DAYS * 86_400_000).toISOString();
  let latest = cursor ?? '';
  for (const s of db.sessionsEndedAfter(floor)) {
    const key = `${SESSION_CURSOR}${s.session}`;
    const done = db.kvGet(key);
    if (done && done >= s.lastEnd) continue;
    const since = done ? new Date(Date.parse(done) + 1).toISOString() : floor;
    for (const run of readCommandRuns(s.transcript, since, s.lastEnd)) apply(db, s.session, s.tool, run, out);
    db.kvSet(key, s.lastEnd);
    out.sessions++;
    if (s.lastEnd > latest) latest = s.lastEnd;
  }
  if (latest) db.kvSet(CURSOR, latest);
  out.closed = db.closeStaleCases(new Date(now.getTime() - OPEN_CASE_MS).toISOString());
  return out;
}

/** Turns ended since the last scan (a hook starts the worker for them at session boundaries). */
export function casesPending(db: StateDb): boolean {
  return db.hasTurnsToScan(db.kvGet(CURSOR) ?? '');
}

/**
 * Old cases, and per-session cursors no future scan can need: below both a week ago and the
 * earliest point a scan reads from (the global cursor minus the overlap). A cursor above that
 * floor is kept, or a resumed session would be read again and its cases recorded twice.
 */
export function pruneCases(db: StateDb, now: Date = new Date()): void {
  db.pruneCases(new Date(now.getTime() - CASE_RETENTION_DAYS * 86_400_000).toISOString());
  const cursor = db.kvGet(CURSOR);
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const floor = new Date(Math.min(weekAgo, cursor ? Date.parse(cursor) - OPEN_CASE_MS : weekAgo)).toISOString();
  for (const { key, value } of db.kvList(SESSION_CURSOR)) if (value < floor) db.kvDelete(key);
}

// ---------------------------------------------------------------------------------------------
// The prompt hint: an error identifier seen before
// ---------------------------------------------------------------------------------------------

const HINT: Record<Language, { resolved: (sig: string, cmd: string, day: string, request: string) => string; open: (sig: string, cmd: string, day: string) => string; more: (sig: string) => string }> = {
  ko: {
    resolved: (sig, cmd, day, request) => `[devctx] 이 저장소에서 전에 본 에러 \`${sig}\`: \`${cmd}\` 실패 → ${day}에 같은 세션에서 통과${request ? ` (그때 요청: "${request}")` : ''}.`,
    open: (sig, cmd, day) => `[devctx] 이 저장소에서 전에 본 에러 \`${sig}\`: \`${cmd}\` 실패 (${day}), 그 세션에서는 해결되지 않았다.`,
    more: (sig) => ` 자세히: .devctx/bin/devctx code search_history ${shellQuote(sig)}`,
  },
  en: {
    resolved: (sig, cmd, day, request) => `[devctx] Error \`${sig}\` was seen in this repository before: \`${cmd}\` failed, then passed in the same session on ${day}${request ? ` (request then: "${request}")` : ''}.`,
    open: (sig, cmd, day) => `[devctx] Error \`${sig}\` was seen in this repository before: \`${cmd}\` failed (${day}) and that session did not resolve it.`,
    more: (sig) => ` Details: .devctx/bin/devctx code search_history ${shellQuote(sig)}`,
  },
};

/** One shell word, so the agent can run the command as written (`Missing script: "test"`). */
export function shellQuote(text: string): string {
  if (!/["\\$`]/.test(text)) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replace(/["\\$`]/g, '\\$&')}"`;
}

const HINT_BUDGET = 90;
const MIN_SIGNATURE = 4;

/**
 * One line when the prompt contains, verbatim, the identifier of an error another session of this
 * worktree ran into (pasted compiler output, an error code): how it went then and where to read
 * more. Nothing for identifiers already pointed out in this session.
 */
export function caseHint(db: StateDb, prompt: string, session: string | null, lang: Language, skip: ReadonlySet<string>, now: Date = new Date()): { text: string; signature: string } | null {
  if (!/[A-Za-z]{2}|\d{4}/.test(prompt)) return null;
  const since = new Date(now.getTime() - CASE_RETENTION_DAYS * 86_400_000).toISOString();
  const hit = db.caseSignatures(since, session).find((c) => c.signature && c.signature.length >= MIN_SIGNATURE && !skip.has(c.signature) && namesSignature(prompt, c.signature));
  if (!hit?.signature) return null;
  return { text: renderHint(hit, lang), signature: hit.signature };
}

/** The identifier as a whole word of the prompt ("TS2345" is not in "TS23456"). */
function namesSignature(prompt: string, signature: string): boolean {
  let from = 0;
  for (;;) {
    const at = prompt.indexOf(signature, from);
    if (at < 0) return false;
    const before = prompt[at - 1] ?? ' ';
    const after = prompt[at + signature.length] ?? ' ';
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
    from = at + 1;
  }
}

function renderHint(c: CaseRow, lang: Language): string {
  const t = HINT[lang];
  const sig = c.signature as string;
  const cmd = truncate(c.command, 50);
  const tail = t.more(sig);
  if (c.state !== 'resolved') return `${t.open(sig, cmd, (c.failedAt).slice(0, 10))}${tail}`;
  let request = c.fixPrompt ?? c.failPrompt ?? '';
  request = normalizeText(request);
  const day = (c.resolvedAt ?? c.failedAt).slice(0, 10);
  // Shorten the request until the line fits; drop it rather than the pointer to the details.
  for (let n = request.length; n >= 0; n = n > 20 ? Math.floor(n * 0.7) : n - 20) {
    const line = `${t.resolved(sig, cmd, day, n > 0 ? truncate(request, Math.max(10, n)) : '')}${tail}`;
    if (approxTokens(line) <= HINT_BUDGET || n <= 0) return line;
  }
  return `${t.resolved(sig, cmd, day, '')}${tail}`;
}
