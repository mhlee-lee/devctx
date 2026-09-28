import path from 'node:path';
import type { StateDb } from '../state/db.ts';
import { readText, sha256 } from '../util/fsx.ts';
import type { ProjectPaths } from '../util/paths.ts';

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
    .filter((l) => l.length > 0 && !l.startsWith('<!--') && !/^-{3,}$/.test(l));
}

/**
 * Detects edits someone (a person or another tool) made directly to generated instruction files.
 * Added lines become a `foreign_edit` event so the worker can absorb them into the knowledge base
 * before the next compile overwrites the file. Returns the number of edited files.
 */
export function detectForeignEdits(paths: ProjectPaths, db: StateDb, tool: string): number {
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
    const added = meaningfulLines(current).filter((l) => !before.has(l));
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
