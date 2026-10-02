import type { ToolId } from '../types.ts';

export type ProviderId = ToolId | 'fake';
export type Tier = 'small' | 'medium' | 'large';
export const TIERS: readonly Tier[] = ['small', 'medium', 'large'];
export type LlmTask = 'extract' | 'judge' | 'summarize' | 'qualify';

/** Token counts a CLI reported for one call (reasoning is part of output). */
export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export interface ModelCandidate {
  provider: ProviderId;
  /** Model id passed to the CLI (`--model`), or `auto` for vendor routing. */
  id: string;
  /** Extra CLI args for this candidate (e.g. Copilot `--auto-tier efficiency`). */
  extraArgs: string[];
  /** Reasoning effort to request, when the CLI supports it. */
  effort: string | null;
  description: string | null;
  source: 'alias' | 'discovered' | 'catalog' | 'auto' | 'pinned';
}

export interface LlmRequest {
  task: LlmTask;
  prompt: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
}

/** auth/quota: account problem, skip the provider for a while. infra: CLI/timeout. answer: bad output. */
export type FailureKind = 'auth' | 'quota' | 'infra' | 'answer';

export interface LlmRawResult {
  ok: boolean;
  data?: unknown;
  text: string;
  error?: string;
  kind?: FailureKind;
  ms: number;
  /** Cost reported by the CLI itself (Claude Code). */
  costUsd?: number | null;
  /** Token usage reported by the CLI (Codex), priced with the catalog. */
  usage?: TokenUsage | null;
}

export interface Provider {
  id: ProviderId;
  /** Human-readable name used in diagnostics. */
  label: string;
  /** Resolves the CLI binary, or null when the tool is not installed. */
  resolveBinary(): Promise<string | null>;
  version(bin: string): Promise<string | null>;
  /** Models this CLI can use right now (discovered, aliases or catalog-backed). */
  discover(bin: string): Promise<ModelCandidate[]>;
  run(bin: string, model: ModelCandidate, req: LlmRequest): Promise<LlmRawResult>;
}

export function candidateKey(m: ModelCandidate): string {
  const extra = m.extraArgs.length > 0 ? `[${m.extraArgs.join(' ')}]` : '';
  return `${m.provider}:${m.id}${extra}${m.effort ? `@${m.effort}` : ''}`;
}
