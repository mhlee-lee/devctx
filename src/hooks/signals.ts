import { stripPasted } from '../util/text.ts';

export interface Signals {
  durable: boolean;
  correction: boolean;
  oneOff: boolean;
  remember: boolean;
  /** Worth sending to the extractor. */
  candidate: boolean;
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
  /말고\s*\S+(으로|로|를|을)/,
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
  /일단/,
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

function any(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Cheap, local classifier run inside the hook fast path. It only decides whether a prompt is
 * worth sending to the extractor; the extractor decides what (if anything) becomes a rule.
 */
export function detectSignals(prompt: string): Signals {
  const text = stripPasted(prompt);
  const durable = any(DURABLE, text);
  const correction = any(CORRECTION, text);
  const oneOff = any(ONE_OFF, text);
  const remember = any(REMEMBER, text);
  const flags: string[] = [];
  if (durable) flags.push('durable');
  if (correction) flags.push('correction');
  if (oneOff) flags.push('one-off');
  if (remember) flags.push('remember');
  return { durable, correction, oneOff, remember, candidate: durable || correction || remember, flags };
}
