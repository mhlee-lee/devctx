import fs from 'node:fs';
import type { LlmRawResult, Provider } from '../types.ts';

/**
 * Test provider, active only when DEVCTX_FAKE_LLM points at a JSON file of queued answers:
 * `{ "extract": [answer, ...], "judge": [...], "qualify": [...] }`. Each call pops one answer for
 * its task (`{"__error": "..."}` simulates a failure) and appends the prompt to `<file>.requests.jsonl`.
 */
export const fakeProvider: Provider = {
  id: 'fake',
  label: 'Fake LLM (tests)',

  async resolveBinary() {
    return process.env.DEVCTX_FAKE_LLM ? 'fake' : null;
  },

  async version() {
    return '1.0.0';
  },

  async discover() {
    return [{ provider: 'fake', id: 'fake-small', extraArgs: [], effort: null, description: 'fast test model', source: 'discovered' }];
  },

  async run(_bin, model, req): Promise<LlmRawResult> {
    const file = process.env.DEVCTX_FAKE_LLM;
    if (!file) return { ok: false, error: 'DEVCTX_FAKE_LLM not set', text: '', ms: 0 };
    const queue = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown[]>;
    fs.appendFileSync(`${file}.requests.jsonl`, `${JSON.stringify({ task: req.task, model: model.id, prompt: req.prompt })}\n`);
    const list = queue[req.task] ?? [];
    const next = list.shift();
    queue[req.task] = list;
    fs.writeFileSync(file, JSON.stringify(queue));
    if (next === undefined) return { ok: false, error: `no fake answer queued for ${req.task}`, text: '', ms: 1 };
    if (next && typeof next === 'object' && '__error' in next) {
      return { ok: false, error: String((next as Record<string, unknown>).__error), text: '', ms: 1 };
    }
    return { ok: true, data: next, text: JSON.stringify(next), ms: 1, costUsd: 0 };
  },
};
