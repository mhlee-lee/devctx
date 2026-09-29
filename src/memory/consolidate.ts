import { isExpired } from '../compile/tiers.ts';
import type { DevctxConfig } from '../config.ts';
import { anchorsFor, type RepoContext } from '../knowledge/anchors.ts';
import { searchItems, type Scored } from '../knowledge/retrieve.ts';
import { newItem, writeItem } from '../knowledge/store.ts';
import type { Enforcement, Evidence, KnowledgeItem, SourceKind } from '../knowledge/types.ts';
import { routeCall, type RouteOptions } from '../llm/router.ts';
import type { StateDb } from '../state/db.ts';
import type { Language } from '../types.ts';
import type { ProjectPaths } from '../util/paths.ts';
import { isoNow, today } from '../util/text.ts';
import { differsInSubstance, sameRule } from './dedupe.ts';
import type { Candidate } from './extract.ts';
import { canOverride, initialStatus } from './policy.ts';
import { buildJudgePrompt, JUDGE_SCHEMA, parseJudgeResult, type JudgeResult, type Relation } from './prompts.ts';

/**
 * Applies extracted candidates to the knowledge base without ever rewriting a knowledge file:
 * - a confirmed rule is a new file; replacing or refining a rule is a new file that names the old
 *   one in `supersedes`; disagreeing with someone else's rule is a new file with `conflict_with`.
 *   Other clones derive the old file's status from these links (knowledge/view.ts), so two
 *   people's changes are always separate files and git merges them without conflicts.
 * - what only this PC needs (how often a rule was restated or broken, unconfirmed proposals) goes
 *   to the local state database, never into git.
 */

export interface ConsolidateContext {
  paths: ProjectPaths;
  cfg: DevctxConfig;
  db: StateDb;
  /** Mutable: new items are appended so later candidates in the same run see them. */
  team: KnowledgeItem[];
  personal: KnowledgeItem[];
  actor: string | null;
  route: RouteOptions | null;
  /** Repository facts for code-evidence anchors (computed once per run, on first use). */
  repo?: () => RepoContext | null;
}

export interface ApplyResult {
  relation: Relation | 'dropped';
  itemId: string | null;
  targetId: string | null;
  files: string[];
  detail: string;
}

const LIVE = new Set(['active', 'proposed', 'conflict']);

const NO_REASON: Record<Language, string> = {
  ko: '사용자 지시 (이유 미기재)',
  en: 'User instruction (no reason given)',
};

const STRENGTH: Record<Enforcement, number> = { info: 0, should: 1, must: 2 };

function isUserKind(kind: SourceKind): boolean {
  return kind === 'user-instruction' || kind === 'user-correction' || kind === 'human-edit';
}

function sameActor(a: string | null, b: string | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function union(a: readonly string[], b: readonly string[], max = 8): string[] {
  return [...new Set([...a, ...b])].slice(0, max);
}

/** Rules a candidate is compared with: live ones, plus archived proposals (they can be revived). */
function neighborsOf(c: Candidate, pool: readonly KnowledgeItem[]): Scored[] {
  const live = pool.filter((i) => (LIVE.has(i.status) || i.archived) && !isExpired(i));
  const hits = searchItems(live, `${c.statement} ${c.scope.topics.join(' ')}`, { limit: 6, minScore: 0.15, pathHints: [] });
  return hits
    .map((h) => ({ ...h, score: h.score + (h.item.scope.paths.some((p) => c.scope.paths.includes(p)) ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score);
}

function heuristicVerdict(c: Candidate, neighbors: readonly Scored[], why: string): JudgeResult {
  const top = neighbors[0];
  if (top && top.score >= 0.75 && !differsInSubstance(c.statement, top.item.summary)) {
    return { relation: 'duplicate', target_id: top.item.id, merged_statement: null, cascade_ids: [], why, confidence: Math.min(1, top.score) };
  }
  return { relation: 'new', target_id: null, merged_statement: null, cascade_ids: [], why, confidence: 0.5 };
}

/** A neighbour that already says exactly this: settled without an LLM call. */
export function fastVerdict(c: Candidate, neighbors: readonly Scored[]): JudgeResult | null {
  const same = neighbors.find((n) => sameRule(c.statement, n.item.summary) || sameRule(c.statement, n.item.sections.rule));
  if (!same) return null;
  return { relation: 'duplicate', target_id: same.item.id, merged_statement: null, cascade_ids: [], why: 'same wording as the existing rule (no LLM call)', confidence: 1 };
}

async function judge(c: Candidate, neighbors: readonly Scored[], ctx: ConsolidateContext): Promise<JudgeResult> {
  if (neighbors.length === 0) {
    return { relation: 'new', target_id: null, merged_statement: null, cascade_ids: [], why: 'no similar item', confidence: 1 };
  }
  const fast = fastVerdict(c, neighbors);
  if (fast) return fast;
  if (!ctx.route) return heuristicVerdict(c, neighbors, 'lexical similarity (no LLM available)');
  const ids = neighbors.map((n) => n.item.id);
  const res = await routeCall(
    {
      task: 'judge',
      prompt: buildJudgePrompt(
        {
          statement: c.statement,
          paths: c.scope.paths,
          topics: c.scope.topics,
          neighbors: neighbors.map((n) => ({
            id: n.item.id,
            status: n.item.archived ? 'proposed' : n.item.status,
            statement: n.item.summary,
            paths: n.item.scope.paths,
            topics: n.item.scope.topics,
          })),
        },
        ctx.cfg.language,
      ),
      schema: JUDGE_SCHEMA,
      timeoutMs: ctx.cfg.llm.timeout_seconds * 1000,
    },
    (d) => parseJudgeResult(d, ids),
    ctx.route,
  );
  return res.ok ? res.value : heuristicVerdict(c, neighbors, `judge unavailable: ${res.error}`);
}

function quoteOf(c: Candidate, ctx: ConsolidateContext): Evidence {
  return ctx.cfg.memory.store_evidence_quote ? { quote: c.evidenceQuote, at: today() } : { at: today() };
}

function withQuote(evidence: readonly Evidence[], e: Evidence): Evidence[] {
  const out = evidence.filter((x) => !e.quote || x.quote !== e.quote).map((x) => ({ ...x }));
  out.push(e);
  return out.slice(-5);
}

function createItem(c: Candidate, ctx: ConsolidateContext, overrides: Partial<KnowledgeItem>): KnowledgeItem {
  return newItem({
    title: c.title,
    summary: c.statement,
    type: c.type,
    status: initialStatus(c.durability, c.confidence),
    enforcement: c.enforcement,
    audience: c.audience,
    scope: { paths: [...c.scope.paths], topics: [...c.scope.topics] },
    source: { kind: c.sourceKind, actor: ctx.actor, tool: c.tool, captured_at: isoNow() },
    evidence: [quoteOf(c, ctx)],
    sections: { rule: c.statement, reason: c.reason ?? NO_REASON[ctx.cfg.language], exceptions: '', notes: '' },
    valid_until: c.validUntil,
    ...overrides,
  });
}

/** A new file carrying an existing rule forward (confirmed, refined, given an end date, settled). */
function successor(t: KnowledgeItem, c: Candidate, ctx: ConsolidateContext, overrides: Partial<KnowledgeItem>): KnowledgeItem {
  const enforcement = STRENGTH[c.enforcement] > STRENGTH[t.enforcement] ? c.enforcement : t.enforcement;
  return newItem({
    title: t.title,
    summary: t.summary,
    type: t.type,
    status: 'active',
    enforcement,
    audience: t.audience,
    scope: { paths: [...t.scope.paths], topics: [...t.scope.topics] },
    source: { kind: c.sourceKind, actor: ctx.actor, tool: c.tool, captured_at: isoNow() },
    evidence: withQuote(t.evidence, quoteOf(c, ctx)),
    tier: t.tier,
    relates: [...t.relates],
    valid_until: c.validUntil ?? t.valid_until,
    sections: { ...t.sections, reason: c.reason ?? t.sections.reason },
    ...overrides,
  });
}

/**
 * Applies one candidate: reinforce a duplicate, refine or supersede a rule, record a conflict, or
 * add a rule. Returns the new files (never modified ones).
 */
export async function consolidate(c: Candidate, ctx: ConsolidateContext): Promise<ApplyResult> {
  const dropped = (detail: string): ApplyResult => ({ relation: 'dropped', itemId: null, targetId: null, files: [], detail });
  if (c.durability === 'one_off') return dropped('one-off instruction');
  const personal = c.audience === 'personal';
  if (personal && !ctx.cfg.memory.personal) return dropped('personal memory disabled');
  const pool = personal ? ctx.personal : ctx.team;
  const files: string[] = [];
  const byId = (id: string): KnowledgeItem | undefined => pool.find((i) => i.id === id);
  const now = isoNow();

  /** Writes a new rule file (the only kind of write to knowledge files). */
  const commit = (item: KnowledgeItem): KnowledgeItem => {
    item.file = '';
    delete item.local;
    delete item.archived;
    if (item.audience === 'team' && ctx.repo) {
      const repo = ctx.repo();
      item.anchors = repo ? anchorsFor(item, repo) : null;
    }
    files.push(writeItem(ctx.paths, item, ctx.cfg.language));
    pool.push(item);
    return item;
  };
  /** Keeps an unconfirmed rule on this PC only. */
  const propose = (item: KnowledgeItem): KnowledgeItem => {
    item.local = true;
    ctx.db.putProposal(item.id, JSON.stringify({ ...item, file: '' }), 'proposed');
    pool.push(item);
    return item;
  };
  const dropLocal = (t: KnowledgeItem): void => {
    ctx.db.deleteProposal(t.id);
    const at = pool.indexOf(t);
    if (at >= 0) pool.splice(at, 1);
  };
  /** In memory only: other clones derive the same from the new file's `supersedes`. */
  const markReplaced = (ids: readonly string[], by: string): void => {
    for (const id of ids) {
      const t = byId(id);
      if (!t) continue;
      t.status = 'superseded';
      t.superseded_by = by;
      t.conflict_with = [];
    }
  };
  const livePartners = (t: KnowledgeItem): string[] => t.conflict_with.filter((id) => {
    const p = byId(id);
    return Boolean(p && LIVE.has(p.status));
  });
  const countViolation = (id: string): void => {
    ctx.db.bumpStats(id, { violations: 1, at: now });
    ctx.db.recordViolation(id, c.eventId);
  };

  const neighbors = neighborsOf(c, pool);
  const verdict = await judge(c, neighbors, ctx);
  const target = verdict.target_id ? (byId(verdict.target_id) ?? null) : null;
  let relation: Relation = target ? verdict.relation : 'new';

  if (target && !target.local) {
    const userResolvingConflict = target.status === 'conflict' && isUserKind(c.sourceKind);
    const allowed = userResolvingConflict || canOverride(c.sourceKind, target.source.kind);
    // Someone else's rule is never replaced silently: that becomes a conflict to settle.
    const crossActor = Boolean(ctx.actor && target.source.actor && !sameActor(ctx.actor, target.source.actor));
    if (relation === 'duplicate' && verdict.confidence < 0.5) relation = 'new';
    if (relation === 'refine' && (!verdict.merged_statement || !allowed)) relation = allowed ? 'duplicate' : 'new';
    if (relation === 'supersede' && (verdict.confidence < 0.6 || !allowed || (crossActor && !userResolvingConflict))) {
      relation = 'conflict';
    }
    // The same person contradicting their own earlier rule changed their mind; a user answering
    // an open conflict settles it.
    if (relation === 'conflict' && allowed && (userResolvingConflict || sameActor(ctx.actor, target.source.actor))) {
      relation = 'supersede';
    }
  } else if (target?.local && relation === 'duplicate' && verdict.confidence < 0.5) {
    relation = 'new';
  }

  let itemId: string | null = null;
  let note = '';

  if (target?.local) {
    // An unconfirmed proposal of this PC (possibly archived months ago).
    if (relation === 'duplicate' || relation === 'refine') {
      dropLocal(target);
      const merged = relation === 'refine' ? (verdict.merged_statement ?? target.summary) : target.summary;
      const item = commit({
        ...target,
        summary: merged,
        sections: { ...target.sections, rule: merged, reason: c.reason ?? target.sections.reason },
        scope: { paths: union(target.scope.paths, c.scope.paths), topics: union(target.scope.topics, c.scope.topics, 6) },
        status: 'active',
        evidence: withQuote(target.evidence, quoteOf(c, ctx)),
        valid_until: c.validUntil ?? target.valid_until,
        source: { ...target.source, captured_at: target.source.captured_at },
      });
      ctx.db.bumpStats(item.id, { reinforced: 1, at: now });
      itemId = item.id;
      note = target.archived ? 'revived an archived proposal' : 'confirmed a proposal';
    } else {
      // Replaced or contradicted before anyone confirmed it: the new statement stands on its own.
      dropLocal(target);
      const created = createItem(c, ctx, relation === 'supersede' ? { status: 'active' } : {});
      itemId = (created.status === 'active' ? commit(created) : propose(created)).id;
      relation = 'new';
      note = 'replaced an unconfirmed proposal';
    }
  } else {
    switch (relation) {
      case 'duplicate': {
        const t = target as KnowledgeItem;
        if (t.status === 'proposed') {
          // Proposal committed by an earlier devctx version, confirmed now.
          const item = commit(successor(t, c, ctx, { supersedes: [t.id] }));
          markReplaced([t.id], item.id);
          itemId = item.id;
          note = 'confirmed a proposal';
        } else if (t.status === 'conflict') {
          // Restating one side of an open conflict settles it.
          const partners = livePartners(t);
          const item = commit(successor(t, c, ctx, { supersedes: [t.id, ...partners] }));
          markReplaced([t.id, ...partners], item.id);
          itemId = item.id;
          note = 'settled a conflict';
        } else if (c.validUntil && c.validUntil !== t.valid_until) {
          // Same rule with a new end date: carried forward in a new file.
          const item = commit(successor(t, c, ctx, { supersedes: [t.id], valid_until: c.validUntil }));
          markReplaced([t.id], item.id);
          itemId = item.id;
          note = `end date ${c.validUntil}`;
        } else {
          t.reinforced += 1;
          ctx.db.bumpStats(t.id, { reinforced: 1, quote: ctx.cfg.memory.store_evidence_quote ? c.evidenceQuote : null, at: now });
          // The rule existed and the assistant still got it wrong.
          if (t.status === 'active' && c.sourceKind === 'user-correction') countViolation(t.id);
          itemId = t.id;
        }
        break;
      }
      case 'refine': {
        const t = target as KnowledgeItem;
        const merged = verdict.merged_statement ?? t.summary;
        const partners = t.status === 'conflict' ? livePartners(t) : [];
        const settle = partners.length > 0 && isUserKind(c.sourceKind);
        const item = commit(
          successor(t, c, ctx, {
            summary: merged,
            sections: { ...t.sections, rule: merged, reason: c.reason ?? t.sections.reason },
            scope: { paths: union(t.scope.paths, c.scope.paths), topics: union(t.scope.topics, c.scope.topics, 6) },
            supersedes: settle ? [t.id, ...partners] : [t.id],
            conflict_with: settle ? [] : partners,
            status: partners.length > 0 && !settle ? 'conflict' : 'active',
            review: verdict.cascade_ids.filter((id) => byId(id)?.status === 'active'),
          }),
        );
        markReplaced(settle ? [t.id, ...partners] : [t.id], item.id);
        // Counters follow the rule to its new file.
        ctx.db.bumpStats(item.id, { reinforced: t.reinforced + 1, violations: t.violations, at: now });
        if (t.status === 'active' && c.sourceKind === 'user-correction') countViolation(item.id);
        itemId = item.id;
        break;
      }
      case 'supersede': {
        const t = target as KnowledgeItem;
        const replaced = [t.id, ...(t.status === 'conflict' ? livePartners(t) : [])];
        const review = verdict.cascade_ids.filter((id) => byId(id)?.status === 'active');
        // An explicit policy change must take effect even if the wording lacked "from now on".
        const item = commit(createItem(c, ctx, { status: 'active', supersedes: replaced, relates: [...t.relates], review }));
        markReplaced(replaced, item.id);
        for (const id of review) {
          const dep = byId(id);
          if (dep) dep.needs_review = true;
        }
        itemId = item.id;
        break;
      }
      case 'conflict': {
        const t = target as KnowledgeItem;
        const item = commit(createItem(c, ctx, { status: 'conflict', conflict_with: [t.id] }));
        t.conflict_with = union(t.conflict_with, [item.id], 20);
        if (t.status === 'active') t.status = 'conflict';
        itemId = item.id;
        break;
      }
      default: {
        const created = createItem(c, ctx, {});
        itemId = (created.status === 'active' ? commit(created) : propose(created)).id;
        if (created.status !== 'active') note = 'kept on this PC until confirmed';
      }
    }
  }
  const detail = [verdict.why, note].filter(Boolean).join('; ');
  ctx.db.recordOp({ eventId: c.eventId, relation, itemId, targetId: target?.id ?? null, detail });
  return { relation, itemId, targetId: target?.id ?? null, files, detail };
}
