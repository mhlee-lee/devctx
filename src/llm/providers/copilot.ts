import { catalogModels, sortEfforts } from '../catalog.ts';
import { findBinary, runProcess, tempWorkdir } from '../exec.ts';
import { extractJson } from '../json.ts';
import type { FailureKind, LlmRawResult, ModelCandidate, Provider } from '../types.ts';
import { failure, helpChoices, helpText, supports, tail, versionOf } from './common.ts';

const COMMON_EFFORTS = ['low', 'medium', 'high'];
/** One GitHub AI Credit is $0.01; the CLI reports nano credits. */
const USD_PER_NANO_AIU = 0.01 / 1e9;
/** Price of one premium request on plans still billed by request. */
const USD_PER_PREMIUM_REQUEST = 0.04;

export interface CopilotEvents {
  /** The last non-empty assistant message: the answer (earlier ones go with tool requests). */
  answer: string | null;
  /** Every non-empty assistant message, in order. */
  text: string;
  /** Session cost from the last usage checkpoint. */
  costUsd: number | null;
  error: { type: string; message: string } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Reads `copilot -p --output-format json` (JSONL). Assistant messages come whole there, while the
 * text output is hard-wrapped at 100 columns, also inside the JSON strings of an answer.
 */
export function readCopilotEvents(stdout: string): CopilotEvents {
  const messages: string[] = [];
  let costUsd: number | null = null;
  let error: CopilotEvents['error'] = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    const data = record(event?.data);
    if (!event || !data) continue;
    if (event.type === 'assistant.message' && typeof data.content === 'string' && data.content.trim()) {
      messages.push(data.content);
    } else if (event.type === 'session.usage_checkpoint') {
      if (typeof data.totalNanoAiu === 'number') costUsd = data.totalNanoAiu * USD_PER_NANO_AIU;
      else if (typeof data.totalPremiumRequests === 'number') costUsd = data.totalPremiumRequests * USD_PER_PREMIUM_REQUEST;
    } else if (event.type === 'session.error' && typeof data.message === 'string') {
      error = { type: typeof data.errorType === 'string' ? data.errorType : '', message: data.message };
    }
  }
  return { answer: messages[messages.length - 1] ?? null, text: messages.join('\n'), costUsd, error };
}

function errorKind(type: string): FailureKind {
  if (/^(authentication|authorization)$/i.test(type)) return 'auth';
  if (/^(quota|rate_limit)$/i.test(type)) return 'quota';
  return 'infra';
}

/**
 * GitHub Copilot CLI (`copilot -p`). The CLI has no model-list command, so candidates are the
 * cheap models from the price catalog plus `auto` with the `efficiency` routing tier, which
 * GitHub keeps pointed at current efficient models. Unknown or retired ids simply fail and the
 * router moves on. VS Code's Copilot plugin shares the account, so the CLI is used for it too.
 */
export const copilotProvider: Provider = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',
  // 2: answers are read from JSONL events (the hard-wrapped text output failed every model).
  revision: 2,

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
      const jsonl = supports(help, '--output-format');
      const args = ['-p', req.prompt, '--model', model.id, ...model.extraArgs];
      if (jsonl) args.push('--output-format', 'json');
      else if (supports(help, '-s')) args.push('-s');
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
      if (jsonl) {
        // stdout carries session events (loaded skills and tools...): only the CLI's own error
        // and the assistant's messages are read, so their wording cannot pass for a login problem.
        const ev = readCopilotEvents(r.stdout);
        const costUsd = ev.costUsd;
        const data = ev.answer === null ? undefined : extractJson(ev.answer);
        if (data !== undefined) return { ok: true, data, text: ev.text, ms: r.ms, costUsd };
        if (ev.error) return { ...failure(`copilot error (${ev.error.type || 'unknown'}): ${tail(ev.error.message)}`, r.ms, '', errorKind(ev.error.type)), costUsd };
        if (ev.answer === null) return { ...failure(`no answer (exit ${r.code}): ${tail(r.stderr || r.error || '')}`, r.ms), costUsd };
        return { ...failure(`no JSON in answer (exit ${r.code}): ${tail(ev.answer)}`, r.ms, ev.text, 'answer'), costUsd };
      }
      // Text output (a CLI without --output-format) may be hard-wrapped; extractJson repairs that.
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
