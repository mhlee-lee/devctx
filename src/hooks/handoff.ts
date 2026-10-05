import { readCommandChecks, type CommandCheck } from '../history/transcript.ts';
import { extractPathHints } from '../knowledge/retrieve.ts';
import { redactSecrets, stripInvisible } from '../memory/evidence.ts';
import type { PreviousSession } from '../state/db.ts';
import type { Language } from '../types.ts';
import { git } from '../util/git.ts';
import { approxTokens, normalizeText, stripPasted } from '../util/text.ts';
import { promptKind } from './context.ts';

/**
 * Session handoff: a new session (in any tool) that picks up earlier work gets a checkpoint of the
 * last session in this worktree: what it set out to do, the last requests, what the assistant said
 * is left, which checks ran and whether they passed, and what the worktree holds now (branch,
 * uncommitted files, commits since that session started). Everything comes from what the hooks
 * captured, the tool's own transcript and git, locally; no LLM call, nothing in git. Atlas does this
 * across agents and OpenViking keeps "pending tasks" per session; devctx only offers it when the
 * new prompt continues that work, because unrequested history derails a fresh task (Hindsight's
 * observation).
 */

const TOOL_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  kiro: 'Kiro',
};

interface HandoffText {
  header: (tool: string, ago: string, requests: number) => string;
  goal: string;
  request: string;
  lastRequest: string;
  reply: string;
  replyStart: string;
  replyEnd: string;
  pending: string;
  checks: string;
  passed: string;
  failed: string;
  unknown: string;
  commits: string;
  worktree: (branch: string, head: string) => string;
  dirty: (n: number) => string;
  clean: string;
  ago: (m: number) => string;
}

const TEXT: Record<Language, HandoffText> = {
  ko: {
    header: (tool, ago, n) => `[devctx] 이 저장소의 직전 작업 (${tool}, ${ago}, 요청 ${n}개). 이어서 하는 요청이면 참고:`,
    goal: '- 처음 요청',
    request: '- 요청',
    lastRequest: '- 마지막 요청',
    reply: '- 마지막 응답',
    replyStart: '- 마지막 응답 (앞부분)',
    replyEnd: '- 마지막 응답 (끝부분)',
    pending: '- 남은 작업 (마지막 응답에서)',
    checks: '- 그 세션의 마지막 검증',
    passed: '통과',
    failed: '실패',
    unknown: '결과 모름',
    commits: '- 그 세션 시작 이후 커밋',
    worktree: (branch, head) => `- 지금 작업 트리 (${branch} @ ${head})`,
    dirty: (n) => `커밋 안 된 파일 ${n}개`,
    clean: '커밋 안 된 변경 없음',
    ago: (m) => (m < 60 ? `${m}분 전` : m < 48 * 60 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`),
  },
  en: {
    header: (tool, ago, n) => `[devctx] Where the last session in this repository stopped (${tool}, ${ago}, ${n} request${n === 1 ? '' : 's'}). Use it if this request continues that work:`,
    goal: '- First request',
    request: '- Request',
    lastRequest: '- Last request',
    reply: '- Last reply',
    replyStart: '- Last reply (start)',
    replyEnd: '- Last reply (end)',
    pending: '- Left to do (from the last reply)',
    checks: "- That session's last checks",
    passed: 'passed',
    failed: 'failed',
    unknown: 'result unknown',
    commits: '- Commits since that session started',
    worktree: (branch, head) => `- Worktree now (${branch} @ ${head})`,
    dirty: (n) => `${n} uncommitted file${n === 1 ? '' : 's'}`,
    clean: 'no uncommitted changes',
    ago: (m) => (m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`),
  },
};

const CUE =
  /(이어서|이어 ?가|마저|아까|지난번|저번에?|전에 하던|하던 (거|것|작업|일)|어디까지|계속 ?(해|하자|진행|작업)|^\s*계속\s*[.!~]*\s*$|\bcontinue\b|\bresume\b|pick (it )?up|carry on|keep going|where (were we|did we (leave|stop))|last (session|time)|previous session|left off)/i;

/** Latin-letter names, numbers and file paths shared with the earlier session count as a link. */
function salient(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize('NFKC').matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
    const w = m[0];
    if (w.length >= 4 && /[A-Z_.$]|\d/.test(w.slice(1))) out.add(w.toLowerCase());
  }
  for (const p of extractPathHints(text)) out.add(p.toLowerCase());
  return out;
}

/** The prompt continues the earlier session: it says so, or it names the same code or files. */
export function continuesSession(prompt: string, previous: PreviousSession): boolean {
  if (CUE.test(prompt)) return true;
  const mine = salient(prompt);
  if (mine.size === 0) return false;
  const theirs = salient([...previous.openingPrompts, ...previous.prompts, previous.lastAssistant ?? ''].join('\n'));
  let shared = 0;
  for (const t of mine) if (theirs.has(t)) shared++;
  return shared >= 2 || (shared === 1 && mine.size === 1);
}

// ---------------------------------------------------------------------------------------------
// What the worktree holds now
// ---------------------------------------------------------------------------------------------

export interface WorkState {
  branch: string;
  head: string;
  /** Uncommitted paths (devctx's own files left out), at most 20. */
  dirty: string[];
  dirtyCount: number;
  /** "abc1234 subject" of commits since the previous session started, newest first (at most 5). */
  commits: string[];
}

/**
 * Branch, HEAD, uncommitted files and commits since `sinceIso`: two git calls, made once per
 * session and only when the session continues earlier work. Null outside a git repository.
 */
export function workState(root: string, sinceIso: string): WorkState | null {
  const st = git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], root, 2_000);
  if (!st.ok) return null;
  let branch = '?';
  let head = '?';
  const dirty: string[] = [];
  const entries = st.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? '';
    if (e.startsWith('# branch.oid ')) head = e.slice(13, 20);
    else if (e.startsWith('# branch.head ')) branch = e.slice(14);
    else {
      const fields = e.split(' ');
      const p = e.startsWith('1 ') ? fields.slice(8).join(' ') : e.startsWith('2 ') ? fields.slice(9).join(' ') : e.startsWith('u ') ? fields.slice(10).join(' ') : e.startsWith('? ') ? e.slice(2) : '';
      if (e.startsWith('2 ')) i++; // the original path of a rename
      if (p && !p.startsWith('.devctx/')) dirty.push(p);
    }
  }
  const log = git(['log', `--since=${sinceIso}`, '-n', '5', '--format=%h %s'], root, 2_000);
  const commits = log.ok && log.stdout ? log.stdout.split('\n').map((l) => redactSecrets(l.trim())).filter(Boolean) : [];
  return { branch, head, dirty: dirty.slice(0, 20), dirtyCount: dirty.length, commits };
}

// ---------------------------------------------------------------------------------------------
// What the last reply says is left
// ---------------------------------------------------------------------------------------------

const PENDING_LABEL =
  /(남은\s*(?:작업|일|것|항목|과제)|다음\s*(?:단계|작업|할\s*일|에\s*할\s*일)|후속\s*(?:작업|조치)|해야\s*할\s*일|할\s*일|미완료|미해결|추가로\s*필요한\s*(?:것|작업)|TODO|To[- ]?do|Next\s+steps?|Remaining(?:\s+(?:work|items|tasks))?|Follow[- ]?ups?|Not\s+(?:yet\s+)?done|Open\s+(?:items|questions|issues)|Left\s+to\s+do|What'?s\s+left|Known\s+issues)/i;
/** A line that is only a label: a heading, bold text or a bare "Next steps:". */
const LABEL_LINE = new RegExp(`^\\s*(?:#{1,6}\\s*|[-*]\\s+)?(?:\\*\\*|__)?\\s*${PENDING_LABEL.source}\\s*(?:\\*\\*|__)?\\s*[:：]?\\s*(?:\\*\\*|__)?\\s*$`, 'i');
/** "남은 일: X, Y" at the start of a line or a sentence (not "the stale `TODO: x` comment"). */
const INLINE_LABEL = new RegExp(`(?:^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?|[.!?。]\\s+)(?:\\*\\*|__)?\\s*${PENDING_LABEL.source}\\s*(?:\\*\\*|__)?\\s*[:：]\\s*(.+)$`, 'i');
const HEADING = /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/;

function withoutCode(text: string): string {
  return text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ');
}

/**
 * The part of the assistant's last reply that says what is left ("남은 작업", "Next steps", "TODO"):
 * the list under such a heading or the text after such a label. Replies usually end with it, which
 * is the part a shortened reply loses. Null when the reply has no such part.
 */
export function pendingWork(reply: string): string | null {
  return splitPending(reply).pending;
}

/**
 * The reply split at its "what is left" part: the text before it, and that part as one line. The
 * last such part wins: an earlier "TODO:" is more often something the reply just dealt with.
 */
function splitPending(reply: string): { before: string; pending: string | null } {
  const lines = withoutCode(reply).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (LABEL_LINE.test(line)) {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && body.join(' ').length < 800; j++) {
        const next = lines[j] ?? '';
        if (HEADING.test(next) || (next.trim() === '' && body.length > 0 && !/^\s*([-*+]|\d+[.)])\s/.test(lines[j + 1] ?? ''))) break;
        if (next.trim()) body.push(next.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim());
      }
      if (body.length > 0) return { before: lines.slice(0, i).join('\n'), pending: body.join('; ') };
    }
    const inline = INLINE_LABEL.exec(line);
    const rest = inline?.[inline.length - 1];
    if (inline && rest && rest.trim().length >= 3) {
      const cut = inline.index + (/^[.!?。]/.test(inline[0]) ? 1 : 0);
      return { before: [...lines.slice(0, i), line.slice(0, cut)].join('\n'), pending: rest.trim() };
    }
  }
  return { before: lines.join('\n'), pending: null };
}

/** The last paragraph of a reply (where questions and open points usually are). */
function lastParagraph(reply: string): string | null {
  const blocks = withoutCode(reply)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.length > 1 ? (blocks[blocks.length - 1] as string) : null;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function cleanPrompt(text: string): string {
  return normalizeText(redactSecrets(stripInvisible(stripPasted(text))));
}

/** Replies keep long lines (prose is often one line per paragraph); code blocks go. */
function cleanReply(text: string): string {
  return normalizeText(redactSecrets(stripInvisible(withoutCode(text))));
}

function fit(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (approxTokens(text) <= budget) return text;
  let n = text.length;
  while (n > 20 && approxTokens(`${text.slice(0, n)}…`) > budget) n = Math.floor(n * 0.85);
  return n > 20 ? `${text.slice(0, n).trimEnd()}…` : '';
}

/** Shortened from the start: the end of a passage is what matters ("…다음은 X 확인"). */
function fitEnd(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (approxTokens(text) <= budget) return text;
  let n = text.length;
  while (n > 20 && approxTokens(`…${text.slice(-n)}`) > budget) n = Math.floor(n * 0.85);
  return n > 20 ? `…${text.slice(-n).trimStart()}` : '';
}

export interface HandoffExtras {
  /** Worktree state now (git); omitted when unavailable. */
  work?: WorkState | null;
  /** Checks the previous session ran (its transcript); omitted when unavailable. */
  checks?: readonly CommandCheck[];
}

/** Worktree state and checks for a handoff (git and the tool's transcript; no LLM). */
export function handoffExtras(root: string, previous: PreviousSession): HandoffExtras {
  let work: WorkState | null = null;
  let checks: CommandCheck[] = [];
  try {
    work = workState(root, previous.startedAt);
  } catch {
    work = null;
  }
  try {
    checks = readCommandChecks(previous.transcriptPath, previous.startedAt, new Date(Date.parse(previous.endedAt) + 60_000).toISOString());
  } catch {
    checks = [];
  }
  return { work, checks };
}

/**
 * The checkpoint text. Each part gets a share of the budget in order of how much it helps the next
 * session (the last request, what is left, checks, the worktree, the first request, the reply);
 * the lines then read in order: what was asked, what the reply said, what is left, the evidence.
 */
export function renderHandoff(previous: PreviousSession, lang: Language, budgetTokens: number, now: Date = new Date(), extras: HandoffExtras = {}): string | null {
  const t = TEXT[lang];
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(previous.endedAt)) / 60_000));
  const header = t.header(TOOL_LABEL[previous.tool] ?? previous.tool, t.ago(minutes), Math.max(previous.promptCount, previous.prompts.length));
  let budget = budgetTokens - approxTokens(header);
  const take = (line: string): string => {
    if (line) budget -= approxTokens(line) + 1;
    return line;
  };

  // Bare acknowledgements ("응", "ok") say nothing on their own; the reply carries what they accepted.
  const normal = previous.prompts.filter((p) => promptKind(p) === 'normal');
  const recent = (normal.length > 0 ? normal : previous.prompts).slice(-2).map(cleanPrompt).filter(Boolean);
  const lastRequest = recent[recent.length - 1] ?? null;
  const opening = previous.openingPrompts.map(cleanPrompt).find((p) => p && promptKind(p) === 'normal') ?? null;
  // The first request is the goal when later ones are follow-ups ("테스트도 해줘").
  const goal = opening && previous.promptCount > 1 && opening !== lastRequest ? opening : null;
  const earlierRequest = recent.length > 1 && recent[0] !== goal ? (recent[0] as string) : null;
  const replyRaw = previous.lastAssistant ?? '';
  const split = splitPending(replyRaw);
  const pending = split.pending ? cleanReply(split.pending) : null;
  const tail = !pending && replyRaw ? lastParagraph(replyRaw) : null;
  // With a "what is left" part, the reply line is the text before it (no repeating it).
  const reply = replyRaw ? cleanReply(pending ? split.before : replyRaw) || null : null;

  const lines = {
    lastRequest: lastRequest ? take(fit(`${goal || earlierRequest ? t.lastRequest : t.request}: ${lastRequest}`, Math.min(budget, 70))) : '',
    pending: pending ? take(fit(`${t.pending}: ${pending}`, Math.min(budget, 110))) : '',
    checks: '',
    commits: '',
    worktree: '',
    goal: '',
    earlierRequest: '',
    replyEnd: '',
    reply: '',
  };
  // Known results first (a failure is what the next session most needs), then checks that ran.
  const all = (extras.checks ?? []).slice(-6);
  const checks = [...all.filter((c) => c.ok !== null), ...all.filter((c) => c.ok === null)].slice(0, 4);
  if (checks.length > 0) {
    const status = (c: CommandCheck): string => (c.ok === null ? t.unknown : c.ok ? t.passed : `${t.failed}${c.signature ? ` (${c.signature})` : ''}`);
    lines.checks = take(fit(`${t.checks}: ${checks.map((c) => `\`${c.command}\` ${status(c)}`).join(', ')}`, Math.min(budget, 60)));
  }
  const work = extras.work;
  if (work) {
    if (work.commits.length > 0) lines.commits = take(fit(`${t.commits}: ${work.commits.slice(0, 3).join('; ')}`, Math.min(budget, 45)));
    const files = work.dirtyCount > 0 ? `${t.dirty(work.dirtyCount)}: ${work.dirty.slice(0, 5).join(', ')}${work.dirtyCount > 5 ? ', …' : ''}` : t.clean;
    lines.worktree = take(fit(`${t.worktree(work.branch, work.head)}: ${files}`, Math.min(budget, 55)));
  }
  if (goal) lines.goal = take(fit(`${t.goal}: ${goal}`, Math.min(budget, 55)));
  if (earlierRequest) lines.earlierRequest = take(fit(`${t.request}: ${earlierRequest}`, Math.min(budget, 50)));
  if (tail && budget > 40) lines.replyEnd = take(fitEnd(`${t.replyEnd}: ${cleanReply(tail)}`, Math.min(budget - 30, 90)));
  if (reply && budget > 25) {
    const label = lines.replyEnd || approxTokens(reply) > budget ? t.replyStart : t.reply;
    lines.reply = take(fit(`${label}: ${reply}`, budget));
  }
  const ordered = [lines.goal, lines.earlierRequest, lines.lastRequest, lines.reply, lines.replyEnd, lines.pending, lines.checks, lines.commits, lines.worktree].filter(Boolean);
  return ordered.length > 0 ? [header, ...ordered].join('\n') : null;
}
