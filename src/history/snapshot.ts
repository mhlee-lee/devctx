import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, worktreeGitDir } from '../util/git.ts';

/**
 * What a turn changed, from git alone so it works the same for every tool: the working tree
 * (tracked and untracked files, minus ignored ones and `.devctx/`) is written as a tree object when
 * the prompt arrives and again when the turn ends, and the two trees are compared. A temporary
 * index copy keeps the developer's real index and staging untouched.
 */

const EXCLUDE = ':(exclude).devctx';

export interface Snapshot {
  tree: string | null;
  branch: string | null;
}

function currentBranch(gitDir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref?.[1]) return ref[1];
    return /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** About 30-60 ms on a typical repository (only changed files are hashed). Null when git fails. */
export function snapshotWorktree(root: string): Snapshot {
  const gitDir = worktreeGitDir(root);
  if (!gitDir) return { tree: null, branch: null };
  const branch = currentBranch(gitDir);
  const tmp = path.join(os.tmpdir(), `devctx-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    try {
      fs.copyFileSync(path.join(gitDir, 'index'), tmp);
    } catch {
      // No index yet (fresh repository): git builds one from scratch.
    }
    const env = { GIT_INDEX_FILE: tmp };
    const add = git(['add', '-A', '--', '.', EXCLUDE], root, 5_000, env);
    if (!add.ok) return { tree: null, branch };
    const tree = git(['write-tree'], root, 5_000, env);
    return { tree: tree.ok && /^[0-9a-f]{40,64}$/.test(tree.stdout) ? tree.stdout : null, branch };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface FileChange {
  path: string;
  /** A added, M modified, D deleted, T type changed. */
  status: string;
  /** Null for binary files. */
  added: number | null;
  removed: number | null;
}

export interface TurnChanges {
  files: FileChange[];
  /** Unified diff, cut to `maxPatchChars`. */
  patch: string;
}

export function turnChanges(root: string, before: string, after: string, maxPatchChars = 8_000): TurnChanges | null {
  if (before === after) return { files: [], patch: '' };
  const status = git(['diff', '--no-renames', '--name-status', before, after], root, 10_000);
  const numstat = git(['diff', '--no-renames', '--numstat', before, after], root, 10_000);
  if (!status.ok || !numstat.ok) return null;
  const counts = new Map<string, [number | null, number | null]>();
  for (const line of numstat.stdout.split('\n')) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(line);
    if (!m?.[3]) continue;
    const n = (v: string | undefined): number | null => (v && /^\d+$/.test(v) ? Number(v) : null);
    counts.set(m[3], [n(m[1]), n(m[2])]);
  }
  const files: FileChange[] = [];
  for (const line of status.stdout.split('\n')) {
    const m = /^([A-Z])\d*\t(.+)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const [added, removed] = counts.get(m[2]) ?? [null, null];
    files.push({ path: m[2], status: m[1], added, removed });
  }
  let patch = '';
  if (files.length > 0) {
    const diff = git(['diff', '--no-renames', '--unified=2', '--no-color', before, after], root, 10_000);
    patch = diff.ok ? diff.stdout.slice(0, maxPatchChars) : '';
  }
  return { files, patch };
}
