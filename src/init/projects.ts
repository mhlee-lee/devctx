import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.ts';
import { commonGitDir, worktreeGitDir } from '../util/git.ts';
import { machineDir } from '../util/paths.ts';

/**
 * The repositories on this PC that use devctx, which `devctx update` moves together. Added by `devctx init`
 * and by the daily upkeep (so clones set up by their hooks are known too); removed by uninstall.
 */
function registryFile(): string {
  return path.join(machineDir(), 'projects.json');
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isProject(root: string): boolean {
  return fs.existsSync(path.join(root, '.devctx', 'tools.lock'));
}

function stored(): string[] {
  const list = readJson<{ projects?: unknown }>(registryFile(), {}).projects;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

function save(list: string[]): void {
  writeJsonAtomic(registryFile(), { projects: [...new Set(list)].sort() });
}

/** Registered repositories that still have devctx (others are dropped from the list). */
export function registeredProjects(): string[] {
  const list = stored();
  const live = list.filter(isProject);
  if (live.length !== list.length) save(live);
  return live;
}

/** Best effort: a registry that can't be written never stops init or a hook. */
export function registerProject(root: string): void {
  try {
    // Linked worktrees (an AI tool's parallel checkouts) share the main checkout's repository.
    const dir = worktreeGitDir(root);
    if (dir && commonGitDir(root) !== real(dir)) return;
    const abs = real(root);
    const list = stored();
    if (list.includes(abs)) return;
    save([...list.filter(isProject), abs]);
  } catch {
    // not recorded: `devctx update` still works inside the repository
  }
}

export function unregisterProject(root: string): void {
  try {
    const abs = real(root);
    const list = stored();
    if (list.includes(abs)) save(list.filter((p) => p !== abs));
  } catch {
    // nothing to clean up
  }
}
