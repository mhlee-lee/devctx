import path from 'node:path';
import type { StateDb } from '../state/db.ts';
import { readText, sha256 } from '../util/fsx.ts';
import type { ProjectPaths } from '../util/paths.ts';
import { normalizeForMatch } from '../util/text.ts';

const PREFIX = 'generated:';

interface GeneratedRecord {
  hash: string;
  content: string;
}

export function recordGenerated(db: StateDb, relPath: string, content: string): void {
  const rec: GeneratedRecord = { hash: sha256(content), content };
  db.kvSet(PREFIX + relPath, JSON.stringify(rec));
}

export function forgetGenerated(db: StateDb, relPath: string): void {
  db.kvDelete(PREFIX + relPath);
}

export function generatedPaths(db: StateDb): string[] {
  return db.kvList(PREFIX).map((r) => r.key.slice(PREFIX.length));
}

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('<!--') && !/^-{3,}$/.test(l) && !/^(<{7}|={7}|>{7})/.test(l));
}

function squash(text: string): string {
  return normalizeForMatch(text).replace(/[`*_]/g, '');
}

export interface ForeignContext {
  /** What this compile is about to write (a teammate's AGENTS.md, pulled or merged, looks like this). */
  rendered: ReadonlyMap<string, string>;
  /** Every known rule's summary, in any status: lines devctx itself renders from them are not edits. */
  summaries: readonly string[];
}

/**
 * Detects edits someone (a person or another tool) made directly to generated instruction files.
 * Added lines become a `foreign_edit` event so the worker can absorb them into the knowledge base
 * before the next compile overwrites the file. Returns the number of edited files.
 *
 * After a pull or merge the file holds what a teammate's devctx generated (or both sides, merged
 * line by line). Those lines come from rule files that arrived in the same merge, so any line that
 * this compile renders too, or that renders a known rule, is not a person's edit.
 */
export function detectForeignEdits(paths: ProjectPaths, db: StateDb, tool: string, ctx?: ForeignContext): number {
  const known = (ctx?.summaries ?? []).map(squash).filter((s) => s.length >= 6);
  const renderedLines = new Map<string, Set<string>>();
  for (const [rel, content] of ctx?.rendered ?? []) renderedLines.set(rel, new Set(meaningfulLines(content)));
  const generatedByDevctx = (rel: string, line: string): boolean => {
    if (renderedLines.get(rel)?.has(line)) return true;
    // Headings and devctx's own guidance text (another devctx version words it differently).
    if (/^#{1,6}\s/.test(line) || /devctx/i.test(line)) return true;
    const s = squash(line);
    return known.some((k) => s.includes(k));
  };
  let edited = 0;
  for (const { key, value } of db.kvList(PREFIX)) {
    const rel = key.slice(PREFIX.length);
    let rec: GeneratedRecord;
    try {
      rec = JSON.parse(value) as GeneratedRecord;
    } catch {
      continue;
    }
    const current = readText(path.join(paths.root, rel));
    if (current === null || sha256(current) === rec.hash) continue;
    const before = new Set(meaningfulLines(rec.content));
    const added = meaningfulLines(current).filter((l) => !before.has(l) && !generatedByDevctx(rel, l));
    if (added.length > 0) {
      db.insertEvent({
        ts: new Date().toISOString(),
        tool,
        host: 'file',
        kind: 'foreign_edit',
        session: null,
        cwd: paths.root,
        prompt: `[${rel}]\n${added.join('\n')}`,
        lastAssistant: null,
        transcriptPath: null,
        model: null,
        flags: ['foreign-edit'],
        candidate: true,
      });
      edited++;
    }
    recordGenerated(db, rel, current);
  }
  return edited;
}
