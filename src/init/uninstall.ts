import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeLockPath } from '../codeindex/files.ts';
import { existingGenerated } from '../compile/compile.ts';
import { isLegacyAgentsMd, withoutAgentsBlock } from '../compile/render.ts';
import { loadConfig } from '../config.ts';
import { TOOL_IDS } from '../types.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';
import { forgetRepo } from '../history/toggle.ts';
import { commonGitDir, git, worktreeGitDir } from '../util/git.ts';
import { lockHolder } from '../util/lock.ts';
import { machineDir, projectPaths, type ProjectPaths } from '../util/paths.ts';
import { BACKUP_SUFFIX, installAgentAccess, removeLegacyMcp } from './access.ts';
import { removeGitBlocks, UNINSTALLED_IGNORE } from './attributes.ts';
import { removeGitHooks } from './githooks.ts';
import { removeToolHooks } from './hookconfigs.ts';
import { unregisterProject } from './projects.ts';

export interface UninstallStep {
  /** Path relative to the repository (or a description for things outside it). */
  target: string;
  action: 'remove' | 'edit';
  note?: string;
}

export interface UninstallReport {
  applied: boolean;
  steps: UninstallStep[];
  /** Paths to commit afterwards (`git add -A -- …`). */
  commitPaths: string[];
  /** What happened besides file changes (background work waited for or stopped). */
  notes: string[];
}

const SKILL_DIRS = ['.claude/skills/devctx-code', '.agents/skills/devctx-code', '.kiro/skills/devctx-code'];
const ACCESS_FILES = ['.codex/rules/devctx.rules', '.claude/settings.json', '.vscode/settings.json', '.cursor/permissions.json', '.cursor/cli.json'];
// Folders devctx may have created for the tools' files, deepest first; removed only when left empty.
const TOOL_DIRS = [
  '.claude/skills', '.claude/rules', '.claude', '.agents/skills', '.agents', '.codex/rules', '.codex', '.cursor/rules', '.cursor',
  '.github/hooks', '.github/instructions', '.github', '.kiro/skills', '.kiro/hooks', '.kiro/steering', '.kiro', '.vscode',
];
/** How long uninstall waits for a running worker or indexer before stopping it. */
export const BACKGROUND_WAIT_MS = 10_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid from a lock file can be reused by another program: only devctx's own background work is stopped. */
function isDevctxBackground(pid: number): boolean {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  const cmd = r.stdout ?? '';
  return /cli\.(js|ts)\b/.test(cmd) && /\s(worker|code index)\b/.test(cmd);
}

/** devctx's background processes of this worktree (worker, code indexer), by their locks. */
function backgroundPids(paths: ProjectPaths): number[] {
  return [paths.workerLock, codeLockPath(paths.root)].map((f) => lockHolder(f, 60 * 60 * 1000)).filter((p): p is number => p !== null && p !== process.pid);
}

/**
 * Lets a running worker or indexer finish (it would write `.devctx/local` again right after it is
 * removed), then stops what is still running. Detached workers lead their own process group, so
 * the model CLI or parse pass they started stops with them.
 */
function stopBackground(paths: ProjectPaths, waitMs: number): string[] {
  const deadline = Date.now() + waitMs;
  let pids = backgroundPids(paths);
  if (pids.length === 0) return [];
  while (pids.length > 0 && Date.now() < deadline) {
    sleep(200);
    pids = backgroundPids(paths);
  }
  if (pids.length === 0) return ['waited for devctx background work to finish'];
  const stopped: number[] = [];
  for (const pid of pids) {
    if (!isDevctxBackground(pid)) continue;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // already gone
        }
      }
      for (let i = 0; i < 15 && alive(pid); i++) sleep(200);
      if (!alive(pid)) break;
    }
    stopped.push(pid);
  }
  return stopped.length > 0 ? [`stopped devctx background work still running after ${Math.round(waitMs / 1000)}s (pid ${stopped.join(', ')})`] : [];
}

function isMainWorktree(root: string): boolean {
  const dir = worktreeGitDir(root);
  if (!dir) return true;
  try {
    return commonGitDir(root) === fs.realpathSync(dir);
  } catch {
    return true;
  }
}

/**
 * Removes everything `devctx init` and the hooks put into a repository: devctx's entries in the
 * tools' hook and permission files (the rest of each file stays), skills, git hook blocks, the
 * `.gitattributes`/`.gitignore` blocks, the block in AGENTS.md, generated rule files and `.devctx/`
 * (`keepHistory` keeps `.devctx/history/`), this PC's history/capture settings for the repository
 * and tool folders left empty. `.gitignore` keeps one line so teammates' leftover local data stays
 * out of commits. Background work is waited for (`waitMs`) and then stopped first, so nothing
 * writes `.devctx` again. `apply: false` lists what would change.
 */
export function uninstall(root: string, opts: { apply: boolean; keepHistory: boolean; waitMs?: number }): UninstallReport {
  const { apply } = opts;
  const paths = projectPaths(root);
  const steps: UninstallStep[] = [];
  const notes: string[] = [];
  const touched = new Set<string>();
  if (apply) notes.push(...stopBackground(paths, opts.waitMs ?? BACKGROUND_WAIT_MS));
  else if (backgroundPids(paths).length > 0) notes.push(`devctx background work is running; --yes waits up to ${BACKGROUND_WAIT_MS / 1000}s for it, then stops it`);
  const step = (target: string, action: UninstallStep['action'], note?: string): void => {
    steps.push(note ? { target, action, note } : { target, action });
    if (!target.startsWith('~') && !target.startsWith('.git/') && !target.includes(' ')) touched.add(target);
  };

  for (const tool of TOOL_IDS) {
    const r = removeToolHooks(root, tool, apply);
    if (r.action === 'removed') step(r.file, 'remove', 'devctx hooks only');
    else if (r.action === 'updated') step(r.file, 'edit', 'devctx hook entries removed, others kept');
    else if (r.action === 'skipped') step(r.file, 'edit', r.note);
  }

  // Skills and the pre-approved command (repository and this PC's Copilot CLI / Kiro entries).
  if (apply) {
    const language = loadConfig(paths).language;
    for (const r of [...installAgentAccess(root, [...TOOL_IDS], { enabled: false, preapprove: false, language }), ...removeLegacyMcp(root)]) {
      if (r.action === 'unchanged') continue;
      const outside = path.isAbsolute(r.file) || r.file.startsWith('~');
      step(outside ? r.file.replace(process.env.HOME ?? '~', '~') : r.file, r.action === 'removed' ? 'remove' : 'edit', r.note);
    }
  } else {
    for (const rel of SKILL_DIRS) if (fs.existsSync(path.join(root, rel))) step(rel, 'remove', 'code index skill');
    for (const rel of ACCESS_FILES) {
      if ((readText(path.join(root, rel)) ?? '').includes('devctx')) step(rel, rel.endsWith('.rules') ? 'remove' : 'edit', 'pre-approved devctx code command');
    }
    steps.push({ target: '~/.copilot, ~/.kiro (this repository only)', action: 'edit', note: 'pre-approved devctx code command, if present' });
  }

  const hooks = removeGitHooks(root, apply);
  if (hooks.removed.length > 0) steps.push({ target: `.git/hooks: ${hooks.removed.join(', ')}`, action: 'edit', note: 'devctx block' });
  if (hooks.skipped.length > 0) steps.push({ target: `.git/hooks: ${hooks.skipped.join(', ')}`, action: 'edit', note: 'symlinked or outside the repository: remove the devctx block by hand' });

  for (const rel of removeGitBlocks(root, apply)) {
    step(rel, 'edit', rel === '.gitignore' ? `devctx block removed; keeps ${UNINSTALLED_IGNORE} so teammates' leftover local data stays out of commits` : 'devctx block');
  }

  for (const rel of existingGenerated(root)) {
    if (apply) fs.rmSync(path.join(root, rel), { force: true });
    step(rel, 'remove', 'generated rule file');
  }

  // AGENTS.md: the people's text stays; a file devctx created (or generated, before the block)
  // goes, and with it the CLAUDE.md import that pointed at it.
  const agents = readText(paths.agentsMd);
  let agentsGone = false;
  if (agents !== null) {
    const rest = isLegacyAgentsMd(agents) ? (readText(paths.preamble)?.trim() || null) : withoutAgentsBlock(agents);
    if (rest === null) {
      if (apply) fs.rmSync(paths.agentsMd, { force: true });
      agentsGone = true;
      step('AGENTS.md', 'remove', 'only devctx content');
    } else if (rest !== agents) {
      if (apply) writeFileAtomic(paths.agentsMd, rest.endsWith('\n') ? rest : `${rest}\n`);
      step('AGENTS.md', 'edit', 'devctx block removed, your text kept');
    }
  }
  const claudeMd = path.join(root, 'CLAUDE.md');
  const claude = readText(claudeMd);
  if (agentsGone && claude !== null && /^@AGENTS\.md\s*\n/.test(claude)) {
    if (apply) writeFileAtomic(claudeMd, claude.replace(/^@AGENTS\.md\s*\n(\s*\n)?/, ''));
    step('CLAUDE.md', 'edit', '@AGENTS.md import removed (AGENTS.md is gone)');
  }

  if (fs.existsSync(paths.devctx)) {
    const historyDir = path.join(paths.devctx, 'history');
    const keep = opts.keepHistory && fs.existsSync(historyDir);
    if (apply) {
      for (const name of fs.readdirSync(paths.devctx)) {
        if (keep && name === 'history') continue;
        fs.rmSync(path.join(paths.devctx, name), { recursive: true, force: true });
      }
      if (!keep) fs.rmSync(paths.devctx, { recursive: true, force: true });
    }
    step('.devctx', 'remove', keep ? 'decisions, settings, local data; .devctx/history kept' : 'decisions, settings, local data and prompt history');
  }
  if (apply) {
    // Something not holding a lock (a hook of a session still open) may have written it again.
    sleep(300);
    const again = fs.existsSync(paths.devctx) ? fs.readdirSync(paths.devctx).filter((n) => !(opts.keepHistory && n === 'history')) : [];
    if (again.length > 0) {
      for (const name of again) fs.rmSync(path.join(paths.devctx, name), { recursive: true, force: true });
      if (!opts.keepHistory) fs.rmSync(paths.devctx, { recursive: true, force: true });
      notes.push('.devctx was written again by a running devctx process (an open AI session?) and removed again; close the session if it comes back');
    }
  }
  for (const rel of TOOL_DIRS) {
    const dir = path.join(root, rel);
    let empty = false;
    try {
      empty = fs.readdirSync(dir).length === 0;
    } catch {
      continue;
    }
    if (!empty) continue;
    if (apply) fs.rmdirSync(dir);
    steps.push({ target: `${rel}/`, action: 'remove', note: 'empty folder' });
  }
  // Settings kept per repository on this PC (shared by its worktrees: only the main checkout drops them).
  if (isMainWorktree(root) && forgetRepo(root, apply)) {
    steps.push({ target: `${tilde(machineDir())}/{history,capture}.json`, action: 'edit', note: "this repository's history/capture setting" });
  }
  if (apply) unregisterProject(root);
  // `git add` fails on a path it never knew: keep files that exist or that git tracks.
  const known = [...touched].filter((rel) => fs.existsSync(path.join(root, rel)) || git(['ls-files', '--', rel], root, 5_000).stdout !== '');
  return { applied: apply, steps, commitPaths: known.sort(), notes };
}

/** One `~`-relative path for the output. */
function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * What devctx keeps on this PC outside repositories: the data directory (installs per version,
 * personal rules, model evaluations, price cache, history/capture settings, project list) and the
 * copies it made of the Copilot CLI and Kiro permission files before first editing them.
 */
export function uninstallMachine(apply: boolean): UninstallStep[] {
  const steps: UninstallStep[] = [];
  const data = machineDir();
  if (fs.existsSync(data)) {
    if (apply) fs.rmSync(data, { recursive: true, force: true });
    steps.push({ target: tilde(data), action: 'remove', note: 'installed versions, personal rules, model evaluations, settings, project list' });
  }
  const copilot = process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(os.homedir(), '.copilot');
  const kiro = process.env.KIRO_HOME ? path.resolve(process.env.KIRO_HOME) : path.join(os.homedir(), '.kiro');
  const backups = [path.join(copilot, `permissions-config.json${BACKUP_SUFFIX}`)];
  try {
    const roots = path.join(kiro, 'workspace-roots');
    for (const d of fs.readdirSync(roots)) backups.push(path.join(roots, d, `permissions.yaml${BACKUP_SUFFIX}`));
  } catch {
    // no Kiro workspaces
  }
  for (const file of backups) {
    if (!fs.existsSync(file)) continue;
    if (apply) fs.rmSync(file, { force: true });
    steps.push({ target: tilde(file), action: 'remove', note: 'copy devctx kept of the file before its first edit' });
  }
  return steps;
}

/** The `devctx` command on PATH (a global npm install or `npm link`), if any. */
export function globalCommand(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = dir && path.join(dir, 'devctx');
    if (bin && fs.existsSync(bin)) return bin;
  }
  return null;
}
