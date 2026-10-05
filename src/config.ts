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
    /** Where the previous session stopped, added once when a new session continues it (0: off). */
    handoff_budget_tokens: number;
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
  memory: {
    store_evidence_quote: boolean;
    proposed_ttl_days: number;
    personal: boolean;
    /**
     * Also send instructions without explicit markers ("앞으로", "항상", "말고") to the extractor,
     * in batches. Off: only explicitly marked prompts are considered.
     */
    implicit_rules: boolean;
  };
  code_index: {
    /** Built-in code index (symbols, call graph, text search), used by agents through the `devctx-code` skill. */
    enabled: boolean;
    /** Extra globs to leave out (generated code, fixtures); vendored and dependency dirs are always skipped. */
    exclude: string[];
    /** Larger source files are listed but not parsed (minified bundles, generated tables). */
    max_file_kb: number;
    /**
     * Pre-approve `.devctx/bin/devctx code …` in each tool's permission settings so agents run
     * the skill's commands without an approval prompt (repo files, plus per-machine files for
     * Copilot CLI and Kiro, which do not read permissions from a repository).
     */
    preapprove: boolean;
  };
  history: {
    /**
     * Hourly cap of summary calls for the prompt history, counted apart from `llm.max_calls_per_hour`
     * so a busy session never starves decision extraction. Whether history is recorded at all is
     * each developer's own switch (`devctx history on|off`), not a team setting.
     */
    max_calls_per_hour: number;
  };
}

export const DEFAULT_CONFIG: DevctxConfig = {
  version: 1,
  language: 'ko',
  targets: [...TOOL_IDS],
  git: { commit_mode: 'ride-along', auto_install_hooks: true },
  inject: { core_budget_tokens: 1500, scoped_budget_tokens: 800, prompt_budget_tokens: 600, session_budget_tokens: 400, handoff_budget_tokens: 300 },
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
  memory: { store_evidence_quote: true, proposed_ttl_days: 30, personal: true, implicit_rules: true },
  code_index: { enabled: true, exclude: [], max_file_kb: 512, preapprove: true },
  history: { max_calls_per_hour: 30 },
};

function globs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

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
  const code = obj(r.code_index);
  // `engine: off` is the setting of configs written before the index was built in.
  const enabled = code.engine === 'off' ? false : bool(code.enabled, d.code_index.enabled);
  const pinRaw = obj(llm.pin);
  const pin: Partial<Record<ToolId, string>> = {};
  for (const [k, v] of Object.entries(pinRaw)) if (isToolId(k) && typeof v === 'string' && v.trim()) pin[k] = v.trim();
  const commit = g.commit_mode;
  return {
    version: 1,
    language: r.language === 'en' ? 'en' : 'ko',
    targets: tools(r.targets, d.targets),
    git: {
      // A value that is present but unknown (a typo) means intent unknown: do not touch commits.
      commit_mode: commit === 'auto-commit' || commit === 'manual' || commit === 'ride-along' ? commit : commit === undefined ? 'ride-along' : 'manual',
      auto_install_hooks: bool(g.auto_install_hooks, d.git.auto_install_hooks),
    },
    inject: {
      core_budget_tokens: num(inj.core_budget_tokens, d.inject.core_budget_tokens, 100, 20_000),
      scoped_budget_tokens: num(inj.scoped_budget_tokens, d.inject.scoped_budget_tokens, 0, 20_000),
      prompt_budget_tokens: num(inj.prompt_budget_tokens, d.inject.prompt_budget_tokens, 0, 5_000),
      session_budget_tokens: num(inj.session_budget_tokens, d.inject.session_budget_tokens, 0, 5_000),
      handoff_budget_tokens: num(inj.handoff_budget_tokens, d.inject.handoff_budget_tokens, 0, 2_000),
    },
    llm: {
      prefer_host_tool: bool(llm.prefer_host_tool, d.llm.prefer_host_tool),
      // An explicit empty list turns LLM calls off (it does not mean "all of them").
      providers: Array.isArray(llm.providers) && llm.providers.length === 0 ? [] : tools(llm.providers, d.llm.providers),
      qualify: bool(llm.qualify, d.llm.qualify),
      qualify_runs: Math.round(num(llm.qualify_runs, d.llm.qualify_runs, 1, 5)),
      max_tier: llm.max_tier === 'small' || llm.max_tier === 'medium' ? llm.max_tier : 'large',
      max_calls_per_hour: num(llm.max_calls_per_hour, d.llm.max_calls_per_hour, 0, 1_000),
      timeout_seconds: num(llm.timeout_seconds, d.llm.timeout_seconds, 10, 900),
      pricing_refresh_days: num(llm.pricing_refresh_days, d.llm.pricing_refresh_days, 0, 365),
      pin,
    },
    memory: {
      store_evidence_quote: bool(mem.store_evidence_quote, d.memory.store_evidence_quote),
      proposed_ttl_days: num(mem.proposed_ttl_days, d.memory.proposed_ttl_days, 1, 3_650),
      personal: bool(mem.personal, d.memory.personal),
      implicit_rules: bool(mem.implicit_rules, d.memory.implicit_rules),
    },
    code_index: {
      enabled,
      exclude: globs(code.exclude),
      max_file_kb: num(code.max_file_kb, d.code_index.max_file_kb, 16, 16_384),
      preapprove: bool(code.preapprove, d.code_index.preapprove),
    },
    history: {
      max_calls_per_hour: num(obj(r.history).max_calls_per_hour, d.history.max_calls_per_hour, 0, 1_000),
    },
  };
}

export function loadConfig(paths: ProjectPaths): DevctxConfig {
  const text = readText(paths.config);
  if (text === null) return normalizeConfig({});
  try {
    return normalizeConfig(parse(text));
  } catch {
    // Unreadable YAML: defaults, but nothing that changes the repository on its own (no staging
    // at commit, no commits). `devctx doctor` reports the parse error.
    const cfg = normalizeConfig({});
    cfg.git.commit_mode = 'manual';
    return cfg;
  }
}

/**
 * What is wrong with `.devctx/config.yaml`: a YAML error (devctx then runs with defaults and
 * `commit_mode: manual`) or values that are not allowed (the default is used for those).
 */
export function configProblems(paths: ProjectPaths): string[] {
  const text = readText(paths.config);
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return [`config.yaml is not valid YAML (${(error as Error).message.split('\n')[0]}); running with defaults and commit_mode: manual`];
  }
  const r = obj(raw);
  const out: string[] = [];
  const check = (where: string, value: unknown, allowed: readonly string[]): void => {
    if (value !== undefined && !(typeof value === 'string' && allowed.includes(value))) {
      out.push(`${where}: ${JSON.stringify(value)} is not one of ${allowed.join(' | ')}; the default is used`);
    }
  };
  check('language', r.language, ['ko', 'en']);
  const commit = obj(r.git).commit_mode;
  if (commit !== undefined && !(typeof commit === 'string' && ['ride-along', 'auto-commit', 'manual'].includes(commit))) {
    out.push(`git.commit_mode: ${JSON.stringify(commit)} is not one of ride-along | auto-commit | manual; manual is used until it is fixed`);
  }
  check('llm.max_tier', obj(r.llm).max_tier, ['small', 'medium', 'large']);
  for (const [where, value] of [['targets', r.targets], ['llm.providers', obj(r.llm).providers]] as const) {
    if (value === undefined) continue;
    const bad = Array.isArray(value) ? value.filter((v) => !isToolId(v)) : [value];
    if (bad.length > 0) out.push(`${where}: unknown tool(s) ${bad.map((v) => JSON.stringify(v)).join(', ')} (allowed: ${TOOL_IDS.join(', ')})`);
  }
  return out;
}

export function renderConfigYaml(targets: ToolId[], language: Language, codeIndex = true): string {
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
  core_budget_tokens: 1500    # 세션 시작 때 붙이는 항상 따를 규칙 상한
  scoped_budget_tokens: 800   # 경로별 규칙이 이 이하면 세션 시작 블록에 함께 넣고, 넘으면 도구별 경로 규칙 파일로
  prompt_budget_tokens: 600   # 프롬프트마다 hook으로 추가하는 관련 결정 상한
  session_budget_tokens: 400  # 세션 시작 시 추가하는 개인 설정·충돌 안내 상한
  handoff_budget_tokens: 300  # 새 세션이 직전 작업을 이어갈 때 한 번 붙이는 직전 세션 정보 상한 (0이면 끔)

llm:
  prefer_host_tool: true      # 작업 중인 도구의 CLI로 추출한다 (없으면 providers 순서)
  providers: [claude, codex, copilot, cursor, kiro]   # []이면 LLM을 부르지 않는다
  qualify: true               # 작업(추출/판정)별 요구사항 평가를 전부 통과한 모델 중 가장 싼 것만 사용
  qualify_runs: 2             # 평가를 몇 번 반복해 한 번도 틀리지 않아야 통과로 볼지
  max_tier: large             # 자동으로 고를 수 있는 가장 큰 모델 등급: small | medium | large
  max_calls_per_hour: 30      # 결정 추출·판정 호출 상한. 0이면 부르지 않는다(명시 표현만 확인 대기로 남김)
  timeout_seconds: 120
  pricing_refresh_days: 7     # 공개 가격표 갱신 주기. 0이면 번들 가격표만 사용
  pin: {}                     # 특정 모델 고정. 예: { codex: gpt-6-luna }

memory:
  store_evidence_quote: true  # 사용자 발화 일부(200자 이하)를 근거로 저장
  proposed_ttl_days: 30       # 재확인 없는 제안 항목의 보존 기간
  personal: true              # 개인 선호는 저장소 밖(~/.local/share/devctx)에 저장
  implicit_rules: true        # "앞으로" 같은 표현이 없는 지시도 LLM이 판단 (5개씩 묶어서). false면 명시 표현만

code_index:
  enabled: ${String(codeIndex).padEnd(19)}# 내장 코드 인덱스(심볼·호출 관계·텍스트 검색)를 스킬 devctx-code로 제공
  exclude: []                 # 색인에서 뺄 경로 glob. 예: ["**/generated/**", "fixtures/**"]
  max_file_kb: 512            # 이보다 큰 소스 파일은 파싱하지 않는다 (번들·생성 코드)
  preapprove: true            # 도구별 권한 설정에 ".devctx/bin/devctx code" 실행을 미리 허용 (승인 창 없이 실행)

# 프롬프트 히스토리 (.devctx/history/). 켜고 끄는 것은 사람마다 따로: devctx history on|off
history:
  max_calls_per_hour: 30      # 작업 내용 요약 호출 상한 (결정 추출의 llm.max_calls_per_hour와 따로 센다). 0이면 요약 없이 AI 응답 앞부분을 쓴다
`;
}

/** Why LLM calls for a kind of work are off by configuration (null when they may run). */
export function llmOff(cfg: DevctxConfig, work: 'decisions' | 'history'): string | null {
  if (cfg.llm.providers.length === 0) return 'llm.providers: []';
  if (work === 'decisions' && cfg.llm.max_calls_per_hour === 0) return 'llm.max_calls_per_hour: 0';
  if (work === 'history' && cfg.history.max_calls_per_hour === 0) return 'history.max_calls_per_hour: 0';
  return null;
}
