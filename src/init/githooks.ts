import fs from 'node:fs';
import path from 'node:path';
import { isInside, readText } from '../util/fsx.ts';
import { gitHooksDir } from '../util/git.ts';

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
 * `allowTrackedDir`, because that changes files shared with the team.
 */
export function ensureGitHooks(root: string, opts: { allowTrackedDir?: boolean } = {}): GitHookResult {
  const dir = gitHooksDir(root);
  const result: GitHookResult = { dir, installed: [], present: [], skipped: [] };
  if (!dir) {
    result.reason = 'not a git repository';
    return result;
  }
  const gitDirHooks = isInside(dir, path.join(root, '.git'));
  if (!gitDirHooks && isInside(dir, root) && !opts.allowTrackedDir) {
    result.skipped.push(...GIT_HOOKS);
    result.reason = `core.hooksPath is a tracked directory (${path.relative(root, dir)}); run "devctx init" to add devctx there`;
    return result;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const name of GIT_HOOKS) {
    const file = path.join(dir, name);
    const existing = readText(file);
    if (existing?.includes(BEGIN)) {
      result.present.push(name);
      continue;
    }
    const content = existing === null ? `#!/bin/sh\n${block(name)}\n` : `${existing.replace(/\s*$/, '')}\n\n${block(name)}\n`;
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
    result.installed.push(name);
  }
  return result;
}

export function gitHooksInstalled(root: string): boolean {
  const dir = gitHooksDir(root);
  if (!dir) return false;
  return GIT_HOOKS.every((name) => readText(path.join(dir, name))?.includes(BEGIN) ?? false);
}
