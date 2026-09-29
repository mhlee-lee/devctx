import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string, timeoutMs = 10_000): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024, // `ls-files` of a large monorepo is several MB
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
