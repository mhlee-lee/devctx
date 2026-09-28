import fs from 'node:fs';
import path from 'node:path';
import { compile } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { hookInstalled, HOOK_FILES } from './init/hookconfigs.ts';
import { gitHooksInstalled } from './init/githooks.ts';
import { readToolsLock } from './init/shim.ts';
import { loadItems, loadPersonalItems } from './knowledge/store.ts';
import { getProvider } from './llm/providers/index.ts';
import { cachedSelection, providerBlocks, providerOrder } from './llm/router.ts';
import { SUITE_TASKS } from './llm/suite.ts';
import { StateDb } from './state/db.ts';
import { readText } from './util/fsx.ts';
import { projectPaths } from './util/paths.ts';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  level: CheckLevel;
  name: string;
  detail: string;
}

function nodeOk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function recentErrors(logFile: string, limit: number): string[] {
  const text = readText(logFile);
  if (!text) return [];
  return text
    .trim()
    .split('\n')
    .slice(-200)
    .map((l) => {
      try {
        return JSON.parse(l) as { level: string; message: string; ts: string; error?: string };
      } catch {
        return null;
      }
    })
    .filter((e): e is { level: string; message: string; ts: string; error?: string } => e !== null && e.level === 'error')
    .slice(-limit)
    .map((e) => `${e.ts.slice(0, 16)} ${e.message}${e.error ? `: ${e.error}` : ''}`);
}

/** Health checks for `devctx doctor`. Everything here is local and makes no LLM calls. */
export async function runDoctor(root: string, host: string | null): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (level: CheckLevel, name: string, detail: string): void => {
    checks.push({ level, name, detail });
  };
  const paths = projectPaths(root);
  if (!fs.existsSync(paths.config)) {
    add('fail', 'project', `.devctx/config.yaml not found under ${root} (run "devctx init")`);
    return checks;
  }
  const cfg = loadConfig(paths);
  add(nodeOk() ? 'ok' : 'fail', 'node', `v${process.versions.node} (needs >= 22.13 for node:sqlite)`);

  const { items, errors } = loadItems(paths);
  const count = (s: string): number => items.filter((i) => i.status === s).length;
  add(
    errors.length > 0 ? 'warn' : 'ok',
    'knowledge',
    `${count('active')} active, ${count('proposed')} proposed, ${count('conflict')} conflict, ${count('superseded')} superseded, ${items.filter((i) => i.needs_review).length} need review, ${loadPersonalItems().items.length} personal` +
      (errors.length > 0 ? `; unreadable: ${errors.map((e) => path.basename(e.file)).join(', ')}` : ''),
  );

  const check = compile(paths, cfg, null, { check: true });
  add(check.drift.length > 0 ? 'warn' : 'ok', 'generated files', check.drift.length > 0 ? `out of date: ${check.drift.join(', ')} (run "devctx compile")` : 'up to date');
  add(
    check.plan.overflow.length > 0 ? 'warn' : 'ok',
    'token budget',
    `core ${check.plan.coreTokens}/${cfg.inject.core_budget_tokens} tokens, scoped ${check.plan.scopedTokens} tokens (${check.plan.scopedInAgents ? 'inside AGENTS.md' : 'per-tool path rules'})`,
  );
  for (const w of check.warnings) add('warn', 'compile', w);

  for (const tool of cfg.targets) {
    add(hookInstalled(root, tool) ? 'ok' : 'fail', `hooks:${tool}`, hookInstalled(root, tool) ? HOOK_FILES[tool] : `missing in ${HOOK_FILES[tool]} (run "devctx init")`);
  }
  const claudeMd = readText(path.join(root, 'CLAUDE.md'));
  if (claudeMd !== null && cfg.targets.includes('claude')) {
    add(/^@AGENTS\.md\s*$/m.test(claudeMd) ? 'ok' : 'warn', 'CLAUDE.md', /^@AGENTS\.md\s*$/m.test(claudeMd) ? 'imports AGENTS.md' : 'does not import @AGENTS.md; Claude Code will not see the rules');
  }
  add(gitHooksInstalled(root) ? 'ok' : 'warn', 'git hooks', gitHooksInstalled(root) ? 'installed' : 'missing (installed automatically at the next session start)');

  let shimOk = false;
  try {
    fs.accessSync(paths.shim, fs.constants.X_OK);
    shimOk = true;
  } catch {
    shimOk = false;
  }
  const lock = readToolsLock(paths.toolsLock);
  add(shimOk && lock ? 'ok' : 'fail', 'shim', `${shimOk ? '.devctx/bin/devctx' : 'missing .devctx/bin/devctx'}; tools.lock ${lock ? `${lock.version} from ${lock.source}` : 'missing'}`);
  if (lock && path.isAbsolute(lock.source)) {
    const exists = fs.existsSync(path.join(lock.source, 'dist', 'cli.js')) || fs.existsSync(path.join(lock.source, 'src', 'cli.ts'));
    add(exists ? 'warn' : 'fail', 'devctx source', `${lock.source} is a local path${exists ? '' : ' that does not exist'}; teammates need a git URL or npm spec`);
  }

  const db = StateDb.open(paths.stateDb);
  try {
    const pending = db.countPending();
    add(pending > 20 ? 'warn' : 'ok', 'events', `${pending} pending`);
    const usage = db.llmUsageSummary(new Date(Date.now() - 7 * 86_400_000).toISOString());
    add('ok', 'llm usage (7d)', usage.length === 0 ? 'no calls' : usage.map((u) => `${u.model} ${u.task} x${u.calls} (ok ${u.ok})`).join('; '));
  } finally {
    db.close();
  }

  const available: string[] = [];
  const blocks = providerBlocks();
  for (const pid of providerOrder(cfg, host)) {
    const bin = await getProvider(pid).resolveBinary();
    available.push(`${pid}${bin ? '' : ' (not installed)'}${blocks[pid] ? ` (skipped: ${blocks[pid].kind})` : ''}`);
  }
  add(available.some((a) => !a.includes('(')) ? 'ok' : 'warn', 'llm providers', available.join(', '));
  const selection = cachedSelection(cfg, host);
  const routing = SUITE_TASKS.map((task) => `${task}: ${selection.find((s) => s.task === task && s.key)?.key ?? 'not evaluated yet'}`);
  add('ok', 'llm routing', `${routing.join('; ')} (details: devctx models)`);
  for (const [pid, b] of Object.entries(blocks)) {
    const hint = b.kind === 'auth' ? `log in again by running "${pid}"` : 'usage limit reached; other installed tools are used meanwhile';
    add('warn', `llm ${pid}`, `${hint} (retry after ${b.until.slice(0, 16)}Z)`);
  }
  for (const e of recentErrors(paths.log, 3)) add('warn', 'recent error', e);
  return checks;
}
