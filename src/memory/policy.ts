import type { ItemStatus, SourceKind } from '../knowledge/types.ts';

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
