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
`;

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

  recordOp(op: { eventId: string | null; relation: string; itemId: string | null; targetId: string | null; detail?: string }): void {
    this.db
      .prepare('insert into ops(id, ts, event_id, relation, item_id, target_id, detail) values(?, ?, ?, ?, ?, ?, ?)')
      .run(ulid(), new Date().toISOString(), op.eventId, op.relation, op.itemId, op.targetId, op.detail ?? null);
  }

  recentOps(limit: number): Row[] {
    return this.db.prepare('select * from ops order by ts desc limit ?').all(limit) as Row[];
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
