import { extractPathHints } from '../knowledge/retrieve.ts';
import { redactSecrets, stripInvisible } from '../memory/evidence.ts';
import type { PreviousSession } from '../state/db.ts';
import type { Language } from '../types.ts';
import { approxTokens, normalizeText, stripPasted } from '../util/text.ts';

/**
 * Session handoff: a new session (in any tool) that picks up earlier work gets where the last
 * session in this worktree stopped: its last requests and the start of the assistant's last reply.
 * Everything comes from what the hooks already captured, locally; no LLM call, nothing in git.
 * Atlas does this across agents and OpenViking keeps "pending tasks" per session; devctx only
 * offers it when the new prompt continues that work, because unrequested history derails a fresh
 * task (Hindsight's observation).
 */

const TOOL_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  kiro: 'Kiro',
};

const TEXT: Record<Language, { header: (tool: string, ago: string) => string; request: string; reply: string; ago: (m: number) => string }> = {
  ko: {
    header: (tool, ago) => `[devctx] 이 저장소의 직전 작업 (${tool}, ${ago}). 이어서 하는 요청이면 참고:`,
    request: '- 요청',
    reply: '- 마지막 응답 (앞부분)',
    ago: (m) => (m < 60 ? `${m}분 전` : m < 48 * 60 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`),
  },
  en: {
    header: (tool, ago) => `[devctx] Where the last session in this repository stopped (${tool}, ${ago}). Use it if this request continues that work:`,
    request: '- Request',
    reply: '- Last reply (start)',
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
  const theirs = salient([...previous.prompts, previous.lastAssistant ?? ''].join('\n'));
  let shared = 0;
  for (const t of mine) if (theirs.has(t)) shared++;
  return shared >= 2 || (shared === 1 && mine.size === 1);
}

function clean(text: string): string {
  return normalizeText(redactSecrets(stripInvisible(stripPasted(text))));
}

function fit(text: string, budget: number): string {
  if (approxTokens(text) <= budget) return text;
  let n = text.length;
  while (n > 20 && approxTokens(`${text.slice(0, n)}…`) > budget) n = Math.floor(n * 0.85);
  return n > 20 ? `${text.slice(0, n).trimEnd()}…` : '';
}

export function renderHandoff(previous: PreviousSession, lang: Language, budgetTokens: number, now: Date = new Date()): string | null {
  const t = TEXT[lang];
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(previous.endedAt)) / 60_000));
  const header = t.header(TOOL_LABEL[previous.tool] ?? previous.tool, t.ago(minutes));
  let budget = budgetTokens - approxTokens(header);
  const lines: string[] = [];
  // The last requests first (they say what was being done), the reply with what is left.
  for (const p of previous.prompts.slice(-2)) {
    const line = fit(`${t.request}: ${clean(p)}`, Math.min(budget, 90));
    if (!line) continue;
    lines.push(line);
    budget -= approxTokens(line);
  }
  if (previous.lastAssistant && budget > 30) {
    const line = fit(`${t.reply}: ${clean(previous.lastAssistant)}`, budget);
    if (line) lines.push(line);
  }
  return lines.length > 0 ? [header, ...lines].join('\n') : null;
}
