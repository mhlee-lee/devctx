import { redactSecrets } from '../memory/evidence.ts';
import type { Language } from '../types.ts';
import { truncate } from '../util/text.ts';
import type { FileChange } from './snapshot.ts';

/** What the summarizer may use: everything a newcomer needs, nothing it has to guess. */
export interface SummaryFacts {
  tool: string;
  prompt: string;
  lastAssistant: string | null;
  files: FileChange[];
  commands: string[];
  patch: string;
  /** The changes could not be computed (no git snapshot). */
  changesUnknown: boolean;
}

export type TurnKind = 'change' | 'investigation' | 'answer' | 'none';

export interface TurnSummary {
  summary: string;
  outcome: string | null;
  kind: TurnKind;
}

const KINDS: readonly TurnKind[] = ['change', 'investigation', 'answer', 'none'];

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'outcome', 'kind'],
  properties: {
    summary: { type: 'string' },
    outcome: { type: ['string', 'null'] },
    kind: { type: 'string', enum: [...KINDS] },
  },
} as const;

const LANGUAGE: Record<Language, string> = { ko: 'Korean', en: 'English' };

function fileLine(f: FileChange): string {
  const counts = f.added === null ? 'binary' : `+${f.added} -${f.removed ?? 0}`;
  return `${f.status} ${f.path} (${counts})`;
}

export function buildSummaryPrompt(f: SummaryFacts, lang: Language): string {
  const files = f.changesUnknown ? '(unknown: no git snapshot)' : f.files.length === 0 ? '(no files changed)' : f.files.slice(0, 60).map(fileLine).join('\n');
  const commands = f.commands.length === 0 ? '(none recorded)' : f.commands.map((c) => `- ${c}`).join('\n');
  return `You write one entry of a project's work history. A developer sent PROMPT to an AI coding assistant (${f.tool}); the facts below show what happened in that turn. Summarize it for a teammate who has never seen this conversation. Return ONLY one JSON object that matches the schema. No prose, no code fences, and do not use any tools.

Rules:
1. Use only the facts below. Never invent files, symbols, commands, results or reasons.
2. summary: 2 to 5 sentences in ${LANGUAGE[lang]}. Say what was asked, what the assistant did (which parts of the code changed and why) and anything left open. Mention files or symbols only when they appear in the facts. Spell out project context a newcomer would miss; no filler.
3. outcome: one sentence in ${LANGUAGE[lang]} on the result (tests passed or failed, question answered, work unfinished, assistant waiting for a decision), or null when the facts do not say.
4. kind: "change" when files changed; "investigation" when the assistant only read code or ran commands; "answer" when it only answered or explained; "none" when nothing happened (for example the turn was interrupted).
5. Do not copy code, secrets or long passages; do not repeat PROMPT word for word.

Schema:
${JSON.stringify(SUMMARY_SCHEMA)}

PROMPT:
"""
${truncate(f.prompt, 4000)}
"""

ASSISTANT_FINAL_MESSAGE:
"""
${f.lastAssistant ? truncate(f.lastAssistant, 3000) : '(not available)'}
"""

CHANGED_FILES:
${files}

COMMANDS_RUN:
${commands}

DIFF_EXCERPT:
"""
${f.patch ? truncate(f.patch, 6000) : '(none)'}
"""
`;
}

export function parseSummaryResult(data: unknown): TurnSummary | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (summary.length < 10) return null;
  const outcome = typeof o.outcome === 'string' && o.outcome.trim() ? o.outcome.trim() : null;
  const kind = KINDS.includes(o.kind as TurnKind) ? (o.kind as TurnKind) : 'none';
  return { summary: redactSecrets(summary), outcome: outcome ? redactSecrets(outcome) : null, kind };
}

const FALLBACK: Record<Language, { noReply: string; replyLead: string }> = {
  ko: { noReply: '요약을 만들지 못했다 (LLM을 쓸 수 없었고 AI 응답도 기록되지 않았다).', replyLead: 'AI 응답 (요약 없이 앞부분):' },
  en: { noReply: 'No summary (no LLM was available and the assistant reply was not recorded).', replyLead: 'Assistant reply (first part, not summarized):' },
};

/** Without an LLM: the assistant's own final message, which usually says what it did. */
export function fallbackSummary(f: SummaryFacts, lang: Language): TurnSummary {
  const t = FALLBACK[lang];
  const kind: TurnKind = f.files.length > 0 ? 'change' : f.commands.length > 0 ? 'investigation' : f.lastAssistant ? 'answer' : 'none';
  if (!f.lastAssistant) return { summary: t.noReply, outcome: null, kind };
  const reply = truncate(redactSecrets(f.lastAssistant.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim()), 700);
  return { summary: `${t.replyLead} ${reply}`, outcome: null, kind };
}

const PATH_LIKE = /(?:[\w@.-]+\/)*[\w@-]+\.[a-z]{1,6}\b/gi;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|kts|go|rs|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|dart|md|json|ya?ml|toml|sql|sh|css|scss|html|vue|svelte|gradle|xml|properties|lock)$/i;

/** File-like names in the summary that appear nowhere in the facts (the model made them up). */
export function inventedPaths(s: TurnSummary, f: SummaryFacts): string[] {
  const facts = [f.prompt, f.lastAssistant ?? '', f.patch, ...f.commands, ...f.files.map((x) => x.path)].join('\n').toLowerCase();
  const said = `${s.summary}\n${s.outcome ?? ''}`.match(PATH_LIKE) ?? [];
  // A path, or a lowercase file name with a source extension ("messages.ts", not "Node.js").
  const fileish = (p: string): boolean => p.includes('/') || (SOURCE_EXT.test(p) && !/^[A-Z]/.test(p));
  return [...new Set(said)].filter((p) => fileish(p) && !facts.includes(p.toLowerCase()));
}
