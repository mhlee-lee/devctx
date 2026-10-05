import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.ts';
import { machineDir, packageRoot } from '../util/paths.ts';
import type { LlmRawResult, ModelCandidate, ProviderId, Tier } from './types.ts';

interface CatalogFile {
  as_of: string;
  units: Record<string, 'usd' | 'relative'>;
  models: { provider: string; model: string; in: number; out: number }[];
}

interface CommunityCache {
  fetched_at: string;
  source: string;
  /** NORMALIZE_VERSION the keys were made with (missing: the first version). */
  norm?: number;
  /** normalized model id -> USD per 1M tokens */
  prices: Record<string, { in: number; out: number }>;
}

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

let bundled: CatalogFile | null = null;

function loadBundled(): CatalogFile {
  if (!bundled) {
    bundled = readJson<CatalogFile>(path.join(packageRoot(), 'data', 'pricing.json'), { as_of: '', units: {}, models: [] });
  }
  return bundled;
}

function communityFile(): string {
  return path.join(machineDir(), 'pricing-cache.json');
}

let community: CommunityCache | null | undefined;

function loadCommunity(): CommunityCache | null {
  if (community === undefined) {
    const cached = readJson<CommunityCache | null>(communityFile(), null);
    // Keys made by an older normalization would match the wrong models: unused until refreshed.
    community = cached && cached.norm === NORMALIZE_VERSION ? cached : null;
  }
  return community;
}

/**
 * `claude-haiku-4.5`, `anthropic/claude-haiku-4-5` and `Claude Haiku 4.5` all normalize to
 * `claude-haiku-4-5`. Separators become one `-` instead of disappearing, so `gpt-5.6` and `gpt-56`
 * stay different models.
 */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[a-z0-9_-]+\//, '')
    .replace(/-\d{8}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Bump when `normalizeModelId` changes: cached community prices are keyed by it. */
const NORMALIZE_VERSION = 2;

export function catalogModels(provider: ProviderId): string[] {
  return loadBundled()
    .models.filter((m) => m.provider === provider)
    .map((m) => m.model);
}

export function providerUnit(provider: ProviderId): 'usd' | 'relative' {
  return loadBundled().units[provider] ?? 'usd';
}

const LARGE_HINT = /\b(opus|fable|astra|ultra|frontier|most demanding|premium|maximum)\b/i;
const SMALL_HINT =
  /\b(haiku|mini|nano|flash|lite|luna|small|tiny|micro|instant|spark|swift|air|affordable|efficient|lightweight|cheap|economy|easier tasks|efficiency)\b/i;

export function tierHint(model: Pick<ModelCandidate, 'id' | 'description' | 'extraArgs'>): Tier {
  const text = `${model.id.replace(/[-_.]/g, ' ')} ${model.description ?? ''} ${model.extraArgs.join(' ')}`;
  if (LARGE_HINT.test(text)) return 'large';
  if (SMALL_HINT.test(text)) return 'small';
  return 'medium';
}

interface Price {
  in: number;
  out: number;
}

/** Guessed prices when no price list knows the model (usd: per 1M tokens; relative: credit multiplier). */
const HEURISTIC: Record<'usd' | 'relative', Record<Tier, Price>> = {
  usd: { small: { in: 0.3, out: 1.5 }, medium: { in: 2, out: 10 }, large: { in: 10, out: 50 } },
  relative: { small: { in: 0.35, out: 0.35 }, medium: { in: 1.2, out: 1.2 }, large: { in: 2.5, out: 2.5 } },
};

// Per-call token profile used to rank candidates before any real usage is known.
const PROMPT_TOKENS = 3_000; // a batch of 5 messages, or one judgement with its neighbours
const ANSWER_TOKENS = 600;
/** Instructions and tool definitions each CLI adds to every call (Codex measured, others rough). */
const CLI_OVERHEAD_TOKENS: Record<ProviderId, number> = { codex: 7_000, claude: 6_000, copilot: 10_000, cursor: 8_000, kiro: 6_000, fake: 0 };
/** Hidden reasoning tokens by effort level. Unknown future levels count as `high`. */
const EFFORT_TOKENS: Record<string, number> = {
  none: 0,
  minimal: 150,
  low: 800,
  medium: 2_500,
  high: 7_000,
  xhigh: 15_000,
  max: 30_000,
  ultra: 60_000,
};
/** Candidates without an effort flag run at the CLI's default. */
const DEFAULT_EFFORT_TOKENS = 2_500;

export function effortTokens(effort: string | null): number {
  if (!effort) return DEFAULT_EFFORT_TOKENS;
  return EFFORT_TOKENS[effort] ?? EFFORT_TOKENS.high ?? 7_000;
}

/** Effort levels a CLI accepts, cheapest first (unknown levels are placed by their cost guess). */
export function sortEfforts(levels: readonly string[]): string[] {
  return [...new Set(levels)].sort((a, b) => effortTokens(a) - effortTokens(b));
}

/** Models that are not general text/JSON models (security, review, embeddings, media...). */
export function isExcludedModel(model: Pick<ModelCandidate, 'id' | 'description'>): boolean {
  const text = `${model.id} ${model.description ?? ''}`;
  return /(embed|embedding|image|audio|speech|tts|transcri|realtime|moderation|auto-review|cybersecurity|\bsecurity\b|computer-use)/i.test(text);
}

function blended(inPrice: number, outPrice: number): number {
  // Only used to pick the cheapest duplicate entry in the community list.
  return inPrice * 0.85 + outPrice * 0.15;
}

/** Known price of a model: bundled seed first, then the refreshed community list (USD only). */
function knownPrice(model: Pick<ModelCandidate, 'provider' | 'id'>): Price | null {
  const key = normalizeModelId(model.id);
  const seed = loadBundled().models.find((m) => m.provider === model.provider && normalizeModelId(m.model) === key);
  if (seed) return { in: seed.in, out: seed.out };
  if (providerUnit(model.provider) !== 'usd') return null;
  return loadCommunity()?.prices[key] ?? null;
}

export interface CostEstimate {
  /** Expected cost of one call (usd: USD; relative: provider credits), effort included. */
  cost: number;
  unit: 'usd' | 'relative';
  /** False when the price is a guess from the model's name or description. */
  known: boolean;
  tier: Tier;
}

export function estimateCost(model: ModelCandidate): CostEstimate {
  const tier = tierHint(model);
  const unit = providerUnit(model.provider);
  let price = knownPrice(model);
  const known = price !== null;
  if (!price && model.source === 'auto') {
    // Vendor auto-routing: cheap on average, never cheaper than a known cheap model.
    const small = HEURISTIC[unit].small;
    price = { in: small.in * 1.5, out: small.out * 1.5 };
  }
  price ??= HEURISTIC[unit][tier];
  const input = CLI_OVERHEAD_TOKENS[model.provider] + PROMPT_TOKENS;
  const output = ANSWER_TOKENS + effortTokens(model.effort);
  return { cost: (price.in * input + price.out * output) / 1_000_000, unit, known, tier };
}

/**
 * Measured cost of one call in USD: what the CLI reported (Claude Code), or its token usage priced
 * with the catalog (Codex). Null when neither is available or the price is unknown.
 */
export function callCostUsd(model: ModelCandidate, raw: Pick<LlmRawResult, 'costUsd' | 'usage'>): number | null {
  if (typeof raw.costUsd === 'number') return raw.costUsd;
  const usage = raw.usage;
  if (!usage || providerUnit(model.provider) !== 'usd') return null;
  const price = knownPrice(model);
  if (!price) return null;
  const cached = Math.min(usage.cachedInput, usage.input);
  // Cached input is billed at roughly a tenth of the input price.
  return (price.in * (usage.input - cached) + price.in * 0.1 * cached + price.out * usage.output) / 1_000_000;
}

/** Cheapest first; known prices before guesses at equal cost; small tier before others. */
export function rankModels(models: readonly ModelCandidate[]): { model: ModelCandidate; estimate: CostEstimate }[] {
  const tierOrder: Record<Tier, number> = { small: 0, medium: 1, large: 2 };
  return models
    .filter((m) => !isExcludedModel(m))
    .map((model) => ({ model, estimate: estimateCost(model) }))
    .sort(
      (a, b) =>
        (a.model.source === 'pinned' ? -1 : 0) - (b.model.source === 'pinned' ? -1 : 0) ||
        a.estimate.cost - b.estimate.cost ||
        Number(b.estimate.known) - Number(a.estimate.known) ||
        tierOrder[a.estimate.tier] - tierOrder[b.estimate.tier],
    );
}

/**
 * Refreshes USD prices from LiteLLM's public price list (runs in the background worker only).
 * Returns true when a refresh happened.
 */
export async function refreshCommunityPrices(maxAgeDays: number): Promise<boolean> {
  if (maxAgeDays <= 0 || process.env.DEVCTX_OFFLINE === '1') return false;
  const file = communityFile();
  const cached = readJson<CommunityCache | null>(file, null);
  if (cached && cached.norm === NORMALIZE_VERSION && Date.now() - Date.parse(cached.fetched_at) < maxAgeDays * 86_400_000) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(LITELLM_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, Record<string, unknown>>;
    const prices: CommunityCache['prices'] = {};
    for (const [id, info] of Object.entries(data)) {
      if (!info || typeof info !== 'object' || (info.mode && info.mode !== 'chat')) continue;
      const input = Number(info.input_cost_per_token);
      const output = Number(info.output_cost_per_token);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0) continue;
      const key = normalizeModelId(id);
      const entry = { in: input * 1_000_000, out: output * 1_000_000 };
      const existing = prices[key];
      if (!existing || blended(entry.in, entry.out) < blended(existing.in, existing.out)) prices[key] = entry;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fresh: CommunityCache = { fetched_at: new Date().toISOString(), source: LITELLM_URL, norm: NORMALIZE_VERSION, prices };
    writeJsonAtomic(file, fresh);
    community = fresh;
    return true;
  } catch {
    return false;
  }
}
