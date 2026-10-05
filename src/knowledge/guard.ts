import { stripInvisible } from '../memory/evidence.ts';

/**
 * Rule text reaches every agent as an instruction, so a decision file carries as much weight as
 * AGENTS.md while getting less review (devctx stages decision files with ordinary commits). Text
 * that poses as a chat role or tells the agent to drop its other instructions is never a project
 * convention: such a rule is held back from every delivery path and `devctx doctor` names it.
 * AnchorMind quarantines memories with the same phrases and escapes role tags in hook output.
 * The patterns are narrow on purpose ("lint 경고는 무시한다", "Keep the system prompt in
 * prompts/" stay ordinary rules).
 */

const ROLE_TAG: RegExp[] = [
  /\[\/?\s*(system|sys|inst|assistant|developer)\s*\]/i,
  // A role block (`<system>…</system>`) or text that opens with one; `<Assistant />` components are fine.
  /<\s*(system|assistant|developer|instructions?)\s*>[\s\S]*<\/\s*\1\s*>/i,
  /^\s*<\s*(system|assistant|developer|instructions?)\s*>/i,
  /<\|(im_start|im_end|system|assistant|user|endoftext)\|>/i,
  /<<\/?\s*sys\s*>>/i,
  /^\s*(system|assistant|developer)\s*(prompt|message)?\s*:/i,
];

const OVERRIDE: RegExp[] = [
  // "Ignore all previous instructions", "forget the prior rules"
  /\b(ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}?\b(previous|prior|above|earlier|preceding)\b[^.!?\n]{0,20}?\b(instructions?|rules?|prompts?|guidelines?|directions?)\b/i,
  // "Ignore the system prompt", "disregard your developer instructions"
  /\b(ignore|disregard|forget)\b[^.!?\n]{0,20}?\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  // "Ignore all instructions", "forget your guidelines"
  /\b(ignore|disregard|forget)\b\s+(all|any|your|every)\s+(of\s+)?(the\s+|your\s+)?(other\s+)?(instructions?|guidelines?|directions?)\b/i,
  // "Disregard the rules above"
  /\b(ignore|disregard|forget)\b\s+(all\s+)?(of\s+)?(the|these|those|your)\s+(instructions?|rules?|prompts?|guidelines?|directions?)\s+(above|before|so far)\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\b(enter|enable|switch\s+to|activate)\s+(DAN|jailbreak|jailbroken)\s+mode\b/i,
  // "이전 지시는 모두 무시하고", "위의 지침을 따르지 말고", "시스템 프롬프트를 무시해"
  /(이전|앞|위|모든|시스템|개발자)(의)?\s*(모든\s*)?(지시|지침|명령|프롬프트|instructions?)(사항|문)?(들)?\s*(을|를|은|는|이|가|도)?\s*(모두|전부|다)?\s*(무시|잊|따르지\s*(마|말))/i,
  /탈옥\s*모드/,
];

/** Asking for the hidden instructions; "never print the system prompt" is the opposite and stays. */
const REVEAL: RegExp[] = [
  /\b(reveal|print|show|output|leak|repeat)\b[^.!?\n]{0,25}?\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /(시스템|개발자)\s*(프롬프트|메시지|지시)[^.!?\n]{0,15}?(보여|출력|알려|공개|노출|유출)/,
];
const NEGATED_BEFORE = /\b(never|not|don'?t|do not|must not|should not|no)\b[^.!?\n]{0,15}$/i;
const NEGATED_AFTER = /^[^.!?\n]{0,12}(않|말|금지|못|마)/;

export interface HeldCheck {
  /** Why the rule is held back, or null when the text is an ordinary rule. */
  reason: string | null;
  /** The matching text, for messages. */
  match: string | null;
}

/** Whether rule text poses as a chat role or tries to override the agent's other instructions. */
export function checkRuleText(text: string): HeldCheck {
  const t = stripInvisible(text.normalize('NFKC'));
  for (const p of ROLE_TAG) {
    const m = p.exec(t);
    if (m) return { reason: 'poses as a chat role tag', match: m[0].trim() };
  }
  for (const p of OVERRIDE) {
    const m = p.exec(t);
    if (m) return { reason: 'tells the agent to ignore or reveal its instructions', match: m[0].trim() };
  }
  for (const p of REVEAL) {
    const m = p.exec(t);
    if (!m) continue;
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    if (NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after)) continue;
    return { reason: 'tells the agent to ignore or reveal its instructions', match: m[0].trim() };
  }
  return { reason: null, match: null };
}

/** Short reason a rule is held back ("tells the agent … (`ignore all previous instructions`)"), or null. */
export function heldReason(text: string): string | null {
  const { reason, match } = checkRuleText(text);
  if (!reason) return null;
  const quoted = match && match.length > 60 ? `${match.slice(0, 57)}…` : match;
  return quoted ? `${reason} (\`${quoted}\`)` : reason;
}
