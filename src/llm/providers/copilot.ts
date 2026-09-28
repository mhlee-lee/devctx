import { catalogModels, sortEfforts } from '../catalog.ts';
import { findBinary, runProcess, tempWorkdir } from '../exec.ts';
import { extractJson } from '../json.ts';
import type { LlmRawResult, ModelCandidate, Provider } from '../types.ts';
import { failure, helpChoices, helpText, supports, tail, versionOf } from './common.ts';

const COMMON_EFFORTS = ['low', 'medium', 'high'];

/**
 * GitHub Copilot CLI (`copilot -p`). The CLI has no model-list command, so candidates are the
 * cheap models from the price catalog plus `auto` with the `efficiency` routing tier, which
 * GitHub keeps pointed at current efficient models. Unknown or retired ids simply fail and the
 * router moves on. VS Code's Copilot plugin shares the account, so the CLI is used for it too.
 */
export const copilotProvider: Provider = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',

  async resolveBinary() {
    return findBinary(['copilot']);
  },

  async version(bin) {
    return versionOf(bin);
  },

  async discover(bin) {
    const help = await helpText(bin);
    // Model support for the extreme levels varies, so the ladder stays within low..high.
    const offered = supports(help, '--reasoning-effort') ? helpChoices(help, '--reasoning-effort') : [];
    const ladder = sortEfforts(offered.filter((e) => COMMON_EFFORTS.includes(e)));
    const efforts: (string | null)[] = ladder.length > 0 ? ladder : [null];
    const out: ModelCandidate[] = catalogModels('copilot').flatMap((id) =>
      efforts.map((effort): ModelCandidate => ({ provider: 'copilot', id, extraArgs: [], effort, description: null, source: 'catalog' })),
    );
    out.push({
      provider: 'copilot',
      id: 'auto',
      extraArgs: supports(help, '--auto-tier') ? ['--auto-tier', 'efficiency'] : [],
      effort: null,
      description: 'vendor auto routing (efficiency)',
      source: 'auto',
    });
    return out;
  },

  async run(bin, model, req): Promise<LlmRawResult> {
    const help = await helpText(bin);
    const work = tempWorkdir('copilot');
    try {
      const args = ['-p', req.prompt, '--model', model.id, ...model.extraArgs];
      if (supports(help, '-s')) args.push('-s');
      if (model.effort && supports(help, '--reasoning-effort')) args.push('--reasoning-effort', model.effort);
      for (const flag of [
        '--no-ask-user',
        '--no-custom-instructions',
        '--disable-builtin-mcps',
        '--no-remote',
        '--no-auto-update',
        '--no-color',
      ]) {
        if (supports(help, flag)) args.push(flag);
      }
      if (supports(help, '--stream')) args.push('--stream', 'off');
      // Non-interactive mode needs tool permission to be settled up front: allow, then deny
      // everything that could touch files, the shell or the network.
      if (supports(help, '--allow-all-tools')) args.push('--allow-all-tools');
      if (supports(help, '--deny-tool')) {
        for (const tool of ['shell', 'write', 'url', 'memory']) args.push(`--deny-tool=${tool}`);
      }
      if (supports(help, '-C')) args.push('-C', work.dir);
      const r = await runProcess(bin, args, { cwd: work.dir, timeoutMs: req.timeoutMs });
      if (r.timedOut) return failure('timeout', r.ms);
      const data = extractJson(r.stdout);
      if (data === undefined) {
        return failure(`no JSON in answer (exit ${r.code}): ${tail(r.stderr || r.stdout)}`, r.ms, r.stdout, r.code === 0 ? 'answer' : 'infra');
      }
      return { ok: true, data, text: r.stdout, ms: r.ms, costUsd: null };
    } finally {
      work.cleanup();
    }
  },
};
