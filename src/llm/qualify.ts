import type { Language } from '../types.ts';
import { callCostUsd } from './catalog.ts';
import { suiteCalls, suiteSize, type SuiteTask } from './suite.ts';
import type { FailureKind, ModelCandidate, Provider } from './types.ts';

export interface QualifyCall {
  ok: boolean;
  ms: number;
  costUsd: number | null;
  error?: string;
}

export interface QualifyResult {
  task: SuiteTask;
  pass: boolean;
  /** Requirements met, over `runs` repetitions of the suite. */
  score: number;
  total: number;
  runs: number;
  details: string[];
  calls: QualifyCall[];
  /** Set when the evaluation could not run (login, quota, CLI failure): no verdict on the model. */
  blocked: FailureKind | null;
  /** Mean measured cost of one call, when the CLI reports usage. */
  avgCostUsd: number | null;
}

function average(calls: readonly QualifyCall[]): number | null {
  const known = calls.map((c) => c.costUsd).filter((c): c is number => typeof c === 'number');
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

/**
 * Runs the requirement suite for one task. The model passes only when every requirement holds in
 * every one of `runs` repetitions (answers vary between calls, so one lucky pass is not enough).
 * Stops at the first broken requirement: a failing model costs as few calls as possible.
 */
export async function qualifyModel(
  provider: Provider,
  bin: string,
  model: ModelCandidate,
  task: SuiteTask,
  lang: Language,
  timeoutMs: number,
  runs: number,
): Promise<QualifyResult> {
  const calls: QualifyCall[] = [];
  const perRun = suiteSize(task);
  const res: QualifyResult = { task, pass: false, score: 0, total: perRun * runs, runs, details: [], calls, blocked: null, avgCostUsd: null };
  const finish = (): QualifyResult => {
    res.avgCostUsd = average(calls);
    return res;
  };

  for (let run = 1; run <= runs; run++) {
    for (const call of suiteCalls(task, lang)) {
      const raw = await provider.run(bin, model, { task: 'qualify', prompt: call.prompt, schema: call.schema, timeoutMs });
      calls.push({ ok: raw.ok, ms: raw.ms, costUsd: callCostUsd(model, raw), ...(raw.error ? { error: raw.error } : {}) });
      if (!raw.ok && raw.kind && raw.kind !== 'answer') {
        res.blocked = raw.kind;
        res.details.push(`${call.name}: could not run (${raw.kind}: ${raw.error ?? ''})`);
        return finish();
      }
      const outcome = raw.ok ? call.check(raw.data) : null;
      if (!outcome) {
        res.details.push(`run ${run} ${call.name}: unusable answer (${raw.error ?? 'bad shape'})`);
        return finish();
      }
      res.score += outcome.passed.length;
      if (outcome.failed.length > 0) {
        res.details.push(`run ${run} ${call.name}: FAIL ${outcome.failed.join('; ')}`);
        res.details.push(`  got: ${outcome.got.slice(0, 400)}`);
        return finish();
      }
    }
  }
  res.pass = true;
  res.details.push(`all ${perRun} requirements met in ${runs} run${runs > 1 ? 's' : ''}`);
  return finish();
}
