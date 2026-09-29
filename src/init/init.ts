import fs from 'node:fs';
import path from 'node:path';
import { compile, isManagedAgentsMd, type CompileResult } from '../compile/compile.ts';
import { loadConfig, renderConfigYaml } from '../config.ts';
import { StateDb } from '../state/db.ts';
import type { Language, ToolId } from '../types.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';
import { projectPaths } from '../util/paths.ts';
import { ensureGitAttributes } from './attributes.ts';
import { ensureGitHooks, type GitHookResult } from './githooks.ts';
import { installAgentAccess, removeLegacyMcp, type AccessResult } from './access.ts';
import { installToolHooks, type HookFileResult } from './hookconfigs.ts';
import { defaultSource, packageInfo, renderShim, renderToolsLock } from './shim.ts';

export interface InitOptions {
  root: string;
  tools: ToolId[];
  source: string | null;
  language: Language;
  gitHooks: boolean;
  force: boolean;
  /** Built-in code index for a new config (default on). */
  codeIndex?: boolean;
}

export interface InitReport {
  root: string;
  written: string[];
  notes: string[];
  hookFiles: HookFileResult[];
  /** Skill files, permission settings and removed legacy MCP entries. */
  accessFiles: AccessResult[];
  gitHooks: GitHookResult | null;
  compile: CompileResult;
}

function writeIfMissing(file: string, content: string, written: string[], root: string, force = false, mode?: number): boolean {
  if (!force && fs.existsSync(file)) return false;
  writeFileAtomic(file, content, mode);
  written.push(path.relative(root, file));
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
  if (!writeIfMissing(paths.config, renderConfigYaml(opts.tools, opts.language, opts.codeIndex ?? true), written, opts.root, opts.force)) {
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

  const codeCfg = loadConfig(paths);
  const codeIndex = codeCfg.code_index.enabled;
  const accessFiles = [
    ...removeLegacyMcp(opts.root),
    ...installAgentAccess(opts.root, opts.tools, { enabled: codeIndex, preapprove: codeCfg.code_index.preapprove, language: codeCfg.language }),
  ];
  for (const a of accessFiles) if (a.note) notes.push(`${a.file}: ${a.note}`);
  if (codeIndex) {
    notes.push('code index: agents use it through the "devctx-code" skill (.devctx/bin/devctx code …); each clone indexes in the background at its first session.');
    if (codeCfg.code_index.preapprove) notes.push('code index: the skill command is pre-approved per tool (turn off with code_index.preapprove: false).');
  }
  if (opts.tools.includes('codex')) notes.push('Codex: approve the project hooks once with /hooks (Codex asks to trust new hooks).');
  if (opts.tools.includes('cursor')) notes.push('Cursor: hooks run only in a trusted workspace.');

  if (ensureGitAttributes(opts.root)) written.push('.gitattributes');

  const gitHooks = opts.gitHooks ? ensureGitHooks(opts.root, { allowTrackedDir: true }) : null;
  if (gitHooks?.reason) notes.push(`git hooks: ${gitHooks.reason}`);

  const cfg = loadConfig(paths);
  const db = StateDb.open(paths.stateDb);
  try {
    const result = compile(paths, cfg, db, { tool: 'cli' });
    return { root: opts.root, written, notes, hookFiles, accessFiles, gitHooks, compile: result };
  } finally {
    db.close();
  }
}
