import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, type DevctxConfig } from '../config.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import { applyCachedStale, loadTeam } from '../knowledge/view.ts';
import { searchHistory } from '../recall.ts';
import { StateDb } from '../state/db.ts';
import { errorMessage, logLine } from '../util/log.ts';
import { git } from '../util/git.ts';
import { cliEntry, projectPaths } from '../util/paths.ts';
import { codeDbPath, indexingInProgress, listRepoFiles } from './files.ts';
import { loadGraph } from './load.ts';
import { familyOf, languageOf } from './languages.ts';
import { changeImpact, deletedFiles, fileOutline, getSymbol, overview, searchSymbols, searchText, traceCalls, type RemovedFile } from './queries.ts';
import { indexPass } from './service.ts';
import { pendingChanges } from './sync.ts';
import { codeTool, CodeToolError, usageLine, validateToolArgs } from './tools-meta.ts';

/**
 * Names declared by files deleted against `base`, parsed from their previous version (the index no
 * longer has them), so change_impact can show code that still uses them.
 */
async function removedSymbols(root: string, base: string): Promise<RemovedFile[]> {
  if (!/^[\w./~^@{}][\w./~^@{}-]*$/.test(base)) return [];
  const rev = base === 'staged' ? 'HEAD' : base;
  const out: RemovedFile[] = [];
  for (const rel of deletedFiles(root, base).slice(0, 30)) {
    const spec = languageOf(rel);
    if (!spec) continue;
    const old = git(['show', `${rev}:${rel}`], root, 10_000);
    if (!old.ok || old.stdout.length > 512 * 1024) continue;
    try {
      const { extractFacts } = await import('./extract/index.ts');
      const facts = await extractFacts(spec.id, old.stdout, rel);
      out.push({ path: rel, family: familyOf(spec.id), names: [...new Set(facts.syms.map((s) => s.name))] });
    } catch {
      // Unparseable old version: the file is still listed as deleted.
    }
  }
  return out;
}

/**
 * `devctx code <tool>`: the code index as plain commands. Agents run them through their shell
 * (the `devctx-code` skill documents them); every call brings the index up to date first, then
 * answers from the cached graph snapshot.
 */

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Changed files one query may parse itself; more go to a background indexer it waits for. */
const IN_PROCESS_FILES = 150;
/** Longest wait for an index being built before answering from what exists. */
const FIRST_INDEX_WAIT_MS = 45_000;
const UPDATE_WAIT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhileIndexing(root: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (indexingInProgress(root)) {
    if (Date.now() > until) return false;
    await sleep(200);
  }
  return true;
}

/**
 * Runs `devctx code index` detached (it outlives this process) and waits up to `ms` for it.
 * Parsing thousands of files is left to that process and its memory-capped passes.
 */
function backgroundIndex(root: string, ms: number): Promise<boolean> {
  const entry = cliEntry();
  if (!entry) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Keep indexing after this query answers; the next query picks up the result.
      child?.unref();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    try {
      child = spawn(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--inspect')), entry, 'code', 'index', '--root', root], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DEVCTX_WORKER: '1' },
      });
      child.on('exit', (code) => finish(code === 0));
      child.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** Brings the index up to date with the working tree; returns notes for the answer. */
async function ensureFresh(root: string, cfg: DevctxConfig): Promise<string[]> {
  const notes: string[] = [];
  const hadIndex = fs.existsSync(codeDbPath(root));
  if (indexingInProgress(root) && !(await waitWhileIndexing(root, hadIndex ? UPDATE_WAIT_MS : FIRST_INDEX_WAIT_MS))) {
    notes.push('note: the index is still being updated in the background; results may be incomplete.');
    return notes;
  }
  let pending = 0;
  try {
    pending = pendingChanges(root, cfg);
  } catch {
    pending = 0;
  }
  if (pending === 0) return notes;
  if (pending <= IN_PROCESS_FILES) {
    try {
      const res = await indexPass(root, cfg);
      if (res.error === 'another devctx process is indexing') await waitWhileIndexing(root, UPDATE_WAIT_MS);
      else if (res.error) notes.push(`note: could not update the index (${res.error}); answering from the last index.`);
    } catch (error) {
      // Read-only checkout or sandbox: the last index is still useful.
      notes.push(`note: could not update the index here (${errorMessage(error).slice(0, 80)}); answering from the last index.`);
    }
    return notes;
  }
  if (!(await backgroundIndex(root, FIRST_INDEX_WAIT_MS))) {
    notes.push(
      hadIndex
        ? 'note: many files changed; the index is catching up in the background, so results may be incomplete.'
        : 'note: the first index of this repository is still being built in the background.',
    );
  }
  return notes;
}

function decisions(root: string, cfg: DevctxConfig): KnowledgeItem[] {
  const paths = projectPaths(root);
  let db: StateDb | null = null;
  try {
    db = StateDb.open(paths.stateDb);
  } catch {
    db = null; // read-only checkout: parse without the cache
  }
  try {
    const items = loadTeam(paths, db, { proposedTtlDays: cfg.memory.proposed_ttl_days }).items;
    if (db) applyCachedStale(db, items);
    return items;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Runs one tool and returns its text answer. */
export async function runCodeTool(root: string, name: string, args: Args): Promise<string> {
  const paths = projectPaths(root);
  const cfg = loadConfig(paths);
  const tool = codeTool(name);
  // Past work needs no code index: it answers also with code_index.enabled: false.
  if (tool?.name !== 'search_history' && !cfg.code_index.enabled) return 'The code index is turned off for this repository (code_index.enabled: false in .devctx/config.yaml).';
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const missing = tool.args.find((a) => a.required && args[a.name] === undefined);
  if (missing) throw new CodeToolError(`missing <${missing.name}>. usage: ${usageLine(tool, '.devctx/bin/devctx code')}`);
  args = validateToolArgs(tool, args);
  if (tool.name === 'search_history') {
    return searchHistory(root, str(args, 'query') ?? '', { ...optional('days', num(args, 'days')), ...optional('limit', num(args, 'limit')) });
  }
  if (tool.name === 'search_text') {
    return searchText(root, str(args, 'pattern') ?? '', {
      regex: bool(args, 'regex') ?? false,
      ignoreCase: bool(args, 'ignore_case') ?? false,
      ...optional('path', str(args, 'path')),
      ...optional('limit', num(args, 'limit')),
    });
  }
  const notes = await ensureFresh(root, cfg);
  let g;
  try {
    g = loadGraph(root);
  } catch (error) {
    logLine(paths.log, 'warn', 'code graph load failed', { error: errorMessage(error) });
    g = null;
  }
  if (!g) return [...notes, 'The code index is not built yet. Retry in a minute, or use search_text now.'].join('\n');
  let text: string;
  switch (tool.name) {
    case 'search_symbols':
      text = searchSymbols(g, str(args, 'query') ?? '', { ...optional('kind', str(args, 'kind')), ...optional('path', str(args, 'path')), ...optional('limit', num(args, 'limit')) });
      break;
    case 'get_symbol':
      text = getSymbol(g, root, str(args, 'target') ?? '', { code: bool(args, 'include_code') ?? true, decisions: decisions(root, cfg) });
      break;
    case 'trace_calls':
      text = traceCalls(g, str(args, 'target') ?? '', { ...optional('direction', str(args, 'direction')), ...optional('depth', num(args, 'depth')) });
      break;
    case 'file_outline':
      text = fileOutline(g, str(args, 'path') ?? '');
      break;
    case 'repo_overview':
      text = overview(g, listRepoFiles(root), { ...optional('path', str(args, 'path')) });
      break;
    case 'change_impact': {
      const base = str(args, 'base')?.trim() || 'HEAD';
      text = changeImpact(g, root, { base, ...optional('depth', num(args, 'depth')), decisions: decisions(root, cfg), removed: await removedSymbols(root, base) });
      break;
    }
    default:
      throw new Error(`unknown tool: ${tool.name}`);
  }
  return notes.length > 0 ? `${notes.join('\n')}\n${text}` : text;
}
