import type { DevctxConfig } from '../config.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import type { Language, ToolId } from '../types.ts';
import { sha256 } from '../util/fsx.ts';
import { slugify } from '../util/text.ts';
import { itemLine, type TierPlan } from './tiers.ts';

/** Marks files devctx builds on each PC from `.devctx/knowledge/` (never committed). */
export const GENERATED_MARKER = 'devctx:generated';

/** The block devctx keeps in AGENTS.md. Everything outside it belongs to the people. */
export const AGENTS_BEGIN = '<!-- devctx:begin -->';
export const AGENTS_END = '<!-- devctx:end -->';

/** Where each PC writes the full list of rules in force (git-ignored). */
export const RULES_FILE = '.devctx/rules.md';

const T: Record<
  Language,
  {
    marker: string;
    title: string;
    core: string;
    scoped: string;
    onDemand: string;
    conflicts: string;
    rulesTitle: string;
    rulesLead: string;
    scopedDesc: string;
    block: string[];
  }
> = {
  ko: {
    marker: `<!-- ${GENERATED_MARKER}: .devctx/knowledge/의 결정 파일로 각 PC에서 만든다. Git에 올리지 않고 직접 고치지 않는다 -->`,
    title: '# 프로젝트 지침',
    core: '## 항상 따르는 규칙',
    scoped: '## 경로별 규칙',
    onDemand: '## 관련 작업일 때 따르는 규칙',
    conflicts: '## 충돌 중인 결정 (해당 범위를 고치기 전에 사용자에게 어느 쪽을 따를지 한 번 묻는다)',
    rulesTitle: '# 프로젝트 결정 (devctx)',
    rulesLead: '지금 유효한 프로젝트 결정이다. 대체되거나 기한이 지난 결정은 빠져 있다.',
    scopedDesc: 'devctx 경로별 규칙',
    block: [
      '## 프로젝트 결정 (devctx)',
      '- 이 저장소의 프로젝트 결정은 AI 도구의 hook이 세션을 시작할 때 "[devctx] 프로젝트 규칙" 블록으로 전달한다. 그 블록을 받았으면 그대로 따른다.',
      '- 받지 못했다면 작업 전에 `.devctx/rules.md`를 읽고 따른다. 그 파일도 없으면 `.devctx/knowledge/decisions/`의 결정 파일을 읽는다. 다른 결정 파일의 `supersedes`에 적힌 결정은 대체된 것이고, `valid_until`이 지난 결정은 끝난 것이다.',
      '- 세션 중에 새로 정해진 결정은 대화에 덧붙여 전달된다. 사용자가 규칙을 바꾸면 최신 지시를 따른다.',
    ],
  },
  en: {
    marker: `<!-- ${GENERATED_MARKER}: built on each PC from the decision files in .devctx/knowledge/. Not committed; do not edit -->`,
    title: '# Project instructions',
    core: '## Rules that always apply',
    scoped: '## Path-specific rules',
    onDemand: '## Rules for related work',
    conflicts: '## Conflicting decisions (ask the user once which one to follow before changing that area)',
    rulesTitle: '# Project decisions (devctx)',
    rulesLead: 'The project decisions in force. Replaced and expired decisions are left out.',
    scopedDesc: 'devctx path-specific rules',
    block: [
      '## Project decisions (devctx)',
      '- The AI tool hooks deliver this repository\'s project decisions at session start as a "[devctx] Project rules" block. When you received it, follow it.',
      '- If you did not, read `.devctx/rules.md` before working and follow it. If that file is missing too, read the decision files in `.devctx/knowledge/decisions/`: a decision named in another file\'s `supersedes` was replaced, and one past its `valid_until` has ended.',
      '- Decisions made during the session are added to the conversation. When the user changes a rule, follow the latest instruction.',
    ],
  },
};

/** Short, static guidance so agents query the code index before grepping and reading files. */
function codeIndexSection(lang: Language): string[] {
  if (lang === 'ko') {
    return [
      '## 코드 탐색',
      '- 이 저장소에는 코드 인덱스가 있다 (스킬 `devctx-code`). 파일을 grep·read로 훑기 전에 저장소 루트에서 `.devctx/bin/devctx code <도구> <인자>`를 먼저 실행한다. 명령은 하나씩, 파이프 없이 실행한다.',
      '- 심볼 찾기 `search_symbols`, 정의·사용처·코드 `get_symbol`, 호출 관계 `trace_calls`, 파일 구조 `file_outline`, 전체 구조 `repo_overview`, 변경 영향 `change_impact`, 텍스트 검색 `search_text`.',
      '- `(by name)`으로 표시된 연결은 이름만 보고 이은 것이다. 중요한 수정 전에는 코드를 직접 확인한다. 명령을 쓸 수 없으면 평소처럼 파일을 읽는다.',
    ];
  }
  return [
    '## Code navigation',
    '- This repository has a code index (skill `devctx-code`). Before grepping or reading files, run `.devctx/bin/devctx code <tool> <args>` from the repository root, one command at a time and without pipes.',
    '- Find symbols `search_symbols`, definition/usages/code `get_symbol`, call graph `trace_calls`, file structure `file_outline`, architecture `repo_overview`, impact of the diff `change_impact`, text search `search_text`.',
    '- Links marked `(by name)` were matched by name only; check the code before relying on them. If the command is unavailable, read files as usual.',
  ];
}

/**
 * devctx's block in AGENTS.md: where the decisions come from, never the decisions themselves.
 * It depends only on the language and whether the code index is on, so recording, replacing or
 * merging decisions never changes AGENTS.md (tools that send it with every request keep their
 * prompt cache, and server-side merges have nothing to merge).
 */
export function renderAgentsBlock(lang: Language, codeIndex: boolean): string {
  const lines = [AGENTS_BEGIN, ...T[lang].block];
  if (codeIndex) lines.push('', ...codeIndexSection(lang));
  lines.push(AGENTS_END);
  return lines.join('\n');
}

/** AGENTS.md written by devctx before the block existed (the whole file was generated). */
export function isLegacyAgentsMd(text: string | null): boolean {
  return text !== null && text.includes(GENERATED_MARKER) && !text.includes(AGENTS_BEGIN);
}

export function hasAgentsBlock(text: string | null): boolean {
  return text !== null && text.includes(AGENTS_BEGIN) && text.indexOf(AGENTS_END) > text.indexOf(AGENTS_BEGIN);
}

/**
 * `text` with devctx's block set to `block`: replaced in place when present, otherwise appended
 * (or a new file with a title). The rest of the file is left exactly as it was.
 */
export function withAgentsBlock(text: string | null, block: string, lang: Language): string {
  if (text !== null && hasAgentsBlock(text)) {
    const start = text.indexOf(AGENTS_BEGIN);
    const end = text.indexOf(AGENTS_END, start) + AGENTS_END.length;
    return `${text.slice(0, start)}${block}${text.slice(end)}`;
  }
  const body = (text ?? '').replace(/\s*$/, '');
  return `${body || T[lang].title}\n\n${block}\n`;
}

/**
 * AGENTS.md without devctx's block. Null when nothing of the people's is left (only the title
 * init put on a file it created), so uninstall removes the file instead of leaving a heading.
 */
export function withoutAgentsBlock(text: string): string | null {
  if (!hasAgentsBlock(text)) return text;
  const start = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END, start) + AGENTS_END.length;
  const rest = `${text.slice(0, start)}${text.slice(end)}`.replace(/\n{3,}/g, '\n\n').trim();
  if (!rest || Object.values(T).some((l) => rest === l.title)) return null;
  return `${rest}\n`;
}

/**
 * `.devctx/rules.md`: every rule in force for agents that did not get the session-start block.
 * Built on each PC and never committed, so a server-side merge has no generated file to get wrong.
 */
export function renderRulesMd(plan: TierPlan, conflicts: readonly KnowledgeItem[], lang: Language): string {
  const t = T[lang];
  const lines = [t.marker, t.rulesTitle, '', t.rulesLead];
  const section = (title: string, items: readonly KnowledgeItem[], withScope: boolean): void => {
    if (items.length > 0) lines.push('', title, ...items.map((i) => itemLine(i, lang, withScope)));
  };
  section(t.core, plan.core, false);
  section(t.scoped, plan.scoped, true);
  section(t.onDemand, plan.onDemand, true);
  section(t.conflicts, [...conflicts].sort((a, b) => (a.id < b.id ? -1 : 1)), true);
  return `${lines.join('\n')}\n`;
}

/** The rules a session starts with: the always-apply rules, and path rules when they are few. */
export function sessionRuleLines(plan: TierPlan, lang: Language): { id: string; line: string }[] {
  return [
    ...plan.core.map((i) => ({ id: i.id, line: itemLine(i, lang, false) })),
    ...(plan.scopedInAgents ? plan.scoped.map((i) => ({ id: i.id, line: itemLine(i, lang, true) })) : []),
  ];
}

interface ScopeGroup {
  globs: string[];
  items: KnowledgeItem[];
  slug: string;
}

export function groupByScope(items: readonly KnowledgeItem[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const item of items) {
    const globs = [...new Set(item.scope.paths)].sort();
    const key = globs.join('\n');
    let g = groups.get(key);
    if (!g) {
      const base = slugify(globs[0]?.replace(/\*+/g, ' ') ?? 'scope', 24, 'scope');
      g = { globs, items: [], slug: `${base}-${sha256(key).slice(0, 6)}` };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  return [...groups.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** Per-tool path-scoped rule files (only used when scoped rules do not fit in the session-start block). */
export function renderPathRules(plan: TierPlan, cfg: DevctxConfig, targets: readonly ToolId[]): Map<string, string> {
  const out = new Map<string, string>();
  if (plan.scopedInAgents || plan.scoped.length === 0) return out;
  const t = T[cfg.language];
  const lang = cfg.language;
  for (const g of groupByScope(plan.scoped)) {
    const body = `${t.marker}\n${g.items.map((i) => itemLine(i, lang, false)).join('\n')}\n`;
    if (targets.includes('copilot')) {
      out.set(
        `.github/instructions/devctx-${g.slug}.instructions.md`,
        `---\napplyTo: ${yamlString(g.globs.join(','))}\n---\n${body}`,
      );
    }
    if (targets.includes('cursor')) {
      out.set(
        `.cursor/rules/devctx-${g.slug}.mdc`,
        `---\ndescription: ${t.scopedDesc} (${g.globs.join(', ')})\nglobs: ${g.globs.join(',')}\nalwaysApply: false\n---\n${body}`,
      );
    }
    if (targets.includes('claude')) {
      out.set(
        `.claude/rules/devctx-${g.slug}.md`,
        `---\npaths:\n${g.globs.map((p) => `  - ${yamlString(p)}`).join('\n')}\n---\n${body}`,
      );
    }
    if (targets.includes('kiro')) {
      g.globs.forEach((glob, idx) => {
        const suffix = g.globs.length > 1 ? `-${idx + 1}` : '';
        out.set(
          `.kiro/steering/devctx-${g.slug}${suffix}.md`,
          `---\ninclusion: fileMatch\nfileMatchPattern: ${yamlString(glob)}\n---\n${body}`,
        );
      });
    }
  }
  return out;
}

/** Directories where devctx may create (and later delete) `devctx-*` rule files. */
export const PATH_RULE_DIRS = ['.github/instructions', '.cursor/rules', '.claude/rules', '.kiro/steering'];

export const CURSOR_ON_DEMAND_FILE = '.cursor/rules/devctx-on-demand.mdc';

const ON_DEMAND: Record<Language, { desc: (topics: string) => string; lead: string }> = {
  ko: {
    desc: (topics) => `devctx 프로젝트 결정 중 관련 작업일 때만 읽을 것. 주제: ${topics}`,
    lead: '아래 작업과 관련 있으면 따른다. 다른 지시와 부딪히면 사용자에게 확인한다.',
  },
  en: {
    desc: (topics) => `devctx project decisions to read only when the task is related. Topics: ${topics}`,
    lead: 'Follow these when the task relates to them. If one contradicts another instruction, ask the user.',
  },
};

/**
 * Rules not in the session-start block (on-demand, overflow, possibly outdated) for tools whose prompt
 * hook cannot add context. Cursor's agent reads the description and pulls the file in when the
 * task is related ("Apply Intelligently"); the other tools get these rules per prompt from the hook.
 */
export function renderOnDemandRules(plan: TierPlan, cfg: DevctxConfig, targets: readonly ToolId[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!targets.includes('cursor') || plan.onDemand.length === 0) return out;
  const t = T[cfg.language];
  const o = ON_DEMAND[cfg.language];
  const topics = [...new Set(plan.onDemand.flatMap((i) => i.scope.topics.length > 0 ? i.scope.topics : [i.title]))].slice(0, 20).join(', ');
  const body = plan.onDemand.map((i) => itemLine(i, cfg.language, true)).join('\n');
  out.set(CURSOR_ON_DEMAND_FILE, `---\ndescription: ${yamlString(o.desc(topics))}\nalwaysApply: false\n---\n${t.marker}\n${o.lead}\n\n${body}\n`);
  return out;
}
