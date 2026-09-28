import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinary, runProcess, stripAnsi, tempWorkdir } from '../exec.ts';
import { extractJson } from '../json.ts';
import type { LlmRawResult, ModelCandidate, Provider } from '../types.ts';
import { failure, tail, versionOf } from './common.ts';

// Verified against Kiro's CLI docs, not against an installed binary (UNVERIFIED locally).
// kiro-cli has no --model flag: the model is set in a throwaway custom agent config.

const AGENT = 'devctx-json';

function collectIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out);
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]+$/i.test(value)) out.add(value);
    return;
  }
  const o = value as Record<string, unknown>;
  const id = o.model_id ?? o.modelId ?? o.id ?? o.name;
  if (typeof id === 'string') out.add(id);
  else for (const v of Object.values(o)) if (typeof v === 'object') collectIds(v, out);
}

export const kiroProvider: Provider = {
  id: 'kiro',
  label: 'Kiro CLI',

  async resolveBinary() {
    return findBinary(['kiro-cli']);
  },

  async version(bin) {
    return versionOf(bin);
  },

  async discover(bin) {
    const r = await runProcess(bin, ['chat', '--list-models', '--format', 'json'], { cwd: os.tmpdir(), timeoutMs: 30_000 });
    const ids = new Set<string>();
    collectIds(extractJson(r.stdout), ids);
    const out: ModelCandidate[] = [...ids]
      .filter((id) => id.toLowerCase() !== 'auto')
      .map((id) => ({ provider: 'kiro', id, extraArgs: [], effort: null, description: null, source: 'discovered' }));
    out.push({ provider: 'kiro', id: 'auto', extraArgs: [], effort: null, description: 'vendor auto routing', source: 'auto' });
    return out;
  },

  async run(bin, model, req): Promise<LlmRawResult> {
    const work = tempWorkdir('kiro');
    try {
      const agentDir = path.join(work.dir, '.kiro', 'agents');
      fs.mkdirSync(agentDir, { recursive: true });
      const agent: Record<string, unknown> = {
        name: AGENT,
        description: 'devctx structured extraction',
        prompt: 'Return exactly one JSON object and nothing else. Never use tools.',
        tools: [],
        includeMcpJson: false,
      };
      if (model.id !== 'auto') agent.model = model.id;
      fs.writeFileSync(path.join(agentDir, `${AGENT}.json`), JSON.stringify(agent, null, 2));
      const args = ['chat', '--no-interactive', '--agent', AGENT, '--trust-tools=', req.prompt];
      const r = await runProcess(bin, args, { cwd: work.dir, timeoutMs: req.timeoutMs });
      if (r.timedOut) return failure('timeout', r.ms);
      const text = stripAnsi(r.stdout);
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
