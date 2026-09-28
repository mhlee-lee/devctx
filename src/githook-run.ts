import fs from 'node:fs';
import path from 'node:path';
import { compile } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { StateDb } from './state/db.ts';
import { gitStage } from './util/git.ts';
import { errorMessage, logLine } from './util/log.ts';
import { projectPaths } from './util/paths.ts';
import { spawnWorker } from './worker-spawn.ts';

/**
 * Called by the installed git hooks. pre-commit regenerates instruction files and stages them
 * with the knowledge changes ("ride-along"), so decisions travel with the code they belong to.
 * Other hooks (checkout, merge, rebase) just regenerate for the new working tree.
 */
export function runGitHook(name: string, root: string): void {
  const paths = projectPaths(root);
  if (!fs.existsSync(paths.config)) return;
  try {
    const cfg = loadConfig(paths);
    const db = StateDb.open(paths.stateDb);
    try {
      const res = compile(paths, cfg, db, { tool: 'git' });
      if (name === 'pre-commit' && cfg.git.commit_mode !== 'manual') {
        const stage = ['.devctx/knowledge', ...res.changed, ...res.unchanged, ...res.removed].filter(
          (rel, i, all) => all.indexOf(rel) === i && (fs.existsSync(path.join(root, rel)) || res.removed.includes(rel)),
        );
        const r = gitStage(root, stage);
        if (r && !r.ok) logLine(paths.log, 'warn', 'pre-commit staging failed', { stderr: r.stderr });
      }
      if (name !== 'pre-commit' && db.hasPendingCandidates()) spawnWorker(root, `git-${name}`, null);
      if (res.foreignEdits > 0 && db.hasPendingCandidates()) spawnWorker(root, 'foreign-edit', null);
    } finally {
      db.close();
    }
  } catch (error) {
    logLine(paths.log, 'error', `git hook ${name} failed`, { error: errorMessage(error) });
  }
}
