import fs from 'node:fs';
import path from 'node:path';
import type { DevctxConfig } from '../config.ts';
import { RATE_LIMIT_ERROR, reportAnswerQuality, routeCall, type RouteOptions } from '../llm/router.ts';
import { redactSecrets } from '../memory/evidence.ts';
import type { HistoryTurn, StateDb } from '../state/db.ts';
import { git, gitUserName } from '../util/git.ts';
import type { ProjectPaths } from '../util/paths.ts';
import { turnChanges } from './snapshot.ts';
import { buildSummaryPrompt, fallbackSummary, inventedPaths, parseSummaryResult, SUMMARY_SCHEMA, type SummaryFacts, type TurnSummary } from './summarize.ts';
import { readTurnTranscript } from './transcript.ts';
import { appendEntry, renderEntry, renderHeader, sessionFile } from './writer.ts';

export interface HistoryReport {
  written: string[];
  /** Turns left for a later run (summary call limit reached). */
  deferred: number;
  errors: string[];
}

/** A turn waiting this long for the summary call limit is written without an LLM summary. */
const MAX_DEFER_MS = 24 * 60 * 60 * 1000;
/** A turn still open after this long never got its end event. */
const OPEN_TURN_MAX_MS = 12 * 60 * 60 * 1000;
const PER_RUN = 20;

function factsOf(root: string, turn: HistoryTurn): { facts: SummaryFacts; files: SummaryFacts['files'] | null } {
  const changes = turn.beforeTree && turn.afterTree ? turnChanges(root, turn.beforeTree, turn.afterTree) : null;
  const transcript = readTurnTranscript(turn.transcriptPath, turn.promptTs, turn.endTs);
  const lastAssistant = turn.lastAssistant ?? transcript.lastAssistant;
  const facts: SummaryFacts = {
    tool: turn.tool,
    prompt: redactSecrets(turn.prompt),
    lastAssistant: lastAssistant ? redactSecrets(lastAssistant) : null,
    files: changes?.files ?? [],
    commands: transcript.commands,
    patch: changes ? redactSecrets(changes.patch) : '',
    changesUnknown: changes === null,
  };
  return { facts, files: changes ? changes.files : null };
}

/**
 * The file a turn goes to. The session's current file while it is not committed yet; after a
 * commit (or a branch switch that took it away) the session continues in a new file. A committed
 * history file is never changed, so it cannot block `git checkout` or conflict in a merge.
 */
function targetFile(root: string, db: StateDb, turn: HistoryTurn): { rel: string; continued: string | null } {
  const latest = db.latestHistoryFile(turn.skey);
  if (latest && fs.existsSync(path.join(root, latest)) && !git(['cat-file', '-e', `HEAD:${latest}`], root, 5_000).ok) {
    return { rel: latest, continued: null };
  }
  return { rel: sessionFile(turn.promptTs, turn.tool, turn.skey), continued: latest };
}

/**
 * Writes the entries of finished turns to `.devctx/history/`, oldest first. Each summary is one
 * call to the cheapest model that passed the `summarize` requirements; without an LLM (or when the
 * call fails) the entry carries the assistant's own final message instead.
 */
export async function processHistory(paths: ProjectPaths, cfg: DevctxConfig, db: StateDb, route: RouteOptions | null): Promise<HistoryReport> {
  const report: HistoryReport = { written: [], deferred: 0, errors: [] };
  db.expireOpenHistoryTurns(new Date(Date.now() - OPEN_TURN_MAX_MS).toISOString());
  const turns = db.readyHistoryTurns(PER_RUN);
  if (turns.length === 0) return report;
  let author: string | null | undefined;
  let rateLimited = false;
  for (const turn of turns) {
    const { facts, files } = factsOf(paths.root, turn);
    let summary: TurnSummary | null = null;
    let error: string | null = null;
    if (route && !rateLimited) {
      const res = await routeCall(
        { task: 'summarize', prompt: buildSummaryPrompt(facts, cfg.language), schema: SUMMARY_SCHEMA, timeoutMs: cfg.llm.timeout_seconds * 1000 },
        parseSummaryResult,
        route,
      );
      if (res.ok) {
        summary = res.value;
        const invented = inventedPaths(summary, facts);
        reportAnswerQuality(res.model, 'summarize', invented.length > 0 ? `named files not in the facts: ${invented.slice(0, 3).join(', ')}` : null);
      } else if (res.error === RATE_LIMIT_ERROR) {
        rateLimited = true;
      } else {
        error = `${res.error}: ${res.attempts.slice(-2).join(' | ')}`;
      }
    }
    if (!summary && rateLimited && Date.now() - Date.parse(turn.promptTs) < MAX_DEFER_MS) {
      report.deferred++;
      continue;
    }
    summary ??= fallbackSummary(facts, cfg.language);
    if (error) report.errors.push(`history summary: ${error}`);
    try {
      const { rel, continued } = targetFile(paths.root, db, turn);
      if (author === undefined) author = gitUserName(paths.root);
      const number = db.historyTurnNumber(turn.skey, turn.promptTs, turn.id);
      const header = renderHeader(
        { tool: turn.tool, session: turn.session, startIso: db.historySessionStart(turn.skey) ?? turn.promptTs, author, continued: continued ? { from: number, previous: continued } : null },
        cfg.language,
      );
      const entry = renderEntry(
        {
          number,
          promptIso: turn.promptTs,
          endIso: turn.endTs,
          branch: turn.branch,
          model: turn.model,
          prompt: turn.prompt,
          summary,
          files,
          commands: facts.commands,
        },
        cfg.language,
      );
      appendEntry(paths.root, rel, header, entry);
      db.finishHistoryTurn(turn.id, rel, error);
      report.written.push(rel);
    } catch (e) {
      report.errors.push(`history write: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
