import { detectForeignEdits } from '../compile/foreign.ts';
import { loadConfig } from '../config.ts';
import { ensureGitHooks } from '../init/githooks.ts';
import { loadItems, loadPersonalItems } from '../knowledge/store.ts';
import { StateDb } from '../state/db.ts';
import type { HookKind, ToolId } from '../types.ts';
import { sha256 } from '../util/fsx.ts';
import { errorMessage, logLine } from '../util/log.ts';
import { findProjectRoot, projectPaths, type ProjectPaths } from '../util/paths.ts';
import { normalizeForMatch, today } from '../util/text.ts';
import { spawnWorker } from '../worker-spawn.ts';
import { promptContext, sessionContext } from './context.ts';
import { normalizeHook } from './normalize.ts';
import { renderHookOutput } from './output.ts';
import { detectSignals } from './signals.ts';

const NO_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

interface SessionState {
  started: string;
  updated: string;
  injected: string[];
}

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
      const signals = event.prompt ? detectSignals(event.prompt) : null;
      const dedupeKey =
        kind === 'prompt' && event.prompt
          ? `prompt|${sha256(normalizeForMatch(event.prompt)).slice(0, 24)}`
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
          lastAssistant: event.lastAssistant,
          transcriptPath: event.transcriptPath,
          model: event.model,
          flags: signals?.flags ?? [],
          candidate: signals?.candidate ?? false,
        });
      }

      let output = fallback;
      if (kind === 'session_start') {
        const previous = readSession(db, tool, event.session, now);
        const keepStart = previous && (event.source === 'compact' || event.source === 'resume');
        const ctx = sessionContext(loadItems(paths).items, cfg.memory.personal ? loadPersonalItems().items : [], cfg);
        writeSession(db, tool, event.session, {
          started: keepStart ? previous.started : now.toISOString(),
          updated: now.toISOString(),
          injected: ctx.ids, // context was rebuilt (new, resumed or compacted): re-inject from scratch
        });
        output = renderHookOutput(tool, kind, ctx.text) ?? fallback;
      } else if (kind === 'prompt') {
        const state = readSession(db, tool, event.session, now) ?? { started: now.toISOString(), updated: now.toISOString(), injected: [] };
        const ctx = promptContext(loadItems(paths).items, event.prompt ?? '', cfg, {
          sessionStartedAt: state.started,
          alreadyInjected: new Set(state.injected),
        });
        state.injected.push(...ctx.ids);
        state.updated = now.toISOString();
        writeSession(db, tool, event.session, state);
        output = renderHookOutput(tool, kind, ctx.text) ?? fallback;
      }

      if (fresh && kind === 'session_start') {
        detectForeignEdits(paths, db, tool);
        if (cfg.git.auto_install_hooks && db.kvGet('githooks_checked') !== today()) {
          const res = ensureGitHooks(root);
          if (res.installed.length > 0) logLine(paths.log, 'info', 'installed git hooks', { hooks: res.installed });
          db.kvSet('githooks_checked', today());
        }
      }
      if (fresh && kind !== 'prompt' && db.hasPendingCandidates()) spawnWorker(root, kind, event.host);
      return output;
    } finally {
      db.close();
    }
  } catch (error) {
    if (paths) logLine(paths.log, 'error', 'hook failed', { tool, kind, error: errorMessage(error) });
    return fallback;
  }
}
