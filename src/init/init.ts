import fs from 'node:fs';
import path from 'node:path';
import { compile, type CompileResult } from '../compile/compile.ts';
import { hasAgentsBlock, isLegacyAgentsMd, renderAgentsBlock, withAgentsBlock } from '../compile/render.ts';
import { loadConfig, renderConfigYaml } from '../config.ts';
import { StateDb } from '../state/db.ts';
import type { Language, ToolId } from '../types.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';
import { projectPaths } from '../util/paths.ts';
import { ensureGitAttributes, ensureGitIgnore, untrackGenerated } from './attributes.ts';
import { git } from '../util/git.ts';
import { ensureGitHooks, type GitHookResult } from './githooks.ts';
import { installAgentAccess, removeLegacyMcp, type AccessResult } from './access.ts';
import { installToolHooks, type HookFileResult } from './hookconfigs.ts';
import { defaultSource, npmSpecVersion, packageInfo, readToolsLock, renderShim, renderToolsLock, sourcePinProblem } from './shim.ts';

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
  /** What to commit so teammates get the same setup: paths with changes, ready for `git add`. */
  commitPaths: string[];
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

  // tools.lock is the team's pin: re-running init (to refresh hooks or skills) never moves it.
  // Only --source does, and then the version follows that source, so the two can't disagree.
  const running = packageInfo().version;
  const existing = readToolsLock(paths.toolsLock);
  let lock: { version: string; source: string };
  if (opts.source) {
    lock = { version: npmSpecVersion(opts.source) ?? running, source: opts.source };
  } else if (existing?.source && existing.version && !path.isAbsolute(existing.source)) {
    lock = existing;
    if (existing.version !== running) {
      notes.push(
        `tools.lock stays at ${existing.version} (${existing.source}); this devctx is ${running}. To move the team: devctx init --source <spec of ${running}>.`,
      );
    }
  } else {
    lock = { version: running, source: existing?.source || defaultSource() };
  }
  const source = lock.source;
  writeFileAtomic(paths.toolsLock, renderToolsLock(lock));
  written.push('.devctx/tools.lock');
  if (path.isAbsolute(source)) {
    notes.push(`tools.lock points at a local path (${source}); teammates need a git URL or npm spec there.`);
  } else {
    const pin = sourcePinProblem(source);
    if (pin) notes.push(`tools.lock source ${source}: ${pin}. Every clone installs and runs it from hooks.`);
  }
  writeFileAtomic(paths.shim, renderShim(), 0o755);
  written.push('.devctx/bin/devctx');

  // AGENTS.md stays the people's file: devctx adds one fixed block that points at the decisions
  // (an AGENTS.md an earlier version generated is converted by compile below).
  const agents = readText(paths.agentsMd);
  if (!isLegacyAgentsMd(agents) && !hasAgentsBlock(agents)) {
    const lang = loadConfig(paths).language;
    writeFileAtomic(paths.agentsMd, withAgentsBlock(agents, renderAgentsBlock(lang, loadConfig(paths).code_index.enabled), lang));
    written.push('AGENTS.md');
    notes.push(agents === null ? 'AGENTS.md created with the devctx block.' : 'AGENTS.md: added the devctx block at the end; the rest of the file is unchanged.');
  }

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
  if (ensureGitIgnore(opts.root)) written.push('.gitignore');
  const untracked = untrackGenerated(opts.root);
  if (untracked.length > 0) notes.push(`stopped tracking ${untracked.length} generated rule file(s) an earlier version committed (each PC builds them now; the removal is staged)`);

  const gitHooks = opts.gitHooks ? ensureGitHooks(opts.root, { allowTrackedDir: true }) : null;
  if (gitHooks?.reason) notes.push(`git hooks: ${gitHooks.reason}`);

  const cfg = loadConfig(paths);
  const db = StateDb.open(paths.stateDb);
  try {
    const result = compile(paths, cfg, db, { tool: 'cli', manual: true });
    if (result.agents === 'migrated') notes.push('AGENTS.md: the file an earlier version generated now holds your text from preamble.md plus the devctx block (preamble.md removed).');
    return { root: opts.root, commitPaths: changedPaths(opts.root), written, notes, hookFiles, accessFiles, gitHooks, compile: result };
  } finally {
    db.close();
  }
}

/** Everything init may have created or changed, as far as git sees a change there. */
const SETUP_PATHS = ['.devctx', 'AGENTS.md', 'CLAUDE.md', '.gitattributes', '.gitignore', '.claude', '.codex', '.github/hooks', '.github/instructions', '.agents', '.cursor', '.kiro', '.vscode/settings.json'];

/**
 * The setup paths with something to commit: changed or new in the working tree, or staged (e.g. a
 * generated file `init` stopped tracking). Read from name lists, not `git status` lines, whose
 * leading status column the trimmed output would cut off (that dropped CLAUDE.md).
 */
function changedPaths(root: string): string[] {
  const names = (args: string[]): string[] => {
    const r = git([...args, '--', ...SETUP_PATHS], root, 10_000);
    return r.ok ? r.stdout.split('\0').filter(Boolean) : [];
  };
  const files = [
    ...names(['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard']),
    ...names(['diff', '--cached', '--name-only', '-z']),
  ];
  const touched = new Set<string>();
  for (const file of files) {
    const top = SETUP_PATHS.find((p) => file === p || file.startsWith(`${p}/`));
    if (top) touched.add(top);
  }
  return SETUP_PATHS.filter((p) => touched.has(p));
}
