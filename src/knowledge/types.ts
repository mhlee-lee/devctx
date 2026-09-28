export type ItemType = 'rule' | 'decision' | 'fact' | 'procedure' | 'lesson';
export type ItemStatus = 'proposed' | 'active' | 'conflict' | 'superseded' | 'retired';
export type Enforcement = 'must' | 'should' | 'info';
export type SourceKind =
  | 'human-edit'
  | 'user-instruction'
  | 'user-correction'
  | 'pr-review'
  | 'agent-proposal'
  | 'code-derived';
export type TierPin = 'auto' | 'core' | 'scoped' | 'on-demand';
export type Audience = 'team' | 'personal';

export const ITEM_TYPES: readonly ItemType[] = ['rule', 'decision', 'fact', 'procedure', 'lesson'];
export const ITEM_STATUSES: readonly ItemStatus[] = ['proposed', 'active', 'conflict', 'superseded', 'retired'];
export const ENFORCEMENTS: readonly Enforcement[] = ['must', 'should', 'info'];
export const SOURCE_KINDS: readonly SourceKind[] = [
  'human-edit',
  'user-instruction',
  'user-correction',
  'pr-review',
  'agent-proposal',
  'code-derived',
];
export const TIER_PINS: readonly TierPin[] = ['auto', 'core', 'scoped', 'on-demand'];

export interface Evidence {
  quote?: string;
  path?: string;
  hash?: string;
  at?: string;
}

export interface Sections {
  rule: string;
  reason: string;
  exceptions: string;
  notes: string;
}

export interface KnowledgeItem {
  id: string;
  title: string;
  summary: string;
  type: ItemType;
  status: ItemStatus;
  enforcement: Enforcement;
  audience: Audience;
  scope: { paths: string[]; topics: string[] };
  source: { kind: SourceKind; actor: string | null; tool: string | null; captured_at: string };
  evidence: Evidence[];
  reinforced: number;
  violations: number;
  tier: TierPin;
  relates: string[];
  supersedes: string[];
  superseded_by: string | null;
  conflict_with: string[];
  needs_review: boolean;
  revision: number;
  last_verified: string;
  sections: Sections;
  /** Absolute path of the backing file (runtime only, not serialized). */
  file: string;
}
