import fs from 'node:fs';
import { indexNeedsRefresh } from './codeindex/service.ts';
import { compile } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { HISTORY_DIR } from './history/writer.ts';
import { StateDb } from './state/db.ts';
import { committedPaths, untrackGenerated } from './init/attributes.ts';
import type { Language } from './types.ts';
import { dailyUpkeep, healthNotices, noteCommit } from './upkeep.ts';
import { git, gitStage } from './util/git.ts';
import { errorMessage, logLine } from './util/log.ts';
import { projectPaths } from './util/paths.ts';
import { spawnWorker } from './worker-spawn.ts';

/**
 * Called by the installed git hooks. pre-commit stages new decision files (and the prompt
 * history) with the commit ("ride-along"), so decisions travel with the code they belong to.
 * Other hooks (checkout, merge, rebase) rebuild this PC's rule files for the new working tree.
 * Returns notices to print on stderr (visible to whoever commits, person or agent).
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
      const notices: string[] = [];
      if (name === 'pre-commit') {
        noteCommit(db);
        if (cfg.git.commit_mode !== 'manual') {
          if (partialCommit()) {
            // `git commit <paths>` (JetBrains IDEs commit this way) builds the commit in a
            // temporary index: staging there would leave the real index without the new files,
            // and the next commit would delete them. They go with a later commit instead (said only
            // when something is actually waiting).
            const waiting = committedPaths(root, ['.devctx/knowledge', HISTORY_DIR]);
            if (waiting.length > 0 && gitPending(root, waiting)) notices.push(PARTIAL_NOTE[cfg.language]);
          } else {
            // Decisions and history, plus an AGENTS.md that an earlier version generated and that
            // was turned into the people's text with devctx's fixed block.
            const r = gitStage(root, committedPaths(root, ['.devctx/knowledge', HISTORY_DIR]));
            if (r && !r.ok) logLine(paths.log, 'warn', 'pre-commit staging failed', { stderr: r.stderr });
            const untracked = untrackGenerated(root);
            if (untracked.length > 0) logLine(paths.log, 'info', 'stopped tracking generated rule files', { files: untracked });
          }
        }
      }
      // Checkout, merge and rebase move HEAD: the worker re-indexes code only when it changed.
      const codeMoved = name !== 'pre-commit' && indexNeedsRefresh(root, cfg);
      if (name !== 'pre-commit' && (codeMoved || db.hasPendingCandidates())) spawnWorker(root, `git-${name}`, null);
      if (name === 'pre-commit' || name === 'post-merge') notices.push(...healthNotices(db, cfg.language, { capture: true, everyDays: 3 }));
      return notices;
    } finally {
      db.close();
    }
  } catch (error) {
    logLine(paths.log, 'error', `git hook ${name} failed`, { error: errorMessage(error) });
    return [];
  }
}

/**
 * Files under `rels` that this commit leaves out: new or changed in the working tree compared with
 * the index the commit is built from (the partial commit's temporary one). Files named in the
 * commit, or staged before it, are part of it and do not count.
 */
function gitPending(root: string, rels: readonly string[]): boolean {
  const r = git(['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard', '--', ...rels], root, 10_000);
  return r.ok && r.stdout !== '';
}

/** `git commit <paths>` / `--only`: git hands the hooks a temporary `next-index-*.lock`. */
function partialCommit(): boolean {
  return /(^|[\\/])next-index-[^\\/]*\.lock$/.test(process.env.GIT_INDEX_FILE ?? '');
}

const PARTIAL_NOTE: Record<Language, string> = {
  ko: 'devctx: 파일을 지정한 커밋이라 새 결정 파일을 함께 올리지 않았다. 다음 일반 커밋에 함께 올라간다.',
  en: 'devctx: this commit names its files, so new decision files were not added to it. They go with your next regular commit.',
};
