import type { DevctxConfig } from '../config.ts';
import { searchItems, type Scored } from '../knowledge/retrieve.ts';
import { newItem, writeItem } from '../knowledge/store.ts';
import type { KnowledgeItem, SourceKind } from '../knowledge/types.ts';
import { routeCall, type RouteOptions } from '../llm/router.ts';
import type { StateDb } from '../state/db.ts';
import type { Language } from '../types.ts';
import type { ProjectPaths } from '../util/paths.ts';
import { isoNow, today } from '../util/text.ts';
import type { Candidate } from './extract.ts';
import { canOverride, initialStatus, registerViolation } from './policy.ts';
import { buildJudgePrompt, JUDGE_SCHEMA, parseJudgeResult, type JudgeResult, type Relation } from './prompts.ts';

export interface ConsolidateContext {
  paths: ProjectPaths;
  cfg: DevctxConfig;
  db: StateDb;
  /** Mutable: new items are appended so later candidates in the same run see them. */
  team: KnowledgeItem[];
  personal: KnowledgeItem[];
  actor: string | null;
  route: RouteOptions | null;
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

function isUserKind(kind: SourceKind): boolean {
  return kind === 'user-instruction' || kind === 'user-correction' || kind === 'human-edit';
}

function sameActor(a: string | null, b: string | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function union(a: readonly string[], b: readonly string[], max = 8): string[] {
  return [...new Set([...a, ...b])].slice(0, max);
}

function neighborsOf(c: Candidate, pool: readonly KnowledgeItem[]): Scored[] {
  const live = pool.filter((i) => LIVE.has(i.status));
  const hits = searchItems(live, `${c.statement} ${c.scope.topics.join(' ')}`, { limit: 6, minScore: 0.15, pathHints: [] });
  return hits
    .map((h) => ({ item: h.item, score: h.score + (h.item.scope.paths.some((p) => c.scope.paths.includes(p)) ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score);
}

function heuristicVerdict(neighbors: readonly Scored[], why: string): JudgeResult {
  const top = neighbors[0];
  if (top && top.score >= 0.75) {
    return { relation: 'duplicate', target_id: top.item.id, merged_statement: null, cascade_ids: [], why, confidence: Math.min(1, top.score) };
  }
  return { relation: 'new', target_id: null, merged_statement: null, cascade_ids: [], why, confidence: 0.5 };
}

async function judge(c: Candidate, neighbors: readonly Scored[], ctx: ConsolidateContext): Promise<JudgeResult> {
  if (neighbors.length === 0) {
    return { relation: 'new', target_id: null, merged_statement: null, cascade_ids: [], why: 'no similar item', confidence: 1 };
  }
  if (!ctx.route) return heuristicVerdict(neighbors, 'lexical similarity (no LLM available)');
  const allowed = new Set(neighbors.map((n) => n.item.id));
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
            status: n.item.status,
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
    (d) => parseJudgeResult(d, allowed),
    ctx.route,
  );
  return res.ok ? res.value : heuristicVerdict(neighbors, `judge unavailable: ${res.error}`);
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
    evidence: ctx.cfg.memory.store_evidence_quote ? [{ quote: c.evidenceQuote, at: today() }] : [{ at: today() }],
    sections: { rule: c.statement, reason: c.reason ?? NO_REASON[ctx.cfg.language], exceptions: '', notes: '' },
    ...overrides,
  });
}

function addEvidence(item: KnowledgeItem, c: Candidate, ctx: ConsolidateContext): void {
  if (ctx.cfg.memory.store_evidence_quote && !item.evidence.some((e) => e.quote === c.evidenceQuote)) {
    item.evidence.push({ quote: c.evidenceQuote, at: today() });
    item.evidence = item.evidence.slice(-5);
  }
  item.last_verified = today();
}

/**
 * Applies one candidate to the knowledge base: reinforce a duplicate, refine or supersede an
 * existing rule, record a conflict, or add a new item. Only the touched items are rewritten
 * (small itemized edits, never a full regeneration of the memory).
 */
export async function consolidate(c: Candidate, ctx: ConsolidateContext): Promise<ApplyResult> {
  const dropped = (detail: string): ApplyResult => ({ relation: 'dropped', itemId: null, targetId: null, files: [], detail });
  if (c.durability === 'one_off') return dropped('one-off instruction');
  const personal = c.audience === 'personal';
  if (personal && !ctx.cfg.memory.personal) return dropped('personal memory disabled');
  const pool = personal ? ctx.personal : ctx.team;
  const files: string[] = [];
  const save = (item: KnowledgeItem): void => {
    files.push(writeItem(ctx.paths, item, ctx.cfg.language));
  };
  const byId = (id: string): KnowledgeItem | undefined => pool.find((i) => i.id === id);
  const retire = (item: KnowledgeItem, by: string): void => {
    item.status = 'superseded';
    item.superseded_by = by;
    item.conflict_with = [];
    save(item);
  };

  const neighbors = neighborsOf(c, pool);
  const verdict = await judge(c, neighbors, ctx);
  const target = verdict.target_id ? (byId(verdict.target_id) ?? null) : null;
  let relation: Relation = target ? verdict.relation : 'new';

  if (target) {
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
  }

  let itemId: string | null = null;
  switch (relation) {
    case 'duplicate': {
      const t = target as KnowledgeItem;
      t.reinforced += 1;
      addEvidence(t, c, ctx);
      if (t.status === 'proposed') {
        t.status = 'active'; // confirmed by repetition
      } else if (t.status === 'active' && c.sourceKind === 'user-correction') {
        registerViolation(t); // the rule existed and the assistant still got it wrong
        ctx.db.recordViolation(t.id, c.eventId);
      } else if (t.status === 'conflict') {
        t.status = 'active';
        for (const partnerId of t.conflict_with) {
          const partner = byId(partnerId);
          if (partner && partner.status !== 'superseded') retire(partner, t.id);
        }
        t.conflict_with = [];
      }
      save(t);
      itemId = t.id;
      break;
    }
    case 'refine': {
      const t = target as KnowledgeItem;
      const merged = verdict.merged_statement ?? t.summary;
      t.summary = merged;
      t.sections.rule = merged;
      t.scope = { paths: union(t.scope.paths, c.scope.paths), topics: union(t.scope.topics, c.scope.topics, 6) };
      t.revision += 1;
      t.reinforced += 1; // the user restated the rule while adding detail
      if (t.status === 'proposed') {
        t.status = 'active';
      } else if (t.status === 'active' && c.sourceKind === 'user-correction') {
        registerViolation(t);
        ctx.db.recordViolation(t.id, c.eventId);
      }
      addEvidence(t, c, ctx);
      save(t);
      itemId = t.id;
      break;
    }
    case 'supersede': {
      const t = target as KnowledgeItem;
      // An explicit policy change must take effect even if the wording lacked "from now on".
      const created = createItem(c, ctx, { status: 'active', supersedes: [t.id], relates: t.relates });
      pool.push(created);
      save(created);
      const partners = t.conflict_with.map(byId).filter((p): p is KnowledgeItem => Boolean(p));
      retire(t, created.id);
      for (const p of partners) if (p.status === 'conflict') retire(p, created.id);
      for (const id of verdict.cascade_ids) {
        const dep = byId(id);
        if (dep && dep.status === 'active' && !dep.needs_review) {
          dep.needs_review = true;
          save(dep);
        }
      }
      itemId = created.id;
      break;
    }
    case 'conflict': {
      const t = target as KnowledgeItem;
      const created = createItem(c, ctx, { status: 'conflict', conflict_with: [t.id] });
      pool.push(created);
      save(created);
      t.conflict_with = union(t.conflict_with, [created.id], 20);
      if (t.status === 'active' || t.status === 'proposed') t.status = 'conflict';
      save(t);
      itemId = created.id;
      break;
    }
    default: {
      const created = createItem(c, ctx, {});
      pool.push(created);
      save(created);
      itemId = created.id;
    }
  }
  ctx.db.recordOp({ eventId: c.eventId, relation, itemId, targetId: target?.id ?? null, detail: verdict.why });
  return { relation, itemId, targetId: target?.id ?? null, files, detail: verdict.why };
}
