import fs from 'node:fs';
import path from 'node:path';
import { canonical } from '../memory/dedupe.ts';
import type { ItemStats, StateDb } from '../state/db.ts';
import { listFiles, readText } from '../util/fsx.ts';
import { personalDir, type ProjectPaths } from '../util/paths.ts';
import { today } from '../util/text.ts';
import { parseItem } from './format.ts';
import { isKnowledgeFile, type LoadResult } from './store.ts';
import type { KnowledgeItem } from './types.ts';

/**
 * The knowledge base as devctx uses it. Files are never rewritten by devctx, so what a rule's
 * status is right now is computed from all files together:
 * - a rule named in a newer rule's `supersedes` is superseded (also when two branches did so);
 * - two live rules linked by `conflict_with`, or two rules that each replaced the same rule on
 *   different branches, are in conflict (a link to a rule that was since replaced, without
 *   settling the disagreement, holds for its replacement);
 * - a rule past its `valid_until` is retired; exact duplicates (same wording and scope, e.g. said
 *   on two branches) collapse into the oldest.
 * The result depends only on the files, so every clone at the same commit computes the same thing
 * and AGENTS.md comes out identical everywhere. What only this PC knows (how often a rule came up,
 * unconfirmed proposals) is added on top in the "local" view and never reaches the compiled files.
 */

export interface ViewOptions {
  /** Days an unconfirmed proposal is kept before it is archived. */
  proposedTtlDays: number;
  /** Include this PC's proposals and counters (worker, status); never used for compiled files. */
  local?: boolean;
  day?: string;
}

// ---------------------------------------------------------------------------------------------
// Reading files (with a parse cache in the state database)
// ---------------------------------------------------------------------------------------------

/**
 * Reads knowledge files. With a state database, a file whose size and times are unchanged is
 * taken from the parse cache instead of being read and parsed again: the prompt hook then costs
 * a directory listing plus `stat` per file, however many rules have accumulated.
 */
export function readKnowledgeFiles(dirs: readonly string[], db: StateDb | null): LoadResult {
  const items: KnowledgeItem[] = [];
  const errors: { file: string; error: string }[] = [];
  const seenIds = new Map<string, string>();
  const cache = db ? db.kfiles() : null;
  const present = new Set<string>();
  for (const dir of dirs) {
    for (const file of listFiles(dir, isKnowledgeFile)) {
      present.add(file);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let item: KnowledgeItem | null = null;
      let error: string | null = null;
      const row = cache?.get(file);
      if (row && row.mtime === st.mtimeMs && row.ctime === st.ctimeMs && row.size === st.size) {
        if (row.item) {
          try {
            item = JSON.parse(row.item) as KnowledgeItem;
          } catch {
            item = null;
          }
        }
        error = row.error;
      }
      if (!item && !error) {
        const text = readText(file);
        if (text === null) continue;
        const res = parseItem(text, file);
        item = res.item;
        error = res.error;
        db?.putKfile({ path: file, mtime: st.mtimeMs, ctime: st.ctimeMs, size: st.size, item: item ? JSON.stringify(item) : null, error });
      }
      if (!item) {
        errors.push({ file, error: error ?? 'unreadable' });
        continue;
      }
      item.file = file;
      const dup = seenIds.get(item.id);
      if (dup) {
        errors.push({ file, error: `duplicate id ${item.id} (also in ${dup})` });
        continue;
      }
      seenIds.set(item.id, file);
      items.push(item);
    }
  }
  if (db && cache) {
    for (const p of cache.keys()) {
      if (!present.has(p) && dirs.some((d) => p.startsWith(d + path.sep))) db.deleteKfile(p);
    }
  }
  return { items, errors };
}

// ---------------------------------------------------------------------------------------------
// Deriving statuses from the links between files
// ---------------------------------------------------------------------------------------------

const LIVE = new Set(['active', 'proposed', 'conflict']);

function isLive(i: KnowledgeItem): boolean {
  return LIVE.has(i.status);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString();
}

/** Computes each item's current status from all items (mutates them). Deterministic. */
export function deriveStatus(items: readonly KnowledgeItem[], opts: { proposedTtlDays: number; day?: string }): void {
  const day = opts.day ?? today();
  const sorted = [...items].sort((a, b) =>
    a.source.captured_at < b.source.captured_at ? -1 : a.source.captured_at > b.source.captured_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const rank = new Map(sorted.map((i, n) => [i.id, n]));
  const older = (a: KnowledgeItem, b: KnowledgeItem): boolean => (rank.get(a.id) ?? 0) < (rank.get(b.id) ?? 0);
  const byId = new Map(items.map((i) => [i.id, i]));

  // 1. Replacement links. Only an older rule can be replaced, so links can never form a cycle.
  const replacedBy = new Map<string, KnowledgeItem[]>();
  for (const s of sorted) {
    for (const tid of s.supersedes) {
      const t = byId.get(tid);
      if (!t || t === s || !older(t, s)) continue;
      const list = replacedBy.get(tid) ?? [];
      list.push(s);
      replacedBy.set(tid, list);
    }
  }
  for (const [tid, list] of replacedBy) {
    const t = byId.get(tid) as KnowledgeItem;
    if (t.status === 'retired') continue;
    t.status = 'superseded';
    t.superseded_by = (list[0] as KnowledgeItem).id;
  }

  // 2. The same rule recorded twice (typically on two branches): the oldest one stands, and the
  //    copy shares its fate (if the original was replaced, so is the copy).
  const firstByText = new Map<string, KnowledgeItem>();
  for (const i of sorted) {
    if (i.status !== 'active' && i.status !== 'superseded') continue;
    const key = `${i.audience}\u0000${canonical(i.summary)}\u0000${[...i.scope.paths].sort().join('\n')}`;
    const first = firstByText.get(key);
    if (!first) firstByText.set(key, i);
    else if (i.status === 'active') {
      i.status = 'superseded';
      i.superseded_by = first.status === 'superseded' && first.superseded_by ? first.superseded_by : first.id;
    }
  }

  // 3. End dates, and old proposals from earlier versions (they were committed then).
  const cutoff = addDays(day, -opts.proposedTtlDays);
  for (const i of items) {
    if (isLive(i) && i.valid_until !== null && i.valid_until < day) i.status = 'retired';
    else if (i.status === 'proposed' && i.reinforced === 0 && i.source.captured_at < cutoff) {
      i.status = 'retired';
      i.archived = true;
    }
  }

  // 4. Conflicts: explicit links, and two rules that replaced the same rule independently.
  const pairs: [KnowledgeItem, KnowledgeItem][] = [];
  for (const i of items) {
    for (const pid of i.conflict_with) {
      const p = byId.get(pid);
      if (p && p !== i) pairs.push([i, p]);
    }
  }
  for (const list of replacedBy.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const x = list[a] as KnowledgeItem;
        const y = list[b] as KnowledgeItem;
        if (!x.supersedes.includes(y.id) && !y.supersedes.includes(x.id)) pairs.push([x, y]);
      }
    }
  }
  // A disagreement is with a rule's current version: when one side was replaced by a rule that
  // does not settle it (e.g. its author changed it on another branch), the conflict moves to the
  // replacement. Settling always replaces both sides, so a settled conflict has no live heads.
  const heads = (t: KnowledgeItem, seen: Set<string>): KnowledgeItem[] => {
    if (isLive(t)) return [t];
    if (t.status !== 'superseded' || seen.has(t.id)) return [];
    seen.add(t.id);
    const next = [...(replacedBy.get(t.id) ?? [])];
    const copyOf = t.superseded_by ? byId.get(t.superseded_by) : undefined;
    if (copyOf && !next.includes(copyOf)) next.push(copyOf);
    return next.flatMap((n) => heads(n, seen));
  };
  const partners = new Map<string, Set<string>>();
  for (const [px, py] of pairs) {
    for (const x of heads(px, new Set())) {
      for (const y of heads(py, new Set())) {
        if (x === y || x.status === 'proposed' || y.status === 'proposed') continue;
        for (const [a, b] of [[x, y], [y, x]] as const) {
          const set = partners.get(a.id) ?? new Set<string>();
          set.add(b.id);
          partners.set(a.id, set);
        }
      }
    }
  }
  for (const i of items) {
    const set = partners.get(i.id);
    if (set) {
      i.status = 'conflict';
      i.conflict_with = [...set].sort();
    } else {
      if (i.status === 'conflict') i.status = 'active'; // the other side was replaced or expired
      i.conflict_with = [];
    }
  }

  // 5. Rules that relied on what a newer rule replaced: check them again.
  for (const r of sorted) {
    if (!isLive(r)) continue;
    for (const nid of r.review) {
      const n = byId.get(nid);
      if (!n || n.status !== 'active' || !older(n, r)) continue;
      n.needs_review = true;
      if (!n.reviewSince || n.reviewSince < r.source.captured_at) n.reviewSince = r.source.captured_at;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What only this PC knows
// ---------------------------------------------------------------------------------------------

/** Unconfirmed proposals of this PC (archived ones as `retired` + `archived`). */
export function localProposals(db: StateDb, audience: 'team' | 'personal'): KnowledgeItem[] {
  const out: KnowledgeItem[] = [];
  for (const row of db.proposals()) {
    let item: KnowledgeItem;
    try {
      item = JSON.parse(row.item) as KnowledgeItem;
    } catch {
      continue;
    }
    if (item.audience !== audience) continue;
    item.file = '';
    item.local = true;
    item.status = row.status === 'archived' ? 'retired' : 'proposed';
    item.archived = row.status === 'archived';
    out.push(item);
  }
  return out;
}

/** Adds this PC's counters to committed items (for ranking and `devctx status`, never compiling). */
export function applyStats(items: readonly KnowledgeItem[], stats: ReadonlyMap<string, ItemStats>): void {
  for (const i of items) {
    const s = stats.get(i.id);
    if (!s) continue;
    i.reinforced += s.reinforced;
    i.violations += s.violations;
    if (s.lastSeen && s.lastSeen.slice(0, 10) > i.last_verified) i.last_verified = s.lastSeen.slice(0, 10);
    // Restated after a replaced rule asked for a check: that restatement is the check.
    if (i.needs_review && i.reviewSince && s.lastSeen && s.lastSeen > i.reviewSince) i.needs_review = false;
    for (const e of s.evidence) if (e.quote && !i.evidence.some((x) => x.quote === e.quote)) i.evidence.push({ ...e });
  }
}

function view(dirs: readonly string[], db: StateDb | null, audience: 'team' | 'personal', opts: ViewOptions): LoadResult {
  const res = readKnowledgeFiles(dirs, db);
  deriveStatus(res.items, opts);
  if (opts.local && db) {
    applyStats(res.items, db.itemStats());
    res.items.push(...localProposals(db, audience));
  }
  return res;
}

const STALE_KEY = 'stale';

/**
 * Code-evidence results of the last compile (which reads manifests and `git ls-files`), so hooks
 * deliver exactly what AGENTS.md was built from without touching git on every prompt.
 */
export function saveStale(db: StateDb, items: readonly KnowledgeItem[]): void {
  const map: Record<string, string> = {};
  for (const i of items) if (i.stale) map[i.id] = i.stale;
  db.kvSet(STALE_KEY, JSON.stringify(map));
}

export function applyCachedStale(db: StateDb, items: readonly KnowledgeItem[]): void {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(db.kvGet(STALE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    map = {};
  }
  for (const i of items) {
    const reason = map[i.id];
    if (reason) i.stale = reason;
  }
}

export function knowledgeDirs(paths: ProjectPaths): string[] {
  return [paths.decisions, paths.context, paths.runbooks, paths.lessons];
}

/** Team rules of this repository with their current status. */
export function loadTeam(paths: ProjectPaths, db: StateDb | null, opts: ViewOptions): LoadResult {
  return view(knowledgeDirs(paths), db, 'team', opts);
}

/** This person's preferences (kept outside every repository). */
export function loadPersonal(db: StateDb | null, opts: ViewOptions): LoadResult {
  return view([personalDir()], db, 'personal', opts);
}
