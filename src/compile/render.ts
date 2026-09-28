import type { DevctxConfig } from '../config.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import type { Language, ToolId } from '../types.ts';
import { sha256 } from '../util/fsx.ts';
import { slugify } from '../util/text.ts';
import { itemLine, type TierPlan } from './tiers.ts';

export const GENERATED_MARKER = 'devctx:generated';

const T: Record<
  Language,
  { marker: string; title: string; core: string; scoped: string; records: string; recordsDir: string; latest: string; pathRules: string; scopedDesc: string }
> = {
  ko: {
    marker: `<!-- ${GENERATED_MARKER}: .devctx/knowledge/에서 자동 생성. 직접 고친 내용은 지식으로 옮겨진 뒤 다시 생성된다 -->`,
    title: '# 프로젝트 지침',
    core: '## 프로젝트 규칙',
    scoped: '## 경로별 규칙',
    records: '## 결정 기록',
    recordsDir: '- 전체 결정과 이유는 `.devctx/knowledge/`에 있다. 필요할 때만 읽는다.',
    latest: '- 사용자가 규칙을 바꾸면 최신 지시를 따른다. 기록은 자동으로 갱신된다.',
    pathRules: '- 경로별 규칙은 해당 파일을 다룰 때 도구별 규칙 파일로 적용된다.',
    scopedDesc: 'devctx 경로별 규칙',
  },
  en: {
    marker: `<!-- ${GENERATED_MARKER}: built from .devctx/knowledge/. Direct edits are imported into the knowledge base, then regenerated -->`,
    title: '# Project instructions',
    core: '## Project rules',
    scoped: '## Path-specific rules',
    records: '## Decision records',
    recordsDir: '- All decisions and their reasons live in `.devctx/knowledge/`. Read them only when needed.',
    latest: "- When the user changes a rule, follow the latest instruction. Records update automatically.",
    pathRules: '- Path-specific rules are applied through each tool\'s rule files when matching files are touched.',
    scopedDesc: 'devctx path-specific rules',
  },
};

export function renderAgentsMd(plan: TierPlan, cfg: DevctxConfig, preamble: string): string {
  const t = T[cfg.language];
  const lang = cfg.language;
  const lines: string[] = [t.marker];
  const pre = preamble.trim();
  if (pre) lines.push(pre);
  else lines.push(t.title);
  if (plan.core.length > 0) {
    lines.push('', t.core, ...plan.core.map((i) => itemLine(i, lang, false)));
  }
  if (plan.scopedInAgents && plan.scoped.length > 0) {
    lines.push('', t.scoped, ...plan.scoped.map((i) => itemLine(i, lang, true)));
  }
  lines.push('', t.records, t.recordsDir, t.latest);
  if (!plan.scopedInAgents && plan.scoped.length > 0) lines.push(t.pathRules);
  return `${lines.join('\n')}\n`;
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

/** Per-tool path-scoped rule files (only used when scoped rules do not fit in AGENTS.md). */
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
