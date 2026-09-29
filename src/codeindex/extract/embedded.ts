import path from 'node:path';
import type { FileFacts, LangId } from '../facts.ts';
import { Builder } from './common.ts';
import { parseInto } from './index.ts';

/**
 * Vue, Svelte and Astro single-file components: each `<script>` block (and Astro frontmatter) is
 * parsed as JavaScript/TypeScript with the deep extractor, and the file becomes one component
 * symbol that owns the script's functions and renders the components its template uses.
 */

interface Block {
  code: string;
  /** 0-based line of the block's first code line in the file. */
  line: number;
  ts: boolean;
}

function lineAt(src: string, index: number): number {
  let n = 0;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function scriptBlocks(src: string, lang: LangId): { blocks: Block[]; template: string } {
  const blocks: Block[] = [];
  let template = src;
  if (lang === 'astro') {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
    if (fm?.[1] !== undefined) {
      blocks.push({ code: fm[1], line: 1, ts: true });
      template = template.replace(fm[0], '');
    }
  }
  for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    const code = m[2] ?? '';
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
    blocks.push({ code, line: lineAt(src, start), ts: /lang\s*=\s*["'](ts|tsx|typescript)["']/.test(attrs) || lang === 'astro' });
    template = template.replace(m[0], '');
  }
  template = template.replace(/<style\b[\s\S]*?<\/style>/g, '');
  return { blocks, template };
}

function componentName(file: string): string {
  const base = path.basename(file).replace(/\.(vue|svelte|astro)$/, '');
  return base
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join('');
}

const HTML_LIKE = /^(slot|template|component|transition|keep-alive|teleport|suspense|router-view|router-link|svelte:[\w-]+)$/;

export async function extractEmbedded(lang: LangId, src: string, file: string): Promise<FileFacts> {
  const b = new Builder(lang, src);
  const name = componentName(file) || 'Component';
  const lines = src.split('\n').length;
  const comp = b.sym({ startPosition: { row: 0 }, endPosition: { row: lines - 1 }, startIndex: 0, endIndex: 0 } as never, name, 'component', -1, {
    sig: `${lang} component ${name}`,
    exported: true,
  });
  b.f.exps.push(['default', name]);

  const { blocks, template } = scriptBlocks(src, lang);
  for (const block of blocks) {
    const sub = new Builder(lang, block.code);
    await parseInto(sub, block.ts ? 'typescript' : 'javascript', block.code, file);
    const base = b.f.syms.length;
    const shift = (i: number): number => (i >= 0 ? i + base : comp);
    for (const s of sub.f.syms) {
      // File-level functions of the script are the component's members.
      b.f.syms.push({ ...s, parent: s.parent >= 0 ? s.parent + base : s.kind === 'function' || s.kind === 'hook' ? comp : -1, line: s.line + block.line, end: s.end + block.line });
    }
    for (const r of sub.f.refs) b.f.refs.push({ ...r, from: shift(r.from), line: r.line + block.line });
    for (const v of sub.f.vars) b.f.vars.push({ ...v, scope: v.scope >= 0 ? v.scope + base : comp });
    b.f.imps.push(...sub.f.imps);
    for (const [exported, local] of sub.f.exps) if (exported !== 'default') b.f.exps.push([exported, local]);
  }

  // Components the template renders: `<UserCard>` and `<user-card>`.
  const seen = new Set<string>();
  for (const m of template.matchAll(/<([A-Z][\w]*(?:\.[A-Z]\w*)?|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g)) {
    const tag = m[1] ?? '';
    if (HTML_LIKE.test(tag)) continue;
    const pascal = tag.includes('-') ? tag.split('-').map((p) => p[0]?.toUpperCase() + p.slice(1)).join('') : tag.split('.').pop() ?? tag;
    const at = src.indexOf(m[0]);
    const key = `${pascal}:${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    b.ref(comp, pascal, 'render', lineAt(src, at >= 0 ? at : 0) + 1, tag.includes('.') ? `v:${tag.split('.')[0]}` : '');
  }
  return b.f;
}
