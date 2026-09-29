import { codeLookup } from './codeindex/hints.ts';
import { loadConfig } from './config.ts';
import { PROMPT_MIN_SCORE, selectPromptContext, type TraceEntry } from './hooks/context.ts';
import { continuesSession, renderHandoff } from './hooks/handoff.ts';
import type { KnowledgeItem } from './knowledge/types.ts';
import { applyCachedStale, loadPersonal, loadTeam } from './knowledge/view.ts';
import { StateDb } from './state/db.ts';
import { projectPaths } from './util/paths.ts';
import { approxTokens, truncate } from './util/text.ts';

/**
 * Read-only views of the memory for people: why a prompt gets the decisions it gets (a retrieval
 * trace, as OpenViking and Hindsight log per query) and what the worker changed on its own (the
 * `ops` audit table, like Mem0's history). Neither calls an LLM or writes anything.
 */

function short(id: string): string {
  return id.slice(-6);
}

function scoreText(e: TraceEntry): string {
  if (!e.parts) return '';
  const p = e.parts;
  const bits = [`lexical ${p.lexical.toFixed(2)}`];
  if (p.topics) bits.push(`topics +${p.topics.toFixed(2)}`);
  if (p.path) bits.push(`path +${p.path.toFixed(2)}`);
  if (p.code) bits.push(`code +${p.code.toFixed(2)}`);
  return `${e.score.toFixed(2)} (${bits.join(', ')})`;
}

/** `devctx why "<prompt>"`: what the prompt hook would add for this prompt in a fresh session. */
export function explainPrompt(root: string, prompt: string, all: boolean): string {
  const paths = projectPaths(root);
  const cfg = loadConfig(paths);
  const db = StateDb.open(paths.stateDb);
  try {
    const team = loadTeam(paths, db, { proposedTtlDays: cfg.memory.proposed_ttl_days }).items;
    applyCachedStale(db, team);
    const violations = new Map<string, number>();
    for (const [id, s] of db.itemStats()) if (s.violations > 0) violations.set(id, s.violations);
    const code = cfg.code_index.enabled ? codeLookup(root, prompt, cfg.language, 200) : { text: null, paths: [] };
    const sel = selectPromptContext(team, prompt, cfg, { sessionStartedAt: null, alreadyInjected: new Set(), codePaths: code.paths, violations });
    const out: string[] = [];
    out.push(`prompt kind   ${sel.kind}${sel.kind === 'command' ? ' (slash command or shell escape: nothing is added)' : sel.kind === 'ack' ? ' (acknowledgement: no relevance search)' : ''}`);
    if (code.paths.length > 0) out.push(`code files    ${code.paths.slice(0, 6).join(', ')} (symbols named in the prompt)`);
    out.push(`threshold     ${PROMPT_MIN_SCORE} (budget ${cfg.inject.prompt_budget_tokens} tokens)`);
    return explainRest(db, cfg, prompt, all, sel, code, out);
  } finally {
    db.close();
  }
}

function explainRest(
  db: StateDb,
  cfg: ReturnType<typeof loadConfig>,
  prompt: string,
  all: boolean,
  sel: ReturnType<typeof selectPromptContext>,
  code: { text: string | null; paths: string[] },
  out: string[],
): string {
  {
    const prev = db.previousSession(new Date().toISOString(), new Date(Date.now() - 7 * 86_400_000).toISOString(), null);
    if (!prev || cfg.inject.handoff_budget_tokens <= 0) {
      out.push(`handoff       ${cfg.inject.handoff_budget_tokens <= 0 ? 'off (inject.handoff_budget_tokens: 0)' : 'no earlier session in the last 7 days'}`);
    } else {
      const linked = sel.kind !== 'command' && continuesSession(prompt, prev);
      out.push(`handoff       ${linked ? 'yes' : 'no'}: last session ${prev.tool} ended ${prev.endedAt.slice(0, 16).replace('T', ' ')}Z${linked ? '' : ' (the prompt neither says it continues nor names the same code)'}`);
    }
    const text = [
      prev && sel.kind !== 'command' && continuesSession(prompt, prev) ? renderHandoff(prev, cfg.language, cfg.inject.handoff_budget_tokens) : null,
      sel.text,
      code.text,
    ]
      .filter(Boolean)
      .join('\n\n');
    out.push('', text ? `would add (${approxTokens(text)} tokens):` : 'would add nothing', ...(text ? text.split('\n').map((l) => `  ${l}`) : []));
  }

  const shown = all ? sel.trace : sel.trace.filter((e) => e.outcome !== 'always loaded' && (e.score > 0 || e.outcome === 'injected')).slice(0, 12);
  if (shown.length > 0) {
    out.push('', 'decisions:');
    for (const e of shown) {
      out.push(`  ${e.outcome.padEnd(16)} ${short(e.item.id)} ${scoreText(e).padEnd(44)} ${truncate(e.item.summary, 70)}${e.item.stale ? `  [${e.item.stale}]` : ''}`);
    }
  }
  const loaded = sel.trace.filter((e) => e.outcome === 'always loaded').length;
  const rest = sel.trace.length - shown.length - (all ? 0 : loaded);
  if (!all && (loaded > 0 || rest > 0)) {
    out.push(`  (${loaded} always loaded from AGENTS.md or path rules${rest > 0 ? `, ${rest} not related` : ''}; --all lists every decision)`);
  }
  return out.join('\n');
}

function describe(byId: Map<string, KnowledgeItem>, id: unknown): string {
  if (typeof id !== 'string' || !id) return '';
  const item = byId.get(id);
  return item ? `${short(id)} "${truncate(item.summary, 60)}"` : short(id);
}

/** `devctx log`: automatic changes to the memory, newest first, with the judge's reason. */
export function memoryLog(root: string, limit: number): string {
  const paths = projectPaths(root);
  const cfg = loadConfig(paths);
  const db = StateDb.open(paths.stateDb);
  try {
    const opts = { proposedTtlDays: cfg.memory.proposed_ttl_days, local: true };
    const items = [...loadTeam(paths, db, opts).items, ...loadPersonal(db, opts).items];
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = db.recentOps(limit);
    if (rows.length === 0) return 'no automatic changes recorded yet';
    return rows
      .map((r) => {
        const when = String(r.ts).slice(0, 16).replace('T', ' ');
        const target = r.target_id && r.target_id !== r.item_id ? ` → ${describe(byId, r.target_id)}` : '';
        const detail = typeof r.detail === 'string' && r.detail ? `\n${' '.repeat(28)}${truncate(r.detail, 110)}` : '';
        return `${when}  ${String(r.relation).padEnd(9)} ${describe(byId, r.item_id)}${target}${detail}`;
      })
      .join('\n');
  } finally {
    db.close();
  }
}
