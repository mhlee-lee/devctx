import fs from 'node:fs';
import path from 'node:path';
import { git } from '../util/git.ts';
import { lockHeld, tryLock } from '../util/lock.ts';
import { packageRoot } from '../util/paths.ts';

/**
 * Paths, lock and file listing of the code index. Kept free of parser imports: hooks load this
 * on every prompt and must stay fast.
 */

const FALLBACK_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', '.gradle', '.idea']);
const LOCK_STALE_MS = 15 * 60 * 1000;

export function codeDbPath(root: string): string {
  return path.join(root, '.devctx', 'local', 'code.sqlite');
}

export function codeLockPath(root: string): string {
  return path.join(root, '.devctx', 'local', 'code.lock');
}

/** Repository files: git's view (tracked + untracked, minus ignored); a plain walk outside git. */
export function listRepoFiles(root: string): string[] {
  const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, 30_000);
  if (r.ok) return [...new Set(r.stdout.split('\0').filter(Boolean))];
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!FALLBACK_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) out.push(rel ? `${rel}/${e.name}` : e.name);
      if (out.length > 200_000) return;
    }
  };
  walk(root, '');
  return out;
}

/** One indexer per worktree; a crashed holder (dead pid or older than 15 min) is ignored. */
export function takeIndexLock(root: string): (() => void) | null {
  // Not "someone else holds it": a read-only checkout or sandbox throws. Callers report that.
  const lock = tryLock(codeLockPath(root), LOCK_STALE_MS, { throwOnError: true });
  return lock ? () => lock.release() : null;
}

export function indexingInProgress(root: string): boolean {
  return lockHeld(codeLockPath(root), LOCK_STALE_MS);
}

/** Vendored grammars: `vendor/grammars/<id>.wasm.br`, provenance in `MANIFEST.json`. */
export function grammarDir(): string {
  return path.join(packageRoot(), 'vendor', 'grammars');
}

export function grammarFile(id: string): string {
  return path.join(grammarDir(), `${id}.wasm.br`);
}

export function hasGrammar(id: string): boolean {
  return fs.existsSync(grammarFile(id));
}
