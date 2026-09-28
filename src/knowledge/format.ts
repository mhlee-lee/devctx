import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { Language } from '../types.ts';
import { sha256 } from '../util/fsx.ts';
import { normalizeText, truncate } from '../util/text.ts';
import {
  ENFORCEMENTS,
  ITEM_STATUSES,
  ITEM_TYPES,
  SOURCE_KINDS,
  TIER_PINS,
  type Evidence,
  type ItemType,
  type KnowledgeItem,
  type Sections,
} from './types.ts';

const HEADINGS: Record<Language, Record<keyof Sections, string>> = {
  ko: { rule: '규칙', reason: '이유', exceptions: '예외', notes: '메모' },
  en: { rule: 'Rule', reason: 'Reason', exceptions: 'Exceptions', notes: 'Notes' },
};

const HEADING_ALIASES: Record<string, keyof Sections> = {
  규칙: 'rule',
  결정: 'rule',
  rule: 'rule',
  decision: 'rule',
  이유: 'reason',
  근거: 'reason',
  reason: 'reason',
  why: 'reason',
  예외: 'exceptions',
  exceptions: 'exceptions',
  exception: 'exceptions',
  메모: 'notes',
  notes: 'notes',
  note: 'notes',
};

const NOTES_MARKER: Record<Language, string> = {
  ko: '<!-- 이 아래는 사람이 쓰는 구간. devctx가 수정하지 않는다 -->',
  en: '<!-- Human-owned section below. devctx never rewrites it -->',
};

const DIR_TYPES: Record<string, ItemType> = {
  decisions: 'rule',
  context: 'fact',
  runbooks: 'procedure',
  lessons: 'lesson',
};

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return fallback;
}

function strOrNull(v: unknown): string | null {
  const s = str(v).trim();
  return s ? s : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  return v.map((x) => str(x).trim()).filter(Boolean);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

function dateOnly(v: unknown, fallback: string): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : fallback;
}

function parseEvidence(v: unknown): Evidence[] {
  if (!Array.isArray(v)) return [];
  const out: Evidence[] = [];
  for (const raw of v) {
    const e = obj(raw);
    const ev: Evidence = {};
    const quote = strOrNull(e.quote);
    const p = strOrNull(e.path);
    const hash = strOrNull(e.hash);
    const at = strOrNull(e.at);
    if (quote) ev.quote = quote;
    if (p) ev.path = p;
    if (hash) ev.hash = hash;
    if (at) ev.at = at.slice(0, 10);
    if (Object.keys(ev).length > 0) out.push(ev);
  }
  return out;
}

function splitFrontMatter(text: string): { meta: string | null; body: string } {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!clean.startsWith('---\n')) return { meta: null, body: clean };
  const end = clean.indexOf('\n---', 4);
  if (end < 0) return { meta: null, body: clean };
  const after = clean.indexOf('\n', end + 4);
  return { meta: clean.slice(4, end), body: after < 0 ? '' : clean.slice(after + 1) };
}

export function parseSections(body: string): Sections {
  const sections: Sections = { rule: '', reason: '', exceptions: '', notes: '' };
  const buckets: Record<keyof Sections, string[]> = { rule: [], reason: [], exceptions: [], notes: [] };
  let current: keyof Sections | null = null;
  const preface: string[] = [];
  for (const line of body.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const key = HEADING_ALIASES[(heading[1] ?? '').trim().toLowerCase()];
      if (key) {
        current = key;
        continue;
      }
      // Unknown heading: keep it verbatim in notes so human content survives rewrites.
      current = 'notes';
      buckets.notes.push(line);
      continue;
    }
    if (current) buckets[current].push(line);
    else preface.push(line);
  }
  const prefaceText = preface
    .filter((l) => !/^#\s/.test(l))
    .join('\n')
    .trim();
  for (const key of Object.keys(buckets) as (keyof Sections)[]) {
    sections[key] = buckets[key]
      .filter((l) => !Object.values(NOTES_MARKER).includes(l.trim()))
      .join('\n')
      .trim();
  }
  if (prefaceText) {
    if (!sections.rule) sections.rule = prefaceText;
    else sections.notes = [prefaceText, sections.notes].filter(Boolean).join('\n\n');
  }
  return sections;
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const clean = line.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim();
    if (clean) return clean;
  }
  return '';
}

export interface ParseResult {
  item: KnowledgeItem | null;
  error: string | null;
}

/** Parses a knowledge file. Missing fields get defaults so hand-written files work too. */
export function parseItem(text: string, file: string, fallbackDate?: string): ParseResult {
  const { meta, body } = splitFrontMatter(text);
  let m: Obj = {};
  if (meta !== null) {
    try {
      m = obj(parse(meta));
    } catch (error) {
      return { item: null, error: `invalid front matter: ${(error as Error).message}` };
    }
  }
  const sections = parseSections(body);
  const dirName = path.basename(path.dirname(file));
  let mtime = fallbackDate;
  if (!mtime) {
    try {
      mtime = fs.statSync(file).mtime.toISOString();
    } catch {
      mtime = new Date().toISOString();
    }
  }
  const baseName = path.basename(file, '.md');
  const summary = normalizeText(str(m.summary) || firstLine(sections.rule));
  if (!summary) return { item: null, error: 'empty rule: add a summary or a "## 규칙" section' };
  const scope = obj(m.scope);
  const source = obj(m.source);
  const id = str(m.id).trim() || `F${sha256(baseName).slice(0, 12).toUpperCase()}`;
  const item: KnowledgeItem = {
    id,
    title: normalizeText(str(m.title)) || truncate(summary, 40),
    summary,
    type: oneOf(m.type, ITEM_TYPES, DIR_TYPES[dirName] ?? 'rule'),
    status: oneOf(m.status, ITEM_STATUSES, 'active'),
    enforcement: oneOf(m.enforcement, ENFORCEMENTS, 'should'),
    audience: m.audience === 'personal' ? 'personal' : 'team',
    scope: { paths: strList(scope.paths), topics: strList(scope.topics) },
    source: {
      kind: oneOf(source.kind, SOURCE_KINDS, 'human-edit'),
      actor: strOrNull(source.actor),
      tool: strOrNull(source.tool),
      captured_at: str(source.captured_at) || mtime,
    },
    evidence: parseEvidence(m.evidence),
    reinforced: int(m.reinforced, 0),
    violations: int(m.violations, 0),
    tier: oneOf(m.tier, TIER_PINS, 'auto'),
    relates: strList(m.relates),
    supersedes: strList(m.supersedes),
    superseded_by: strOrNull(m.superseded_by),
    conflict_with: strList(m.conflict_with),
    needs_review: m.needs_review === true,
    revision: Math.max(1, int(m.revision, 1)),
    last_verified: dateOnly(m.last_verified, mtime.slice(0, 10)),
    sections: { ...sections, rule: sections.rule || summary },
    file,
  };
  return { item, error: null };
}

export function serializeItem(item: KnowledgeItem, language: Language): string {
  const meta = {
    id: item.id,
    title: item.title,
    summary: item.summary,
    type: item.type,
    status: item.status,
    enforcement: item.enforcement,
    audience: item.audience,
    scope: { paths: item.scope.paths, topics: item.scope.topics },
    source: {
      kind: item.source.kind,
      actor: item.source.actor,
      tool: item.source.tool,
      captured_at: item.source.captured_at,
    },
    evidence: item.evidence,
    reinforced: item.reinforced,
    violations: item.violations,
    tier: item.tier,
    relates: item.relates,
    supersedes: item.supersedes,
    superseded_by: item.superseded_by,
    conflict_with: item.conflict_with,
    needs_review: item.needs_review,
    revision: item.revision,
    last_verified: item.last_verified,
  };
  const h = HEADINGS[language];
  const s = item.sections;
  const body = [
    `## ${h.rule}`,
    s.rule || item.summary,
    '',
    `## ${h.reason}`,
    s.reason,
    '',
    `## ${h.exceptions}`,
    s.exceptions,
    '',
    `## ${h.notes}`,
    NOTES_MARKER[language],
    s.notes,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return `---\n${stringify(meta, { lineWidth: 0 }).trimEnd()}\n---\n${body}\n`;
}
