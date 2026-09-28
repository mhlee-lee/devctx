import path from 'node:path';
import type { HookKind, ToolId } from '../types.ts';
import { readText, writeFileAtomic } from '../util/fsx.ts';

type Json = Record<string, unknown>;

export interface HookFileResult {
  tool: ToolId;
  file: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  note?: string;
}

/** Matches devctx hook commands regardless of quoting, so re-running init replaces them. */
const OURS = /\.devctx\/bin\/devctx\\?"?\s+hook\b/;

function isOurs(command: unknown): boolean {
  return typeof command === 'string' && OURS.test(command);
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

/** Shell command each tool runs. `sh` avoids depending on the executable bit after checkout. */
export function hookCommand(tool: ToolId, kind: HookKind): string {
  const args = `hook --tool ${tool} --event ${kind}`;
  switch (tool) {
    case 'claude':
      return `sh "$CLAUDE_PROJECT_DIR/.devctx/bin/devctx" ${args}`;
    case 'codex':
    case 'copilot':
      // Both run hooks from the session cwd, which may be a subdirectory.
      return `sh "$(git rev-parse --show-toplevel)/.devctx/bin/devctx" ${args}`;
    case 'cursor':
    case 'kiro':
      // Both run hook commands from the project root.
      return `sh .devctx/bin/devctx ${args}`;
  }
}

type EventSpec = [event: string, kind: HookKind, timeoutSeconds: number];

const CLAUDE_EVENTS: EventSpec[] = [
  ['SessionStart', 'session_start', 15],
  ['UserPromptSubmit', 'prompt', 10],
  ['Stop', 'turn_end', 10],
  ['PreCompact', 'pre_compact', 10],
  ['SessionEnd', 'session_end', 5],
];

const CODEX_EVENTS: EventSpec[] = [
  ['SessionStart', 'session_start', 15],
  ['UserPromptSubmit', 'prompt', 10],
  ['Stop', 'turn_end', 10],
  ['PreCompact', 'pre_compact', 10],
  ['SessionEnd', 'session_end', 3],
];

const COPILOT_EVENTS: EventSpec[] = [
  ['sessionStart', 'session_start', 15],
  ['userPromptSubmitted', 'prompt', 10],
  ['agentStop', 'turn_end', 10],
  ['preCompact', 'pre_compact', 10],
  ['sessionEnd', 'session_end', 10],
];

const CURSOR_EVENTS: EventSpec[] = [
  ['sessionStart', 'session_start', 15],
  ['beforeSubmitPrompt', 'prompt', 10],
  ['stop', 'turn_end', 10],
  ['preCompact', 'pre_compact', 10],
  ['sessionEnd', 'session_end', 10],
];

const KIRO_EVENTS: EventSpec[] = [
  ['SessionStart', 'session_start', 30],
  ['UserPromptSubmit', 'prompt', 15],
  ['Stop', 'turn_end', 30],
];

function readJsonFile(file: string): { data: Json; exists: boolean; invalid: boolean } {
  const text = readText(file);
  if (text === null) return { data: {}, exists: false, invalid: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return { data: obj(parsed), exists: true, invalid: !parsed || typeof parsed !== 'object' || Array.isArray(parsed) };
  } catch {
    return { data: {}, exists: true, invalid: true };
  }
}

function writeIfChanged(tool: ToolId, root: string, rel: string, value: Json, existed: boolean): HookFileResult {
  const file = path.join(root, rel);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (readText(file) === content) return { tool, file: rel, action: 'unchanged' };
  writeFileAtomic(file, content);
  return { tool, file: rel, action: existed ? 'updated' : 'created' };
}

/** Claude Code and Codex share one format: event -> [{ matcher?, hooks: [{type, command, timeout}] }]. */
function mergeMatcherGroups(data: Json, tool: ToolId, events: EventSpec[]): Json {
  const hooks = obj(data.hooks);
  for (const [event, kind, timeout] of events) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).map(obj) : [];
    const kept = groups
      .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: (g.hooks as unknown[]).map(obj).filter((h) => !isOurs(h.command)) } : g))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    kept.push({ hooks: [{ type: 'command', command: hookCommand(tool, kind), timeout }] });
    hooks[event] = kept;
  }
  return { ...data, hooks };
}

function writeMerged(tool: ToolId, root: string, rel: string, build: (data: Json) => Json): HookFileResult {
  const { data, exists, invalid } = readJsonFile(path.join(root, rel));
  if (invalid) return { tool, file: rel, action: 'skipped', note: 'existing file is not valid JSON; left untouched' };
  return writeIfChanged(tool, root, rel, build(data), exists);
}

export function installToolHooks(root: string, tool: ToolId): HookFileResult {
  switch (tool) {
    case 'claude':
      return writeMerged(tool, root, '.claude/settings.json', (d) => mergeMatcherGroups(d, tool, CLAUDE_EVENTS));
    case 'codex':
      return writeMerged(tool, root, '.codex/hooks.json', (d) => mergeMatcherGroups(d, tool, CODEX_EVENTS));
    case 'cursor':
      return writeMerged(tool, root, '.cursor/hooks.json', (d) => {
        const hooks = obj(d.hooks);
        for (const [event, kind, timeout] of CURSOR_EVENTS) {
          const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).map(obj).filter((h) => !isOurs(h.command)) : [];
          list.push({ command: hookCommand(tool, kind), timeout });
          hooks[event] = list;
        }
        return { version: typeof d.version === 'number' ? d.version : 1, ...d, hooks };
      });
    case 'copilot': {
      // Own file: read by Copilot CLI, the cloud agent (default branch) and VS Code agent mode.
      const hooks: Json = {};
      for (const [event, kind, timeoutSec] of COPILOT_EVENTS) {
        hooks[event] = [{ type: 'command', bash: hookCommand(tool, kind), timeoutSec }];
      }
      const rel = '.github/hooks/devctx.json';
      return writeIfChanged(tool, root, rel, { version: 1, hooks }, readText(path.join(root, rel)) !== null);
    }
    case 'kiro': {
      const rel = '.kiro/hooks/devctx.json';
      const hooks = KIRO_EVENTS.map(([trigger, kind, timeout]) => ({
        name: `devctx ${kind.replace('_', ' ')}`,
        description: 'devctx: records project decisions and injects relevant ones',
        trigger,
        action: { type: 'command', command: hookCommand(tool, kind) },
        timeout,
      }));
      return writeIfChanged(tool, root, rel, { version: 'v1', hooks }, readText(path.join(root, rel)) !== null);
    }
  }
}

export const HOOK_FILES: Record<ToolId, string> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  copilot: '.github/hooks/devctx.json',
  cursor: '.cursor/hooks.json',
  kiro: '.kiro/hooks/devctx.json',
};

export function hookInstalled(root: string, tool: ToolId): boolean {
  const text = readText(path.join(root, HOOK_FILES[tool]));
  return text !== null && OURS.test(text);
}
