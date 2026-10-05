import { indexNeedsRefresh, refreshIndex } from './codeindex/service.ts';
import type { SyncResult } from './codeindex/sync.ts';
import { compile, type CompileResult } from './compile/compile.ts';
import { committedPaths } from './init/attributes.ts';
import { isExpired } from './compile/tiers.ts';
import { llmOff, loadConfig, type DevctxConfig } from './config.ts';
import { processHistory, type HistoryReport } from './history/process.ts';
import { HISTORY_DIR } from './history/writer.ts';
import { extractionDue } from './hooks/signals.ts';
import { repoContext, type RepoContext } from './knowledge/anchors.ts';
import type { KnowledgeItem } from './knowledge/types.ts';
import { deriveStatus, knowledgeDirs, loadPersonal, loadTeam, readKnowledgeFiles } from './knowledge/view.ts';
import { refreshCommunityPrices } from './llm/catalog.ts';
import type { RouteOptions } from './llm/router.ts';
import { consolidate, type ApplyResult, type ConsolidateContext } from './memory/consolidate.ts';
import { extractCandidates } from './memory/extract.ts';
import { StateDb } from './state/db.ts';
import { recordExtractionHealth } from './state/health.ts';
import { gitCommitPaths, gitUserEmail } from './util/git.ts';
import { tryLock } from './util/lock.ts';
import { errorMessage, logLine } from './util/log.ts';
import { personalDir, projectPaths, type ProjectPaths } from './util/paths.ts';

/** A live worker may run long (first-time model evaluations); a dead one never holds the lock. */
const LOCK_STALE_MS = 60 * 60 * 1000;
const MAX_ROUNDS = 10;
/** Worker runs that may fail to store what one event said before the event is given up. */
const MAX_EVENT_ATTEMPTS = 3;
/** Model evaluations one worker run may start (each runs a task's requirement suite). */
const QUALIFICATIONS_PER_RUN = 3;

export interface WorkerOptions {
  root: string;
  host: string | null;
  reason: string;
  allowLlm: boolean;
}

export interface WorkerReport {
  skipped: string | null;
  processed: number;
  candidates: number;
  applied: ApplyResult[];
  retired: number;
  compiled: CompileResult | null;
  committed: boolean;
  codeIndex?: SyncResult;
  history?: HistoryReport;
  errors: string[];
}

/** Worker runs that also bring the code index up to date (turn ends leave it to the engine). */
const CODE_INDEX_REASONS = new Set(['session_start', 'code-index', 'manual']);

/** Processed events older than this are deleted (decisions live in files; unprocessed events stay). */
const EVENT_RETENTION_DAYS = 90;

/**
 * Paths devctx commits: decision files and history (plus a pending AGENTS.md conversion). The
 * rule files compile builds are local and gitignored: a path-limited commit would track them again.
 */
export function ownedPaths(root: string): string[] {
  return committedPaths(root, ['.devctx/knowledge', HISTORY_DIR]);
}

/**
 * Housekeeping without touching knowledge files: archives unconfirmed proposals of this PC after
 * `proposed_ttl_days` (kept, so a later restatement revives them), logs rules whose end date has
 * passed (their status is derived from the date), and drops old events and session state.
 */
function maintain(paths: ProjectPaths, db: StateDb, cfg: DevctxConfig): number {
  const ttlDays = cfg.memory.proposed_ttl_days;
  let retired = 0;
  const stats = db.itemStats();
  const restated = new Set([...stats.entries()].filter(([, s]) => s.reinforced > 0).map(([id]) => id));
  for (const id of db.archiveProposals(new Date(Date.now() - ttlDays * 86_400_000).toISOString(), restated)) {
    db.recordOp({ eventId: null, relation: 'archive', itemId: id, targetId: null, detail: `unconfirmed for ${ttlDays} days (kept; saying it again makes it active)` });
    retired++;
  }
  // Expiry needs no write (the date decides); record it once for `devctx log`.
  const seen = new Set<string>(JSON.parse(db.kvGet('expired_seen') ?? '[]') as string[]);
  // Every past end date is noted as seen (so session hooks stop asking for this run), but only a
  // rule still in force when its date passed is logged, not one a newer file had replaced.
  let changed = false;
  for (const dirs of [knowledgeDirs(paths), ...(cfg.memory.personal ? [[personalDir()]] : [])]) {
    const items: KnowledgeItem[] = readKnowledgeFiles(dirs, db).items;
    const inFile = new Map(items.map((i) => [i.id, i.status]));
    deriveStatus(items, { proposedTtlDays: ttlDays });
    for (const item of items) {
      if (!item.valid_until || !isExpired(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      changed = true;
      const wasInForce = inFile.get(item.id) !== 'superseded' && inFile.get(item.id) !== 'retired';
      if (wasInForce && item.status === 'retired' && !item.archived) {
        db.recordOp({ eventId: null, relation: 'expire', itemId: item.id, targetId: null, detail: `valid until ${item.valid_until}` });
        retired++;
      }
    }
  }
  if (changed) db.kvSet('expired_seen', JSON.stringify([...seen].slice(-2000)));
  db.pruneEvents(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString());
  db.pruneHistoryTurns(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString());
  const weekAgo = Date.now() - 7 * 86_400_000;
  for (const { key, value } of db.kvList('sess:')) {
    try {
      if (Date.parse((JSON.parse(value) as { updated: string }).updated) < weekAgo) db.kvDelete(key);
    } catch {
      db.kvDelete(key);
    }
  }
  return retired;
}

/**
 * Background processing: extract rule candidates from pending events, consolidate them into
 * `.devctx/knowledge/`, regenerate instruction files and (optionally) commit. Safe to run
 * repeatedly; a lock keeps one worker per worktree.
 */
export async function runWorker(opts: WorkerOptions): Promise<WorkerReport> {
  const paths = projectPaths(opts.root);
  const report: WorkerReport = { skipped: null, processed: 0, candidates: 0, applied: [], retired: 0, compiled: null, committed: false, errors: [] };
  const lock = tryLock(paths.workerLock, LOCK_STALE_MS);
  if (!lock) {
    report.skipped = 'another worker is running';
    return report;
  }
  try {
    const cfg = loadConfig(paths);
    const db = StateDb.open(paths.stateDb);
    try {
      const log = (message: string, extra?: Record<string, unknown>): void => logLine(paths.log, 'info', message, extra);
      const route: RouteOptions | null = opts.allowLlm
        ? { cfg, host: opts.host, db, allowQualify: true, qualifyBudget: { remaining: QUALIFICATIONS_PER_RUN }, log }
        : null;
      // `max_calls_per_hour: 0` or `providers: []` turn calls off: rules fall back to the no-LLM
      // path (explicit markers kept as proposals), history entries to the assistant's reply.
      const decisionRoute = route && !llmOff(cfg, 'decisions') ? route : null;
      const historyRoute = route && !llmOff(cfg, 'history') ? route : null;
      if (decisionRoute || historyRoute) await refreshCommunityPrices(cfg.llm.pricing_refresh_days);
      const viewOpts = { proposedTtlDays: cfg.memory.proposed_ttl_days, local: true };
      let repo: RepoContext | null | undefined;
      const ctx: ConsolidateContext = {
        paths,
        cfg,
        db,
        team: loadTeam(paths, db, viewOpts).items,
        personal: loadPersonal(db, viewOpts).items,
        actor: gitUserEmail(paths.root),
        route: decisionRoute,
        repo: () => (repo === undefined ? (repo = repoContext(paths.root)) : repo),
      };
      let attempted = 0;
      let succeeded = 0;
      let lastError: string | null = null;
      // Implicit candidates wait for a full batch at a plain turn end, even when the worker runs for
      // something else (a history entry, the code index), so they keep costing one call per five.
      const flushImplicit = opts.reason !== 'turn_end' || extractionDue(db.pendingCandidates(), false);
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const pending = db.pendingEvents(50);
        const events = flushImplicit ? pending : pending.filter((e) => !(e.candidate && e.flags.includes('implicit')));
        if (events.length === 0) break;
        const candidates = events.filter((e) => e.candidate && e.prompt);
        const outcome = await extractCandidates(candidates, db, decisionRoute);
        if (decisionRoute && candidates.length > 0 && outcome.deferredEventIds.length < candidates.length) {
          attempted++;
          if (outcome.usedLlm) succeeded++;
          else lastError = outcome.errors[outcome.errors.length - 1] ?? 'no model answered';
        }
        report.errors.push(...outcome.errors);
        report.candidates += outcome.candidates.length;
        const failed = new Map<string, string>();
        for (const c of outcome.candidates) {
          try {
            report.applied.push(await consolidate(c, ctx));
          } catch (error) {
            report.errors.push(`consolidate failed: ${errorMessage(error)}`);
            failed.set(c.eventId, errorMessage(error));
          }
        }
        // An event whose rule could not be stored (a write error) stays pending and is tried again
        // by a later run; after MAX_EVENT_ATTEMPTS it is kept with its error instead of retried.
        const retry = new Set<string>();
        for (const [id, message] of failed) {
          if (db.noteEventFailure(id) < MAX_EVENT_ATTEMPTS) retry.add(id);
          else db.markProcessed([id], `consolidate failed ${MAX_EVENT_ATTEMPTS} times: ${message}`.slice(0, 500));
        }
        const deferred = new Set(outcome.deferredEventIds);
        const done = events.filter((e) => !deferred.has(e.id) && !failed.has(e.id)).map((e) => e.id);
        db.markProcessed(done);
        report.processed += done.length;
        if (deferred.size > 0 || retry.size > 0) break;
      }
      if (attempted > 0) recordExtractionHealth(db, succeeded > 0, lastError);
      report.retired = maintain(paths, db, cfg);
      // At a turn end the session is still running: only .devctx/rules.md is rebuilt, the tools'
      // rule files wait for the next session (new decisions reach this one through the prompt hook).
      report.compiled = compile(paths, cfg, db, { tool: opts.host ?? 'worker', toolFiles: opts.reason !== 'turn_end' });
      try {
        report.history = await processHistory(paths, cfg, db, historyRoute);
        report.errors.push(...report.history.errors);
      } catch (error) {
        report.errors.push(`history: ${errorMessage(error)}`);
      }
      // Code index last: a first full index of a large repository takes a while.
      if ((CODE_INDEX_REASONS.has(opts.reason) || opts.reason.startsWith('git-post-')) && (opts.reason === 'manual' || indexNeedsRefresh(paths.root, cfg))) {
        try {
          const res = await refreshIndex(paths.root, cfg);
          if (res?.ran) {
            report.codeIndex = res;
            logLine(paths.log, res.error ? 'warn' : 'info', 'code index sync', { files: res.files, parsed: res.parsed, removed: res.removed, failed: res.failed, ms: res.ms, error: res.error });
            if (res.error) report.errors.push(`code index: ${res.error}`);
          }
        } catch (error) {
          report.errors.push(`code index: ${errorMessage(error)}`);
        }
      }
      // Auto-commit takes everything devctx owns that is still uncommitted, also what earlier turns
      // of the session wrote (gitCommitPaths commits only when something in these paths changed).
      if (cfg.git.commit_mode === 'auto-commit' && opts.reason === 'session_end') {
        const res = gitCommitPaths(paths.root, ownedPaths(paths.root), 'chore(devctx): update project decisions');
        report.committed = Boolean(res?.ok);
        if (res && !res.ok) report.errors.push(`auto-commit failed: ${res.stderr}`);
      }
      logLine(paths.log, report.errors.length > 0 ? 'warn' : 'info', 'worker finished', {
        reason: opts.reason,
        processed: report.processed,
        candidates: report.candidates,
        applied: report.applied.map((a) => `${a.relation}:${a.itemId ?? '-'}`),
        changed: report.compiled.changed,
        history: report.history?.written.length ?? 0,
        errors: report.errors.slice(0, 5),
      });
      return report;
    } finally {
      db.close();
    }
  } catch (error) {
    report.errors.push(errorMessage(error));
    logLine(paths.log, 'error', 'worker failed', { error: errorMessage(error) });
    return report;
  } finally {
    lock.release();
  }
}
