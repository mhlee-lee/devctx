import fs from 'node:fs';
import path from 'node:path';
import { hasAgentsBlock, isLegacyAgentsMd, PATH_RULE_DIRS } from '../compile/render.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';
import { git } from '../util/git.ts';

const BEGIN = '# >>> devctx >>>';
const END = '# <<< devctx <<<';

// Committed files devctx writes only when its version or the config changes (skills, Codex
// rules) merge with git's built-in `union` driver: both sides' lines, never conflict markers,
// and the next session rewrites them. Decision files need nothing: devctx only ever adds new
// ones, so two people's changes never touch the same file. AGENTS.md belongs to the people
// (devctx keeps one fixed block in it) and merges like any other file.
const ATTRIBUTES = [
  BEGIN,
  '**/skills/devctx-code/SKILL.md linguist-generated=true merge=union',
  '.codex/rules/devctx.rules linguist-generated=true merge=union',
  END,
].join('\n');

// What each PC builds from the decision files. Not committed: a server-side merge (a pull request
// merged on GitHub) cannot rebuild it, so a committed copy would go stale and then show up as a
// change in everyone's next commit.
const IGNORE = [
  BEGIN,
  '# Built on each PC from .devctx/knowledge/ (not committed)',
  '/.devctx/rules.md',
  ...PATH_RULE_DIRS.map((dir) => `/${dir}/devctx-*`),
  END,
].join('\n');

function ensureBlock(file: string, block: string): boolean {
  const current = readText(file) ?? '';
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  let next: string;
  if (start >= 0 && end > start) next = `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
  else next = `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}${block}\n`;
  if (next === current) return false;
  writeFileAtomic(file, next);
  return true;
}

/** Removes the devctx block from `.gitattributes` and `.gitignore` (files left empty are deleted). */
export function removeGitBlocks(root: string, apply: boolean): string[] {
  const changed: string[] = [];
  for (const rel of ['.gitattributes', '.gitignore']) {
    const file = path.join(root, rel);
    const current = readText(file);
    const start = current?.indexOf(BEGIN) ?? -1;
    const end = current?.indexOf(END) ?? -1;
    if (current === null || start < 0 || end < start) continue;
    const rest = `${current.slice(0, start)}${current.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n').trim();
    if (apply) {
      if (rest) writeFileAtomic(file, `${rest}\n`);
      else fs.rmSync(file, { force: true });
    }
    changed.push(rel);
  }
  return changed;
}

/** Keeps the devctx block of `.gitattributes` current (init, and once a day from the hooks). */
export function ensureGitAttributes(root: string): boolean {
  return ensureBlock(path.join(root, '.gitattributes'), ATTRIBUTES);
}

/** Keeps the devctx block of `.gitignore` current (init, and once a day from the hooks). */
export function ensureGitIgnore(root: string): boolean {
  return ensureBlock(path.join(root, '.gitignore'), IGNORE);
}

/** Generated rule files an earlier devctx version committed. */
export function trackedGenerated(root: string): string[] {
  const r = git(['ls-files', '-z', '--', '.devctx/rules.md', ...PATH_RULE_DIRS.map((dir) => `${dir}/devctx-*`)], root, 10_000);
  return r.ok ? r.stdout.split('\0').filter(Boolean) : [];
}

/**
 * Stops tracking generated files an earlier version committed (they stay on disk). The removal is
 * staged, so it goes out with the next commit and the team's clones stop tracking them too.
 */
export function untrackGenerated(root: string): string[] {
  const files = trackedGenerated(root);
  if (files.length === 0) return [];
  const r = git(['rm', '--cached', '-q', '--', ...files], root, 10_000);
  return r.ok ? files : [];
}

/**
 * The committed AGENTS.md is one an earlier version generated and the working copy is already
 * converted (people's text plus the fixed block): the conversion belongs in the next commit,
 * whichever run of devctx did it.
 */
export function agentsMigrationPending(root: string): boolean {
  const head = git(['show', 'HEAD:AGENTS.md'], root, 5_000);
  return head.ok && isLegacyAgentsMd(head.stdout) && hasAgentsBlock(readText(path.join(root, 'AGENTS.md')));
}

/** What devctx commits: decision files, prompt history, and a pending AGENTS.md conversion. */
export function committedPaths(root: string, extra: readonly string[] = []): string[] {
  const out = [...extra, ...(agentsMigrationPending(root) ? ['AGENTS.md'] : [])];
  return [...new Set(out)].filter((rel) => rel === 'AGENTS.md' || fs.existsSync(path.join(root, rel)));
}
