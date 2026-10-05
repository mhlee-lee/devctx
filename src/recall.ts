import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { HISTORY_DIR, toolLabel } from './history/writer.ts';
import { heldReason } from './knowledge/guard.ts';
import type { KnowledgeItem } from './knowledge/types.ts';
import { loadTeam } from './knowledge/view.ts';
import { redactSecrets, stripInvisible } from './memory/evidence.ts';
import { StateDb } from './state/db.ts';
import type { Language } from './types.ts';
import { listFiles, readText } from './util/fsx.ts';
import { projectPaths } from './util/paths.ts';
import { normalizeText, splitSentences, tokenSet, truncate } from './util/text.ts';

/**
 * `devctx recall` / `devctx code search_history`: earlier work in this repository, found by words,
 * without an LLM. Rules reach every session anyway; this is for what rules do not hold: what was
 * asked before, what the assistant did and how it ended (a failed approach, a check that kept
 * failing), and why a decision was replaced. Four sources:
 * - turns this PC captured (`.devctx/local/state.sqlite`, the request and the reply after it),
 * - verification cases of this PC (a check that failed, its error, and the turn where it passed),
 * - the prompt history the team committed (`.devctx/history/`, for people who turned it on),
 * - decision files, including replaced and expired ones with their reason and successor.
 * Agents run it when they need it (the devctx-code skill lists it), so it costs no tokens per prompt
 * (Memento/AnchorMind "recall before answering", Hindsight's experience memory, read on demand).
 */

export interface RecallOptions {
  limit?: number;
  /** Only work from the last N days (decisions are always searched). */
  days?: number;
  now?: Date;
}

type Source = 'turn' | 'history' | 'decision' | 'case';

interface Doc {
  source: Source;
  at: string;
  /** The request, normalized: the same turn from two sources has the same key. */
  key: string | null;
  tokens: Set<string>;
  /** Full text the snippet is taken from. */
  body: string;
  head: string;
  lines: (snippet: (text: string, max: number) => string) => string[];
}

export interface RecallHit {
  source: Source;
  at: string;
  /** Share of the query's weighted words found (0..1). */
  coverage: number;
  head: string;
  lines: string[];
}

export interface RecallResult {
  hits: RecallHit[];
  /** Documents that matched (before the limit). */
  total: number;
  counts: { turns: number; history: number; decisions: number; cases: number; days: number; localUnreadable: boolean };
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_DAYS = 90;
/** At least this share of the query's (IDF-weighted) words must appear. */
const MIN_COVERAGE = 0.3;

const T: Record<
  Language,
  {
    title: (q: string, shown: number, total: number) => string;
    none: (q: string) => string;
    sources: (turns: number, history: number, decisions: number, cases: number, days: number) => string;
    case: string;
    caseState: Record<string, string>;
    inferred: string;
    failed: string;
    error: string;
    thenRequest: string;
    fixTurn: string;
    turn: string;
    history: string;
    decision: string;
    request: string;
    reply: string;
    work: string;
    result: string;
    reason: string;
    replacedBy: string;
    replaced: string;
    status: Record<string, string>;
    noLocal: string;
  }
> = {
  ko: {
    title: (q, shown, total) => `이전 작업 검색: "${q}" (${total}건 중 ${shown}건, 관련도 순)`,
    none: (q) => `이전 작업을 찾지 못했다: "${q}". 다른 단어(코드 이름, 에러 메시지, 파일 경로)로 다시 찾아본다.`,
    sources: (turns, history, decisions, cases, days) => `찾은 범위: 이 PC의 대화 ${turns}턴과 검증 사례 ${cases}건(최근 ${days}일), 히스토리 항목 ${history}개, 결정 ${decisions}개`,
    case: '검증 사례',
    caseState: { resolved: '해결됨', unresolved: '해결 안 됨', failed: '진행 중' },
    inferred: '출력으로 판단',
    failed: '실패',
    error: '에러',
    thenRequest: '그때 요청',
    fixTurn: '통과한 턴',
    turn: '이 PC의 대화',
    history: '히스토리',
    decision: '결정',
    request: '요청',
    reply: '응답',
    work: '작업',
    result: '결과',
    reason: '이유',
    replacedBy: '대체한 결정',
    replaced: '이전 결정',
    status: { active: '적용 중', conflict: '충돌', superseded: '대체됨', retired: '만료', proposed: '확인 대기' },
    noLocal: '이 PC의 대화 기록은 읽지 못했다',
  },
  en: {
    title: (q, shown, total) => `Earlier work related to "${q}" (${shown} of ${total}, most relevant first)`,
    none: (q) => `No earlier work found for "${q}". Try other words (a code name, an error message, a file path).`,
    sources: (turns, history, decisions, cases, days) => `Searched: ${turns} turns and ${cases} verification cases captured on this PC (last ${days} days), ${history} history entries, ${decisions} decisions`,
    case: 'verification case',
    caseState: { resolved: 'resolved', unresolved: 'not resolved', failed: 'in progress' },
    inferred: 'read from the output',
    failed: 'Failed',
    error: 'Error',
    thenRequest: 'Request then',
    fixTurn: 'Passed in',
    turn: 'turn on this PC',
    history: 'history',
    decision: 'decision',
    request: 'Request',
    reply: 'Reply',
    work: 'Work',
    result: 'Result',
    reason: 'Reason',
    replacedBy: 'Replaced by',
    replaced: 'Replaced',
    status: { active: 'in force', conflict: 'conflict', superseded: 'replaced', retired: 'expired', proposed: 'proposed' },
    noLocal: 'could not read the turns captured on this PC',
  },
};

function clean(text: string): string {
  return redactSecrets(stripInvisible(text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' [code] ')));
}

function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

function turnDocs(db: StateDb | null, sinceIso: string, t: (typeof T)[Language]): Doc[] {
  if (!db) return [];
  return db.turnsSince(sinceIso).map((turn): Doc => {
    const prompt = normalizeText(clean(turn.prompt));
    const reply = turn.reply ? clean(turn.reply) : '';
    return {
      source: 'turn',
      at: turn.ts,
      key: prompt,
      tokens: tokenSet(`${prompt} ${reply}`),
      body: reply,
      head: `${localDate(turn.ts)} · ${toolLabel(turn.tool)} · ${t.turn}`,
      lines: (snippet) => [`${t.request}: ${truncate(prompt, 200)}`, ...(reply ? [`${t.reply}: ${snippet(reply, 320)}`] : [])],
    };
  });
}

const ENTRY_HEAD = /^## (\d+)\. (.+)$/m;
const FILE_HEAD = /^# .+? · (.+?) · /m;
const AUTHOR = /^- (?:작성자|Author): (.+)$/m;

interface HistoryEntry {
  file: string;
  number: number;
  at: string;
  tool: string;
  author: string | null;
  prompt: string;
  work: string;
  result: string | null;
}

/** Entries of one `.devctx/history/` file (either language). */
export function parseHistoryFile(rel: string, text: string): HistoryEntry[] {
  const tool = FILE_HEAD.exec(text)?.[1]?.trim() ?? '';
  const author = AUTHOR.exec(text)?.[1]?.trim() ?? null;
  const out: HistoryEntry[] = [];
  const parts = text.split(/\n---\n\n(?=## \d+\. )/);
  for (const part of parts) {
    const head = ENTRY_HEAD.exec(part);
    if (!head) continue;
    const when = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \(([+-]\d{2}:\d{2})\)/.exec(head[2] ?? '');
    const at = when ? new Date(`${when[1]}T${when[2]}${when[3]}`).toISOString() : '';
    const fence = /^(`{3,})text\n([\s\S]*?)\n\1/m.exec(part);
    const workMatch = /^\*\*(?:작업 내용|What was done)\*\*[^\n]*\n\n([\s\S]*?)(?:\n\n|$)/m.exec(part);
    const result = /^(?:결과|Result): (.+)$/m.exec(part);
    out.push({
      file: rel,
      number: Number(head[1]),
      at,
      tool,
      author,
      prompt: fence?.[2] ?? '',
      work: workMatch?.[1]?.trim() ?? '',
      result: result?.[1]?.trim() ?? null,
    });
  }
  return out;
}

function historyDocs(root: string, sinceIso: string, t: (typeof T)[Language]): Doc[] {
  const dir = path.join(root, HISTORY_DIR);
  if (!fs.existsSync(dir)) return [];
  const sinceMonth = sinceIso.slice(0, 7);
  const docs: Doc[] = [];
  for (const file of listFiles(dir, (f) => f.endsWith('.md'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const month = /history\/(\d{4}-\d{2})\//.exec(rel)?.[1];
    if (month && month < sinceMonth) continue;
    const text = readText(file);
    if (!text) continue;
    for (const e of parseHistoryFile(rel, text)) {
      if (e.at && e.at < sinceIso) continue;
      const prompt = normalizeText(clean(e.prompt));
      const work = clean(e.work);
      docs.push({
        source: 'history',
        at: e.at,
        key: prompt,
        tokens: tokenSet(`${prompt} ${work} ${e.result ?? ''}`),
        body: work,
        head: `${e.at ? localDate(e.at) : '?'} · ${e.tool}${e.author ? ` · ${e.author}` : ''} · ${t.history} ${rel}#${e.number}`,
        lines: (snippet) => [
          `${t.request}: ${truncate(prompt, 200)}`,
          ...(work ? [`${t.work}: ${snippet(work, 320)}`] : []),
          ...(e.result ? [`${t.result}: ${truncate(clean(e.result), 160)}`] : []),
        ],
      });
    }
  }
  return docs;
}

const NO_REASON = /^(사용자 지시 \(이유 미기재\)|User instruction \(no reason given\))$/;

function decisionDocs(items: readonly KnowledgeItem[], t: (typeof T)[Language]): Doc[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) => !i.local && !i.held)
    .map((i): Doc => {
      const reasonText = normalizeText(i.sections.reason);
      // Shown to the agent only here, so it gets the same check as rule text.
      const reason = heldReason(reasonText) ? '' : reasonText;
      const next = i.superseded_by ? byId.get(i.superseded_by) : undefined;
      const successor = next && !next.held ? next : undefined;
      const replaced = i.supersedes.map((id) => byId.get(id)).filter((x): x is KnowledgeItem => Boolean(x && !x.held));
      const status = t.status[i.status] ?? i.status;
      return {
        source: 'decision',
        at: i.source.captured_at,
        key: null,
        tokens: tokenSet([i.summary, reason, i.sections.exceptions, i.scope.topics.join(' ')].join(' ')),
        body: '',
        head: `${localDate(i.source.captured_at).slice(0, 10)} · ${t.decision} ${i.id.slice(-6)} (${status})`,
        lines: () => [
          i.summary,
          ...(reason && !NO_REASON.test(reason) ? [`${t.reason}: ${truncate(reason, 200)}`] : []),
          ...(successor ? [`${t.replacedBy} (${successor.source.captured_at.slice(0, 10)}): ${truncate(successor.summary, 160)}`] : []),
          ...replaced.slice(0, 2).map((r) => `${t.replaced}: ${truncate(r.summary, 160)}`),
        ],
      };
    });
}

function caseDocs(db: StateDb | null, sinceIso: string, t: (typeof T)[Language]): Doc[] {
  if (!db) return [];
  return db.casesSince(sinceIso).map((c): Doc => {
    const error = c.error ? normalizeText(clean(c.error)) : '';
    const failPrompt = c.failPrompt ? normalizeText(clean(c.failPrompt)) : '';
    const fixPrompt = c.fixPrompt ? normalizeText(clean(c.fixPrompt)) : '';
    const fixReply = c.fixReply ? clean(c.fixReply) : '';
    const state = `${t.caseState[c.state] ?? c.state}${c.inferred ? `, ${t.inferred}` : ''}`;
    return {
      source: 'case',
      at: c.failedAt,
      key: null,
      tokens: tokenSet([c.command, c.signature ?? '', error, failPrompt, fixPrompt, fixReply].join(' ')),
      body: fixReply,
      head: `${localDate(c.failedAt)} · ${toolLabel(c.tool)} · ${t.case} (${state})`,
      lines: (snippet) => [
        `${t.failed}: \`${c.command}\`${c.signature ? ` (${c.signature})` : ''}`,
        ...(error ? [`${t.error}: ${truncate(error, 220)}`] : []),
        ...(failPrompt ? [`${t.thenRequest}: ${truncate(failPrompt, 160)}`] : []),
        ...(c.state === 'resolved' && (fixPrompt || fixReply)
          ? [`${t.fixTurn} (${(c.resolvedAt ?? '').slice(0, 10)}): ${[fixPrompt ? truncate(fixPrompt, 120) : '', fixReply ? snippet(fixReply, 220) : ''].filter(Boolean).join(' → ')}`]
          : []),
      ],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------

/**
 * Share of the query's words a document contains, each word weighted by IDF over all documents
 * searched (so "테스트" in every turn counts little, an error code a lot). Coverage rather than
 * cosine: a long reply that contains every word of the query is a full match.
 */
function scorer(docs: readonly Doc[]): (query: Set<string>, doc: Doc) => number {
  const df = new Map<string, number>();
  for (const d of docs) for (const tok of d.tokens) df.set(tok, (df.get(tok) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  const w = (tok: string): number => Math.log(1 + n / (df.get(tok) ?? 0.5));
  return (query, doc) => {
    let total = 0;
    let hit = 0;
    for (const tok of query) {
      const x = w(tok);
      total += x;
      if (doc.tokens.has(tok)) hit += x;
    }
    return total > 0 ? hit / total : 0;
  };
}

function snippetFor(query: Set<string>): (text: string, max: number) => string {
  return (text, max) => {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return '';
    let best = 0;
    let bestScore = -1;
    sentences.forEach((s, i) => {
      const toks = tokenSet(s);
      let score = 0;
      for (const q of query) if (toks.has(q)) score++;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    const picked = sentences.slice(best, best + 3).join(' ');
    return truncate(best > 0 ? `… ${picked}` : picked, max);
  };
}

function openState(file: string): StateDb | null {
  if (!fs.existsSync(file)) return null;
  try {
    return StateDb.open(file);
  } catch {
    return null; // read-only checkout or sandbox
  }
}

/** Earlier work matching `query`, best first. */
export function findPastWork(root: string, query: string, opts: RecallOptions = {}): RecallResult {
  const paths = projectPaths(root);
  const cfg = loadConfig(paths);
  const t = T[cfg.language];
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.min(3650, Math.floor(opts.days ?? DEFAULT_DAYS)));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
  const q = tokenSet(query);
  const db = openState(paths.stateDb);
  let turns: Doc[] = [];
  let cases: Doc[] = [];
  let localUnreadable = fs.existsSync(paths.stateDb) && !db;
  let items: KnowledgeItem[] = [];
  try {
    try {
      turns = turnDocs(db, sinceIso, t);
      cases = caseDocs(db, sinceIso, t);
    } catch {
      localUnreadable = true;
    }
    try {
      items = loadTeam(paths, db, { proposedTtlDays: cfg.memory.proposed_ttl_days }).items;
    } catch {
      items = loadTeam(paths, null, { proposedTtlDays: cfg.memory.proposed_ttl_days }).items;
    }
  } finally {
    db?.close();
  }
  const history = historyDocs(root, sinceIso, t);
  const decisions = decisionDocs(items, t);
  const counts = { turns: turns.length, history: history.length, decisions: decisions.length, cases: cases.length, days, localUnreadable };
  if (q.size === 0) return { hits: [], total: 0, counts };
  // The same turn can be in this PC's events and in a committed history file: keep the history
  // entry (it has the summary, the changed files and the result).
  const inHistory = new Set(history.map((h) => h.key));
  const docs = [...history, ...turns.filter((d) => !inHistory.has(d.key)), ...cases, ...decisions];

  const score = scorer(docs);
  const nowMs = now.getTime();
  const ranked = docs
    .map((doc) => {
      const coverage = score(q, doc);
      const ageDays = Math.max(0, (nowMs - Date.parse(doc.at || '1970-01-01')) / 86_400_000);
      // Newer work wins ties; never enough to lift an unrelated document over the bar.
      return { doc, coverage, rank: coverage + 0.1 * Math.exp(-ageDays / 30) };
    })
    .filter((r) => r.coverage >= MIN_COVERAGE)
    .sort((a, b) => b.rank - a.rank);
  const snippet = snippetFor(q);
  const hits = ranked.slice(0, limit).map((r) => ({ source: r.doc.source, at: r.doc.at, coverage: r.coverage, head: r.doc.head, lines: r.doc.lines(snippet) }));
  return { hits, total: ranked.length, counts };
}

/** `devctx recall` / `devctx code search_history`: the hits as text. */
export function searchHistory(root: string, query: string, opts: RecallOptions = {}): string {
  const t = T[loadConfig(projectPaths(root)).language];
  const res = findPastWork(root, query, opts);
  const c = res.counts;
  const footer = `${t.sources(c.turns, c.history, c.decisions, c.cases, c.days)}${c.localUnreadable ? ` (${t.noLocal})` : ''}`;
  if (res.hits.length === 0) return `${t.none(query)}\n${footer}`;
  const out = [t.title(query, res.hits.length, res.total), ''];
  res.hits.forEach((h, i) => out.push(`${i + 1}. ${h.head}`, ...h.lines.map((l) => `   ${l}`), ''));
  out.push(footer);
  return out.join('\n');
}
