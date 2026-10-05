import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { DevctxConfig } from '../config.ts';
import { git } from '../util/git.ts';
import { cliEntry } from '../util/paths.ts';
import { codeDbPath, hasGrammar, indexingInProgress, listRepoFiles } from './files.ts';
import { detectLanguages, languageById, type DetectedLanguage } from './languages.ts';
import { CodeStore } from './store.ts';
import type { SyncResult } from './sync.ts';

// Hooks import this module on every event: the parser stack (sync.ts) loads only when indexing.

export function codeIndexEnabled(cfg: DevctxConfig): boolean {
  return cfg.code_index.enabled;
}

export function gitHead(root: string): string | null {
  const r = git(['rev-parse', 'HEAD'], root, 5_000);
  return r.ok && r.stdout ? r.stdout : null;
}

export interface IndexMeta {
  exists: boolean;
  head: string | null;
  syncedAt: string | null;
  files: number;
  parsed: number;
  failed: number;
  /** Languages whose files the parser had to recover from syntax errors. */
  syntax: { lang: string; files: number; total: number; examples: string[] }[];
}

export function readIndexMeta(root: string): IndexMeta {
  const store = CodeStore.openExisting(codeDbPath(root));
  if (!store) return { exists: false, head: null, syncedAt: null, files: 0, parsed: 0, failed: 0, syntax: [] };
  try {
    const c = store.counts();
    return { exists: true, head: store.meta('head') || null, syncedAt: store.meta('synced_at'), ...c, syntax: store.syntaxErrors() };
  } catch {
    return { exists: false, head: null, syncedAt: null, files: 0, parsed: 0, failed: 0, syntax: [] };
  } finally {
    store.close();
  }
}

/**
 * Cheap check for hooks: never indexed, or HEAD moved since the last sync (checkout, pull,
 * rebase). Edits between commits are picked up by the next `devctx code` query.
 */
export function indexNeedsRefresh(root: string, cfg: DevctxConfig): boolean {
  if (!codeIndexEnabled(cfg)) return false;
  if (indexingInProgress(root)) return false;
  const meta = readIndexMeta(root);
  if (!meta.exists || !meta.syncedAt) return true;
  return gitHead(root) !== meta.head;
}

/**
 * Memory one indexing process may reach before a fresh one takes over. Parser memory plateaus
 * (about 600 MB for Kotlin-heavy code, less elsewhere), so normal repositories finish in one pass.
 */
const INDEX_RSS_MB = 1024;
/** Exit code of `devctx code index --pass` when it stopped at the memory cap. */
export const EXIT_MEMORY_CAPPED = 3;

/** One capped pass in this process (`devctx code index --pass`). */
export async function indexPass(root: string, cfg: DevctxConfig): Promise<SyncResult> {
  const { syncIndex } = await import('./sync.ts');
  return syncIndex(root, cfg, { maxRssMb: INDEX_RSS_MB });
}

function runPass(root: string): Promise<number | null> {
  const entry = cliEntry();
  if (!entry) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--inspect')), entry, 'code', 'index', '--pass', '--root', root], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, DEVCTX_WORKER: '1' },
      });
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Full incremental sync (worker, `devctx code index`). Parsing grows WebAssembly memory that is
 * never returned, so a large first index runs as a chain of capped passes in fresh processes.
 */
export async function refreshIndex(root: string, cfg: DevctxConfig): Promise<SyncResult | null> {
  if (!codeIndexEnabled(cfg)) return null;
  const res = await syncAll(root, cfg);
  // Resolve once here (a background process) so queries only replay the cached graph.
  if (res && !res.error) {
    const { buildSnapshot, snapshotFresh } = await import('./load.ts');
    if (!snapshotFresh(root)) buildSnapshot(root);
  }
  return res;
}

async function syncAll(root: string, cfg: DevctxConfig): Promise<SyncResult | null> {
  const started = Date.now();
  const { pendingChanges } = await import('./sync.ts');
  // A few changed files: parse here. Many (first index, branch switch): only in child passes,
  // so this process never holds parser memory while a child builds up its own.
  if (pendingChanges(root, cfg) <= IN_PROCESS_FILES) {
    const res = await indexPass(root, cfg);
    if (!res.memoryCapped) return res;
  }
  for (let round = 0; round < 200; round++) {
    const code = await runPass(root);
    if (code === EXIT_MEMORY_CAPPED) continue;
    const meta = readIndexMeta(root);
    const base: SyncResult = { ran: true, complete: code === 0, files: meta.files, parsed: meta.parsed, removed: 0, failed: meta.failed, changed: true, ms: Date.now() - started, error: null };
    return code === 0 ? base : { ...base, error: `indexing pass failed (exit ${code ?? 'spawn error'})` };
  }
  return null;
}

/** Changed files one process may parse itself before handing the work to child passes. */
const IN_PROCESS_FILES = 150;

export interface CodeStatus {
  enabled: boolean;
  meta: IndexMeta;
  indexing: boolean;
  stale: boolean;
  languages: (DetectedLanguage & { grammar: boolean })[];
  dbBytes: number;
}

export function codeStatus(root: string, cfg: DevctxConfig): CodeStatus {
  const files = listRepoFiles(root);
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(codeDbPath(root)).size;
  } catch {
    dbBytes = 0;
  }
  return {
    enabled: codeIndexEnabled(cfg),
    meta: readIndexMeta(root),
    indexing: indexingInProgress(root),
    stale: indexNeedsRefresh(root, cfg),
    languages: detectLanguages(files).map((l) => {
      const spec = languageById(l.id);
      // Embedded languages (Vue, Svelte, Astro) parse their scripts with the JS/TS grammars.
      return { ...l, grammar: spec?.grammar ? hasGrammar(spec.grammar) : true };
    }),
    dbBytes,
  };
}
