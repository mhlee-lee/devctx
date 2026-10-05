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
  /**
   * Last day (YYYY-MM-DD, inclusive) the rule applies, when the developer gave an end date
   * ("until the 2.0 release on 2026-10-10"). After it the item is no longer delivered and the
   * worker retires it. On a superseded item: the day a newer rule replaced it.
   */
  valid_until: string | null;
  /** Rules that relied on what this rule replaced and should be checked again (cascade). */
  review: string[];
  /**
   * What in the repository this rule depends on, recorded when the file is created: dependency or
   * tool names found in manifests and path globs that matched files. When they disappear the rule
   * is marked "check needed" instead of being delivered as settled.
   */
  anchors: Anchors | null;
  sections: Sections;
  /** Absolute path of the backing file (runtime only, not serialized). */
  file: string;
  // ---- runtime only (never serialized) ----
  /** Lives in this PC's state database (an unconfirmed proposal), not in a file. */
  local?: boolean;
  /** An old proposal nobody confirmed: kept so a later restatement revives it. */
  archived?: boolean;
  /** Why the rule may be outdated (its anchors are gone from the repository). */
  stale?: string | null;
  /** When `needs_review` was raised (the reviewing rule's time). */
  reviewSince?: string;
  /** The file's `## 규칙` section and front matter `summary` disagree (the section is used). */
  summaryDiffers?: boolean;
  /**
   * The rule text poses as a chat role or tells the agent to ignore its instructions (see
   * knowledge/guard.ts): held back from every delivery path until a person rewrites it.
   */
  held?: string | null;
}

export interface Anchors {
  terms: string[];
  paths: string[];
}
