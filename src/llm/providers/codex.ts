import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sortEfforts } from '../catalog.ts';
import { findBinary, runProcess, tempWorkdir } from '../exec.ts';
import { extractJson } from '../json.ts';
import type { LlmRawResult, ModelCandidate, Provider, TokenUsage } from '../types.ts';
import { failure, helpText, supports, tail, versionOf } from './common.ts';

interface CodexModel {
  slug?: unknown;
  description?: unknown;
  visibility?: unknown;
  model_specialty?: unknown;
  supported_reasoning_levels?: unknown;
}

function efforts(m: CodexModel): string[] {
  if (!Array.isArray(m.supported_reasoning_levels)) return [];
  return m.supported_reasoning_levels
    .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).effort : l))
    .filter((e): e is string => typeof e === 'string');
}

/**
 * Features that add tools or tool instructions to every request. A JSON-only call needs none of
 * them; turning them off cut Codex's fixed input from ~17.7k to ~7k tokens per call (measured on
 * 0.158). Only features the installed CLI lists as enabled are passed to `--disable`.
 */
const TOOL_FEATURES = [
  'hooks',
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'goals',
  'image_generation',
  'multi_agent',
  'plugins',
  'remote_plugin',
  'shell_tool',
  'skill_search',
  'sleep_tool',
  'tool_suggest',
  'unified_exec',
  'view_image',
  'worktrees',
  'workspace_dependencies',
];

const INSTRUCTIONS =
  'You are a JSON function inside a developer tool. Follow the instructions in the user message, reply with exactly one JSON object that matches the requested schema, and never use tools.\n';

const featureCache = new Map<string, Set<string>>();

async function enabledFeatures(bin: string): Promise<Set<string>> {
  let set = featureCache.get(bin);
  if (!set) {
    const r = await runProcess(bin, ['features', 'list'], { cwd: os.tmpdir(), timeoutMs: 20_000 });
    set = new Set<string>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^([a-z0-9_.]+)\s+.*\btrue\s*$/);
      if (m?.[1]) set.add(m[1]);
    }
    featureCache.set(bin, set);
  }
  return set;
}

/**
 * The user's config.toml is skipped (hermetic call: no MCP servers, profiles or experiments)
 * unless it picks a model provider or profile, which the call may need to reach the API at all.
 */
function userConfigNeeded(): boolean {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    return /^\s*(model_provider|profile)\s*=/m.test(text) || /^\s*\[(model_providers|profiles)[.\]]/m.test(text);
  } catch {
    return false;
  }
}

/** Token usage from `--json` events (`turn.completed.usage`); the last report wins. */
export function usageFromEvents(stdout: string): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"usage"')) continue;
    try {
      const u = (JSON.parse(line) as { usage?: Record<string, unknown> }).usage;
      if (u && typeof u.input_tokens === 'number') {
        const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        usage = { input: n(u.input_tokens), cachedInput: n(u.cached_input_tokens), output: n(u.output_tokens), reasoning: n(u.reasoning_output_tokens) };
      }
    } catch {
      // not an event line
    }
  }
  return usage;
}

/**
 * Codex CLI (`codex exec`). Models come from `codex debug models`, the same catalog the Codex app
 * and IDE use, so new models appear without code changes. Every supported reasoning effort of a
 * model is a separate candidate; the router tries them cheapest first, so a small model at a
 * higher effort is preferred to a bigger model whenever it meets every requirement.
 */
export const codexProvider: Provider = {
  id: 'codex',
  label: 'OpenAI Codex',

  async resolveBinary() {
    return findBinary(['codex']);
  },

  async version(bin) {
    return versionOf(bin);
  },

  async discover(bin) {
    const r = await runProcess(bin, ['debug', 'models'], { cwd: os.tmpdir(), timeoutMs: 45_000 });
    const parsed = extractJson(r.stdout) as { models?: CodexModel[] } | undefined;
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const out: ModelCandidate[] = [];
    for (const m of models) {
      if (typeof m.slug !== 'string') continue;
      if (m.visibility !== undefined && m.visibility !== 'list') continue;
      if (m.model_specialty) continue;
      const description = typeof m.description === 'string' ? m.description : null;
      const levels = sortEfforts(efforts(m));
      if (levels.length === 0) {
        out.push({ provider: 'codex', id: m.slug, extraArgs: [], effort: null, description, source: 'discovered' });
        continue;
      }
      for (const effort of levels) out.push({ provider: 'codex', id: m.slug, extraArgs: [], effort, description, source: 'discovered' });
    }
    return out;
  },

  async run(bin, model, req): Promise<LlmRawResult> {
    const help = await helpText(bin, ['exec', '--help']);
    const work = tempWorkdir('codex');
    try {
      const schemaFile = path.join(work.dir, 'schema.json');
      const outFile = path.join(work.dir, 'last-message.json');
      const instructionsFile = path.join(work.dir, 'instructions.md');
      fs.writeFileSync(schemaFile, JSON.stringify(req.schema));
      fs.writeFileSync(instructionsFile, INSTRUCTIONS);
      const args = ['exec', '--model', model.id];
      if (model.effort) args.push('-c', `model_reasoning_effort="${model.effort}"`);
      if (supports(help, '--ignore-user-config') && !userConfigNeeded()) args.push('--ignore-user-config');
      args.push('-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`, '-c', 'web_search="disabled"');
      if (supports(help, '--disable')) {
        const enabled = await enabledFeatures(bin);
        for (const f of TOOL_FEATURES) if (f === 'hooks' || enabled.has(f)) args.push('--disable', f);
      }
      if (supports(help, '--sandbox')) args.push('--sandbox', 'read-only');
      if (supports(help, '--skip-git-repo-check')) args.push('--skip-git-repo-check');
      if (supports(help, '--ephemeral')) args.push('--ephemeral');
      if (supports(help, '--ignore-rules')) args.push('--ignore-rules');
      if (supports(help, '--color')) args.push('--color', 'never');
      const json = supports(help, '--json');
      if (json) args.push('--json');
      if (supports(help, '--output-schema')) args.push('--output-schema', schemaFile);
      args.push('-o', outFile, '-C', work.dir, req.prompt);
      const r = await runProcess(bin, args, { cwd: work.dir, timeoutMs: req.timeoutMs });
      if (r.timedOut) return failure('timeout', r.ms);
      const usage = json ? usageFromEvents(r.stdout) : null;
      let text = '';
      try {
        text = fs.readFileSync(outFile, 'utf8');
      } catch {
        text = json ? '' : r.stdout;
      }
      if (r.code !== 0 && !text.trim()) return { ...failure(`exit ${r.code}: ${tail(r.stderr || r.stdout)}`, r.ms), usage };
      const data = extractJson(text);
      if (data === undefined) {
        return { ...failure(`no JSON in answer: ${tail(text || r.stdout)}`, r.ms, text, r.code === 0 ? 'answer' : 'infra'), usage };
      }
      return { ok: true, data, text, ms: r.ms, costUsd: null, usage };
    } finally {
      work.cleanup();
    }
  },
};
