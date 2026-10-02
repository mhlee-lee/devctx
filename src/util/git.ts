import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string, timeoutMs = 10_000, env: Record<string, string> = {}): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024, // `ls-files` of a large monorepo is several MB
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

export function gitToplevel(cwd: string): string | null {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok && r.stdout ? path.resolve(r.stdout) : null;
}

export function gitUserEmail(cwd: string): string | null {
  const r = git(['config', 'user.email'], cwd);
  return r.ok && r.stdout ? r.stdout : null;
}

export function gitUserName(cwd: string): string | null {
  const r = git(['config', 'user.name'], cwd);
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * Git directory of the worktree at `root` (`.git`, or what a worktree's `.git` file points at),
 * found without starting git: hooks call this on every prompt.
 */
export function worktreeGitDir(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    return m?.[1] ? path.resolve(root, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** The git directory all worktrees of a repository share (stable identity of the repository). */
export function commonGitDir(root: string): string | null {
  const dir = worktreeGitDir(root);
  if (!dir) return null;
  try {
    const common = path.join(dir, 'commondir');
    const resolved = fs.existsSync(common) ? path.resolve(dir, fs.readFileSync(common, 'utf8').trim()) : dir;
    return fs.realpathSync(resolved);
  } catch {
    return dir;
  }
}

/** Hooks directory, honoring core.hooksPath. */
export function gitHooksDir(cwd: string): string | null {
  const r = git(['rev-parse', '--git-path', 'hooks'], cwd);
  return r.ok && r.stdout ? path.resolve(cwd, r.stdout) : null;
}

export function gitBranch(cwd: string): string | null {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.ok && r.stdout ? r.stdout : null;
}

export function gitStage(cwd: string, paths: string[]): GitResult | null {
  if (paths.length === 0) return null;
  return git(['add', '--all', '--', ...paths], cwd);
}

/** Commits only the given paths, leaving any other staged work untouched. */
export function gitCommitPaths(cwd: string, paths: string[], message: string): GitResult | null {
  if (paths.length === 0) return null;
  const add = gitStage(cwd, paths);
  if (add && !add.ok) return add;
  const diff = git(['diff', '--cached', '--quiet', '--', ...paths], cwd);
  if (diff.ok) return null; // nothing staged for these paths
  return git(['commit', '-m', message, '--', ...paths], cwd, 30_000);
}
