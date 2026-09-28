import os from 'node:os';
import { findBinary, runProcess, stripAnsi, tempWorkdir } from '../exec.ts';
import { extractJson } from '../json.ts';
import type { LlmRawResult, ModelCandidate, Provider } from '../types.ts';
import { failure, tail, versionOf } from './common.ts';

// Verified against Cursor's CLI docs, not against an installed binary (UNVERIFIED locally).

async function isCursorAgent(bin: string): Promise<boolean> {
  const r = await runProcess(bin, ['--help'], { cwd: os.tmpdir(), timeoutMs: 15_000 });
  return /cursor/i.test(`${r.stdout}\n${r.stderr}`);
}

function parseModelList(text: string): string[] {
  const ids = new Set<string>();
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(available|models?\b|usage|tip|note)/i.test(line)) continue;
    const m = line.match(/^[*•\-\s]*([a-z0-9][a-z0-9._:/-]*[a-z0-9])/i);
    if (m?.[1] && /[a-z]/i.test(m[1]) && m[1].length <= 60) ids.add(m[1]);
  }
  return [...ids];
}

/** Cursor CLI (`cursor-agent`, newer builds install it as `agent`). */
export const cursorProvider: Provider = {
  id: 'cursor',
  label: 'Cursor CLI',

  async resolveBinary() {
    const named = findBinary(['cursor-agent']);
    if (named) return named;
    const generic = findBinary(['agent']);
    return generic && (await isCursorAgent(generic)) ? generic : null;
  },

  async version(bin) {
    return versionOf(bin);
  },

  async discover(bin) {
    let r = await runProcess(bin, ['models'], { cwd: os.tmpdir(), timeoutMs: 30_000 });
    if (r.code !== 0) r = await runProcess(bin, ['--list-models'], { cwd: os.tmpdir(), timeoutMs: 30_000 });
    const out: ModelCandidate[] = parseModelList(r.stdout)
      .filter((id) => id !== 'auto')
      .map((id) => ({ provider: 'cursor', id, extraArgs: [], effort: null, description: null, source: 'discovered' }));
    out.push({ provider: 'cursor', id: 'auto', extraArgs: [], effort: null, description: 'vendor auto routing', source: 'auto' });
    return out;
  },

  async run(bin, model, req): Promise<LlmRawResult> {
    const work = tempWorkdir('cursor');
    try {
      const args = ['-p', req.prompt, '--output-format', 'json', '--model', model.id, '--mode', 'ask', '--workspace', work.dir, '--trust'];
      const r = await runProcess(bin, args, { cwd: work.dir, timeoutMs: req.timeoutMs });
      if (r.timedOut) return failure('timeout', r.ms);
      const outer = extractJson(r.stdout) as Record<string, unknown> | undefined;
      if (outer?.is_error === true) return failure(`cursor error: ${tail(String(outer.result ?? ''))}`, r.ms);
      const text = typeof outer?.result === 'string' ? outer.result : r.stdout;
      const data = extractJson(text);
      if (data === undefined) {
        return failure(`no JSON in answer (exit ${r.code}): ${tail(r.stderr || text)}`, r.ms, text, r.code === 0 ? 'answer' : 'infra');
      }
      return { ok: true, data, text, ms: r.ms, costUsd: null };
    } finally {
      work.cleanup();
    }
  },
};
