import type { ItemStatus, KnowledgeItem, SourceKind, TierPin } from '../knowledge/types.ts';

/** Who may override whom. A later AI suggestion never replaces what the user decided. */
export const AUTHORITY: Record<SourceKind, number> = {
  'human-edit': 5,
  'user-instruction': 4,
  'user-correction': 4,
  'pr-review': 3,
  'agent-proposal': 2,
  'code-derived': 1,
};

export function canOverride(next: SourceKind, current: SourceKind): boolean {
  return AUTHORITY[next] >= AUTHORITY[current];
}

export function initialStatus(durability: 'durable' | 'one_off' | 'unclear', confidence: number): ItemStatus {
  return durability === 'durable' && confidence >= 0.6 ? 'active' : 'proposed';
}

const NEXT_TIER: Record<TierPin, TierPin> = { 'on-demand': 'scoped', scoped: 'core', core: 'core', auto: 'auto' };

/**
 * The user repeated a rule that was already active: the assistant did not follow it. Record the
 * violation and move the rule toward always-loaded context. `auto` items are escalated by
 * planTiers through the violation count itself.
 */
export function registerViolation(item: KnowledgeItem): void {
  item.violations += 1;
  if (item.tier !== 'auto') item.tier = NEXT_TIER[item.tier];
}
