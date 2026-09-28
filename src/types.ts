// Shared identifiers used across devctx modules.

/** AI tools that devctx integrates with. Provider ids for LLM calls use the same names. */
export type ToolId = 'claude' | 'codex' | 'copilot' | 'cursor' | 'kiro';
export const TOOL_IDS: readonly ToolId[] = ['claude', 'codex', 'copilot', 'cursor', 'kiro'];

/** Canonical hook events. Each tool's native event names are mapped onto these. */
export type HookKind = 'session_start' | 'prompt' | 'turn_end' | 'pre_compact' | 'session_end';
export const HOOK_KINDS: readonly HookKind[] = ['session_start', 'prompt', 'turn_end', 'pre_compact', 'session_end'];

export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value);
}

export function isHookKind(value: unknown): value is HookKind {
  return typeof value === 'string' && (HOOK_KINDS as readonly string[]).includes(value);
}

export type Language = 'ko' | 'en';
