import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.ts';
import { commonGitDir } from '../util/git.ts';
import { machineDir } from '../util/paths.ts';

/**
 * Personal switches kept on this PC (never in git), per repository. Keyed by the repository's
 * shared git directory so every worktree follows it.
 * - history: record the prompt history (off by default; prompts go verbatim into commits, so each
 *   person opts in for themselves).
 * - capture: analyze this person's prompts for project rules (on by default; off means no LLM
 *   call is made on their prompts, at their quota's expense or otherwise). Rules still arrive.
 *   `devctx capture off --global` turns it off for every repository on this PC (replacing
 *   per-repository settings; a later per-repository `on`/`off` overrides it there).
 */

export type Switch = 'history' | 'capture';

const DEFAULTS: Record<Switch, boolean> = { history: false, capture: true };
const GLOBAL = '*';

interface ToggleFile {
  version: 1;
  repos: Record<string, { enabled: boolean; since: string; root: string }>;
}

export interface HistoryState {
  enabled: boolean;
  /** When it was last turned on or off. */
  since: string | null;
  /** Set by `--global` (applies to every repository without its own setting). */
  global?: boolean;
}

function toggleFile(name: Switch): string {
  return path.join(machineDir(), `${name}.json`);
}

function repoKey(root: string): string {
  const common = commonGitDir(root);
  if (common) return common;
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function load(name: Switch): ToggleFile {
  const data = readJson<ToggleFile>(toggleFile(name), { version: 1, repos: {} });
  return data && typeof data === 'object' && data.repos && typeof data.repos === 'object' ? data : { version: 1, repos: {} };
}

export function switchState(root: string, name: Switch): HistoryState {
  const repos = load(name).repos;
  const entry = repos[repoKey(root)];
  if (entry) return { enabled: entry.enabled === true, since: entry.since ?? null };
  const all = repos[GLOBAL];
  if (all) return { enabled: all.enabled === true, since: all.since ?? null, global: true };
  return { enabled: DEFAULTS[name], since: null };
}

export function setSwitch(root: string, name: Switch, enabled: boolean, opts: { global?: boolean } = {}): HistoryState {
  const data = load(name);
  const since = new Date().toISOString();
  if (opts.global) {
    // The global setting is the one that applies now, also where a repository had its own.
    data.repos = { [GLOBAL]: { enabled, since, root: '*' } };
  } else {
    data.repos[repoKey(root)] = { enabled, since, root: path.resolve(root) };
  }
  writeJsonAtomic(toggleFile(name), data);
  return { enabled, since, global: opts.global };
}

export function historyState(root: string): HistoryState {
  return switchState(root, 'history');
}

export function historyEnabled(root: string): boolean {
  return historyState(root).enabled;
}

export function setHistoryEnabled(root: string, enabled: boolean): HistoryState {
  return setSwitch(root, 'history', enabled);
}

export function captureEnabled(root: string): boolean {
  return switchState(root, 'capture').enabled;
}
