import fs from 'node:fs';
import path from 'node:path';
import { assertSafeTarget, isInside, readText, writeFileAtomic } from '../util/fsx.ts';
import { commonGitDir, gitHooksDir } from '../util/git.ts';

export const GIT_HOOKS = ['pre-commit', 'post-merge', 'post-checkout', 'post-rewrite'] as const;
export type GitHookName = (typeof GIT_HOOKS)[number];

const BEGIN = '# >>> devctx >>>';
const END = '# <<< devctx <<<';

function block(name: GitHookName): string {
  return [
    BEGIN,
    '# Keeps AI instruction files in sync with .devctx/knowledge. Safe to remove.',
    'devctx_root="$(git rev-parse --show-toplevel 2>/dev/null)"',
    'if [ -n "$devctx_root" ] && [ -x "$devctx_root/.devctx/bin/devctx" ]; then',
    `  "$devctx_root/.devctx/bin/devctx" git-hook ${name} "$@" || true`,
    'fi',
    END,
  ].join('\n');
}

export interface GitHookResult {
  dir: string | null;
  installed: string[];
  present: string[];
  skipped: string[];
  reason?: string;
}

/**
 * Installs devctx blocks into git hooks. Existing hooks are kept: the block is appended.
 * When core.hooksPath points at a committed directory (husky etc.) it is only touched with
 * `allowTrackedDir`, because that changes files shared with the team. A hooks directory outside
 * the repository (a global core.hooksPath shared by every repository) and hook files that are
 * symlinks are never written: devctx reports them instead.
 */
export function ensureGitHooks(root: string, opts: { allowTrackedDir?: boolean } = {}): GitHookResult {
  const dir = gitHooksDir(root);
  const result: GitHookResult = { dir, installed: [], present: [], skipped: [] };
  if (!dir) {
    result.reason = 'not a git repository';
    return result;
  }
  // Linked worktrees share the main repository's hooks: the common git directory is ours too.
  const gitDir = commonGitDir(root) ?? path.join(root, '.git');
  const inGitDir = isInside(realOrSelf(dir), realOrSelf(gitDir));
  const inRepo = isInside(realOrSelf(dir), realOrSelf(root));
  if (!inGitDir && !inRepo) {
    result.skipped.push(...GIT_HOOKS);
    result.reason = `core.hooksPath points outside this repository (${dir}); add the devctx block there yourself if you want it`;
    return result;
  }
  if (!inGitDir && !opts.allowTrackedDir) {
    result.skipped.push(...GIT_HOOKS);
    result.reason = `core.hooksPath is a tracked directory (${path.relative(root, dir)}); run "devctx init" to add devctx there`;
    return result;
  }
  fs.mkdirSync(dir, { recursive: true });
  const allowedRoot = inGitDir ? gitDir : root;
  for (const name of GIT_HOOKS) {
    const file = path.join(dir, name);
    try {
      assertSafeTarget(file, allowedRoot);
    } catch (error) {
      result.skipped.push(name);
      result.reason = (error as Error).message;
      continue;
    }
    const existing = readText(file);
    if (existing?.includes(BEGIN)) {
      result.present.push(name);
      continue;
    }
    const content = existing === null ? `#!/bin/sh\n${block(name)}\n` : `${existing.replace(/\s*$/, '')}\n\n${block(name)}\n`;
    writeFileAtomic(file, content, existing === null ? 0o755 : (fs.statSync(file).mode & 0o7777) | 0o111);
    result.installed.push(name);
  }
  return result;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function gitHooksInstalled(root: string): boolean {
  const dir = gitHooksDir(root);
  if (!dir) return false;
  return GIT_HOOKS.every((name) => readText(path.join(dir, name))?.includes(BEGIN) ?? false);
}

/** Why the git hooks cannot be installed automatically (null when they can). */
export function gitHooksBlocked(root: string): string | null {
  const dir = gitHooksDir(root);
  if (!dir) return 'not a git repository';
  const gitDir = commonGitDir(root) ?? path.join(root, '.git');
  if (isInside(realOrSelf(dir), realOrSelf(gitDir))) return null;
  if (!isInside(realOrSelf(dir), realOrSelf(root))) return `core.hooksPath points outside this repository (${dir}); devctx does not write there`;
  return `core.hooksPath is a tracked directory (${path.relative(root, dir)}); run "devctx init" to add devctx there`;
}

/** Removes devctx's block from the git hooks; a hook left with only `#!/bin/sh` is deleted. */
export function removeGitHooks(root: string, apply: boolean): { removed: string[]; skipped: string[] } {
  const out = { removed: [] as string[], skipped: [] as string[] };
  const dir = gitHooksDir(root);
  if (!dir) return out;
  const gitDir = commonGitDir(root) ?? path.join(root, '.git');
  const allowedRoot = isInside(realOrSelf(dir), realOrSelf(gitDir)) ? gitDir : root;
  for (const name of GIT_HOOKS) {
    const file = path.join(dir, name);
    const text = readText(file);
    const start = text?.indexOf(BEGIN) ?? -1;
    const end = text?.indexOf(END) ?? -1;
    if (text === null || start < 0 || end < start) continue;
    try {
      assertSafeTarget(file, allowedRoot);
    } catch {
      out.skipped.push(name);
      continue;
    }
    const rest = `${text.slice(0, start)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n').trim();
    if (apply) {
      if (rest === '' || /^#!\S*sh$/.test(rest)) fs.rmSync(file, { force: true });
      else writeFileAtomic(file, `${rest}\n`, fs.statSync(file).mode & 0o7777);
    }
    out.removed.push(name);
  }
  return out;
}
