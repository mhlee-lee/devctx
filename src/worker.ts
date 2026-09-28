import fs from 'node:fs';
import path from 'node:path';
import { compile, type CompileResult } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { loadItems, loadPersonalItems, writeItem } from './knowledge/store.ts';
import { refreshCommunityPrices } from './llm/catalog.ts';
import type { RouteOptions } from './llm/router.ts';
import { consolidate, type ApplyResult } from './memory/consolidate.ts';
import { extractCandidates } from './memory/extract.ts';
import { StateDb } from './state/db.ts';
import { gitCommitPaths, gitUserEmail } from './util/git.ts';
import { errorMessage, logLine } from './util/log.ts';
import { projectPaths, type ProjectPaths } from './util/paths.ts';

/** A live worker may run long (first-time model evaluations); a dead one never holds the lock. */
const LOCK_STALE_MS = 60 * 60 * 1000;
const MAX_ROUNDS = 10;
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
  errors: string[];
}

function acquireLock(file: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let stale = true;
      try {
        const info = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; at: string };
        const alive = (() => {
          try {
            process.kill(info.pid, 0);
            return true;
          } catch {
            return false;
          }
        })();
        stale = !alive || Date.now() - Date.parse(info.at) > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

/** Retires unconfirmed proposals after `proposed_ttl_days` and drops old session state. */
function maintain(paths: ProjectPaths, db: StateDb, ttlDays: number, language: 'ko' | 'en'): number {
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
  let retired = 0;
  for (const item of loadItems(paths).items) {
    if (item.status === 'proposed' && item.reinforced === 0 && item.source.captured_at < cutoff) {
      item.status = 'retired';
      writeItem(paths, item, language);
      db.recordOp({ eventId: null, relation: 'retire', itemId: item.id, targetId: null, detail: `unconfirmed for ${ttlDays} days` });
      retired++;
    }
  }
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
  if (!acquireLock(paths.workerLock)) {
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
      if (route) await refreshCommunityPrices(cfg.llm.pricing_refresh_days);
      const ctx = {
        paths,
        cfg,
        db,
        team: loadItems(paths).items,
        personal: loadPersonalItems().items,
        actor: gitUserEmail(paths.root),
        route,
      };
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const events = db.pendingEvents(50);
        if (events.length === 0) break;
        const outcome = await extractCandidates(events.filter((e) => e.candidate && e.prompt), db, route);
        report.errors.push(...outcome.errors);
        report.candidates += outcome.candidates.length;
        for (const c of outcome.candidates) {
          try {
            report.applied.push(await consolidate(c, ctx));
          } catch (error) {
            report.errors.push(`consolidate failed: ${errorMessage(error)}`);
          }
        }
        const deferred = new Set(outcome.deferredEventIds);
        const done = events.filter((e) => !deferred.has(e.id)).map((e) => e.id);
        db.markProcessed(done);
        report.processed += done.length;
        if (deferred.size > 0) break;
      }
      report.retired = maintain(paths, db, cfg.memory.proposed_ttl_days, cfg.language);
      report.compiled = compile(paths, cfg, db, { tool: opts.host ?? 'worker' });
      const touched = report.applied.some((a) => a.files.length > 0) || report.retired > 0 || report.compiled.changed.length > 0;
      if (touched && cfg.git.commit_mode === 'auto-commit' && opts.reason === 'session_end') {
        const res = gitCommitPaths(paths.root, ['.devctx/knowledge', ...report.compiled.changed, ...report.compiled.removed], 'chore(devctx): update project decisions');
        report.committed = Boolean(res?.ok);
        if (res && !res.ok) report.errors.push(`auto-commit failed: ${res.stderr}`);
      }
      logLine(paths.log, report.errors.length > 0 ? 'warn' : 'info', 'worker finished', {
        reason: opts.reason,
        processed: report.processed,
        candidates: report.candidates,
        applied: report.applied.map((a) => `${a.relation}:${a.itemId ?? '-'}`),
        changed: report.compiled.changed,
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
    fs.rmSync(paths.workerLock, { force: true });
  }
}
