import fs from 'node:fs';
import path from 'node:path';
import { indexNeedsRefresh } from './codeindex/service.ts';
import { compile } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { StateDb } from './state/db.ts';
import { dailyUpkeep, healthNotices, noteCommit } from './upkeep.ts';
import { gitStage } from './util/git.ts';
import { errorMessage, logLine } from './util/log.ts';
import { projectPaths } from './util/paths.ts';
import { spawnWorker } from './worker-spawn.ts';

/**
 * Called by the installed git hooks. pre-commit regenerates instruction files and stages them
 * with the knowledge changes ("ride-along"), so decisions travel with the code they belong to.
 * Other hooks (checkout, merge, rebase) regenerate for the new working tree: after a merge this
 * turns AGENTS.md (merged line by line by git's union driver) back into exactly what the merged
 * knowledge files produce. Returns notices to print on stderr (visible to whoever commits,
 * person or agent).
 */
export function runGitHook(name: string, root: string): string[] {
  const paths = projectPaths(root);
  if (!fs.existsSync(paths.config)) return [];
  try {
    const cfg = loadConfig(paths);
    const db = StateDb.open(paths.stateDb);
    try {
      const upkept = dailyUpkeep(root, cfg, db);
      if (upkept.length > 0) logLine(paths.log, 'info', 'daily upkeep (git hook)', { files: upkept });
      const res = compile(paths, cfg, db, { tool: 'git' });
      if (name === 'pre-commit') {
        noteCommit(db);
        if (cfg.git.commit_mode !== 'manual') {
          const stage = ['.devctx/knowledge', ...res.changed, ...res.unchanged, ...res.removed].filter(
            (rel, i, all) => all.indexOf(rel) === i && (fs.existsSync(path.join(root, rel)) || res.removed.includes(rel)),
          );
          const r = gitStage(root, stage);
          if (r && !r.ok) logLine(paths.log, 'warn', 'pre-commit staging failed', { stderr: r.stderr });
        }
      }
      // Checkout, merge and rebase move HEAD: the worker re-indexes code only when it changed.
      const codeMoved = name !== 'pre-commit' && indexNeedsRefresh(root, cfg);
      if (name !== 'pre-commit' && (codeMoved || db.hasPendingCandidates())) spawnWorker(root, `git-${name}`, null);
      if (res.foreignEdits > 0 && db.hasPendingCandidates()) spawnWorker(root, 'foreign-edit', null);
      return name === 'pre-commit' || name === 'post-merge' ? healthNotices(db, cfg.language, { capture: true, everyDays: 3 }) : [];
    } finally {
      db.close();
    }
  } catch (error) {
    logLine(paths.log, 'error', `git hook ${name} failed`, { error: errorMessage(error) });
    return [];
  }
}
