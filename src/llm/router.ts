import path from 'node:path';
import type { DevctxConfig } from '../config.ts';
import type { StateDb } from '../state/db.ts';
import { isToolId } from '../types.ts';
import { readJson, writeJsonAtomic } from '../util/fsx.ts';
import { machineDir } from '../util/paths.ts';
import { callCostUsd, rankModels, type CostEstimate } from './catalog.ts';
import { pickAnswer } from './json.ts';
import { getProvider } from './providers/index.ts';
import { qualifyModel, type QualifyResult } from './qualify.ts';
import { SUITE_TASKS, SUITE_VERSIONS, suiteCalls, suiteCurrent, type SuiteTask } from './suite.ts';
import {
  candidateKey,
  TIERS,
  type FailureKind,
  type LlmRequest,
  type ModelCandidate,
  type Provider,
  type ProviderId,
  type Tier,
} from './types.ts';

export const RATE_LIMIT_ERROR = 'hourly LLM call limit reached';

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const QUALIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A candidate whose evaluation could not run (timeout, CLI error) is skipped this long. */
const ERROR_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_TRIES_PER_PROVIDER = 2;
/** Evaluations one call may start when the caller does not share a budget. */
const DEFAULT_QUALIFY_BUDGET = 2;
/** Runtime answers in a row that break a requirement before a qualified model is demoted. */
const QUALITY_STRIKES = 2;
/** How long a provider is skipped after an account problem. */
const BLOCK_TTL_MS: Partial<Record<FailureKind, number>> = { auth: 30 * 60 * 1000, quota: 6 * 60 * 60 * 1000 };

export interface Qualification {
  /** pass/fail: verdict of the requirement suite. error: the evaluation could not run. */
  status: 'pass' | 'fail' | 'error';
  task: SuiteTask;
  suite: number;
  runs: number;
  score: number;
  total: number;
  at: string;
  version: string | null;
  details: string[];
  avgCostUsd: number | null;
}

export interface Stats {
  ok: number;
  fail: number;
  consecutiveFail: number;
  lastError: string | null;
  lastUsed: string | null;
  /** Measured spend of calls whose cost is known. */
  costUsd: number;
  costCalls: number;
  /** Runtime answers in a row that broke a requirement, per task. */
  strikes: Partial<Record<SuiteTask, number>>;
}

export interface ProviderBlock {
  kind: FailureKind;
  error: string;
  until: string;
}

interface RouterCache {
  version: 2;
  discovery: Record<string, { bin: string; version: string | null; at: string; models: ModelCandidate[] }>;
  /** Keyed by `${candidateKey}#${task}`. */
  qualification: Record<string, Qualification>;
  /** Keyed by candidateKey. */
  stats: Record<string, Stats>;
  blocked: Record<string, ProviderBlock>;
}

export interface RouteOptions {
  cfg: DevctxConfig;
  /** Tool the user is working in; its CLI is tried first (same account, same data policy). */
  host: string | null;
  db: StateDb | null;
  /** Evaluations spend calls, so only the background worker allows them. */
  allowQualify: boolean;
  /** Shared between calls so one worker run starts a bounded number of evaluations. */
  qualifyBudget?: { remaining: number };
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export type RouteResult<T> =
  | { ok: true; value: T; provider: ProviderId; model: string }
  | { ok: false; error: string; attempts: string[] };

function cacheFile(): string {
  return path.join(machineDir(), 'router.json');
}

function emptyStats(): Stats {
  return { ok: 0, fail: 0, consecutiveFail: 0, lastError: null, lastUsed: null, costUsd: 0, costCalls: 0, strikes: {} };
}

function loadCache(): RouterCache {
  const c = readJson<Partial<RouterCache> & { version?: number } | null>(cacheFile(), null);
  if (c && c.version === 2) {
    return { version: 2, discovery: c.discovery ?? {}, qualification: c.qualification ?? {}, stats: c.stats ?? {}, blocked: c.blocked ?? {} };
  }
  // Version 1 verdicts came from a smaller suite: keep discovery and usage, re-evaluate models.
  const stats: Record<string, Stats> = {};
  for (const [key, s] of Object.entries(c?.stats ?? {})) stats[key] = { ...emptyStats(), ...s, strikes: {} };
  return { version: 2, discovery: c?.discovery ?? {}, qualification: {}, stats, blocked: c?.blocked ?? {} };
}

function saveCache(cache: RouterCache): void {
  try {
    writeJsonAtomic(cacheFile(), cache);
  } catch {
    // cache is an optimization
  }
}

function qKey(key: string, task: SuiteTask): string {
  return `${key}#${task}`;
}

export function taskOf(req: Pick<LlmRequest, 'task'>): SuiteTask {
  return req.task === 'judge' || req.task === 'summarize' ? req.task : 'extract';
}

function activeBlock(cache: RouterCache, pid: ProviderId): ProviderBlock | null {
  const b = cache.blocked[pid];
  if (!b) return null;
  if (Date.parse(b.until) <= Date.now()) {
    delete cache.blocked[pid];
    return null;
  }
  return b;
}

function block(cache: RouterCache, pid: ProviderId, kind: FailureKind, error: string): void {
  const ttl = BLOCK_TTL_MS[kind];
  if (!ttl) return;
  cache.blocked[pid] = { kind, error: error.slice(0, 300), until: new Date(Date.now() + ttl).toISOString() };
}

/** Providers currently skipped because of login or quota problems (for `devctx doctor`). */
export function providerBlocks(): Record<string, ProviderBlock> {
  const cache = loadCache();
  const out: Record<string, ProviderBlock> = {};
  for (const [pid, b] of Object.entries(cache.blocked)) if (Date.parse(b.until) > Date.now()) out[pid] = b;
  return out;
}

export function providerOrder(cfg: DevctxConfig, host: string | null): ProviderId[] {
  if (process.env.DEVCTX_FAKE_LLM) return ['fake'];
  const order: ProviderId[] = [];
  if (cfg.llm.prefer_host_tool && isToolId(host)) order.push(host);
  for (const p of cfg.llm.providers) if (!order.includes(p)) order.push(p);
  return order;
}

async function discover(
  provider: Provider,
  bin: string,
  cfg: DevctxConfig,
  cache: RouterCache,
  force: boolean,
): Promise<{ version: string | null; models: ModelCandidate[] }> {
  const prev = cache.discovery[provider.id];
  const version = await provider.version(bin);
  let models: ModelCandidate[];
  if (!force && prev && prev.bin === bin && prev.version === version && Date.now() - Date.parse(prev.at) < DISCOVERY_TTL_MS && prev.models.length > 0) {
    models = prev.models;
  } else {
    try {
      models = await provider.discover(bin);
    } catch {
      models = [];
    }
    if (models.length === 0 && prev) models = prev.models;
    cache.discovery[provider.id] = { bin, version, at: new Date().toISOString(), models };
  }
  const pin = provider.id === 'fake' ? undefined : cfg.llm.pin[provider.id];
  if (pin) {
    models = [
      { provider: provider.id, id: pin, extraArgs: [], effort: null, description: 'pinned in .devctx/config.yaml', source: 'pinned' },
      ...models.filter((m) => m.id !== pin),
    ];
  }
  return { version, models };
}

/** Candidates in expected-cost order, up to the configured tier (a pinned model always stays). */
function candidates(models: readonly ModelCandidate[], maxTier: Tier): { model: ModelCandidate; estimate: CostEstimate }[] {
  const limit = TIERS.indexOf(maxTier);
  return rankModels(models).filter((r) => r.model.source === 'pinned' || TIERS.indexOf(r.estimate.tier) <= limit);
}

/** Pinned models, the test provider and `qualify: false` skip the requirement suite. */
function trusted(cfg: DevctxConfig, model: ModelCandidate): boolean {
  return model.source === 'pinned' || model.provider === 'fake' || !cfg.llm.qualify;
}

function qualificationFor(cache: RouterCache, key: string, task: SuiteTask, version: string | null): Qualification | null {
  const q = cache.qualification[qKey(key, task)];
  if (!q || !suiteCurrent(task, q.suite) || q.version !== version) return null;
  const age = Date.now() - Date.parse(q.at);
  if (age > (q.status === 'error' ? ERROR_BACKOFF_MS : QUALIFICATION_TTL_MS)) return null;
  return q;
}

function storeQualification(cache: RouterCache, key: string, version: string | null, res: QualifyResult): void {
  cache.qualification[qKey(key, res.task)] = {
    status: res.blocked ? 'error' : res.pass ? 'pass' : 'fail',
    task: res.task,
    suite: SUITE_VERSIONS[res.task],
    runs: res.runs,
    score: res.score,
    total: res.total,
    at: new Date().toISOString(),
    version,
    details: res.details,
    avgCostUsd: res.avgCostUsd,
  };
}

function statsFor(cache: RouterCache, key: string): Stats {
  const s = cache.stats[key] ?? emptyStats();
  s.strikes ??= {};
  cache.stats[key] = s;
  return s;
}

function addCost(s: Stats, costUsd: number | null): void {
  if (typeof costUsd !== 'number') return;
  s.costUsd += costUsd;
  s.costCalls += 1;
}

function bumpStats(cache: RouterCache, key: string, ok: boolean, error: string | null, costUsd: number | null): Stats {
  const s = statsFor(cache, key);
  if (ok) {
    s.ok++;
    s.consecutiveFail = 0;
  } else {
    s.fail++;
    s.consecutiveFail++;
    s.lastError = error;
  }
  addCost(s, costUsd);
  s.lastUsed = new Date().toISOString();
  return s;
}

async function runQualification(
  provider: Provider,
  bin: string,
  model: ModelCandidate,
  task: SuiteTask,
  version: string | null,
  cache: RouterCache,
  cfg: DevctxConfig,
  db: StateDb | null,
): Promise<QualifyResult> {
  const key = candidateKey(model);
  const res = await qualifyModel(provider, bin, model, task, cfg.language, cfg.llm.timeout_seconds * 1000, cfg.llm.qualify_runs);
  const s = statsFor(cache, key);
  for (const c of res.calls) {
    addCost(s, c.costUsd);
    db?.recordLlmCall({ provider: provider.id, model: key, task: `qualify:${task}`, ok: c.ok, ms: c.ms, costUsd: c.costUsd, error: c.error ?? null });
  }
  if (res.blocked === 'auth' || res.blocked === 'quota') {
    block(cache, provider.id, res.blocked, res.details.join(' '));
  } else {
    storeQualification(cache, key, version, res);
  }
  return res;
}

/** History summaries (and their model evaluations) have their own hourly budget. */
const HISTORY_TASKS = ['summarize', 'qualify:summarize'];

/**
 * Calls left this hour for the task's budget: `history.max_calls_per_hour` for summaries,
 * `llm.max_calls_per_hour` for everything else. Counted from recorded calls, so it holds across
 * worker runs; checked before every call, retries and model evaluations included.
 */
export function callsLeft(cfg: DevctxConfig, db: StateDb | null, task: SuiteTask): number {
  if (!db) return Number.POSITIVE_INFINITY;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const history = task === 'summarize';
  const used = db.llmCallsSince(hourAgo, history ? { tasks: HISTORY_TASKS } : { excludeTasks: HISTORY_TASKS });
  return (history ? cfg.history.max_calls_per_hour : cfg.llm.max_calls_per_hour) - used;
}

/**
 * Sends one structured request to the cheapest model that meets every requirement of the task:
 * host tool first, then the configured provider order. Inside a provider, candidates (model x
 * reasoning effort) are tried in expected-cost order and a candidate is only used after it passes
 * the task's requirement suite in every run. New models show up through each CLI's own discovery;
 * a qualified model that later breaks requirements at runtime is demoted. Login or quota problems
 * skip the provider for a while instead of failing the model.
 */
export async function routeCall<T>(req: LlmRequest, parse: (data: unknown) => T | null, opts: RouteOptions): Promise<RouteResult<T>> {
  const { cfg, db } = opts;
  const task = taskOf(req);
  const attempts: string[] = [];
  const limit = task === 'summarize' ? cfg.history.max_calls_per_hour : cfg.llm.max_calls_per_hour;
  if (callsLeft(cfg, db, task) <= 0) return { ok: false, error: RATE_LIMIT_ERROR, attempts };
  // An evaluation runs the whole suite. It must fit the hour's remaining calls; one that is larger
  // than the whole hourly limit may only start in an hour with no calls yet.
  const evaluationCalls = suiteCalls(task, cfg.language).length * cfg.llm.qualify_runs;
  let limited = false;
  const cache = loadCache();
  const budget = opts.qualifyBudget ?? { remaining: DEFAULT_QUALIFY_BUDGET };
  try {
    providers: for (const pid of providerOrder(cfg, opts.host)) {
      const blocked = activeBlock(cache, pid);
      if (blocked) {
        attempts.push(`${pid}: skipped (${blocked.kind} until ${blocked.until.slice(11, 16)}Z)`);
        continue;
      }
      const provider = getProvider(pid);
      const bin = await provider.resolveBinary();
      if (!bin) {
        attempts.push(`${pid}: not installed`);
        continue;
      }
      const { version, models } = await discover(provider, bin, cfg, cache, false);
      const ranked = candidates(models, cfg.llm.max_tier);
      if (ranked.length === 0) {
        attempts.push(`${pid}: no usable models`);
        continue;
      }
      let tries = 0;
      let providerBlocked = false;
      for (const { model } of ranked) {
        if (tries >= MAX_TRIES_PER_PROVIDER) break;
        const key = candidateKey(model);
        if (!trusted(cfg, model)) {
          const q = qualificationFor(cache, key, task, version);
          if (q && q.status !== 'pass') continue; // failed, or its evaluation errored recently
          if (!q) {
            if (!opts.allowQualify || budget.remaining <= 0) continue;
            if (callsLeft(cfg, db, task) < Math.min(evaluationCalls, limit)) {
              limited = true;
              break providers;
            }
            budget.remaining--;
            const res = await runQualification(provider, bin, model, task, version, cache, cfg, db);
            opts.log?.('qualification', { model: key, task, pass: res.pass, score: `${res.score}/${res.total}`, blocked: res.blocked });
            attempts.push(`${key}: ${task} evaluation ${res.blocked ? `could not run (${res.blocked})` : res.pass ? 'passed' : 'failed'} ${res.score}/${res.total}`);
            if (res.blocked === 'auth' || res.blocked === 'quota') {
              providerBlocked = true;
              break;
            }
            if (!res.pass) continue;
          }
        }
        tries++;
        if (callsLeft(cfg, db, task) <= 0) {
          limited = true;
          break providers;
        }
        const raw = await provider.run(bin, model, req);
        const value = raw.ok ? pickAnswer(raw.data, raw.text, parse) : null;
        const ok = value !== null;
        const error = ok ? null : raw.error ?? 'answer did not match the expected shape';
        const costUsd = callCostUsd(model, raw);
        const stats = bumpStats(cache, key, ok, error, costUsd);
        db?.recordLlmCall({ provider: pid, model: key, task: req.task, ok, ms: raw.ms, costUsd, error });
        if (ok) return { ok: true, value, provider: pid, model: key };
        attempts.push(`${key}: ${error}`);
        if (raw.kind === 'auth' || raw.kind === 'quota') {
          block(cache, pid, raw.kind, error ?? raw.kind);
          providerBlocked = true;
          break;
        }
        // A model that keeps failing gets re-evaluated next time instead of being trusted.
        if (stats.consecutiveFail >= 3) delete cache.qualification[qKey(key, task)];
      }
      if (providerBlocked) opts.log?.('provider blocked', { provider: pid });
    }
    // Out of calls for this hour: callers keep the work for later instead of falling back.
    if (limited) return { ok: false, error: RATE_LIMIT_ERROR, attempts };
    return { ok: false, error: 'no provider produced a valid answer', attempts };
  } finally {
    saveCache(cache);
  }
}

/**
 * Feedback from the caller after validating a routed answer against production rules (for
 * example evidence quotes that are not verbatim). A qualified model that breaks requirements
 * QUALITY_STRIKES times in a row loses its pass, so the next cheapest qualified model takes over.
 */
export function reportAnswerQuality(modelKey: string, task: SuiteTask, problem: string | null): void {
  const cache = loadCache();
  const s = cache.stats[modelKey];
  if (!s) return;
  s.strikes ??= {};
  if (!problem) {
    if (!s.strikes[task]) return;
    s.strikes[task] = 0;
    saveCache(cache);
    return;
  }
  const strikes = (s.strikes[task] ?? 0) + 1;
  s.strikes[task] = strikes;
  const q = cache.qualification[qKey(modelKey, task)];
  if (strikes >= QUALITY_STRIKES && q?.status === 'pass') {
    q.status = 'fail';
    q.at = new Date().toISOString();
    q.details = [...q.details, `demoted at runtime: ${problem}`].slice(-12);
    s.strikes[task] = 0;
  }
  saveCache(cache);
}

export interface ModelReport {
  key: string;
  estimate: CostEstimate;
  qualification: Partial<Record<SuiteTask, Qualification | null>>;
  stats: Stats | null;
  /** Measured mean cost of one call, when known. */
  measuredUsd: number | null;
  /** Allowed under `max_tier` (or pinned). */
  auto: boolean;
}

export interface RouteReport {
  provider: ProviderId;
  bin: string | null;
  version: string | null;
  blocked: ProviderBlock | null;
  /** Candidate the router would use per task right now (null: nothing qualified yet). */
  selected: Partial<Record<SuiteTask, string | null>>;
  models: ModelReport[];
}

function measured(s: Stats | undefined): number | null {
  return s && s.costCalls > 0 ? s.costUsd / s.costCalls : null;
}

/** Diagnostics for `devctx models`: what each provider would use per task and why. */
export async function describeRoutes(cfg: DevctxConfig, host: string | null, opts: { refresh: boolean }): Promise<RouteReport[]> {
  const cache = loadCache();
  const out: RouteReport[] = [];
  for (const pid of providerOrder(cfg, host)) {
    const provider = getProvider(pid);
    const bin = await provider.resolveBinary();
    if (!bin) {
      out.push({ provider: pid, bin: null, version: null, blocked: null, selected: {}, models: [] });
      continue;
    }
    const { version, models } = await discover(provider, bin, cfg, cache, opts.refresh);
    const eligible = candidates(models, cfg.llm.max_tier);
    const eligibleKeys = new Set(eligible.map((r) => candidateKey(r.model)));
    const selected: RouteReport['selected'] = {};
    for (const task of SUITE_TASKS) {
      const pick = eligible.find(({ model }) => trusted(cfg, model) || qualificationFor(cache, candidateKey(model), task, version)?.status === 'pass');
      selected[task] = pick ? candidateKey(pick.model) : null;
    }
    out.push({
      provider: pid,
      bin,
      version,
      blocked: activeBlock(cache, pid),
      selected,
      models: rankModels(models).map(({ model, estimate }) => {
        const key = candidateKey(model);
        const qualification: ModelReport['qualification'] = {};
        for (const task of SUITE_TASKS) qualification[task] = qualificationFor(cache, key, task, version);
        return { key, estimate, qualification, stats: cache.stats[key] ?? null, measuredUsd: measured(cache.stats[key]), auto: eligibleKeys.has(key) };
      }),
    });
  }
  saveCache(cache);
  return out;
}

/** Cached per-task selection without calling any CLI (for `devctx doctor`). */
export function cachedSelection(cfg: DevctxConfig, host: string | null): { provider: ProviderId; task: SuiteTask; key: string | null }[] {
  const cache = loadCache();
  const out: { provider: ProviderId; task: SuiteTask; key: string | null }[] = [];
  for (const pid of providerOrder(cfg, host)) {
    const d = cache.discovery[pid];
    if (!d) continue;
    const eligible = candidates(d.models, cfg.llm.max_tier);
    for (const task of SUITE_TASKS) {
      const pick = eligible.find(({ model }) => trusted(cfg, model) || qualificationFor(cache, candidateKey(model), task, d.version)?.status === 'pass');
      out.push({ provider: pid, task, key: pick ? candidateKey(pick.model) : null });
    }
  }
  return out;
}

export interface QualifyReport {
  key: string;
  task: SuiteTask;
  pass: boolean;
  score: string;
  details: string[];
  blocked: FailureKind | null;
  avgCostUsd: number | null;
}

/**
 * `devctx models --qualify <provider>`: walks the candidates of one provider in cost order and
 * evaluates them until one passes the task's suite (or `limit` evaluations ran). Candidates with a
 * current verdict are skipped; an existing pass ends the walk because nothing cheaper is left.
 */
export async function qualifyProvider(
  cfg: DevctxConfig,
  pid: ProviderId,
  task: SuiteTask,
  limit: number,
  db: StateDb | null,
  onResult?: (r: QualifyReport) => void,
): Promise<QualifyReport[]> {
  const cache = loadCache();
  const provider = getProvider(pid);
  const bin = await provider.resolveBinary();
  if (!bin) return [];
  const { version, models } = await discover(provider, bin, cfg, cache, false);
  const results: QualifyReport[] = [];
  try {
    for (const { model } of candidates(models, cfg.llm.max_tier)) {
      if (results.length >= limit) break;
      const key = candidateKey(model);
      const q = qualificationFor(cache, key, task, version);
      if (q?.status === 'pass') break;
      if (q) continue;
      const res = await runQualification(provider, bin, model, task, version, cache, cfg, db);
      saveCache(cache);
      const report: QualifyReport = { key, task, pass: res.pass, score: `${res.score}/${res.total}`, details: res.details, blocked: res.blocked, avgCostUsd: res.avgCostUsd };
      results.push(report);
      onResult?.(report);
      if (res.blocked === 'auth' || res.blocked === 'quota' || res.pass) break;
    }
  } finally {
    saveCache(cache);
  }
  return results;
}
