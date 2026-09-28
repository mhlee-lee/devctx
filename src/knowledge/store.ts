import fs from 'node:fs';
import path from 'node:path';
import type { Language } from '../types.ts';
import { assertSafeTarget, listFiles, readText, writeFileAtomic } from '../util/fsx.ts';
import { personalDir, type ProjectPaths } from '../util/paths.ts';
import { slugify, today } from '../util/text.ts';
import { ulid } from '../util/ulid.ts';
import { parseItem, serializeItem } from './format.ts';
import type { ItemType, KnowledgeItem } from './types.ts';

export interface LoadResult {
  items: KnowledgeItem[];
  errors: { file: string; error: string }[];
}

function isKnowledgeFile(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('_') && name !== 'README.md' && name !== 'preamble.md';
}

function loadFrom(dirs: string[]): LoadResult {
  const items: KnowledgeItem[] = [];
  const errors: { file: string; error: string }[] = [];
  const seen = new Map<string, string>();
  for (const dir of dirs) {
    for (const file of listFiles(dir, isKnowledgeFile)) {
      const text = readText(file);
      if (text === null) continue;
      const { item, error } = parseItem(text, file);
      if (!item) {
        errors.push({ file, error: error ?? 'unreadable' });
        continue;
      }
      const dup = seen.get(item.id);
      if (dup) {
        errors.push({ file, error: `duplicate id ${item.id} (also in ${dup})` });
        continue;
      }
      seen.set(item.id, file);
      items.push(item);
    }
  }
  return { items, errors };
}

export function loadItems(paths: ProjectPaths): LoadResult {
  return loadFrom([paths.decisions, paths.context, paths.runbooks, paths.lessons]);
}

export function loadPersonalItems(): LoadResult {
  return loadFrom([personalDir()]);
}

export function typeDir(paths: ProjectPaths, type: ItemType): string {
  switch (type) {
    case 'fact':
      return paths.context;
    case 'procedure':
      return paths.runbooks;
    case 'lesson':
      return paths.lessons;
    default:
      return paths.decisions;
  }
}

export function newItem(fields: Partial<KnowledgeItem> & Pick<KnowledgeItem, 'summary'>): KnowledgeItem {
  const now = new Date().toISOString();
  return {
    id: fields.id ?? ulid(),
    title: fields.title ?? fields.summary.slice(0, 40),
    summary: fields.summary,
    type: fields.type ?? 'rule',
    status: fields.status ?? 'active',
    enforcement: fields.enforcement ?? 'should',
    audience: fields.audience ?? 'team',
    scope: fields.scope ?? { paths: [], topics: [] },
    source: fields.source ?? { kind: 'user-instruction', actor: null, tool: null, captured_at: now },
    evidence: fields.evidence ?? [],
    reinforced: fields.reinforced ?? 0,
    violations: fields.violations ?? 0,
    tier: fields.tier ?? 'auto',
    relates: fields.relates ?? [],
    supersedes: fields.supersedes ?? [],
    superseded_by: fields.superseded_by ?? null,
    conflict_with: fields.conflict_with ?? [],
    needs_review: fields.needs_review ?? false,
    revision: fields.revision ?? 1,
    last_verified: fields.last_verified ?? today(),
    sections: fields.sections ?? { rule: fields.summary, reason: '', exceptions: '', notes: '' },
    file: fields.file ?? '',
  };
}

/** Writes an item to its file (creating `<id>-<slug>.md` for new items). Returns the file path. */
export function writeItem(paths: ProjectPaths, item: KnowledgeItem, language: Language): string {
  const root = item.audience === 'personal' ? personalDir() : paths.knowledge;
  const dir = item.audience === 'personal' ? personalDir() : typeDir(paths, item.type);
  const file = item.file || path.join(dir, `${item.id}-${slugify(`${item.title} ${item.scope.topics.join(' ')}`, 40, item.type)}.md`);
  fs.mkdirSync(root, { recursive: true });
  assertSafeTarget(file, root);
  writeFileAtomic(file, serializeItem(item, language));
  item.file = file;
  return file;
}

export function findItem(items: readonly KnowledgeItem[], id: string): KnowledgeItem | undefined {
  return items.find((i) => i.id === id);
}
