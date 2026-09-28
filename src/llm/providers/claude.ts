import { catalogModels, sortEfforts } from '../catalog.ts';
import { findBinary, runProcess, tempWorkdir } from '../exec.ts';
import { extractJson } from '../json.ts';
import type { LlmRawResult, ModelCandidate, Provider } from '../types.ts';
import { failure, helpChoices, helpText, supports, tail, versionOf } from './common.ts';

/**
 * Claude Code in print mode. Aliases (`haiku`, `sonnet`, ...) track the latest model of each
 * family, and new aliases are picked up from `claude --help`, so new models need no code change.
 * Note: since 2026-06 `claude -p` usage draws from the plan's separate Agent SDK credit.
 */
export const claudeProvider: Provider = {
  id: 'claude',
  label: 'Claude Code',

  async resolveBinary() {
    return findBinary(['claude']);
  },

  async version(bin) {
    return versionOf(bin);
  },

  async discover(bin) {
    const help = await helpText(bin);
    const aliases = new Set<string>(['haiku', 'sonnet', 'opus', ...catalogModels('claude')]);
    const modelHelp = help.match(/--model[\s\S]{0,600}?(?=\n\s*--[a-z])/);
    if (modelHelp) {
      for (const m of modelHelp[0].matchAll(/'([a-z][a-z0-9]{1,15})'/g)) if (m[1]) aliases.add(m[1]);
    }
    // `--effort <level> ... (low, medium, high, xhigh, max)`: every level is its own candidate.
    const levels = supports(help, '--effort') ? sortEfforts(helpChoices(help, '--effort')) : [];
    const efforts: (string | null)[] = levels.length > 0 ? levels : [null];
    return [...aliases].flatMap((id) =>
      efforts.map((effort): ModelCandidate => ({ provider: 'claude', id, extraArgs: [], effort, description: null, source: 'alias' })),
    );
  },

  async run(bin, model, req): Promise<LlmRawResult> {
    const help = await helpText(bin);
    const work = tempWorkdir('claude');
    try {
      const args = ['-p', req.prompt, '--model', model.id, '--output-format', 'json'];
      if (model.effort && supports(help, '--effort')) args.push('--effort', model.effort);
      if (supports(help, '--json-schema')) args.push('--json-schema', JSON.stringify(req.schema));
      if (supports(help, '--tools')) args.push('--tools', '');
      // Hooks must not fire for this internal call (project and user hooks run in -p mode).
      if (supports(help, '--settings')) args.push('--settings', JSON.stringify({ disableAllHooks: true }));
      if (supports(help, '--strict-mcp-config')) args.push('--strict-mcp-config');
      if (supports(help, '--disable-slash-commands')) args.push('--disable-slash-commands');
      if (supports(help, '--no-session-persistence')) args.push('--no-session-persistence');
      if (supports(help, '--permission-prompts')) args.push('--permission-prompts', 'none');
      if (supports(help, '--max-budget-usd')) args.push('--max-budget-usd', '0.5');
      const r = await runProcess(bin, args, { cwd: work.dir, timeoutMs: req.timeoutMs });
      if (r.timedOut) return failure('timeout', r.ms);
      const outer = extractJson(r.stdout);
      if (!outer || typeof outer !== 'object') return failure(`no JSON output (exit ${r.code}): ${tail(r.stderr || r.stdout)}`, r.ms);
      const o = outer as Record<string, unknown>;
      const cost = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null;
      if (o.is_error === true) return { ...failure(`claude error: ${tail(String(o.result ?? o.subtype ?? ''))}`, r.ms), costUsd: cost };
      const text = typeof o.result === 'string' ? o.result : '';
      const data = o.structured_output ?? extractJson(text);
      if (data === undefined || data === null) return { ...failure('no structured output', r.ms, text, 'answer'), costUsd: cost };
      return { ok: true, data, text, ms: r.ms, costUsd: cost };
    } finally {
      work.cleanup();
    }
  },
};
