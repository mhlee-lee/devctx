import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.ts';
import { commonGitDir } from '../util/git.ts';
import { machineDir } from '../util/paths.ts';

/**
 * Whether this developer records the prompt history of a repository. A personal switch kept on
 * this PC (never in git): prompts are written verbatim into commits, so each person opts in for
 * themselves. Keyed by the repository's shared git directory so every worktree follows it.
 */

interface ToggleFile {
  version: 1;
  repos: Record<string, { enabled: boolean; since: string; root: string }>;
}

export interface HistoryState {
  enabled: boolean;
  /** When it was last turned on or off. */
  since: string | null;
}

function toggleFile(): string {
  return path.join(machineDir(), 'history.json');
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

function load(): ToggleFile {
  const data = readJson<ToggleFile>(toggleFile(), { version: 1, repos: {} });
  return data && typeof data === 'object' && data.repos && typeof data.repos === 'object' ? data : { version: 1, repos: {} };
}

export function historyState(root: string): HistoryState {
  const entry = load().repos[repoKey(root)];
  return entry ? { enabled: entry.enabled === true, since: entry.since ?? null } : { enabled: false, since: null };
}

export function historyEnabled(root: string): boolean {
  return historyState(root).enabled;
}

export function setHistoryEnabled(root: string, enabled: boolean): HistoryState {
  const data = load();
  const key = repoKey(root);
  const since = new Date().toISOString();
  data.repos[key] = { enabled, since, root: path.resolve(root) };
  writeJsonAtomic(toggleFile(), data);
  return { enabled, since };
}
