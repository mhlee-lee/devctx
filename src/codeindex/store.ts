import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FACTS_VERSION, type LangId } from './facts.ts';

/**
 * `.devctx/local/code.sqlite`: per-file facts plus a little project metadata. Derived data only,
 * git-ignored, and safe to delete (the next sync rebuilds it).
 */
const SCHEMA = `
create table if not exists files(
  path text primary key,
  lang text not null,
  size integer not null,
  mtime real not null,
  hash text not null,
  facts text,
  error text
);
create table if not exists meta(key text primary key, value text not null);
create table if not exists symbols(
  path text not null,
  name text not null,
  lname text not null,
  qname text not null,
  kind text not null,
  line integer not null
);
create index if not exists symbols_lname on symbols(lname);
create index if not exists symbols_path on symbols(path);
create table if not exists snapshot(id integer primary key check (id = 1), generation text not null, data text not null);
`;

export interface SymbolRow {
  path: string;
  name: string;
  qname: string;
  kind: string;
  line: number;
}

export interface FileRow {
  path: string;
  lang: LangId;
  size: number;
  mtime: number;
  hash: string;
  error: string | null;
}

type Row = Record<string, unknown>;

export class CodeStore {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(file: string): CodeStore {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('pragma busy_timeout = 5000; pragma journal_mode = wal; pragma synchronous = normal;');
    db.exec(SCHEMA);
    const store = new CodeStore(db);
    // New extractor output: keep rows (for the file list) but force every file to be parsed again.
    if (store.meta('facts_version') !== String(FACTS_VERSION)) {
      db.exec("update files set hash = '', facts = null; delete from symbols;");
      store.setMeta('facts_version', String(FACTS_VERSION));
    }
    return store;
  }

  /** Read-only open for hooks: never creates or migrates (returns null when there is no index). */
  static openExisting(file: string): CodeStore | null {
    if (!fs.existsSync(file)) return null;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      db.exec('pragma busy_timeout = 1000;');
      return new CodeStore(db);
    } catch {
      return null;
    }
  }

  replaceSymbols(file: string, syms: readonly SymbolRow[]): void {
    this.db.prepare('delete from symbols where path = ?').run(file);
    const stmt = this.db.prepare('insert into symbols(path, name, lname, qname, kind, line) values(?, ?, ?, ?, ?, ?)');
    for (const s of syms) stmt.run(file, s.name, s.name.toLowerCase(), s.qname, s.kind, s.line);
  }

  /** Symbols named exactly `name` (case-insensitive), for prompt-time hints. */
  symbolsNamed(name: string, limit: number): SymbolRow[] {
    return (this.db.prepare('select path, name, qname, kind, line from symbols where lname = ? limit ?').all(name.toLowerCase(), limit) as Row[]).map((r) => ({
      path: String(r.path),
      name: String(r.name),
      qname: String(r.qname),
      kind: String(r.kind),
      line: Number(r.line),
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  meta(key: string): string | null {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
  }

  rows(): Map<string, FileRow> {
    const out = new Map<string, FileRow>();
    for (const r of this.db.prepare('select path, lang, size, mtime, hash, error from files').all() as Row[]) {
      out.set(String(r.path), {
        path: String(r.path),
        lang: String(r.lang) as LangId,
        size: Number(r.size),
        mtime: Number(r.mtime),
        hash: String(r.hash),
        error: r.error === null ? null : String(r.error),
      });
    }
    return out;
  }

  upsert(row: FileRow, facts: string | null): void {
    this.db
      .prepare(
        `insert into files(path, lang, size, mtime, hash, facts, error) values(?, ?, ?, ?, ?, ?, ?)
         on conflict(path) do update set lang = excluded.lang, size = excluded.size, mtime = excluded.mtime,
           hash = excluded.hash, facts = excluded.facts, error = excluded.error`,
      )
      .run(row.path, row.lang, row.size, row.mtime, row.hash, facts, row.error);
  }

  touch(file: string, size: number, mtime: number): void {
    this.db.prepare('update files set size = ?, mtime = ? where path = ?').run(size, mtime, file);
  }

  remove(file: string): void {
    this.db.prepare('delete from files where path = ?').run(file);
    this.db.prepare('delete from symbols where path = ?').run(file);
  }

  /** Every parsed file with its encoded facts, in path order (stable graph ids). */
  allFacts(): { path: string; facts: string }[] {
    return (this.db.prepare('select path, facts from files where facts is not null order by path').all() as Row[]).map((r) => ({
      path: String(r.path),
      facts: String(r.facts),
    }));
  }

  /** The resolved-graph cache (see graph.ts `GraphSnapshot`); null before the first build. */
  snapshot(): { generation: string; data: string } | null {
    try {
      const row = this.db.prepare('select generation, data from snapshot where id = 1').get() as Row | undefined;
      return row ? { generation: String(row.generation), data: String(row.data) } : null;
    } catch {
      return null; // an index written before the cache existed (read-only open skips the schema)
    }
  }

  saveSnapshot(generation: string, data: string): void {
    this.db
      .prepare('insert into snapshot(id, generation, data) values(1, ?, ?) on conflict(id) do update set generation = excluded.generation, data = excluded.data')
      .run(generation, data);
  }

  factsOf(file: string): string | null {
    const row = this.db.prepare('select facts from files where path = ?').get(file) as Row | undefined;
    return row && row.facts !== null ? String(row.facts) : null;
  }

  counts(): { files: number; parsed: number; failed: number } {
    const row = this.db
      .prepare('select count(*) as n, sum(facts is not null) as parsed, sum(error is not null) as failed from files')
      .get() as Row | undefined;
    return { files: Number(row?.n ?? 0), parsed: Number(row?.parsed ?? 0), failed: Number(row?.failed ?? 0) };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try {
      const out = fn();
      this.db.exec('commit');
      return out;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }
}
