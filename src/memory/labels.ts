import type { ItemStatus } from '../knowledge/types.ts';
import type { Language } from '../types.ts';

/**
 * Words people read for what happened to a rule and where it stands now. The internal relation
 * names (new, duplicate, ...) say how a candidate related to existing rules, not whether the rule
 * is in force: a "new" rule may only be a proposal on this PC, and a "duplicate" may be the
 * moment that proposal became a decision.
 */

const RELATION: Record<string, [ko: string, en: string]> = {
  new: ['추가', 'added'],
  duplicate: ['같은 규칙', 'same rule'],
  confirmed: ['확정', 'confirmed'],
  refine: ['보강', 'refined'],
  supersede: ['대체', 'replaced'],
  conflict: ['충돌', 'conflict'],
  dropped: ['기록 안 함', 'not recorded'],
  archive: ['보관', 'archived'],
  expire: ['기한 만료', 'expired'],
  approve: ['확정', 'confirmed'],
  discard: ['버림', 'dropped'],
  resolve: ['충돌 정리', 'conflict settled'],
};

const STATUS: Record<string, [ko: string, en: string]> = {
  active: ['적용 중', 'in force'],
  proposed: ['확인 대기 (이 PC만, 확정: devctx approve)', 'waiting for confirmation (this PC only; devctx approve)'],
  conflict: ['충돌 (정리: devctx resolve)', 'conflict (settle: devctx resolve)'],
  superseded: ['대체됨', 'replaced'],
  retired: ['만료됨', 'expired'],
  archived: ['보관됨 (다시 말하면 적용)', 'archived (saying it again applies it)'],
};

/** Whether a `duplicate` turned a proposal of this PC into a decision (consolidate's note). */
export function confirmedProposal(detail: string | null | undefined): boolean {
  return /confirmed a proposal|revived an archived proposal/.test(detail ?? '');
}

export function relationLabel(relation: string, lang: Language, detail?: string | null): string {
  const key = relation === 'duplicate' && confirmedProposal(detail) ? 'confirmed' : relation;
  const pair = RELATION[key];
  return pair ? pair[lang === 'ko' ? 0 : 1] : relation;
}

export function statusLabel(status: ItemStatus | null | undefined, lang: Language, archived = false): string {
  const pair = archived ? STATUS.archived : status ? STATUS[status] : undefined;
  return pair ? pair[lang === 'ko' ? 0 : 1] : '';
}
