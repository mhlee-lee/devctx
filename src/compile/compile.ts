import fs from 'node:fs';
import path from 'node:path';
import type { DevctxConfig } from '../config.ts';
import { loadItems } from '../knowledge/store.ts';
import type { StateDb } from '../state/db.ts';
import { assertSafeTarget, readText, writeFileAtomic } from '../util/fsx.ts';
import type { ProjectPaths } from '../util/paths.ts';
import { detectForeignEdits, forgetGenerated, recordGenerated } from './foreign.ts';
import { GENERATED_MARKER, PATH_RULE_DIRS, renderAgentsMd, renderPathRules } from './render.ts';
import { planTiers, type TierPlan } from './tiers.ts';

export interface CompileResult {
  changed: string[];
  removed: string[];
  unchanged: string[];
  /** --check: files whose content differs from what would be generated. */
  drift: string[];
  warnings: string[];
  plan: TierPlan;
  foreignEdits: number;
}

export function isManagedAgentsMd(content: string | null): boolean {
  return content === null || content.includes(GENERATED_MARKER);
}

function existingGenerated(root: string): string[] {
  const out: string[] = [];
  for (const dir of PATH_RULE_DIRS) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('devctx-')) continue;
      const rel = `${dir}/${name}`;
      if (readText(path.join(root, rel))?.includes(GENERATED_MARKER)) out.push(rel);
    }
  }
  return out;
}

export function renderOutputs(paths: ProjectPaths, cfg: DevctxConfig): { outputs: Map<string, string>; plan: TierPlan; warnings: string[] } {
  const { items, errors } = loadItems(paths);
  const warnings = errors.map((e) => `${path.relative(paths.root, e.file)}: ${e.error}`);
  const plan = planTiers(items, cfg);
  if (plan.overflow.length > 0) {
    warnings.push(`core budget exceeded: ${plan.overflow.length} rule(s) moved to on-demand (inject.core_budget_tokens=${cfg.inject.core_budget_tokens})`);
  }
  const outputs = new Map<string, string>();
  outputs.set('AGENTS.md', renderAgentsMd(plan, cfg, readText(paths.preamble) ?? ''));
  for (const [rel, content] of renderPathRules(plan, cfg, cfg.targets)) outputs.set(rel, content);
  return { outputs, plan, warnings };
}

/**
 * Regenerates AGENTS.md and path-scoped rule files from `.devctx/knowledge/`. Output is
 * deterministic (sorted by id) so unchanged knowledge never changes the files, which keeps
 * prompt caches warm and git diffs quiet. Direct edits are captured before overwriting.
 */
export function compile(paths: ProjectPaths, cfg: DevctxConfig, db: StateDb | null, opts: { check?: boolean; tool?: string } = {}): CompileResult {
  const { outputs, plan, warnings } = renderOutputs(paths, cfg);
  const result: CompileResult = { changed: [], removed: [], unchanged: [], drift: [], warnings, plan, foreignEdits: 0 };
  const agentsCurrent = readText(paths.agentsMd);
  if (!isManagedAgentsMd(agentsCurrent)) {
    outputs.delete('AGENTS.md');
    warnings.push('AGENTS.md is not managed by devctx yet (run "devctx init" to import it)');
  }
  const stale = existingGenerated(paths.root).filter((rel) => !outputs.has(rel));

  if (opts.check) {
    for (const [rel, content] of outputs) {
      if (readText(path.join(paths.root, rel)) !== content) result.drift.push(rel);
    }
    result.drift.push(...stale);
    return result;
  }

  if (db) result.foreignEdits = detectForeignEdits(paths, db, opts.tool ?? 'cli');
  for (const [rel, content] of outputs) {
    const file = path.join(paths.root, rel);
    if (readText(file) === content) {
      result.unchanged.push(rel);
    } else {
      assertSafeTarget(file, paths.root);
      writeFileAtomic(file, content);
      result.changed.push(rel);
    }
    if (db) recordGenerated(db, rel, content);
  }
  for (const rel of stale) {
    const file = path.join(paths.root, rel);
    assertSafeTarget(file, paths.root);
    fs.rmSync(file, { force: true });
    result.removed.push(rel);
    if (db) forgetGenerated(db, rel);
  }
  return result;
}
