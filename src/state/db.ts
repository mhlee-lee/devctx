import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '../memory/evidence.ts';
import type { HookKind } from '../types.ts';
import { ulid } from '../util/ulid.ts';

export interface StoredEvent {
  id: string;
  ts: string;
  /** Tool whose hook config produced the event, or `file`/`cli` for non-hook sources. */
  tool: string;
  host: string;
  kind: HookKind | 'foreign_edit';
  session: string | null;
  cwd: string;
  prompt: string | null;
  lastAssistant: string | null;
  transcriptPath: string | null;
  model: string | null;
  flags: string[];
  candidate: boolean;
}

export interface PreviousSession {
  tool: string;
  session: string | null;
  endedAt: string;
  /** The session's first recorded event. */
  startedAt: string;
  /** Up to the last 3 requests, oldest first. */
  prompts: string[];
  /** Up to the first 3 requests, oldest first (what the session set out to do). */
  openingPrompts: string[];
  /** Requests in the session. */
  promptCount: number;
  lastAssistant: string | null;
  /** The tool's transcript of the session, when its hooks reported one. */
  transcriptPath: string | null;
}

export interface InjectionRecord {
  tool: string;
  session: string | null;
  kind: string;
  ids: string[];
  tokens: number;
  handoff: boolean;
}

type Row = Record<string, unknown>;

const SCHEMA = `
create table if not exists events(
  id text primary key,
  ts text not null,
  tool text not null,
  host text not null,
  kind text not null,
  session text,
  cwd text not null,
  prompt text,
  last_assistant text,
  transcript_path text,
  model text,
  flags text not null default '[]',
  candidate integer not null default 0,
  processed integer not null default 0,
  error text
);
create index if not exists events_pending on events(processed, ts);
create index if not exists events_session on events(session, kind, ts);
create table if not exists dedupe(key text primary key, ts integer not null);
create table if not exists ops(
  id text primary key,
  ts text not null,
  event_id text,
  relation text not null,
  item_id text,
  target_id text,
  detail text
);
create table if not exists violations(id text primary key, ts text not null, item_id text not null, event_id text);
create table if not exists llm_calls(
  id text primary key,
  ts text not null,
  provider text not null,
  model text not null,
  task text not null,
  ok integer not null,
  ms integer not null,
  cost_usd real,
  error text
);
create index if not exists llm_calls_ts on llm_calls(ts);
create table if not exists kv(key text primary key, value text not null);
create table if not exists injections(
  id text primary key,
  ts text not null,
  tool text not null,
  session text,
  kind text not null,
  ids text not null default '[]',
  tokens integer not null default 0,
  handoff integer not null default 0
);
create index if not exists injections_ts on injections(ts);
create table if not exists item_stats(
  item_id text primary key,
  reinforced integer not null default 0,
  violations integer not null default 0,
  last_seen text,
  evidence text not null default '[]'
);
create table if not exists proposals(
  id text primary key,
  status text not null,
  created text not null,
  updated text not null,
  item text not null
);
create table if not exists kfiles(
  path text primary key,
  mtime real not null,
  ctime real not null,
  size integer not null,
  item text,
  error text
);
create table if not exists history_turns(
  id text primary key,
  tool text not null,
  session text,
  skey text not null,
  model text,
  branch text,
  prompt_ts text not null,
  prompt text not null,
  before_tree text,
  end_ts text,
  after_tree text,
  last_assistant text,
  transcript_path text,
  state text not null,
  file text,
  error text
);
create index if not exists history_state on history_turns(state, prompt_ts);
create index if not exists history_session on history_turns(skey, prompt_ts);
create table if not exists cases(
  id text primary key,
  session text not null,
  tool text not null,
  command text not null,
  state text not null,
  inferred integer not null default 0,
  signature text,
  error text,
  failed_at text not null,
  resolved_at text,
  fail_prompt text,
  fix_prompt text,
  fix_reply text
);
create index if not exists cases_open on cases(session, command, state);
create index if not exists cases_signature on cases(signature, failed_at);
`;

/**
 * One prompt and what followed it, for the prompt history (`.devctx/history/`). `open` until the
 * turn ends, `ready` until the worker writes its entry, then `done`.
 */
export interface HistoryTurn {
  id: string;
  tool: string;
  session: string | null;
  /** Session id, or tool and day when the tool gives none: one history file per key. */
  skey: string;
  model: string | null;
  branch: string | null;
  promptTs: string;
  prompt: string;
  beforeTree: string | null;
  endTs: string | null;
  afterTree: string | null;
  lastAssistant: string | null;
  transcriptPath: string | null;
  state: 'open' | 'ready' | 'done';
  file: string | null;
  error: string | null;
}
/**
 * A check that failed in a session, and whether a later run of the same check in that session
 * passed (`resolved`) or the session ended without that (`unresolved`). Kept on this PC only.
 */
export interface CaseRow {
  id: string;
  session: string;
  tool: string;
  command: string;
  state: 'failed' | 'resolved' | 'unresolved';
  /** The failure or the pass was read from the output, not from an exit status. */
  inferred: boolean;
  signature: string | null;
  error: string | null;
  failedAt: string;
  resolvedAt: string | null;
  failPrompt: string | null;
  fixPrompt: string | null;
  fixReply: string | null;
}

function caseRow(r: Row): CaseRow {
  return {
    id: String(r.id),
    session: String(r.session),
    tool: String(r.tool),
    command: String(r.command),
    state: String(r.state) as CaseRow['state'],
    inferred: Number(r.inferred) === 1,
    signature: asString(r.signature),
    error: asString(r.error),
    failedAt: String(r.failed_at),
    resolvedAt: asString(r.resolved_at),
    failPrompt: asString(r.fail_prompt),
    fixPrompt: asString(r.fix_prompt),
    fixReply: asString(r.fix_reply),
  };
}

/** How often this PC saw a committed rule again (kept out of git so files never change). */
export interface ItemStats {
  reinforced: number;
  violations: number;
  lastSeen: string | null;
  /** Extra evidence quotes seen on this PC, newest last (at most 5). */
  evidence: { quote?: string; at?: string }[];
}

export interface ProposalRow {
  id: string;
  status: 'proposed' | 'archived';
  created: string;
  updated: string;
  /** Serialized KnowledgeItem. */
  item: string;
}

export interface KfileRow {
  path: string;
  mtime: number;
  ctime: number;
  size: number;
  item: string | null;
  error: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Per-worktree state store (`.devctx/local/state.sqlite`). Not a cache: holds unprocessed events. */
export class StateDb {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(file: string): StateDb {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('pragma busy_timeout = 5000; pragma journal_mode = wal; pragma synchronous = normal;');
    db.exec(SCHEMA);
    return new StateDb(db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /**
   * Returns true the first time `key` is seen within `windowMs`. Several tools read each other's
   * hook files (Cursor and Copilot also run `.claude/settings.json`), so one user action can fire
   * the same devctx hook more than once.
   */
  dedupeOnce(key: string, windowMs: number, now: number = Date.now()): boolean {
    const row = this.db
      .prepare(
        `insert into dedupe(key, ts) values(?, ?)
         on conflict(key) do update set ts = excluded.ts where excluded.ts - dedupe.ts > ?
         returning key`,
      )
      .get(key, now, windowMs);
    if (Math.random() < 0.02) this.db.prepare('delete from dedupe where ts < ?').run(now - 86_400_000);
    return row !== undefined;
  }

  insertEvent(ev: Omit<StoredEvent, 'id'> & { id?: string }): string {
    const id = ev.id ?? ulid();
    this.db
      .prepare(
        `insert into events(id, ts, tool, host, kind, session, cwd, prompt, last_assistant, transcript_path, model, flags, candidate)
         values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ev.ts,
        ev.tool,
        ev.host,
        ev.kind,
        ev.session,
        ev.cwd,
        // Credentials never reach the disk, also when nothing else is recorded (history off).
        ev.prompt === null ? null : redactSecrets(ev.prompt),
        ev.lastAssistant === null ? null : redactSecrets(ev.lastAssistant),
        ev.transcriptPath,
        ev.model,
        JSON.stringify(ev.flags),
        ev.candidate ? 1 : 0,
      );
    return id;
  }

  private toEvent(r: Row): StoredEvent {
    let flags: string[] = [];
    try {
      flags = JSON.parse(String(r.flags ?? '[]')) as string[];
    } catch {
      flags = [];
    }
    return {
      id: String(r.id),
      ts: String(r.ts),
      tool: String(r.tool),
      host: String(r.host),
      kind: String(r.kind) as StoredEvent['kind'],
      session: asString(r.session),
      cwd: String(r.cwd),
      prompt: asString(r.prompt),
      lastAssistant: asString(r.last_assistant),
      transcriptPath: asString(r.transcript_path),
      model: asString(r.model),
      flags,
      candidate: r.candidate === 1,
    };
  }

  pendingEvents(limit: number): StoredEvent[] {
    const rows = this.db.prepare('select * from events where processed = 0 order by ts, id limit ?').all(limit) as Row[];
    return rows.map((r) => this.toEvent(r));
  }

  hasPendingCandidates(): boolean {
    return this.db.prepare('select 1 as x from events where processed = 0 and candidate = 1 limit 1').get() !== undefined;
  }

  /** Unprocessed candidates split by how they were picked (see hooks/signals.ts `extractionDue`). */
  pendingCandidates(): { explicit: number; implicit: number; oldestImplicit: string | null } {
    const row = this.db
      .prepare(
        `select
           coalesce(sum(case when flags like '%"implicit"%' then 0 else 1 end), 0) as explicit,
           coalesce(sum(case when flags like '%"implicit"%' then 1 else 0 end), 0) as implicit,
           min(case when flags like '%"implicit"%' then ts end) as oldest
         from events where processed = 0 and candidate = 1`,
      )
      .get() as Row | undefined;
    return { explicit: Number(row?.explicit ?? 0), implicit: Number(row?.implicit ?? 0), oldestImplicit: asString(row?.oldest) };
  }

  countPending(): number {
    const row = this.db.prepare('select count(*) as n from events where processed = 0').get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  markProcessed(ids: readonly string[], error?: string): void {
    const stmt = this.db.prepare('update events set processed = ?, error = ? where id = ?');
    const clear = this.db.prepare('delete from kv where key = ?');
    for (const id of ids) {
      stmt.run(error ? 2 : 1, error ?? null, id);
      clear.run(`event_retry:${id}`);
    }
  }

  /** Counts a failed attempt to apply what a pending event said; returns the failures so far. */
  noteEventFailure(id: string): number {
    const key = `event_retry:${id}`;
    const n = Number(this.kvGet(key) ?? '0') + 1;
    this.kvSet(key, String(n));
    return n;
  }

  /** When the session's latest turn ended (any tool's hook config). */
  lastTurnEndTs(session: string): string | null {
    const row = this.db.prepare("select max(ts) as ts from events where session = ? and kind = 'turn_end'").get(session) as Row | undefined;
    return row ? asString(row.ts) : null;
  }

  /** The assistant's last message before `ts` in the same session (context for a correction). */
  lastAssistantBefore(session: string | null, ts: string): string | null {
    if (!session) return null;
    const row = this.db
      .prepare(
        `select last_assistant from events
         where session = ? and kind = 'turn_end' and ts <= ? and last_assistant is not null
         order by ts desc limit 1`,
      )
      .get(session, ts) as Row | undefined;
    return row ? asString(row.last_assistant) : null;
  }

  /**
   * The latest session in this worktree before `beforeTs` (any tool, other than `excludeSession`):
   * its last requests and the assistant's last reply. Local data only; used for session handoff.
   */
  previousSession(beforeTs: string, sinceTs: string, excludeSession: string | null): PreviousSession | null {
    const last = this.db
      .prepare(
        `select tool, session, ts from events
         where kind in ('prompt', 'turn_end') and tool not in ('cli', 'file') and ts < ? and ts >= ?
           and (? is null or session is null or session != ?)
         order by ts desc limit 1`,
      )
      .get(beforeTs, sinceTs, excludeSession, excludeSession) as Row | undefined;
    if (!last) return null;
    const tool = String(last.tool);
    const session = asString(last.session);
    const endedAt = String(last.ts);
    // Without a session id, "the session" is that tool's activity in the two hours before it ended.
    const where = session ? 'session = ?' : "session is null and tool = ? and ts >= ?";
    const args: (string | number)[] = session ? [session] : [tool, new Date(Date.parse(endedAt) - 2 * 3_600_000).toISOString()];
    const prompts = (
      this.db
        .prepare(`select prompt from events where ${where} and kind = 'prompt' and prompt is not null and ts <= ? order by ts desc limit 3`)
        .all(...args, endedAt) as Row[]
    )
      .map((r) => String(r.prompt))
      .reverse();
    const reply = this.db
      .prepare(`select last_assistant from events where ${where} and kind = 'turn_end' and last_assistant is not null and ts <= ? order by ts desc limit 1`)
      .get(...args, endedAt) as Row | undefined;
    if (prompts.length === 0 && !reply) return null;
    const span = this.db
      .prepare(`select min(ts) as started, sum(case when kind = 'prompt' and prompt is not null then 1 else 0 end) as n from events where ${where} and ts <= ?`)
      .get(...args, endedAt) as Row | undefined;
    const opening = (
      this.db
        .prepare(`select prompt from events where ${where} and kind = 'prompt' and prompt is not null and ts <= ? order by ts asc limit 3`)
        .all(...args, endedAt) as Row[]
    ).map((r) => String(r.prompt));
    const transcript = this.db
      .prepare(`select transcript_path from events where ${where} and transcript_path is not null and ts <= ? order by ts desc limit 1`)
      .get(...args, endedAt) as Row | undefined;
    return {
      tool,
      session,
      endedAt,
      startedAt: asString(span?.started) ?? endedAt,
      prompts,
      openingPrompts: opening,
      promptCount: Number(span?.n ?? prompts.length),
      lastAssistant: reply ? asString(reply.last_assistant) : null,
      transcriptPath: transcript ? asString(transcript.transcript_path) : null,
    };
  }

  /**
   * Requests and the assistant's reply that followed each, since `sinceIso`, oldest first (hook
   * events of this worktree; for `devctx recall`). Unprocessed or not, every captured turn counts.
   */
  turnsSince(sinceIso: string, limit = 5000): { ts: string; tool: string; session: string | null; prompt: string; reply: string | null }[] {
    const rows = this.db
      .prepare(
        `select ts, tool, session, kind, prompt, last_assistant from events
         where kind in ('prompt', 'turn_end') and tool not in ('cli', 'file') and ts >= ?
         order by ts desc limit ?`,
      )
      .all(sinceIso, limit) as Row[];
    rows.reverse(); // the newest `limit` events, read oldest first
    const turns: { ts: string; tool: string; session: string | null; prompt: string; reply: string | null }[] = [];
    const open = new Map<string, number>();
    for (const r of rows) {
      const session = asString(r.session);
      const key = session ?? `-${String(r.tool)}`;
      if (r.kind === 'prompt' && typeof r.prompt === 'string' && r.prompt.trim()) {
        open.set(key, turns.length);
        turns.push({ ts: String(r.ts), tool: String(r.tool), session, prompt: r.prompt, reply: null });
      } else if (r.kind === 'turn_end' && typeof r.last_assistant === 'string') {
        const at = open.get(key);
        const turn = at === undefined ? undefined : turns[at];
        if (turn && turn.reply === null) turn.reply = r.last_assistant;
      }
    }
    return turns;
  }

  // ---- verification cases (failed check -> passed again) ------------------------------------

  /** Sessions with turn ends after `afterTs` whose transcript is known: what case scanning reads. */
  sessionsEndedAfter(afterTs: string): { session: string; tool: string; transcript: string; lastEnd: string }[] {
    const rows = this.db
      .prepare(
        `select session, tool, max(ts) as last_end from events
         where kind = 'turn_end' and session is not null and tool not in ('cli', 'file') and ts > ?
         group by session, tool order by last_end asc limit 200`,
      )
      .all(afterTs) as Row[];
    const out: { session: string; tool: string; transcript: string; lastEnd: string }[] = [];
    for (const r of rows) {
      const t = this.db
        .prepare("select transcript_path from events where session = ? and transcript_path is not null order by ts desc limit 1")
        .get(String(r.session)) as Row | undefined;
      const transcript = t ? asString(t.transcript_path) : null;
      if (transcript) out.push({ session: String(r.session), tool: String(r.tool), transcript, lastEnd: String(r.last_end) });
    }
    return out;
  }

  /** Any turn end with a transcript after `afterTs` (cheap check for the hooks). */
  hasTurnsToScan(afterTs: string): boolean {
    return Boolean(
      this.db.prepare("select 1 from events where kind = 'turn_end' and session is not null and transcript_path is not null and ts > ? limit 1").get(afterTs),
    );
  }

  /** The request of the turn running at `ts` in a session, and the reply that ended it. */
  turnAt(session: string, ts: string): { prompt: string | null; reply: string | null } {
    const p = this.db
      .prepare("select prompt from events where session = ? and kind = 'prompt' and prompt is not null and ts <= ? order by ts desc limit 1")
      .get(session, ts) as Row | undefined;
    const r = this.db
      .prepare("select last_assistant from events where session = ? and kind = 'turn_end' and last_assistant is not null and ts >= ? order by ts asc limit 1")
      .get(session, ts) as Row | undefined;
    return { prompt: p ? asString(p.prompt) : null, reply: r ? asString(r.last_assistant) : null };
  }

  /**
   * The case a run of `command` in `session` continues: a failed one, or one marked unresolved
   * while the session was quiet (a session left open overnight goes on with the same id).
   */
  openCase(session: string, command: string): CaseRow | null {
    const r = this.db
      .prepare("select * from cases where session = ? and command = ? and state in ('failed', 'unresolved') order by failed_at desc limit 1")
      .get(session, command) as Row | undefined;
    return r ? caseRow(r) : null;
  }

  reopenCase(id: string): void {
    this.db.prepare("update cases set state = 'failed' where id = ? and state = 'unresolved'").run(id);
  }

  insertCase(c: Omit<CaseRow, 'id' | 'state' | 'resolvedAt' | 'fixPrompt' | 'fixReply'>): string {
    const id = ulid();
    this.db
      .prepare('insert into cases(id, session, tool, command, state, inferred, signature, error, failed_at, fail_prompt) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.session, c.tool, c.command, 'failed', c.inferred ? 1 : 0, c.signature, c.error ? redactSecrets(c.error) : null, c.failedAt, c.failPrompt ? redactSecrets(c.failPrompt) : null);
    return id;
  }

  /** A later failure of an open case: keep its latest error (that is the one that got fixed). */
  updateCaseError(id: string, signature: string | null, error: string | null, inferred: boolean): void {
    this.db
      .prepare('update cases set signature = coalesce(?, signature), error = coalesce(?, error), inferred = max(inferred, ?) where id = ?')
      .run(signature, error ? redactSecrets(error) : null, inferred ? 1 : 0, id);
  }

  resolveCase(id: string, at: string, fix: { prompt: string | null; reply: string | null }, inferred: boolean): void {
    this.db
      .prepare("update cases set state = 'resolved', resolved_at = ?, fix_prompt = ?, fix_reply = ?, inferred = max(inferred, ?) where id = ?")
      .run(at, fix.prompt ? redactSecrets(fix.prompt) : null, fix.reply ? redactSecrets(fix.reply.slice(0, 4000)) : null, inferred ? 1 : 0, id);
  }

  /** Open cases of sessions with no event since `beforeIso` stay unresolved. */
  closeStaleCases(beforeIso: string): number {
    const res = this.db
      .prepare(
        `update cases set state = 'unresolved'
         where state = 'failed' and not exists (select 1 from events e where e.session = cases.session and e.ts >= ?)`,
      )
      .run(beforeIso);
    return Number(res.changes ?? 0);
  }

  casesSince(sinceIso: string, limit = 2000): CaseRow[] {
    return (this.db.prepare('select * from cases where failed_at >= ? order by failed_at desc limit ?').all(sinceIso, limit) as Row[]).map(caseRow);
  }

  /** Error identifiers seen since `sinceIso` outside `excludeSession`, newest case per identifier (resolved first). */
  caseSignatures(sinceIso: string, excludeSession: string | null): CaseRow[] {
    const rows = this.db
      .prepare(
        `select * from cases where signature is not null and failed_at >= ? and (? is null or session != ?)
         order by case state when 'resolved' then 0 else 1 end, failed_at desc limit 500`,
      )
      .all(sinceIso, excludeSession, excludeSession) as Row[];
    const seen = new Set<string>();
    const out: CaseRow[] = [];
    for (const r of rows) {
      const c = caseRow(r);
      if (c.signature && !seen.has(c.signature)) {
        seen.add(c.signature);
        out.push(c);
      }
    }
    return out;
  }

  pruneCases(beforeIso: string): number {
    return Number(this.db.prepare('delete from cases where failed_at < ?').run(beforeIso).changes ?? 0);
  }

  recordOp(op: { eventId: string | null; relation: string; itemId: string | null; targetId: string | null; detail?: string }): void {
    this.db
      .prepare('insert into ops(id, ts, event_id, relation, item_id, target_id, detail) values(?, ?, ?, ?, ?, ?, ?)')
      .run(ulid(), new Date().toISOString(), op.eventId, op.relation, op.itemId, op.targetId, op.detail ?? null);
  }

  recentOps(limit: number): Row[] {
    return this.db.prepare('select * from ops order by ts desc, id desc limit ?').all(limit) as Row[];
  }

  /** What a hook added to the tool's context (local audit log, like OpenMemory's access log). */
  recordInjection(rec: InjectionRecord): void {
    this.db
      .prepare('insert into injections(id, ts, tool, session, kind, ids, tokens, handoff) values(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ulid(), new Date().toISOString(), rec.tool, rec.session, rec.kind, JSON.stringify(rec.ids), Math.round(rec.tokens), rec.handoff ? 1 : 0);
    if (Math.random() < 0.01) this.db.prepare('delete from injections where ts < ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString());
  }

  /** Prompt injections since `sinceIso`: how often context was added, its size, and how often each item was sent. */
  injectionSummary(sinceIso: string): { prompts: number; withContext: number; avgTokens: number; handoffs: number; perItem: Map<string, number> } {
    const rows = this.db.prepare("select ids, tokens, handoff from injections where ts >= ? and kind = 'prompt'").all(sinceIso) as Row[];
    const perItem = new Map<string, number>();
    let withContext = 0;
    let tokens = 0;
    let handoffs = 0;
    for (const r of rows) {
      const t = Number(r.tokens ?? 0);
      if (t > 0) {
        withContext++;
        tokens += t;
      }
      if (r.handoff === 1) handoffs++;
      try {
        for (const id of JSON.parse(String(r.ids ?? '[]')) as string[]) perItem.set(id, (perItem.get(id) ?? 0) + 1);
      } catch {
        // ignore malformed rows
      }
    }
    return { prompts: rows.length, withContext, avgTokens: withContext > 0 ? Math.round(tokens / withContext) : 0, handoffs, perItem };
  }

  recordViolation(itemId: string, eventId: string | null): void {
    this.db
      .prepare('insert into violations(id, ts, item_id, event_id) values(?, ?, ?, ?)')
      .run(ulid(), new Date().toISOString(), itemId, eventId);
  }

  recordLlmCall(call: { provider: string; model: string; task: string; ok: boolean; ms: number; costUsd?: number | null; error?: string | null }): void {
    this.db
      .prepare('insert into llm_calls(id, ts, provider, model, task, ok, ms, cost_usd, error) values(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        ulid(),
        new Date().toISOString(),
        call.provider,
        call.model,
        call.task,
        call.ok ? 1 : 0,
        Math.round(call.ms),
        call.costUsd ?? null,
        call.error ? call.error.slice(0, 500) : null,
      );
  }

  llmCallsSince(isoTs: string, opts: { tasks?: readonly string[]; excludeTasks?: readonly string[] } = {}): number {
    const list = opts.tasks ?? opts.excludeTasks ?? [];
    const marks = list.map(() => '?').join(', ');
    const where = list.length === 0 ? '' : opts.tasks ? ` and task in (${marks})` : ` and task not in (${marks})`;
    const row = this.db.prepare(`select count(*) as n from llm_calls where ts >= ?${where}`).get(isoTs, ...list) as Row | undefined;
    return Number(row?.n ?? 0);
  }

  // ---- prompt history ----

  private toTurn(r: Row): HistoryTurn {
    return {
      id: String(r.id),
      tool: String(r.tool),
      session: asString(r.session),
      skey: String(r.skey),
      model: asString(r.model),
      branch: asString(r.branch),
      promptTs: String(r.prompt_ts),
      prompt: String(r.prompt ?? ''),
      beforeTree: asString(r.before_tree),
      endTs: asString(r.end_ts),
      afterTree: asString(r.after_tree),
      lastAssistant: asString(r.last_assistant),
      transcriptPath: asString(r.transcript_path),
      state: String(r.state) as HistoryTurn['state'],
      file: asString(r.file),
      error: asString(r.error),
    };
  }

  openHistoryTurn(t: Pick<HistoryTurn, 'tool' | 'session' | 'skey' | 'model' | 'branch' | 'promptTs' | 'prompt' | 'beforeTree' | 'transcriptPath'>): string {
    const id = ulid();
    this.db
      .prepare(
        `insert into history_turns(id, tool, session, skey, model, branch, prompt_ts, prompt, before_tree, transcript_path, state)
         values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(id, t.tool, t.session, t.skey, t.model, t.branch, t.promptTs, redactSecrets(t.prompt), t.beforeTree, t.transcriptPath);
    return id;
  }

  /** The turn of this session still waiting for its end. */
  openHistoryTurnOf(skey: string): HistoryTurn | null {
    const row = this.db.prepare("select * from history_turns where skey = ? and state = 'open' order by prompt_ts desc, id desc limit 1").get(skey) as Row | undefined;
    return row ? this.toTurn(row) : null;
  }

  closeHistoryTurn(id: string, end: { endTs: string; afterTree: string | null; lastAssistant: string | null; transcriptPath: string | null }): void {
    this.db
      .prepare(
        `update history_turns set state = 'ready', end_ts = ?, after_tree = ?,
           last_assistant = coalesce(?, last_assistant), transcript_path = coalesce(?, transcript_path)
         where id = ? and state = 'open'`,
      )
      .run(end.endTs, end.afterTree, end.lastAssistant === null ? null : redactSecrets(end.lastAssistant), end.transcriptPath, id);
  }

  readyHistoryTurns(limit: number): HistoryTurn[] {
    const rows = this.db.prepare("select * from history_turns where state = 'ready' order by prompt_ts, id limit ?").all(limit) as Row[];
    return rows.map((r) => this.toTurn(r));
  }

  hasReadyHistory(): boolean {
    return this.db.prepare("select 1 as x from history_turns where state = 'ready' limit 1").get() !== undefined;
  }

  finishHistoryTurn(id: string, file: string, error: string | null = null): void {
    this.db.prepare("update history_turns set state = 'done', file = ?, error = ? where id = ?").run(file, error, id);
  }

  /** File the latest written turn of this session went to. */
  latestHistoryFile(skey: string): string | null {
    const row = this.db
      .prepare("select file from history_turns where skey = ? and state = 'done' and file is not null order by prompt_ts desc, id desc limit 1")
      .get(skey) as Row | undefined;
    return row ? asString(row.file) : null;
  }

  /** When the session's first recorded prompt arrived. */
  historySessionStart(skey: string): string | null {
    const row = this.db.prepare('select min(prompt_ts) as ts from history_turns where skey = ?').get(skey) as Row | undefined;
    return row ? asString(row.ts) : null;
  }

  /**
   * Turns that never saw an end (the tool crashed, or a session without an id crossed midnight):
   * written without their changes instead of waiting forever.
   */
  expireOpenHistoryTurns(beforeIso: string): number {
    const res = this.db.prepare("update history_turns set state = 'ready' where state = 'open' and prompt_ts < ?").run(beforeIso);
    return Number(res.changes ?? 0);
  }

  /** Position of a turn in its session (1-based, by prompt time). */
  historyTurnNumber(skey: string, promptTs: string, id: string): number {
    const row = this.db
      .prepare('select count(*) as n from history_turns where skey = ? and (prompt_ts < ? or (prompt_ts = ? and id <= ?))')
      .get(skey, promptTs, promptTs, id) as Row | undefined;
    return Number(row?.n ?? 1);
  }

  historyCounts(): { open: number; ready: number; done: number; sessions: number } {
    const row = this.db
      .prepare(
        `select coalesce(sum(state = 'open'), 0) as open, coalesce(sum(state = 'ready'), 0) as ready,
                coalesce(sum(state = 'done'), 0) as done, count(distinct case when state = 'done' then file end) as sessions
         from history_turns`,
      )
      .get() as Row | undefined;
    return { open: Number(row?.open ?? 0), ready: Number(row?.ready ?? 0), done: Number(row?.done ?? 0), sessions: Number(row?.sessions ?? 0) };
  }

  recentHistoryTurns(limit: number): HistoryTurn[] {
    const rows = this.db.prepare('select * from history_turns order by prompt_ts desc, id desc limit ?').all(limit) as Row[];
    return rows.map((r) => this.toTurn(r));
  }

  /** Written entries live in `.devctx/history/`; their rows are only bookkeeping. */
  /** Drops history turns not written yet (prompt text included). Returns how many. */
  discardPendingHistory(): number {
    const res = this.db.prepare("delete from history_turns where state in ('open', 'ready')").run();
    return Number(res.changes ?? 0);
  }

  /**
   * Erases the prompt and reply text this PC keeps: in hook events (also ones not analyzed yet;
   * their timestamps stay for the health checks), history turns not written yet, the text kept
   * with written turns, restatement quotes and session hand-off state. Decision files, counters
   * and proposals stay.
   */
  purgePromptText(): { events: number; turns: number } {
    const events = Number(
      this.db.prepare('update events set prompt = null, last_assistant = null, transcript_path = null where prompt is not null or last_assistant is not null').run().changes ?? 0,
    );
    const turns = this.discardPendingHistory();
    this.db.prepare("update history_turns set prompt = '', last_assistant = null where state = 'done'").run();
    this.db.prepare("update item_stats set evidence = '[]'").run();
    this.db.prepare("delete from kv where key like 'sess:%'").run();
    // Verification cases hold error output and the requests around it.
    this.db.prepare('delete from cases').run();
    return { events, turns };
  }

  pruneHistoryTurns(beforeIso: string): number {
    const res = this.db.prepare("delete from history_turns where state = 'done' and prompt_ts < ?").run(beforeIso);
    return Number(res.changes ?? 0);
  }

  llmUsageSummary(sinceIso: string): Row[] {
    return this.db
      .prepare(
        `select provider, model, task, count(*) as calls, sum(ok) as ok, round(avg(ms)) as avg_ms, sum(cost_usd) as cost_usd
         from llm_calls where ts >= ? group by provider, model, task order by calls desc`,
      )
      .all(sinceIso) as Row[];
  }

  // ---- local counters for committed rules --------------------------------------------------

  itemStats(): Map<string, ItemStats> {
    const out = new Map<string, ItemStats>();
    for (const r of this.db.prepare('select * from item_stats').all() as Row[]) {
      let evidence: ItemStats['evidence'] = [];
      try {
        evidence = JSON.parse(String(r.evidence ?? '[]')) as ItemStats['evidence'];
      } catch {
        evidence = [];
      }
      out.set(String(r.item_id), { reinforced: Number(r.reinforced ?? 0), violations: Number(r.violations ?? 0), lastSeen: asString(r.last_seen), evidence });
    }
    return out;
  }

  bumpStats(itemId: string, delta: { reinforced?: number; violations?: number; quote?: string | null; at?: string }): void {
    const current = this.itemStats().get(itemId) ?? { reinforced: 0, violations: 0, lastSeen: null, evidence: [] };
    const at = delta.at ?? new Date().toISOString();
    const evidence = [...current.evidence];
    if (delta.quote && !evidence.some((e) => e.quote === delta.quote)) evidence.push({ quote: delta.quote, at: at.slice(0, 10) });
    this.db
      .prepare(
        `insert into item_stats(item_id, reinforced, violations, last_seen, evidence) values(?, ?, ?, ?, ?)
         on conflict(item_id) do update set reinforced = excluded.reinforced, violations = excluded.violations,
           last_seen = excluded.last_seen, evidence = excluded.evidence`,
      )
      .run(itemId, current.reinforced + (delta.reinforced ?? 0), current.violations + (delta.violations ?? 0), at, JSON.stringify(evidence.slice(-5)));
  }

  // ---- proposals: unconfirmed rules stay on this PC until someone confirms them -------------

  proposals(): ProposalRow[] {
    return (this.db.prepare('select * from proposals order by created, id').all() as Row[]).map((r) => ({
      id: String(r.id),
      status: r.status === 'archived' ? 'archived' : 'proposed',
      created: String(r.created),
      updated: String(r.updated),
      item: String(r.item),
    }));
  }

  putProposal(id: string, item: string, status: 'proposed' | 'archived' = 'proposed'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into proposals(id, status, created, updated, item) values(?, ?, ?, ?, ?)
         on conflict(id) do update set status = excluded.status, updated = excluded.updated, item = excluded.item`,
      )
      .run(id, status, now, now, item);
  }

  deleteProposal(id: string): void {
    this.db.prepare('delete from proposals where id = ?').run(id);
  }

  /**
   * Proposals nobody confirmed within the TTL are archived, not deleted: if the same rule comes up
   * months later it becomes active right away instead of starting over.
   */
  archiveProposals(beforeIso: string, keep: ReadonlySet<string>): string[] {
    const ids = (this.db.prepare("select id from proposals where status = 'proposed' and created < ?").all(beforeIso) as Row[])
      .map((r) => String(r.id))
      .filter((id) => !keep.has(id));
    const stmt = this.db.prepare("update proposals set status = 'archived', updated = ? where id = ?");
    const now = new Date().toISOString();
    for (const id of ids) stmt.run(now, id);
    return ids;
  }

  // ---- parse cache for knowledge files -------------------------------------------------------

  kfiles(): Map<string, KfileRow> {
    const out = new Map<string, KfileRow>();
    for (const r of this.db.prepare('select * from kfiles').all() as Row[]) {
      out.set(String(r.path), {
        path: String(r.path),
        mtime: Number(r.mtime),
        ctime: Number(r.ctime),
        size: Number(r.size),
        item: asString(r.item),
        error: asString(r.error),
      });
    }
    return out;
  }

  putKfile(row: KfileRow): void {
    this.db
      .prepare(
        `insert into kfiles(path, mtime, ctime, size, item, error) values(?, ?, ?, ?, ?, ?)
         on conflict(path) do update set mtime = excluded.mtime, ctime = excluded.ctime, size = excluded.size, item = excluded.item, error = excluded.error`,
      )
      .run(row.path, row.mtime, row.ctime, row.size, row.item, row.error);
  }

  deleteKfile(path: string): void {
    this.db.prepare('delete from kfiles where path = ?').run(path);
  }

  clearKfiles(): void {
    this.db.exec('delete from kfiles');
  }

  // ---- housekeeping ----------------------------------------------------------------------------

  /**
   * Deletes captured events that were processed before `beforeIso`. Unprocessed events are kept
   * however old they are; decisions live in `.devctx/knowledge/`, not here.
   */
  pruneEvents(beforeIso: string): number {
    const res = this.db.prepare('delete from events where processed != 0 and ts < ?').run(beforeIso);
    return Number(res.changes ?? 0);
  }

  /** Time of the latest event an AI tool's hook delivered (null: hooks never ran here). */
  lastHookEventTs(): string | null {
    const row = this.db.prepare("select max(ts) as ts from events where tool not in ('cli', 'file')").get() as Row | undefined;
    return row ? asString(row.ts) : null;
  }

  kvGet(key: string): string | null {
    const row = this.db.prepare('select value from kv where key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare('insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
  }

  kvList(prefix: string): { key: string; value: string }[] {
    const rows = this.db
      .prepare("select key, value from kv where substr(key, 1, ?) = ? order by key")
      .all(prefix.length, prefix) as Row[];
    return rows.map((r) => ({ key: String(r.key), value: String(r.value) }));
  }

  kvDelete(key: string): void {
    this.db.prepare('delete from kv where key = ?').run(key);
  }
}
