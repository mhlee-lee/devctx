import { codeLookup } from '../codeindex/hints.ts';
import { indexNeedsRefresh } from '../codeindex/service.ts';
import { compile } from '../compile/compile.ts';
import { isExpired } from '../compile/tiers.ts';
import { loadConfig } from '../config.ts';
import { caseHint, casesPending } from '../history/cases.ts';
import { captureHistory, historyNotice } from '../history/capture.ts';
import { captureEnabled, historyEnabled } from '../history/toggle.ts';
import { readLastAssistant } from '../history/transcript.ts';
import { ensureGitHooks } from '../init/githooks.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import { applyCachedStale, loadPersonal, loadTeam } from '../knowledge/view.ts';
import { StateDb } from '../state/db.ts';
import { dailyUpkeep, healthNotices } from '../upkeep.ts';
import type { HookKind, ToolId } from '../types.ts';
import { sha256 } from '../util/fsx.ts';
import { errorMessage, logLine } from '../util/log.ts';
import { findProjectRoot, projectPaths, type ProjectPaths } from '../util/paths.ts';
import { approxTokens, normalizeForMatch, today, truncate } from '../util/text.ts';
import { spawnWorker } from '../worker-spawn.ts';
import { promptContext, promptKind, sessionContext } from './context.ts';
import { continuesSession, handoffExtras, renderHandoff } from './handoff.ts';
import { normalizeHook } from './normalize.ts';
import { promptInjectable, renderHookOutput } from './output.ts';
import { detectSignals, extractionDue } from './signals.ts';

const NO_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

interface SessionState {
  started: string;
  updated: string;
  injected: string[];
  /** Prompts seen in this session (handoff is only offered on the first few). */
  prompts?: number;
  /** The previous session's handoff was already given. */
  handoff?: boolean;
  /** Error identifiers already pointed out in this session (verification cases). */
  hinted?: string[];
}

/** Handoff is considered on the first prompts of a session, for sessions that ended within a week. */
const HANDOFF_PROMPTS = 3;
const HANDOFF_MAX_AGE_MS = 7 * 86_400_000;

async function readStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sessionKey(tool: ToolId, session: string | null): string {
  return `sess:${tool}:${session ?? '-'}`;
}

function readSession(db: StateDb, tool: ToolId, session: string | null, now: Date): SessionState | null {
  const raw = db.kvGet(sessionKey(tool, session));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as SessionState;
    if (!session && now.getTime() - Date.parse(state.updated) > NO_SESSION_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

function writeSession(db: StateDb, tool: ToolId, session: string | null, state: SessionState): void {
  state.injected = [...new Set(state.injected)].slice(-500);
  db.kvSet(sessionKey(tool, session), JSON.stringify(state));
}

/**
 * Hook fast path: record the event, print context for the tool, hand heavy work to a detached
 * worker. Never throws and never blocks the host tool; returns what to print on stdout.
 */
export async function runHook(tool: ToolId, kind: HookKind): Promise<string | null> {
  const fallback = renderHookOutput(tool, kind, null);
  if (process.env.DEVCTX_INTERNAL === '1') return fallback;
  let paths: ProjectPaths | null = null;
  try {
    const payload = parseObject(await readStdin(1_000_000, 800));
    const { event, skip } = normalizeHook(tool, kind, payload, process.env);
    if (skip) return fallback;
    const root = findProjectRoot(event.cwd) ?? findProjectRoot(process.cwd());
    if (!root) return fallback;
    paths = projectPaths(root);
    const cfg = loadConfig(paths);
    const db = StateDb.open(paths.stateDb);
    try {
      const now = new Date();
      const isAck = Boolean(event.prompt) && promptKind(event.prompt ?? '') === 'ack';
      const prevAssistant = isAck ? (db.lastAssistantBefore(event.session, event.ts) ?? readLastAssistant(event.transcriptPath)) : null;
      // A developer who turned capture off (devctx capture off) gets the rules but their prompts are
      // never analyzed: no candidate, so no LLM call on their quota.
      const capture = kind !== 'prompt' || captureEnabled(root);
      const signals =
        event.prompt && capture ? detectSignals(event.prompt, { implicit: cfg.memory.implicit_rules, previousAssistant: prevAssistant }) : null;
      // The same prompt fired by two tools' hook configs is one event. Within a session the key also
      // carries the last turn end, so saying the same thing again ("응") in a later turn still counts.
      const turnMark = kind === 'prompt' && event.session ? (db.lastTurnEndTs(event.session) ?? '-') : '';
      const dedupeKey =
        kind === 'prompt' && event.prompt
          ? `prompt|${event.session ?? '-'}|${turnMark}|${sha256(normalizeForMatch(event.prompt)).slice(0, 24)}`
          : `${kind}|${tool}|${event.session ?? '-'}`;
      const fresh = db.dedupeOnce(dedupeKey, kind === 'prompt' ? 30_000 : 3_000);
      if (fresh) {
        db.insertEvent({
          ts: event.ts,
          tool,
          host: event.host,
          kind,
          session: event.session,
          cwd: root,
          prompt: event.prompt,
          lastAssistant: event.lastAssistant ?? (signals?.flags.includes('accept') && prevAssistant ? truncate(prevAssistant, 4000) : null),
          transcriptPath: event.transcriptPath,
          model: event.model,
          flags: signals?.flags ?? [],
          candidate: signals?.candidate ?? false,
        });
      }
      let historyReady = false;
      if (fresh) {
        try {
          historyReady = captureHistory(root, db, kind, event);
        } catch (error) {
          logLine(paths.log, 'warn', 'history capture failed', { tool, kind, error: errorMessage(error) });
        }
      }

      let output = fallback;
      // A rule past its end date is no longer injected; the worker rebuilds the local rule files
      // without it and logs the expiry.
      let expiredLive = false;
      const viewOpts = { proposedTtlDays: cfg.memory.proposed_ttl_days };
      let team: KnowledgeItem[] | null = null;
      const teamItems = (): KnowledgeItem[] => {
        if (!team) {
          team = loadTeam(paths as ProjectPaths, db, viewOpts).items;
          applyCachedStale(db, team);
        }
        return team;
      };
      if (kind === 'session_start') {
        // A new session is when the local rule files may change (between sessions, tools that send
        // them with every request lose no cache). The session gets the same rules in its context.
        if (fresh) {
          try {
            compile(paths, cfg, db, { tool });
          } catch (error) {
            logLine(paths.log, 'warn', 'compile at session start failed', { error: errorMessage(error) });
          }
        }
        const previous = readSession(db, tool, event.session, now);
        const keepStart = previous && (event.source === 'compact' || event.source === 'resume');
        const seen = new Set<string>(JSON.parse(db.kvGet('expired_seen') ?? '[]') as string[]);
        expiredLive = teamItems().some((i) => i.valid_until !== null && isExpired(i) && !seen.has(i.id));
        const notices = fresh ? healthNotices(db, cfg.language, { capture: false, everyDays: 1 }) : [];
        if (fresh && historyEnabled(root)) notices.push(historyNotice(cfg.language));
        const ctx = sessionContext(teamItems(), cfg.memory.personal ? loadPersonal(db, viewOpts).items : [], cfg, notices);
        writeSession(db, tool, event.session, {
          started: keepStart ? previous.started : now.toISOString(),
          updated: now.toISOString(),
          injected: ctx.ids, // context was rebuilt (new, resumed or compacted): re-inject from scratch
          // A compacted or resumed conversation still has its own history: no handoff for it.
          prompts: keepStart ? (previous.prompts ?? HANDOFF_PROMPTS) : 0,
          handoff: Boolean(keepStart),
        });
        if (fresh && ctx.text) db.recordInjection({ tool, session: event.session, kind, ids: ctx.ids, tokens: approxTokens(ctx.text), handoff: false });
        output = renderHookOutput(tool, kind, ctx.text) ?? fallback;
      } else if (kind === 'prompt' && !promptInjectable(tool)) {
        // Nothing can be added to this tool's prompt: record no injection, so a rule is never
        // counted as delivered when it was not (Cursor reads on-demand rules from its rule file).
        const state = readSession(db, tool, event.session, now) ?? { started: now.toISOString(), updated: now.toISOString(), injected: [] };
        state.prompts = (state.prompts ?? 0) + 1;
        state.updated = now.toISOString();
        writeSession(db, tool, event.session, state);
        output = renderHookOutput(tool, kind, null) ?? fallback;
      } else if (kind === 'prompt') {
        const prompt = event.prompt ?? '';
        const state = readSession(db, tool, event.session, now) ?? { started: now.toISOString(), updated: now.toISOString(), injected: [] };
        state.prompts = (state.prompts ?? 0) + 1;
        let handoff: string | null = null;
        if (cfg.inject.handoff_budget_tokens > 0 && !state.handoff && state.prompts <= HANDOFF_PROMPTS && promptKind(prompt) !== 'command') {
          const before = state.started < event.ts ? state.started : event.ts;
          const prev = db.previousSession(before, new Date(now.getTime() - HANDOFF_MAX_AGE_MS).toISOString(), event.session);
          if (prev && continuesSession(prompt, prev)) handoff = renderHandoff(prev, cfg.language, cfg.inject.handoff_budget_tokens, now, handoffExtras(root, prev));
          if (handoff) state.handoff = true;
        }
        const code = cfg.code_index.enabled
          ? codeLookup(root, prompt, cfg.language, Math.min(200, Math.floor(cfg.inject.prompt_budget_tokens / 3)))
          : { text: null, paths: [] };
        const boosts = new Map<string, number>();
        for (const [id, s] of db.itemStats()) if (s.violations > 0) boosts.set(id, s.violations);
        const ctx = promptContext(teamItems(), prompt, cfg, {
          sessionStartedAt: state.started,
          alreadyInjected: new Set(state.injected),
          codePaths: code.paths,
          violations: boosts,
        });
        // An error identifier another session ran into: how it went then (one line, once per session).
        let hint: string | null = null;
        if (cfg.inject.prompt_budget_tokens > 0 && promptKind(prompt) === 'normal') {
          try {
            const found = caseHint(db, prompt, event.session, cfg.language, new Set(state.hinted ?? []), now);
            if (found) {
              hint = found.text;
              state.hinted = [...(state.hinted ?? []), found.signature].slice(-50);
            }
          } catch (error) {
            logLine((paths as ProjectPaths).log, 'warn', 'case hint failed', { error: errorMessage(error) });
          }
        }
        state.injected.push(...ctx.ids);
        state.updated = now.toISOString();
        writeSession(db, tool, event.session, state);
        const text = [handoff, hint, ctx.text, code.text].filter(Boolean).join('\n\n') || null;
        if (fresh) db.recordInjection({ tool, session: event.session, kind, ids: ctx.ids, tokens: text ? approxTokens(text) : 0, handoff: Boolean(handoff) });
        output = renderHookOutput(tool, kind, text) ?? fallback;
      }

      let codeRefresh = false;
      if (fresh && kind === 'session_start') {
        if (cfg.git.auto_install_hooks && db.kvGet('githooks_checked') !== today()) {
          const res = ensureGitHooks(root);
          if (res.installed.length > 0) logLine(paths.log, 'info', 'installed git hooks', { hooks: res.installed });
          db.kvSet('githooks_checked', today());
        }
        const upkept = dailyUpkeep(root, cfg, db);
        if (upkept.length > 0) logLine(paths.log, 'info', 'daily upkeep', { files: upkept });
        codeRefresh = cfg.code_index.enabled && indexNeedsRefresh(root, cfg);
      }
      const extractNow = fresh && kind !== 'prompt' && extractionDue(db.pendingCandidates(), kind !== 'turn_end');
      const historyNow = fresh && kind !== 'prompt' && (historyReady || db.hasReadyHistory());
      // Auto-commit happens in the worker at session end, also when this hook has nothing new.
      const commitNow = fresh && kind === 'session_end' && cfg.git.commit_mode === 'auto-commit';
      // Verification cases of finished turns are read at session boundaries (not after every turn).
      const casesNow = fresh && (kind === 'session_start' || kind === 'session_end') && casesPending(db);
      if (fresh && kind !== 'prompt' && (codeRefresh || expiredLive || extractNow || historyNow || commitNow || casesNow)) spawnWorker(root, kind, event.host);
      return output;
    } finally {
      db.close();
    }
  } catch (error) {
    if (paths) logLine(paths.log, 'error', 'hook failed', { tool, kind, error: errorMessage(error) });
    return fallback;
  }
}
