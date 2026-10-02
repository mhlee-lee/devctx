import { splitSentences, stripPasted } from '../util/text.ts';
import { promptKind } from './context.ts';

export interface Signals {
  durable: boolean;
  correction: boolean;
  oneOff: boolean;
  remember: boolean;
  /** Worth sending to the extractor. */
  candidate: boolean;
  /**
   * No explicit marker, but the prompt states something ("DB 컬럼명은 snake_case") or accepts the
   * assistant's proposal ("응"). The extractor still decides; these wait to be sent in batches (see
   * `extractionDue`) because most of them are ordinary task requests.
   */
  implicit: boolean;
  flags: string[];
}

// Language: statements meant to keep applying.
const DURABLE: RegExp[] = [
  /앞으로/,
  /이제부터/,
  /지금부터/,
  /다음부터/,
  /다음에도/,
  /항상/,
  /언제나/,
  /매번/,
  /절대/,
  /반드시/,
  /무조건/,
  /꼭\s/,
  /명심/,
  /잊지\s*마/,
  /규칙/,
  /원칙/,
  /정책/,
  /컨벤션/,
  /금지/,
  /통일/,
  /프로젝트\s*전체/,
  /모든\s*(파일|곳|코드|api|테스트|화면|모듈|함수|클래스)/i,
  /(하|쓰|사용하|만들|넣|두|붙이|바꾸|건드리|올리|지우|추가하|남기|쓰이)지\s*(마|말|않)/,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bdon'?t ever\b/i,
  /\bdo not ever\b/i,
  /\bin (the )?future\b/i,
  /\bas a rule\b/i,
  /\bconvention\b/i,
  /\bpolicy\b/i,
  /\bevery time\b/i,
  /\bacross the (project|codebase|repo)\b/i,
];

// Language: the user is correcting what the assistant just did.
const CORRECTION: RegExp[] = [
  /^\s*(아니|아냐|아뇨|노노|ㄴㄴ)/,
  /그게\s*아니/,
  /(그거|이거|저거)\s*말고/,
  /\S\s*말고\s+\S/,
  /대신에?\s/,
  /잘못/,
  /틀렸|틀린/,
  /왜\s*.{0,20}(했|한|썼|쓴|넣었|만들었|바꿨)/,
  /다시\s*(해|하|작성|만들|고쳐|짜)/,
  /되돌려|원래대로|롤백/,
  /(라고|하라고|말라고)\s*(했|말했)/,
  /했잖아|말했잖아|하랬잖아/,
  /^\s*no\b[,.! ]/i,
  /\bthat'?s (wrong|not right|not what)\b/i,
  /\bnot what i (asked|wanted|meant)\b/i,
  /\binstead\b/i,
  /\brevert\b/i,
  /\bundo\b/i,
  /\bi (said|told you)\b/i,
  /\bstop (doing|using|adding|creating)\b/i,
  /\bwhy did you\b/i,
  /\bdon'?t (use|add|do|create|write|put|change)\b/i,
];

// Language: explicitly limited to the current task.
const ONE_OFF: RegExp[] = [
  /이번만/,
  /이번에?는/,
  /이번\s*한\s*번/,
  /일단(?!위)/,
  /임시로/,
  /잠깐/,
  /테스트로/,
  /\bjust this once\b/i,
  /\bfor now\b/i,
  /\btemporar(y|ily)\b/i,
  /\bthis time\b/i,
  /\bfor this (task|pr|change|commit)\b/i,
];

const REMEMBER: RegExp[] = [/기억해/, /기억\s*해\s*줘/, /\bremember\b/i, /\bkeep in mind\b/i];

// A sentence limited to the current task; only that sentence is left out of implicit capture.
// Narrower than ONE_OFF: "테스트로", "잠깐" and "temporary" also appear in lasting rules.
const TASK_ONLY: RegExp[] = [
  /이번만/,
  /이번에?는/,
  /이번\s*한\s*번/,
  /일단(?!위)/,
  /임시로/,
  /\bjust this once\b/i,
  /\bfor now\b/i,
  /\bthis time\b/i,
  /\bfor this (task|pr|change|commit)\b/i,
];

// Korean endings that ask something rather than tell.
const KO_QUESTION_END = /(까|니|냐|나|나요|가요|래|래요|는지|은지|던가|건가|걸까|어때|어떄|뭐야|뭐지|왜|맞지|되나|될까|있나|없나)$/;
const EN_QUESTION_START = /^(what|why|how|where|when|which|who|whose)\b/i;

// The assistant ended its message by proposing something ("RFC 7807 형식으로 통일할까요?").
const PROPOSAL: RegExp[] = [
  /[?？]\s*$/,
  /(할까요|드릴까요|하시겠어요|하시겠습니까|어떨까요|좋을까요|괜찮을까요|원하시나요|진행할까요)/,
  /\b(should I|shall I|do you want|would you like|want me to)\b/i,
];

function lastWords(sentence: string): { text: string; words: string[]; last: string } {
  const text = sentence.trim().replace(/[\s.!~…;:)\]"'`ㅋㅎㅠㅜ^]+$/u, '');
  const words = text.split(/\s+/).filter(Boolean);
  return { text, words, last: words[words.length - 1] ?? '' };
}

/** A sentence that asks rather than tells ("뭐가 나아?", "이 코드 어때", "Which do you prefer"). */
export function isQuestion(raw: string): boolean {
  if (/[?？]\s*$/.test(raw.trim())) return true;
  const { text, last } = lastWords(raw);
  if (/[가-힣]/.test(last)) return KO_QUESTION_END.test(last);
  return EN_QUESTION_START.test(text);
}

/**
 * Whether the prompt states anything that could be a rule: any sentence of two or more words
 * except questions and sentences limited to the current task ("일단 빌드부터 고쳐줘"), outside
 * pasted content. Slash commands and bare acknowledgements say nothing. Deliberately broad, since
 * rules also come as terse notes ("DB 컬럼명은 snake_case", "Lombok은 안 씀"); the extractor drops
 * the ordinary task requests that make up most matches.
 */
export function hasStatement(prompt: string): boolean {
  if (promptKind(prompt) !== 'normal') return false;
  return splitSentences(stripPasted(prompt)).some((s) => !TASK_ONLY.some((p) => p.test(s)) && !isQuestion(s) && lastWords(s).words.length >= 2);
}

/** "응", "ok" right after the assistant proposed something: the reply may accept a convention. */
export function acceptsProposal(prompt: string, previousAssistant: string | null | undefined): boolean {
  if (!previousAssistant || promptKind(prompt) !== 'ack') return false;
  const tail = previousAssistant.trim().slice(-400);
  return PROPOSAL.some((p) => p.test(tail));
}

function any(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

export interface SignalOptions {
  /** Also send prompts without explicit markers to the extractor (`memory.implicit_rules`). */
  implicit?: boolean;
  /** The assistant's message before this prompt, when the tool reported it. */
  previousAssistant?: string | null;
}

/**
 * Cheap, local classifier run inside the hook fast path. It only decides whether a prompt is
 * worth sending to the extractor; the extractor decides what (if anything) becomes a rule.
 */
export function detectSignals(prompt: string, opts: SignalOptions = {}): Signals {
  const text = stripPasted(prompt);
  const durable = any(DURABLE, text);
  const correction = any(CORRECTION, text);
  const oneOff = any(ONE_OFF, text);
  const remember = any(REMEMBER, text);
  const explicit = durable || correction || remember;
  const allowImplicit = !explicit && opts.implicit !== false;
  const accept = allowImplicit && acceptsProposal(prompt, opts.previousAssistant);
  const implicit = accept || (allowImplicit && hasStatement(prompt));
  const flags: string[] = [];
  if (durable) flags.push('durable');
  if (correction) flags.push('correction');
  if (oneOff) flags.push('one-off');
  if (remember) flags.push('remember');
  if (implicit) flags.push('implicit');
  if (accept) flags.push('accept');
  return { durable, correction, oneOff, remember, candidate: explicit || implicit, implicit, flags };
}

/** Implicit candidates are sent once this many are waiting (one extraction call takes 5). */
export const IMPLICIT_BATCH = 5;
/** ...or once the oldest has waited this long. */
export const IMPLICIT_MAX_WAIT_MS = 60 * 60 * 1000;

export interface PendingCandidates {
  explicit: number;
  implicit: number;
  oldestImplicit: string | null;
}

/**
 * Whether a hook should start the worker for extraction. Explicit candidates go at the next turn
 * end; implicit ones wait for a full batch, a session boundary or an hour, so ordinary task
 * requests cost about one extraction call per five prompts.
 */
export function extractionDue(pending: PendingCandidates, sessionBoundary: boolean, now: number = Date.now()): boolean {
  if (pending.explicit > 0) return true;
  if (pending.implicit === 0) return false;
  if (sessionBoundary || pending.implicit >= IMPLICIT_BATCH) return true;
  return pending.oldestImplicit !== null && now - Date.parse(pending.oldestImplicit) >= IMPLICIT_MAX_WAIT_MS;
}
