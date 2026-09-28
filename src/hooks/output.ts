import type { HookKind, ToolId } from '../types.ts';

const CLAUDE_EVENT: Partial<Record<HookKind, string>> = {
  session_start: 'SessionStart',
  prompt: 'UserPromptSubmit',
};

/**
 * Renders what a hook prints on stdout for each tool. Returns null when nothing should be
 * printed. Cursor's beforeSubmitPrompt always needs `{"continue": true}` so the prompt goes through.
 */
export function renderHookOutput(tool: ToolId, kind: HookKind, context: string | null): string | null {
  const injectable = kind === 'session_start' || kind === 'prompt';
  switch (tool) {
    case 'claude':
    case 'codex': {
      if (!injectable || !context) return null;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: CLAUDE_EVENT[kind], additionalContext: context } });
    }
    case 'copilot': {
      // Copilot CLI and VS Code (Local) share `.github/hooks/*.json` but read different output keys.
      if (!injectable || !context) return null;
      return JSON.stringify({
        additionalContext: context,
        hookSpecificOutput: { hookEventName: CLAUDE_EVENT[kind], additionalContext: context },
      });
    }
    case 'cursor': {
      if (kind === 'prompt') return JSON.stringify({ continue: true });
      if (kind === 'session_start' && context) return JSON.stringify({ additional_context: context });
      return null;
    }
    case 'kiro': {
      if (!injectable || !context) return null;
      return context;
    }
    default:
      return null;
  }
}
