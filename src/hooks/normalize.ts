import type { HookKind, ToolId } from '../types.ts';

export interface HookEvent {
  ts: string;
  /** Which devctx hook config invoked us (`--tool`). */
  tool: ToolId;
  /** The tool actually running the hook (differs when a tool reads another tool's config). */
  host: string;
  kind: HookKind;
  session: string | null;
  cwd: string;
  prompt: string | null;
  lastAssistant: string | null;
  transcriptPath: string | null;
  model: string | null;
  /** SessionStart source (`startup`, `resume`, `compact`, `clear`, ...) when the tool reports it. */
  source: string | null;
}

export interface NormalizeResult {
  event: HookEvent;
  /** True when another devctx config already covers this host (avoid double capture/injection). */
  skip: boolean;
  reason?: string;
}

type Obj = Record<string, unknown>;

function s(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    const x = s(v);
    if (x) return x;
  }
  return null;
}

/**
 * Maps each tool's hook payload onto one event shape. Field names differ per tool:
 * Claude/Codex/VS Code use snake_case, Copilot CLI camelCase, Cursor `conversation_id` +
 * `workspace_roots`, Kiro IDE passes the prompt in USER_PROMPT.
 */
export function normalizeHook(tool: ToolId, kind: HookKind, payload: Obj, env: NodeJS.ProcessEnv): NormalizeResult {
  const cursorHost = Boolean(env.CURSOR_VERSION || payload.cursor_version);
  const host = cursorHost ? 'cursor' : tool;
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const cwd =
    firstString(payload.cwd, roots[0], env.CLAUDE_PROJECT_DIR, env.CURSOR_PROJECT_DIR) ?? process.cwd();
  let prompt: string | null = null;
  if (kind === 'prompt') {
    prompt = firstString(payload.prompt, payload.user_prompt, tool === 'kiro' ? env.USER_PROMPT : undefined);
  }
  const event: HookEvent = {
    ts: new Date().toISOString(),
    tool,
    host,
    kind,
    session: firstString(payload.session_id, payload.sessionId, payload.conversation_id),
    cwd,
    prompt,
    lastAssistant: kind === 'turn_end' ? firstString(payload.last_assistant_message, payload.lastAssistantMessage) : null,
    transcriptPath: firstString(payload.transcript_path, payload.transcriptPath, env.CURSOR_TRANSCRIPT_PATH),
    model: firstString(payload.model, payload.model_id),
    source: kind === 'session_start' ? firstString(payload.source, payload.trigger) : null,
  };
  // Cursor also runs `.claude/settings.json` hooks by default; its own `.cursor/hooks.json` entry
  // already covers it, so the Claude-config copy is skipped.
  if (cursorHost && tool !== 'cursor') return { event, skip: true, reason: 'cursor runs its own devctx hook' };
  return { event, skip: false };
}
