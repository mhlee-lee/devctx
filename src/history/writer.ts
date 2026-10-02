import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../memory/evidence.ts';
import type { Language } from '../types.ts';
import { sha256 } from '../util/fsx.ts';
import type { FileChange } from './snapshot.ts';
import type { TurnSummary } from './summarize.ts';

/**
 * `.devctx/history/<YYYY-MM>/<UTC time of the first entry>-<tool>-<session hash>.md`: a session's
 * entries in prompt order. File names start with the time of their first entry, so a plain sort is
 * chronological for the whole team, and two people never write the same file. A session continues
 * in a new file once its file is committed (see history/process.ts), so committed files never
 * change: no merge conflicts and no blocked checkouts.
 */

export const HISTORY_DIR = '.devctx/history';
/** Longer prompts are kept up to this many characters, with a note on what was cut. */
export const PROMPT_MAX_CHARS = 20_000;

const TOOL_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', cursor: 'Cursor', kiro: 'Kiro' };

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Relative path (posix) of a new history file whose first entry was prompted at `startIso`. */
export function sessionFile(startIso: string, tool: string, skey: string): string {
  const d = new Date(startIso);
  const month = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  const stamp = `${month}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const id = sha256(`${tool}|${skey}`).slice(0, 6);
  const safeTool = tool.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'tool';
  return `${HISTORY_DIR}/${month}/${stamp}-${safeTool}-${id}.md`;
}

/** Local time with its UTC offset: "2026-10-01 22:09:13 (+09:00)". */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

function duration(fromIso: string, toIso: string | null, lang: Language): string | null {
  if (!toIso) return null;
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  const m = Math.floor(s / 60);
  if (lang === 'ko') return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`;
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** A code fence longer than any backtick run inside, so the prompt is kept byte for byte. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const T: Record<
  Language,
  { title: string; session: string; author: string; branch: string; started: string; prompt: string; work: string; result: string; files: string; commands: string; cut: (n: number) => string; kinds: Record<TurnSummary['kind'], string>; noFiles: string; unknownFiles: string; model: string; continued: (from: number, previous: string) => string }
> = {
  ko: {
    title: '작업 기록',
    session: '세션',
    author: '작성자',
    branch: '브랜치',
    started: '세션 시작',
    prompt: '프롬프트',
    work: '작업 내용',
    result: '결과',
    files: '바뀐 파일',
    commands: '실행한 명령',
    cut: (n) => `(이하 ${n}자 생략)`,
    kinds: { change: '코드 변경', investigation: '조사', answer: '답변', none: '진행 없음' },
    noFiles: '바뀐 파일 없음',
    unknownFiles: '바뀐 파일을 계산하지 못함 (git 스냅샷 없음)',
    model: '모델',
    continued: (from, previous) => `이어서: 이 세션의 ${from}번째 프롬프트부터 (앞부분: \`${previous}\`)`,
  },
  en: {
    title: 'Work history',
    session: 'Session',
    author: 'Author',
    branch: 'Branch',
    started: 'Session started',
    prompt: 'Prompt',
    work: 'What was done',
    result: 'Result',
    files: 'Changed files',
    commands: 'Commands run',
    cut: (n) => `(${n} more characters cut)`,
    kinds: { change: 'code change', investigation: 'investigation', answer: 'answer', none: 'no progress' },
    noFiles: 'No files changed',
    unknownFiles: 'Changed files unknown (no git snapshot)',
    model: 'Model',
    continued: (from, previous) => `Continued: from prompt ${from} of this session (earlier part: \`${previous}\`)`,
  },
};

export interface SessionMeta {
  tool: string;
  session: string | null;
  startIso: string;
  author: string | null;
  /** This file continues a session whose earlier prompts are in `previous` (already committed). */
  continued: { from: number; previous: string } | null;
}

export function renderHeader(m: SessionMeta, lang: Language): string {
  const t = T[lang];
  const rows = [
    `- ${t.started}: ${localTime(m.startIso)}`,
    m.session ? `- ${t.session}: \`${m.session}\`` : null,
    m.author ? `- ${t.author}: ${m.author}` : null,
    m.continued ? `- ${t.continued(m.continued.from, path.posix.basename(m.continued.previous))}` : null,
  ].filter(Boolean);
  return `# ${t.title} · ${toolLabel(m.tool)} · ${localTime(m.startIso).slice(0, 16)}\n\n${rows.join('\n')}\n`;
}

export interface EntryData {
  number: number;
  promptIso: string;
  endIso: string | null;
  branch: string | null;
  model: string | null;
  prompt: string;
  summary: TurnSummary;
  files: FileChange[] | null;
  commands: string[];
}

function fileItem(f: FileChange): string {
  const counts = f.added === null ? 'binary' : `+${f.added} −${f.removed ?? 0}`;
  return `- \`${f.path}\` (${f.status}, ${counts})`;
}

export function renderEntry(e: EntryData, lang: Language): string {
  const t = T[lang];
  const meta = [localTime(e.promptIso), duration(e.promptIso, e.endIso, lang), e.branch ? `${t.branch} \`${e.branch}\`` : null, e.model ? `${t.model} \`${e.model}\`` : null]
    .filter(Boolean)
    .join(' · ');
  let prompt = redactSecrets(e.prompt);
  let cut = '';
  if (prompt.length > PROMPT_MAX_CHARS) {
    cut = `\n\n${t.cut(prompt.length - PROMPT_MAX_CHARS)}`;
    prompt = prompt.slice(0, PROMPT_MAX_CHARS);
  }
  const fence = fenceFor(prompt);
  const lines: string[] = [
    `## ${e.number}. ${meta}`,
    '',
    `**${t.prompt}**`,
    '',
    `${fence}text`,
    prompt,
    `${fence}${cut}`,
    '',
    `**${t.work}** (${t.kinds[e.summary.kind]})`,
    '',
    e.summary.summary,
  ];
  if (e.summary.outcome) lines.push('', `${t.result}: ${e.summary.outcome}`);
  lines.push('');
  if (e.files === null) lines.push(`${t.unknownFiles}`);
  else if (e.files.length === 0) lines.push(`${t.noFiles}`);
  else {
    const shown = e.files.slice(0, 40);
    lines.push(`${t.files} (${e.files.length}):`, '', ...shown.map(fileItem));
    if (e.files.length > shown.length) lines.push(`- … +${e.files.length - shown.length}`);
  }
  if (e.commands.length > 0) lines.push('', `${t.commands}:`, '', ...e.commands.map((c) => `- \`${c.replace(/`/g, "'")}\``));
  return `${lines.join('\n')}\n`;
}

/** Appends one entry, creating the file with its header on the first one. Returns the relative path. */
export function appendEntry(root: string, rel: string, header: string, entry: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  fs.appendFileSync(file, exists ? `\n---\n\n${entry}` : `${header}\n---\n\n${entry}`, 'utf8');
  return rel;
}
