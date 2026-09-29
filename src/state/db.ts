import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  /** Up to the last 3 requests, oldest first. */
  prompts: string[];
  lastAssistant: string | null;
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
`;

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
        ev.prompt,
        ev.lastAssistant,
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

  countPending(): number {
    const row = this.db.prepare('select count(*) as n from events where processed = 0').get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  markProcessed(ids: readonly string[], error?: string): void {
    const stmt = this.db.prepare('update events set processed = ?, error = ? where id = ?');
    for (const id of ids) stmt.run(error ? 2 : 1, error ?? null, id);
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
    return { tool, session, endedAt, prompts, lastAssistant: reply ? asString(reply.last_assistant) : null };
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

  llmCallsSince(isoTs: string): number {
    const row = this.db.prepare('select count(*) as n from llm_calls where ts >= ?').get(isoTs) as Row | undefined;
    return Number(row?.n ?? 0);
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
