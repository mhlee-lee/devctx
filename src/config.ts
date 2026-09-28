import { parse } from 'yaml';
import { readText } from './util/fsx.ts';
import type { ProjectPaths } from './util/paths.ts';
import type { Tier } from './llm/types.ts';
import { isToolId, TOOL_IDS, type Language, type ToolId } from './types.ts';

export type CommitMode = 'ride-along' | 'auto-commit' | 'manual';

export interface DevctxConfig {
  version: number;
  language: Language;
  targets: ToolId[];
  git: { commit_mode: CommitMode; auto_install_hooks: boolean };
  inject: {
    core_budget_tokens: number;
    scoped_budget_tokens: number;
    prompt_budget_tokens: number;
    session_budget_tokens: number;
  };
  llm: {
    prefer_host_tool: boolean;
    providers: ToolId[];
    qualify: boolean;
    /** Repetitions of the requirement suite a model must pass without a single miss. */
    qualify_runs: number;
    /** Largest model tier the router may pick automatically (it still tries cheaper ones first). */
    max_tier: Tier;
    max_calls_per_hour: number;
    timeout_seconds: number;
    pricing_refresh_days: number;
    pin: Partial<Record<ToolId, string>>;
  };
  memory: { store_evidence_quote: boolean; proposed_ttl_days: number; personal: boolean };
}

export const DEFAULT_CONFIG: DevctxConfig = {
  version: 1,
  language: 'ko',
  targets: [...TOOL_IDS],
  git: { commit_mode: 'ride-along', auto_install_hooks: true },
  inject: { core_budget_tokens: 1500, scoped_budget_tokens: 800, prompt_budget_tokens: 600, session_budget_tokens: 400 },
  llm: {
    prefer_host_tool: true,
    providers: [...TOOL_IDS],
    qualify: true,
    qualify_runs: 2,
    max_tier: 'large',
    max_calls_per_hour: 30,
    timeout_seconds: 120,
    pricing_refresh_days: 7,
    pin: {},
  },
  memory: { store_evidence_quote: true, proposed_ttl_days: 30, personal: true },
};

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function tools(value: unknown, fallback: ToolId[]): ToolId[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter(isToolId);
  return out.length > 0 ? [...new Set(out)] : fallback;
}

export function normalizeConfig(raw: unknown): DevctxConfig {
  const r = obj(raw);
  const d = DEFAULT_CONFIG;
  const g = obj(r.git);
  const inj = obj(r.inject);
  const llm = obj(r.llm);
  const mem = obj(r.memory);
  const pinRaw = obj(llm.pin);
  const pin: Partial<Record<ToolId, string>> = {};
  for (const [k, v] of Object.entries(pinRaw)) if (isToolId(k) && typeof v === 'string' && v.trim()) pin[k] = v.trim();
  const commit = g.commit_mode;
  return {
    version: 1,
    language: r.language === 'en' ? 'en' : 'ko',
    targets: tools(r.targets, d.targets),
    git: {
      commit_mode: commit === 'auto-commit' || commit === 'manual' ? commit : 'ride-along',
      auto_install_hooks: bool(g.auto_install_hooks, d.git.auto_install_hooks),
    },
    inject: {
      core_budget_tokens: num(inj.core_budget_tokens, d.inject.core_budget_tokens, 100, 20_000),
      scoped_budget_tokens: num(inj.scoped_budget_tokens, d.inject.scoped_budget_tokens, 0, 20_000),
      prompt_budget_tokens: num(inj.prompt_budget_tokens, d.inject.prompt_budget_tokens, 0, 5_000),
      session_budget_tokens: num(inj.session_budget_tokens, d.inject.session_budget_tokens, 0, 5_000),
    },
    llm: {
      prefer_host_tool: bool(llm.prefer_host_tool, d.llm.prefer_host_tool),
      providers: tools(llm.providers, d.llm.providers),
      qualify: bool(llm.qualify, d.llm.qualify),
      qualify_runs: Math.round(num(llm.qualify_runs, d.llm.qualify_runs, 1, 5)),
      max_tier: llm.max_tier === 'small' || llm.max_tier === 'medium' ? llm.max_tier : 'large',
      max_calls_per_hour: num(llm.max_calls_per_hour, d.llm.max_calls_per_hour, 1, 1_000),
      timeout_seconds: num(llm.timeout_seconds, d.llm.timeout_seconds, 10, 900),
      pricing_refresh_days: num(llm.pricing_refresh_days, d.llm.pricing_refresh_days, 0, 365),
      pin,
    },
    memory: {
      store_evidence_quote: bool(mem.store_evidence_quote, d.memory.store_evidence_quote),
      proposed_ttl_days: num(mem.proposed_ttl_days, d.memory.proposed_ttl_days, 1, 3_650),
      personal: bool(mem.personal, d.memory.personal),
    },
  };
}

export function loadConfig(paths: ProjectPaths): DevctxConfig {
  const text = readText(paths.config);
  if (text === null) return normalizeConfig({});
  try {
    return normalizeConfig(parse(text));
  } catch {
    return normalizeConfig({});
  }
}

export function renderConfigYaml(targets: ToolId[], language: Language): string {
  const list = targets.map((t) => `  - ${t}`).join('\n');
  return `# devctx 설정. Git으로 공유된다.
version: 1
language: ${language}             # 생성 문서 언어: ko | en

# 결정을 전달하고 hook을 설치할 도구
targets:
${list}

git:
  commit_mode: ride-along   # ride-along: 사용자 커밋에 함께 포함 | auto-commit: 세션 종료 시 별도 커밋 | manual
  auto_install_hooks: true  # 세션 시작 시 git hook이 없으면 자동으로 설치

inject:
  core_budget_tokens: 1500    # AGENTS.md 핵심 규칙 상한
  scoped_budget_tokens: 800   # 경로별 규칙이 이 이하면 AGENTS.md에 함께 둔다
  prompt_budget_tokens: 600   # 프롬프트마다 hook으로 추가하는 관련 결정 상한
  session_budget_tokens: 400  # 세션 시작 시 추가하는 개인 설정·충돌 안내 상한

llm:
  prefer_host_tool: true      # 작업 중인 도구의 CLI로 추출한다 (없으면 providers 순서)
  providers: [claude, codex, copilot, cursor, kiro]
  qualify: true               # 작업(추출/판정)별 요구사항 평가를 전부 통과한 모델 중 가장 싼 것만 사용
  qualify_runs: 2             # 평가를 몇 번 반복해 한 번도 틀리지 않아야 통과로 볼지
  max_tier: large             # 자동으로 고를 수 있는 가장 큰 모델 등급: small | medium | large
  max_calls_per_hour: 30
  timeout_seconds: 120
  pricing_refresh_days: 7     # 공개 가격표 갱신 주기. 0이면 번들 가격표만 사용
  pin: {}                     # 특정 모델 고정. 예: { codex: gpt-6-luna }

memory:
  store_evidence_quote: true  # 사용자 발화 일부(200자 이하)를 근거로 저장
  proposed_ttl_days: 30       # 재확인 없는 제안 항목의 보존 기간
  personal: true              # 개인 선호는 저장소 밖(~/.local/share/devctx)에 저장
`;
}
