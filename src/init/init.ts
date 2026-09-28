import fs from 'node:fs';
import path from 'node:path';
import { compile, isManagedAgentsMd, type CompileResult } from '../compile/compile.ts';
import { loadConfig, renderConfigYaml } from '../config.ts';
import { StateDb } from '../state/db.ts';
import type { Language, ToolId } from '../types.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';
import { projectPaths } from '../util/paths.ts';
import { ensureGitHooks, type GitHookResult } from './githooks.ts';
import { installToolHooks, type HookFileResult } from './hookconfigs.ts';
import { defaultSource, packageInfo, renderShim, renderToolsLock } from './shim.ts';

export interface InitOptions {
  root: string;
  tools: ToolId[];
  source: string | null;
  language: Language;
  gitHooks: boolean;
  force: boolean;
}

export interface InitReport {
  root: string;
  written: string[];
  notes: string[];
  hookFiles: HookFileResult[];
  gitHooks: GitHookResult | null;
  compile: CompileResult;
}

const ATTR_BEGIN = '# >>> devctx >>>';
const ATTR_END = '# <<< devctx <<<';
const ATTR_BLOCK = [
  ATTR_BEGIN,
  '.github/instructions/devctx-*.instructions.md linguist-generated=true',
  '.cursor/rules/devctx-*.mdc linguist-generated=true',
  '.claude/rules/devctx-*.md linguist-generated=true',
  '.kiro/steering/devctx-*.md linguist-generated=true',
  ATTR_END,
].join('\n');

function writeIfMissing(file: string, content: string, written: string[], root: string, force = false, mode?: number): boolean {
  if (!force && fs.existsSync(file)) return false;
  writeFileAtomic(file, content, mode);
  written.push(path.relative(root, file));
  return true;
}

function upsertBlock(file: string, block: string): boolean {
  const current = readText(file) ?? '';
  const start = current.indexOf(ATTR_BEGIN);
  const end = current.indexOf(ATTR_END);
  let next: string;
  if (start >= 0 && end > start) next = `${current.slice(0, start)}${block}${current.slice(end + ATTR_END.length)}`;
  else next = `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}${block}\n`;
  if (next === current) return false;
  writeFileAtomic(file, next);
  return true;
}

/**
 * Sets a repository up for devctx. Idempotent: re-running updates hook commands and the shim but
 * never overwrites config or knowledge (unless `force` for config).
 */
export function runInit(opts: InitOptions): InitReport {
  const paths = projectPaths(opts.root);
  const written: string[] = [];
  const notes: string[] = [];

  for (const dir of [paths.decisions, paths.context, paths.runbooks, paths.lessons, paths.local, path.dirname(paths.shim)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const dir of [paths.decisions, paths.context, paths.runbooks, paths.lessons]) {
    writeIfMissing(path.join(dir, '.gitkeep'), '', written, opts.root);
  }
  if (!writeIfMissing(paths.config, renderConfigYaml(opts.tools, opts.language), written, opts.root, opts.force)) {
    notes.push('.devctx/config.yaml already exists (kept). Use --force to regenerate it.');
  }
  writeIfMissing(path.join(paths.devctx, '.gitignore'), '/local/\n', written, opts.root);

  const { version } = packageInfo();
  const source = opts.source ?? defaultSource();
  writeFileAtomic(paths.toolsLock, renderToolsLock({ version, source }));
  written.push('.devctx/tools.lock');
  if (path.isAbsolute(source)) {
    notes.push(`tools.lock points at a local path (${source}); teammates need a git URL or npm spec there.`);
  }
  writeFileAtomic(paths.shim, renderShim(), 0o755);
  written.push('.devctx/bin/devctx');

  // Keep what people already wrote: an unmanaged AGENTS.md becomes the preamble of the generated one.
  const agents = readText(paths.agentsMd);
  if (agents !== null && !isManagedAgentsMd(agents)) {
    const preamble = readText(paths.preamble);
    if (preamble === null || !preamble.trim()) {
      writeFileAtomic(paths.preamble, agents.trim() ? `${agents.trim()}\n` : '');
      // Content is preserved in preamble.md; remove the unmanaged file so compile can own it.
      fs.rmSync(paths.agentsMd, { force: true });
      notes.push('Existing AGENTS.md moved into .devctx/knowledge/preamble.md; AGENTS.md is now generated.');
    } else {
      notes.push('AGENTS.md is unmanaged but preamble.md already has content; merge them by hand, then re-run init.');
    }
  }
  if (!fs.existsSync(paths.preamble)) writeFileAtomic(paths.preamble, '');

  if (opts.tools.includes('claude')) {
    const claudeMd = path.join(opts.root, 'CLAUDE.md');
    const text = readText(claudeMd);
    if (text !== null && !/^@AGENTS\.md\s*$/m.test(text)) {
      writeFileAtomic(claudeMd, `@AGENTS.md\n\n${text}`);
      notes.push('CLAUDE.md now imports @AGENTS.md (Claude Code ignores AGENTS.md when CLAUDE.md exists).');
    }
  }

  const hookFiles = opts.tools.map((tool) => installToolHooks(opts.root, tool));
  for (const h of hookFiles) if (h.note) notes.push(`${h.file}: ${h.note}`);
  if (opts.tools.includes('codex')) notes.push('Codex: approve the project hooks once with /hooks (Codex asks to trust new hooks).');
  if (opts.tools.includes('cursor')) notes.push('Cursor: hooks run only in a trusted workspace.');

  if (upsertBlock(path.join(opts.root, '.gitattributes'), ATTR_BLOCK)) written.push('.gitattributes');

  const gitHooks = opts.gitHooks ? ensureGitHooks(opts.root, { allowTrackedDir: true }) : null;
  if (gitHooks?.reason) notes.push(`git hooks: ${gitHooks.reason}`);

  const cfg = loadConfig(paths);
  const db = StateDb.open(paths.stateDb);
  try {
    const result = compile(paths, cfg, db, { tool: 'cli' });
    return { root: opts.root, written, notes, hookFiles, gitHooks, compile: result };
  } finally {
    db.close();
  }
}
