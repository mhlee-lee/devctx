import type { DevctxConfig } from '../config.ts';
import { anchorsFor, repoContext } from '../knowledge/anchors.ts';
import { heldReason } from '../knowledge/guard.ts';
import { newItem, writeItem } from '../knowledge/store.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import { loadPersonal, loadTeam, localProposals } from '../knowledge/view.ts';
import type { StateDb } from '../state/db.ts';
import { gitUserEmail } from '../util/git.ts';
import type { ProjectPaths } from '../util/paths.ts';

/**
 * Decisions a person makes by command instead of in a conversation: confirming or dropping a
 * proposal kept on this PC, and settling a conflict by choosing one side.
 */

function byPrefix<T extends { id: string }>(items: readonly T[], id: string, what: string): T {
  const want = id.trim().toUpperCase();
  const hits = items.filter((i) => i.id.toUpperCase() === want);
  // `devctx status` shows the last six characters of an id; the start of an id works too.
  const found =
    hits.length > 0
      ? hits
      : items.filter((i) => want.length >= 4 && (i.id.toUpperCase().endsWith(want) || i.id.toUpperCase().startsWith(want)));
  if (found.length === 1) return found[0] as T;
  throw new Error(found.length === 0 ? `no ${what} ${id}` : `${id} matches ${found.length} ${what}s; give more of the id`);
}

/** This PC's unconfirmed proposals (team first), archived ones last. */
export function listProposals(db: StateDb): KnowledgeItem[] {
  return [...localProposals(db, 'team'), ...localProposals(db, 'personal')].sort(
    (a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || a.id.localeCompare(b.id),
  );
}

/** Confirms a proposal: it becomes a decision file (team) or a personal preference. */
export function approveProposal(paths: ProjectPaths, cfg: DevctxConfig, db: StateDb, id: string): { item: KnowledgeItem; file: string } {
  const found = byPrefix(listProposals(db), id, 'proposal');
  const held = heldReason(found.summary);
  // It would never be delivered: a decision file that only the guard keeps quiet does not belong in git.
  if (held) throw new Error(`${found.id.slice(-6)} is held: the text ${held}. Reword it and record it again (devctx remember "<rule>"), or drop it: devctx discard ${found.id.slice(-6)}`);
  const item: KnowledgeItem = { ...found, status: 'active', file: '' };
  delete item.local;
  delete item.archived;
  if (item.audience === 'team') item.anchors = anchorsFor(item, repoContext(paths.root));
  const file = writeItem(paths, item, cfg.language);
  db.deleteProposal(found.id);
  db.recordOp({ eventId: null, relation: 'approve', itemId: item.id, targetId: null, detail: 'confirmed by command' });
  return { item, file };
}

export function discardProposal(db: StateDb, id: string): KnowledgeItem {
  const found = byPrefix(listProposals(db), id, 'proposal');
  db.deleteProposal(found.id);
  db.recordOp({ eventId: null, relation: 'discard', itemId: found.id, targetId: null, detail: 'dropped by command' });
  return found;
}

/**
 * Settles a conflict in favour of `id`: a new file restating that rule replaces it and every live
 * rule it conflicts with (the same thing restating one side in a conversation does).
 */
export function resolveConflict(
  paths: ProjectPaths,
  cfg: DevctxConfig,
  db: StateDb,
  id: string,
): { item: KnowledgeItem; file: string; replaced: string[] } {
  const viewOpts = { proposedTtlDays: cfg.memory.proposed_ttl_days, local: true };
  const pool = [...loadTeam(paths, db, viewOpts).items, ...(cfg.memory.personal ? loadPersonal(db, viewOpts).items : [])];
  const conflicted = pool.filter((i) => i.status === 'conflict' && !i.local);
  const chosen = byPrefix(conflicted, id, 'conflicting rule');
  const live = new Set(pool.filter((i) => i.status === 'conflict' || i.status === 'active').map((i) => i.id));
  const partners = new Set(chosen.conflict_with.filter((p) => live.has(p)));
  // The other side may record the link (the newer file of a conflict names the older one).
  for (const other of conflicted) if (other.id !== chosen.id && other.conflict_with.includes(chosen.id)) partners.add(other.id);
  const replaced = [chosen.id, ...partners];
  const item = newItem({
    title: chosen.title,
    summary: chosen.summary,
    type: chosen.type,
    status: 'active',
    enforcement: chosen.enforcement,
    audience: chosen.audience,
    scope: { paths: [...chosen.scope.paths], topics: [...chosen.scope.topics] },
    source: { kind: 'user-instruction', actor: gitUserEmail(paths.root), tool: 'cli', captured_at: new Date().toISOString() },
    evidence: chosen.evidence.map((e) => ({ ...e })),
    tier: chosen.tier,
    relates: [...chosen.relates],
    supersedes: replaced,
    valid_until: chosen.valid_until,
    sections: { ...chosen.sections },
  });
  if (item.audience === 'team') item.anchors = anchorsFor(item, repoContext(paths.root));
  const file = writeItem(paths, item, cfg.language);
  db.recordOp({ eventId: null, relation: 'resolve', itemId: item.id, targetId: chosen.id, detail: `replaces ${replaced.join(', ')}` });
  return { item, file, replaced };
}
