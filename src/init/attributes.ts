import path from 'node:path';
import { readText, writeFileAtomic } from '../util/fsx.ts';

const BEGIN = '# >>> devctx >>>';
const END = '# <<< devctx <<<';

// Generated files merge with git's built-in `union` driver (both sides' lines, never conflict
// markers); the post-merge hook then regenerates them from the merged knowledge files. It needs
// no per-clone git config, only this committed file. Knowledge files need nothing: devctx only
// ever adds new ones, so two people's changes never touch the same file.
const BLOCK = [
  BEGIN,
  'AGENTS.md merge=union',
  '.github/instructions/devctx-*.instructions.md linguist-generated=true merge=union',
  '.cursor/rules/devctx-*.mdc linguist-generated=true merge=union',
  '.claude/rules/devctx-*.md linguist-generated=true merge=union',
  '.kiro/steering/devctx-*.md linguist-generated=true merge=union',
  '**/skills/devctx-code/SKILL.md linguist-generated=true merge=union',
  '.codex/rules/devctx.rules linguist-generated=true merge=union',
  END,
].join('\n');

/** Keeps the devctx block of `.gitattributes` current (init, and once a day from the hooks). */
export function ensureGitAttributes(root: string): boolean {
  const file = path.join(root, '.gitattributes');
  const current = readText(file) ?? '';
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  let next: string;
  if (start >= 0 && end > start) next = `${current.slice(0, start)}${BLOCK}${current.slice(end + END.length)}`;
  else next = `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}${BLOCK}\n`;
  if (next === current) return false;
  writeFileAtomic(file, next);
  return true;
}
