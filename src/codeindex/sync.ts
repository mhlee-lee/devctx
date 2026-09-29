import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DevctxConfig } from '../config.ts';
import { git } from '../util/git.ts';
import { matchAny } from '../util/glob.ts';
import { errorMessage } from '../util/log.ts';
import { extractFacts } from './extract/index.ts';
import { encodeFacts, type FileFacts } from './facts.ts';
import { codeDbPath, listRepoFiles, takeIndexLock } from './files.ts';
import { languageOf } from './languages.ts';
import { CodeStore, type FileRow, type SymbolRow } from './store.ts';

export { codeDbPath, indexingInProgress, listRepoFiles } from './files.ts';

/** Never worth indexing even when committed. */
const BUILTIN_SKIP = ['**/node_modules/**', '**/vendor/**', '**/third_party/**', '**/*.min.js', '**/*.bundle.js', '.devctx/**'];
const BATCH = 200;

/** Path aliases and module roots the resolver needs (tsconfig paths, go.mod, package names). */
export interface ProjectInfo {
  tsconfigs: { dir: string; baseUrl: string | null; paths: Record<string, string[]> }[];
  gomods: { dir: string; module: string }[];
  packages: { dir: string; name: string }[];
}

function readJsonc(file: string): Record<string, unknown> | null {
  try {
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tsconfigOptions(root: string, rel: string, depth = 0): { baseUrl: string | null; paths: Record<string, string[]>; dir: string } | null {
  const json = readJsonc(path.join(root, rel));
  if (!json) return null;
  const dir = path.posix.dirname(rel);
  const opts = (json.compilerOptions ?? {}) as Record<string, unknown>;
  const paths = opts.paths && typeof opts.paths === 'object' ? (opts.paths as Record<string, string[]>) : null;
  const baseUrl = typeof opts.baseUrl === 'string' ? path.posix.normalize(path.posix.join(dir, opts.baseUrl)) : null;
  if (paths || baseUrl) return { dir, baseUrl, paths: paths ?? {} };
  // `extends` of a local file (tsconfig.app.json → tsconfig.base.json) is followed once or twice.
  if (typeof json.extends === 'string' && json.extends.startsWith('.') && depth < 2) {
    const parent = path.posix.normalize(path.posix.join(dir, json.extends.endsWith('.json') ? json.extends : `${json.extends}.json`));
    const inherited = tsconfigOptions(root, parent, depth + 1);
    if (inherited) return { ...inherited, dir: inherited.dir };
  }
  return null;
}

export function readProjectInfo(root: string, files: readonly string[]): ProjectInfo {
  const info: ProjectInfo = { tsconfigs: [], gomods: [], packages: [] };
  for (const rel of files) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (matchAny(rel, BUILTIN_SKIP)) continue;
    if (base === 'tsconfig.json' || base === 'jsconfig.json') {
      const opts = tsconfigOptions(root, rel);
      if (opts) info.tsconfigs.push({ dir: path.posix.dirname(rel), baseUrl: opts.baseUrl, paths: opts.paths });
    } else if (base === 'go.mod') {
      try {
        const m = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(root, rel), 'utf8'));
        if (m?.[1]) info.gomods.push({ dir: path.posix.dirname(rel), module: m[1] });
      } catch {
        // unreadable go.mod
      }
    } else if (base === 'package.json') {
      const json = readJsonc(path.join(root, rel));
      if (json && typeof json.name === 'string') info.packages.push({ dir: path.posix.dirname(rel), name: json.name });
    }
  }
  return info;
}

type Wanted = Map<string, NonNullable<ReturnType<typeof languageOf>>>;

function wantedFiles(root: string, cfg: DevctxConfig): { all: string[]; wanted: Wanted } {
  const all = listRepoFiles(root);
  const skip = [...BUILTIN_SKIP, ...cfg.code_index.exclude];
  const wanted: Wanted = new Map();
  for (const rel of all) {
    const lang = languageOf(rel);
    if (lang && !matchAny(rel, skip)) wanted.set(rel, lang);
  }
  return { all, wanted };
}

/**
 * Files a sync would read (new, removed, or size/mtime changed) plus project-file changes, from
 * `stat` alone: no parsing, no writes. Code commands and the index pass call this to decide
 * whether to parse in-process or leave the work to a separate index process.
 */
export function pendingChanges(root: string, cfg: DevctxConfig): number {
  const store = CodeStore.openExisting(codeDbPath(root));
  if (!store) return Number.MAX_SAFE_INTEGER;
  try {
    const { all, wanted } = wantedFiles(root, cfg);
    const rows = store.rows();
    let n = 0;
    for (const rel of rows.keys()) if (!wanted.has(rel)) n++;
    for (const rel of wanted.keys()) {
      const prev = rows.get(rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(root, rel));
      } catch {
        continue;
      }
      if (!prev || !prev.hash || prev.size !== st.size || prev.mtime !== st.mtimeMs) n++;
    }
    if (store.meta('project') !== JSON.stringify(readProjectInfo(root, all))) n++;
    return n;
  } finally {
    store.close();
  }
}

/** Name index rows (qualified by enclosing types) so hooks can look names up without the graph. */
function symbolRows(rel: string, facts: FileFacts): SymbolRow[] {
  const qname = (i: number): string => {
    const parts: string[] = [];
    for (let s = facts.syms[i]; s; s = s.parent >= 0 ? facts.syms[s.parent] : undefined) parts.unshift(s.name);
    return parts.join('.');
  };
  return facts.syms.map((s, i) => ({ path: rel, name: s.name, qname: s.owner ? `${s.owner}.${s.name}` : qname(i), kind: s.kind, line: s.line }));
}

export interface SyncResult {
  ran: boolean;
  /** False when the time budget ran out before every file was checked. */
  complete: boolean;
  /** Stopped at `maxRssMb`: WebAssembly memory only grows, so another process must continue. */
  memoryCapped?: boolean;
  /** Source files considered (after filters). */
  files: number;
  parsed: number;
  removed: number;
  failed: number;
  /** True when anything in the store changed (callers rebuild their graph). */
  changed: boolean;
  ms: number;
  error: string | null;
}

export interface SyncOptions {
  /** Stop parsing after this long; the rest is picked up by the next sync. */
  budgetMs?: number;
  /** Stop parsing once the process uses this much memory (a fresh process continues). */
  maxRssMb?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Brings `.devctx/local/code.sqlite` up to date with the working tree: only files whose size or
 * mtime changed are read, and only files whose content hash changed are parsed again.
 */
export async function syncIndex(root: string, cfg: DevctxConfig, opts: SyncOptions = {}): Promise<SyncResult> {
  const started = Date.now();
  const result: SyncResult = { ran: false, complete: false, files: 0, parsed: 0, removed: 0, failed: 0, changed: false, ms: 0, error: null };
  const release = takeIndexLock(root);
  if (!release) return { ...result, error: 'another devctx process is indexing' };
  const store = CodeStore.open(codeDbPath(root));
  try {
    result.ran = true;
    const { all, wanted } = wantedFiles(root, cfg);
    const maxBytes = cfg.code_index.max_file_kb * 1024;
    result.files = wanted.size;

    const projectJson = JSON.stringify(readProjectInfo(root, all));
    if (store.meta('project') !== projectJson) {
      store.setMeta('project', projectJson);
      result.changed = true;
    }

    const rows = store.rows();
    for (const rel of rows.keys()) {
      if (!wanted.has(rel)) {
        store.remove(rel);
        result.removed++;
      }
    }

    const pending: { row: FileRow; facts: string | null; syms?: SymbolRow[] }[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      store.transaction(() => {
        for (const p of pending) {
          store.upsert(p.row, p.facts);
          store.replaceSymbols(p.row.path, p.syms ?? []);
        }
      });
      pending.length = 0;
    };

    let done = 0;
    let complete = true;
    for (const [rel, spec] of wanted) {
      done++;
      if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs) {
        complete = false;
        break;
      }
      if (opts.maxRssMb && result.parsed > 0 && process.memoryUsage.rss() > opts.maxRssMb * 1_048_576) {
        complete = false;
        result.memoryCapped = true;
        break;
      }
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue; // deleted but still in the git index
      }
      if (!st.isFile()) continue;
      const prev = rows.get(rel);
      if (prev && prev.hash && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
      const lang = spec.id;
      if (st.size > maxBytes) {
        if (!prev || prev.error === null) {
          pending.push({ row: { path: rel, lang, size: st.size, mtime: st.mtimeMs, hash: 'skipped', error: `larger than ${cfg.code_index.max_file_kb} KB` }, facts: null });
        }
        continue;
      }
      let src: string;
      try {
        src = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const hash = crypto.createHash('sha1').update(src).digest('hex');
      if (prev && prev.hash === hash && prev.error === null) {
        store.touch(rel, st.size, st.mtimeMs);
        continue;
      }
      try {
        const facts = await extractFacts(lang, src, rel);
        pending.push({ row: { path: rel, lang, size: st.size, mtime: st.mtimeMs, hash, error: null }, facts: encodeFacts(facts), syms: symbolRows(rel, facts) });
        result.parsed++;
      } catch (error) {
        pending.push({ row: { path: rel, lang, size: st.size, mtime: st.mtimeMs, hash, error: errorMessage(error).slice(0, 200) }, facts: null });
        result.failed++;
      }
      if (pending.length >= BATCH) {
        flush();
        opts.onProgress?.(done, wanted.size);
      }
    }
    flush();
    result.complete = complete;
    if (result.parsed > 0 || result.removed > 0 || result.failed > 0) result.changed = true;
    if (result.changed) store.setMeta('generation', String(Number(store.meta('generation') ?? '0') + 1));
    store.setMeta('synced_at', new Date().toISOString());
    const head = git(['rev-parse', 'HEAD'], root, 5_000);
    store.setMeta('head', head.ok ? head.stdout : '');
    return { ...result, ms: Date.now() - started };
  } catch (error) {
    return { ...result, ms: Date.now() - started, error: errorMessage(error) };
  } finally {
    store.close();
    release();
  }
}
