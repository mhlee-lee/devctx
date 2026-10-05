import fs from 'node:fs';
import path from 'node:path';
import { existingGenerated } from '../compile/compile.ts';
import { isLegacyAgentsMd, withoutAgentsBlock } from '../compile/render.ts';
import { loadConfig } from '../config.ts';
import { TOOL_IDS } from '../types.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';
import { git } from '../util/git.ts';
import { projectPaths } from '../util/paths.ts';
import { installAgentAccess, removeLegacyMcp } from './access.ts';
import { removeGitBlocks } from './attributes.ts';
import { removeGitHooks } from './githooks.ts';
import { removeToolHooks } from './hookconfigs.ts';

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
}

const SKILL_DIRS = ['.claude/skills/devctx-code', '.agents/skills/devctx-code', '.kiro/skills/devctx-code'];
const ACCESS_FILES = ['.codex/rules/devctx.rules', '.claude/settings.json', '.vscode/settings.json', '.cursor/permissions.json', '.cursor/cli.json'];

/**
 * Removes everything `devctx init` and the hooks put into a repository: devctx's entries in the
 * tools' hook and permission files (the rest of each file stays), skills, git hook blocks, the
 * `.gitattributes`/`.gitignore` blocks, the block in AGENTS.md, generated rule files and `.devctx/`
 * (`keepHistory` keeps `.devctx/history/`). `apply: false` lists what would change.
 */
export function uninstall(root: string, opts: { apply: boolean; keepHistory: boolean }): UninstallReport {
  const { apply } = opts;
  const paths = projectPaths(root);
  const steps: UninstallStep[] = [];
  const touched = new Set<string>();
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

  for (const rel of removeGitBlocks(root, apply)) step(rel, 'edit', 'devctx block');

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
  // `git add` fails on a path it never knew: keep files that exist or that git tracks.
  const known = [...touched].filter((rel) => fs.existsSync(path.join(root, rel)) || git(['ls-files', '--', rel], root, 5_000).stdout !== '');
  return { applied: apply, steps, commitPaths: known.sort() };
}
