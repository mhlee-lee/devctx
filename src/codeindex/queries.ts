import fs from 'node:fs';
import path from 'node:path';
import { isDeliverable } from '../compile/tiers.ts';
import { CodeToolError } from './tools-meta.ts';
import type { KnowledgeItem } from '../knowledge/types.ts';
import { git } from '../util/git.ts';
import { matchAny, matchGlob } from '../util/glob.ts';
import { CLASS_LIKE, isCommonName, qualifiedName, type Edge, type Graph, type Sym } from './graph.ts';
import { detectLanguages, familyOf, languageById, languageOf } from './languages.ts';

/**
 * Read-side of the code index. Every function returns compact text meant for an agent's context:
 * one line per hit with `path:line`, so the agent can read exactly the lines it needs.
 */

const MAX_SNIPPET_LINES = 160;

function loc(s: Sym): string {
  return s.end > s.line ? `${s.file.path}:${s.line}-${s.end}` : `${s.file.path}:${s.line}`;
}

function label(s: Sym): string {
  return `${s.kind} ${qualifiedName(s)}`;
}

function oneLine(s: Sym): string {
  const sig = s.sig && s.sig !== s.name ? `  ${s.sig}` : '';
  return `- ${label(s)}  ${loc(s)}${sig}`;
}

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:/\\]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function score(s: Sym, q: string, qTokens: string[]): number {
  const name = s.name.toLowerCase();
  const qn = qualifiedName(s).toLowerCase();
  const ql = q.toLowerCase();
  let base = 0;
  if (s.name === q || qualifiedName(s) === q) base = 110;
  else if (name === ql || qn === ql) base = 100;
  else if (qn.endsWith(`.${ql}`)) base = 90;
  else if (name.startsWith(ql)) base = 70;
  else if (name.includes(ql)) base = 50;
  else if (qn.includes(ql)) base = 40;
  else {
    // Words: the symbol's own name counts most, its enclosing types less, the file path least.
    const own = tokens(s.name);
    const outer = tokens(qualifiedName(s));
    const where = tokens(s.file.path);
    let hit = 0;
    for (const t of qTokens) {
      if (own.some((x) => x.startsWith(t))) hit += 1;
      else if (outer.some((x) => x.startsWith(t))) hit += 0.6;
      else if (where.some((x) => x.startsWith(t))) hit += 0.25;
    }
    if (hit === 0 || (qTokens.length > 1 && !qTokens.some((t) => own.some((x) => x.startsWith(t))))) return 0;
    base = 8 + (27 * hit) / qTokens.length;
  }
  // Types and public API first; heavily used symbols first among equals.
  if (CLASS_LIKE.has(s.kind)) base += 4;
  if (s.exported) base += 2;
  base += Math.min(6, Math.log2(1 + s.in.length));
  if (/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.|_test\./.test(s.file.path)) base -= 5;
  return base;
}

export interface SearchOptions {
  kind?: string;
  path?: string;
  limit?: number;
}

export function searchSymbols(g: Graph, query: string, opts: SearchOptions = {}): string {
  const q = query.trim();
  if (!q) return 'Give a symbol name or words to search for.';
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const qTokens = tokens(q);
  const kinds = opts.kind ? new Set(opts.kind.split(/[,\s|]+/).filter(Boolean)) : null;
  const hits: { s: Sym; score: number }[] = [];
  for (const s of g.syms) {
    if (kinds && !kinds.has(s.kind)) continue;
    if (opts.path && !pathMatches(s.file.path, opts.path)) continue;
    const sc = score(s, q, qTokens);
    if (sc > 0) hits.push({ s, score: sc });
  }
  hits.sort((a, b) => b.score - a.score || a.s.file.path.localeCompare(b.s.file.path) || a.s.line - b.s.line);
  if (hits.length === 0) return `No symbols match "${q}". Try search_text for strings, comments or config keys.`;
  const shown = hits.slice(0, limit);
  const more = hits.length > shown.length ? ` (showing ${shown.length} of ${hits.length}; narrow with kind or path)` : '';
  return [`${hits.length} symbol(s) for "${q}"${more}`, ...shown.map((h) => `${oneLine(h.s)}${h.s.in.length > 0 ? `  [${h.s.in.length} refs]` : ''}`)].join('\n');
}

function pathMatches(file: string, filter: string): boolean {
  const f = filter.replace(/^\.\//, '');
  return /[*?{[]/.test(f) ? matchGlob(file, f) : file === f || file.startsWith(f.endsWith('/') ? f : `${f}/`) || file.includes(f);
}

/** `name`, `Class.method`, `path/to/file.ext:line`, or `path#Qualified.name`. */
export function resolveTarget(g: Graph, target: string, file?: string): { sym: Sym | null; candidates: Sym[] } {
  const t = target.trim();
  const atLine = /^(.+?):(\d+)$/.exec(t);
  if (atLine?.[1] && atLine[2]) {
    const f = g.files.get(atLine[1].replace(/^\.\//, ''));
    const line = Number(atLine[2]);
    if (f) {
      const around = f.syms.filter((s) => s.line <= line && line <= Math.max(s.end, s.line)).sort((a, b) => a.end - a.line - (b.end - b.line));
      return { sym: around[0] ?? null, candidates: around };
    }
  }
  const hash = t.indexOf('#');
  const inFile = hash > 0 ? t.slice(0, hash) : file;
  const name = hash > 0 ? t.slice(hash + 1) : t;
  const pool = inFile ? (g.files.get(inFile.replace(/^\.\//, ''))?.syms ?? []) : g.syms;
  const lower = name.toLowerCase();
  let exact = pool.filter((s) => qualifiedName(s) === name || s.name === name);
  if (exact.length === 0) exact = pool.filter((s) => qualifiedName(s).toLowerCase() === lower || s.name.toLowerCase() === lower);
  if (exact.length === 0) exact = pool.filter((s) => qualifiedName(s).toLowerCase().endsWith(`.${lower}`));
  // Prefer definitions over prototypes, then the most referenced.
  exact.sort((a, b) => Number(a.sig.endsWith(';')) - Number(b.sig.endsWith(';')) || b.in.length - a.in.length);
  const first = exact[0];
  // One name (a prototype and its definition, partial classes) is one target; different names are ambiguous.
  const same = first !== undefined && exact.every((s) => qualifiedName(s) === qualifiedName(first));
  return { sym: same ? first : null, candidates: exact };
}

function ambiguous(target: string, candidates: Sym[]): string {
  if (candidates.length === 0) return `No symbol "${target}". Use search_symbols to find the right name.`;
  return [`"${target}" matches ${candidates.length} symbols; pass one of these as target:`, ...candidates.slice(0, 15).map((s) => `${oneLine(s)}  → target "${s.file.path}:${s.line}"`)].join('\n');
}

function edgeLine(e: Edge, side: 'from' | 'to'): string {
  const other = side === 'from' ? e.from : e.to;
  const where = `${e.file.path}:${e.line}`;
  const what = other ? `${label(other)}` : `(file level)`;
  const kind = e.kind === 'call' ? '' : ` ${e.kind}`;
  return `- ${what}${kind}  ${side === 'from' ? where : loc(e.to)}${e.weak ? '  (by name)' : ''}`;
}

function uniqueEdges(edges: Edge[], key: (e: Edge) => string): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = key(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function readLines(root: string, file: string, from: number, to: number): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const end = Math.min(to, lines.length, from + MAX_SNIPPET_LINES - 1);
  const out: string[] = [];
  const width = String(end).length;
  for (let i = from; i <= end; i++) out.push(`${String(i).padStart(width)} | ${lines[i - 1] ?? ''}`);
  if (to > end) out.push(`… ${to - end} more line(s); read ${file}:${end + 1}-${to} if needed`);
  return out;
}

export interface DecisionLink {
  items: readonly KnowledgeItem[];
}

/** Active team decisions whose path scope covers the file. */
function decisionsFor(items: readonly KnowledgeItem[], files: readonly string[]): KnowledgeItem[] {
  return items.filter((i) => isDeliverable(i) && i.scope.paths.length > 0 && files.some((f) => matchAny(f, i.scope.paths)));
}

function decisionLines(items: readonly KnowledgeItem[]): string[] {
  return items.slice(0, 8).map((i) => `- [${i.enforcement}] ${i.summary}  (${i.id})`);
}

export function getSymbol(g: Graph, root: string, target: string, opts: { file?: string; code?: boolean; decisions?: readonly KnowledgeItem[] } = {}): string {
  const { sym, candidates } = resolveTarget(g, target, opts.file);
  if (!sym) return ambiguous(target, candidates);
  const lang = languageById(sym.file.facts.lang);
  const out: string[] = [`${label(sym)}  ${loc(sym)}  (${lang?.label ?? sym.file.facts.lang})`];
  if (sym.sig) out.push(`signature: ${sym.sig}`);
  if (sym.doc) out.push(`doc: ${sym.doc}`);
  if (sym.bases.length > 0) out.push(`extends/implements: ${sym.bases.map((b) => `${qualifiedName(b)} (${loc(b)})`).join(', ')}`);
  if (sym.subs.length > 0) out.push(`subtypes: ${sym.subs.slice(0, 12).map((b) => `${qualifiedName(b)} (${loc(b)})`).join(', ')}${sym.subs.length > 12 ? ` +${sym.subs.length - 12}` : ''}`);
  if (sym.members && sym.members.size > 0) {
    const members = [...sym.members.values()].flat().sort((a, b) => a.line - b.line);
    out.push(`members (${members.length}):`, ...members.slice(0, 40).map((m) => `  - ${m.kind} ${m.name}  ${loc(m)}${m.sig ? `  ${m.sig}` : ''}`));
    if (members.length > 40) out.push(`  … ${members.length - 40} more`);
  }
  const callers = uniqueEdges(sym.in.filter((e) => e.kind !== 'inherit'), (e) => `${e.file.path}:${e.line}:${e.from?.id ?? -1}`);
  out.push(`referenced by (${callers.length}):`);
  out.push(...(callers.length > 0 ? callers.slice(0, 25).map((e) => `  ${edgeLine(e, 'from').slice(2)}`) : ['  (none found)']));
  if (callers.length > 25) out.push(`  … ${callers.length - 25} more; use trace_calls`);
  for (const base of overridden(g, sym)) {
    const via = uniqueEdges(base.in.filter((e) => e.kind !== 'inherit'), (e) => `${e.file.path}:${e.line}:${e.from?.id ?? -1}`);
    if (via.length === 0) continue;
    out.push(`referenced through ${label(base)} (${via.length}):`, ...via.slice(0, 15).map((e) => `  ${edgeLine(e, 'from').slice(2)}`));
    if (via.length > 15) out.push(`  … ${via.length - 15} more`);
  }
  const callees = uniqueEdges(sym.out.filter((e) => e.kind !== 'inherit'), (e) => String(e.to.id));
  if (callees.length > 0) out.push(`uses (${callees.length}):`, ...callees.slice(0, 25).map((e) => `  ${edgeLine(e, 'to').slice(2)}`));
  const related = decisionsFor(opts.decisions ?? [], [sym.file.path]);
  if (related.length > 0) out.push('team decisions for this file:', ...decisionLines(related).map((l) => `  ${l}`));
  if (opts.code !== false) out.push('code:', ...readLines(root, sym.file.path, sym.line, Math.max(sym.end, sym.line)));
  return out.join('\n');
}

/** Base-type declarations a method overrides or implements (`RealCall.execute` → `Call.execute`). */
function overridden(g: Graph, sym: Sym): Sym[] {
  const cls = sym.parent;
  if (!cls || CLASS_LIKE.has(sym.kind)) return [];
  const out: Sym[] = [];
  const seen = new Set<Sym>([cls]);
  const visit = (c: Sym): void => {
    for (const b of c.bases) {
      if (seen.has(b)) continue;
      seen.add(b);
      for (const m of b.members?.get(sym.name) ?? []) if (m !== sym) out.push(m);
      visit(b);
    }
  };
  visit(cls);
  return out;
}

export function traceCalls(g: Graph, target: string, opts: { direction?: string; depth?: number; file?: string } = {}): string {
  const { sym, candidates } = resolveTarget(g, target, opts.file);
  if (!sym) return ambiguous(target, candidates);
  const depth = Math.min(Math.max(opts.depth ?? 2, 1), 5);
  const dir = opts.direction === 'callees' || opts.direction === 'out' ? 'out' : opts.direction === 'both' ? 'both' : 'in';
  const out: string[] = [`${label(sym)}  ${loc(sym)}`];
  let budget = 120;
  const walk = (s: Sym, level: number, way: 'in' | 'out', seen: Set<number>): void => {
    if (level > depth || budget <= 0) return;
    const edges = way === 'in' ? s.in : s.out;
    const next = uniqueEdges(
      edges.filter((e) => e.kind !== 'inherit'),
      (e) => (way === 'in' ? `${e.from?.id ?? `f:${e.file.path}`}` : String(e.to.id)),
    );
    for (const e of next) {
      if (budget-- <= 0) {
        out.push(`${'  '.repeat(level)}… (truncated)`);
        return;
      }
      const other = way === 'in' ? e.from : e.to;
      const where = way === 'in' ? `${e.file.path}:${e.line}` : loc(e.to);
      out.push(`${'  '.repeat(level)}${way === 'in' ? '←' : '→'} ${other ? label(other) : `(file level ${e.file.path})`}  ${where}${e.weak ? '  (by name)' : ''}`);
      if (other && !seen.has(other.id)) {
        seen.add(other.id);
        walk(other, level + 1, way, seen);
      }
    }
  };
  if (dir === 'in' || dir === 'both') {
    out.push('callers:');
    const bases = overridden(g, sym);
    const direct = sym.in.filter((e) => e.kind !== 'inherit').length;
    const through = bases.reduce((n, b) => n + b.in.filter((e) => e.kind !== 'inherit').length, 0);
    if (direct === 0 && through === 0) out.push('  (none found; dynamic dispatch, reflection or framework calls may exist, check search_text)');
    const seen = new Set([sym.id]);
    walk(sym, 1, 'in', seen);
    for (const b of bases) {
      if (b.in.filter((e) => e.kind !== 'inherit').length === 0) continue;
      out.push(`  (through ${label(b)}  ${loc(b)})`);
      walk(b, 1, 'in', seen);
    }
  }
  if (dir === 'out' || dir === 'both') {
    out.push('callees:');
    walk(sym, 1, 'out', new Set([sym.id]));
  }
  // Interface methods are reached through their implementations too.
  const cls = sym.parent;
  if (cls && (cls.kind === 'interface' || cls.subs.length > 0)) {
    const impls = cls.subs.flatMap((sub) => sub.members?.get(sym.name) ?? []);
    if (impls.length > 0) out.push('implementations:', ...impls.slice(0, 15).map((m) => `  - ${label(m)}  ${loc(m)}`));
  }
  return out.join('\n');
}

export function fileOutline(g: Graph, file: string): string {
  const rel = file.replace(/^\.\//, '');
  const f = g.files.get(rel) ?? [...g.files.values()].find((x) => x.path.endsWith(`/${rel}`));
  if (!f) return `No indexed file "${file}". Paths are relative to the repository root.`;
  const lang = languageById(f.facts.lang);
  const out: string[] = [`${f.path}  (${lang?.label ?? f.facts.lang}${f.facts.pkg ? `, ${f.facts.pkg}` : ''})`];
  // `use crate::pricing;` is recorded both as a module and as a name; show it once.
  const modules = f.facts.imps.filter((i) => i.kind === 'module').map((i) => i.module);
  const imports = [
    ...new Set(
      f.facts.imps
        .filter((i) => !(i.kind === 'named' && modules.some((m) => i.name && m.endsWith(i.name) && m.length > i.name.length)))
        .map((i) => (i.name && i.kind !== 'module' ? `${i.module}:${i.name}` : i.module))
        .filter(Boolean),
    ),
  ];
  if (imports.length > 0) out.push(`imports: ${imports.slice(0, 30).join(', ')}${imports.length > 30 ? ` +${imports.length - 30}` : ''}`);
  // Nest a member under its type only where the type's body contains it; members declared
  // elsewhere (Rust `impl`, Go receivers, C++ `Foo::bar`, extensions) are written `Type.member`.
  const contains = (p: Sym, s: Sym): boolean => p.file === s.file && p.line <= s.line && s.end <= Math.max(p.end, p.line);
  const depth = (s: Sym): number => {
    let d = 0;
    for (let p = s.parent; p && contains(p, s); p = p.parent) d++;
    return d;
  };
  const syms = [...f.syms].sort((a, b) => a.line - b.line);
  for (const s of syms) {
    const prefix = s.parent && !contains(s.parent, s) ? `${qualifiedName(s.parent)}.` : '';
    out.push(`${'  '.repeat(depth(s))}- ${s.kind} ${prefix}${s.name}  :${s.line}${s.end > s.line ? `-${s.end}` : ''}${s.sig && s.sig !== s.name ? `  ${s.sig}` : ''}`);
  }
  if (syms.length === 0) out.push('(no symbols)');
  return out.join('\n');
}

export function overview(g: Graph, allFiles: readonly string[], opts: { path?: string } = {}): string {
  const scoped = opts.path ? allFiles.filter((f) => pathMatches(f, opts.path as string)) : allFiles;
  const langs = detectLanguages(scoped);
  const out: string[] = [`${scoped.length} files${opts.path ? ` under ${opts.path}` : ''}; ${g.syms.length} symbols indexed in ${g.files.size} source files`];
  if (langs.length > 0) out.push(`languages: ${langs.map((l) => `${l.label} ${l.files}`).join(', ')}`);
  const dirs = new Map<string, number>();
  for (const f of g.files.values()) {
    if (opts.path && !pathMatches(f.path, opts.path)) continue;
    const parts = f.path.split('/');
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? (parts[0] as string) : '.';
    dirs.set(key, (dirs.get(key) ?? 0) + f.syms.length);
  }
  const topDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topDirs.length > 0) out.push('main directories (symbols):', ...topDirs.map(([d, n]) => `  - ${d}/  ${n}`));
  const inScope = g.syms.filter((s) => !opts.path || pathMatches(s.file.path, opts.path));
  const hubs = inScope
    .filter((s) => s.in.length > 0)
    .sort((a, b) => b.in.length - a.in.length)
    .slice(0, 15);
  if (hubs.length > 0) out.push('most referenced:', ...hubs.map((s) => `  - ${label(s)}  ${loc(s)}  [${s.in.length} refs]`));
  const entries = inScope.filter((s) => /^(main|Main|run|start|serve|handler|app)$/.test(s.name) && s.in.length === 0).slice(0, 10);
  if (entries.length > 0) out.push('entry points:', ...entries.map((s) => `  - ${label(s)}  ${loc(s)}`));
  const roots = inScope.filter((s) => CLASS_LIKE.has(s.kind) && s.subs.length >= 2).sort((a, b) => b.subs.length - a.subs.length).slice(0, 10);
  if (roots.length > 0) out.push('type hierarchies:', ...roots.map((s) => `  - ${label(s)}  ${loc(s)}  ← ${s.subs.slice(0, 6).map((x) => x.name).join(', ')}${s.subs.length > 6 ? ` +${s.subs.length - 6}` : ''}`));
  return out.join('\n');
}

interface Hunk {
  file: string;
  from: number;
  to: number;
}

function diffHunks(root: string, base: string): { hunks: Hunk[]; files: string[]; deleted: string[]; error: string | null } {
  const args = base === 'staged' ? ['diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff'] : ['diff', base, '--unified=0', '--no-color', '--no-ext-diff'];
  const r = git(args, root, 20_000);
  if (!r.ok) return { hunks: [], files: [], deleted: [], error: r.stderr || 'git diff failed' };
  const hunks: Hunk[] = [];
  const files = new Set<string>();
  const deleted: string[] = [];
  let current = '';
  let previous = '';
  for (const line of r.stdout.split('\n')) {
    const a = /^--- a\/(.+)$/.exec(line);
    if (a?.[1]) {
      previous = a[1];
      continue;
    }
    if (line.startsWith('--- /dev/null')) {
      previous = '';
      continue;
    }
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f?.[1]) {
      current = f[1];
      files.add(current);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      // A deleted file: all of it changed (a stale index still has its symbols and callers).
      current = '';
      if (previous) {
        files.add(previous);
        deleted.push(previous);
        hunks.push({ file: previous, from: 1, to: Number.MAX_SAFE_INTEGER });
      }
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h?.[1] && current) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      hunks.push({ file: current, from: Math.max(1, start), to: Math.max(start, start + count - 1) });
    }
  }
  if (base !== 'staged') {
    const untracked = git(['ls-files', '--others', '--exclude-standard'], root, 10_000);
    for (const f of untracked.ok ? untracked.stdout.split('\n').filter(Boolean) : []) {
      files.add(f);
      hunks.push({ file: f, from: 1, to: Number.MAX_SAFE_INTEGER });
    }
  }
  return { hunks, files: [...files], deleted, error: null };
}

/** Symbols a deleted file declared (from its previous version), so their leftover uses can be found. */
export interface RemovedFile {
  path: string;
  family: string;
  names: string[];
}

/** Files reported as deleted against `base`. */
export function deletedFiles(root: string, base: string): string[] {
  const args = base === 'staged' ? ['diff', '--cached', '--name-only', '--diff-filter=D'] : ['diff', '--name-only', '--diff-filter=D', base];
  const r = git(args, root, 20_000);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

/**
 * Code that still names what only the deleted files declared (text match on whole words in files
 * of the same language family): likely broken references. The graph no longer has those symbols,
 * so this is a name match, labelled as such.
 */
function leftoverUses(g: Graph, root: string, removed: readonly RemovedFile[], deleted: ReadonlySet<string>): string[] {
  const byFamily = new Map<string, Set<string>>();
  for (const r of removed) {
    const set = byFamily.get(r.family) ?? new Set<string>();
    for (const n of r.names) if (n.length > 2 && /^[\w$]+$/.test(n) && !isCommonName(n) && !g.declares(r.family, n)) set.add(n);
    byFamily.set(r.family, set);
  }
  const names = [...new Set([...byFamily.values()].flatMap((s) => [...s]))].slice(0, 100);
  if (names.length === 0) return [];
  const r = git(['grep', '-n', '-I', '-w', '-F', '--untracked', '--exclude-standard', ...names.flatMap((n) => ['-e', n]), '--', '.', ':!.devctx'], root, 20_000);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!m?.[1] || deleted.has(m[1])) continue;
    const spec = languageOf(m[1]);
    const family = spec ? familyOf(spec.id) : null;
    const wanted = family ? byFamily.get(family) : undefined;
    const hit = wanted ? [...wanted].find((n) => new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(m[3] ?? '')) : undefined;
    if (!hit) continue;
    out.push(`  - ${m[1]}:${m[2]}  ${hit}  (by name)`);
    if (out.length >= 50) break;
  }
  return out;
}

export function changeImpact(
  g: Graph,
  root: string,
  opts: { base?: string; depth?: number; decisions?: readonly KnowledgeItem[]; removed?: readonly RemovedFile[] } = {},
): string {
  const base = opts.base?.trim() || 'HEAD';
  if (!/^[\w./~^@{}-]+$/.test(base)) throw new CodeToolError('--base must be a git revision (HEAD, main, origin/main, HEAD~3) or "staged"');
  const { hunks, files, deleted, error } = diffHunks(root, base);
  if (error) throw new CodeToolError(`git diff ${base} failed: ${error}`);
  if (files.length === 0) return `No changes against ${base}.`;
  const deletedSet = new Set(deleted);
  const changed = new Map<number, Sym>();
  for (const h of hunks) {
    const f = g.files.get(h.file);
    if (!f) continue;
    const touched = f.syms.filter((s) => s.line <= h.to && h.from <= Math.max(s.end, s.line));
    // The innermost symbol of each hunk (a method, not its whole class).
    const inner = touched.filter((s) => !touched.some((o) => o !== s && o.parent === s));
    for (const s of inner.length > 0 ? inner : touched) changed.set(s.id, s);
  }
  const depth = Math.min(Math.max(opts.depth ?? 2, 1), 4);
  const affected = new Map<number, { sym: Sym; level: number }>();
  let frontier = [...changed.values()];
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next: Sym[] = [];
    for (const s of frontier) {
      // Callers that go through an interface or base method reach this implementation too.
      const viaBase = s.parent ? s.parent.bases.flatMap((b) => g.memberOf(b, s.name)) : [];
      const targets = [s, ...viaBase];
      for (const t of targets) {
        for (const e of t.in) {
          const from = e.from;
          if (!from || changed.has(from.id) || affected.has(from.id)) continue;
          affected.set(from.id, { sym: from, level });
          next.push(from);
        }
      }
    }
    frontier = next;
  }
  const out: string[] = [`changes against ${base}: ${files.length} file(s)${deleted.length > 0 ? ` (${deleted.length} deleted)` : ''}, ${changed.size} symbol(s) touched`];
  out.push('changed files:', ...files.slice(0, 40).map((f) => `  - ${f}${deletedSet.has(f) ? '  (deleted)' : ''}`));
  if (files.length > 40) out.push(`  … ${files.length - 40} more`);
  if (changed.size > 0) out.push('changed symbols:', ...[...changed.values()].slice(0, 40).map((s) => `  - ${label(s)}  ${loc(s)}  [${s.in.length} refs]`));
  const leftover = opts.removed && opts.removed.length > 0 ? leftoverUses(g, root, opts.removed, deletedSet) : [];
  if (leftover.length > 0) out.push('still used after deletion (names only deleted files declared):', ...leftover);
  if (affected.size > 0) {
    const list = [...affected.values()].sort((a, b) => a.level - b.level);
    out.push(`possibly affected callers (${affected.size}, up to ${depth} hop(s)):`, ...list.slice(0, 50).map((a) => `  - ${'·'.repeat(a.level)} ${label(a.sym)}  ${loc(a.sym)}`));
    if (list.length > 50) out.push(`  … ${list.length - 50} more`);
    const testFiles = [...new Set(list.map((a) => a.sym.file.path).filter((p) => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.|_test\.|Test\.\w+$/.test(p)))];
    if (testFiles.length > 0) out.push('tests that reach the change:', ...testFiles.slice(0, 20).map((t) => `  - ${t}`));
  }
  const related = decisionsFor(opts.decisions ?? [], files);
  if (related.length > 0) out.push('team decisions that apply to the changed paths:', ...decisionLines(related).map((l) => `  ${l}`));
  return out.join('\n');
}

export function searchText(root: string, pattern: string, opts: { path?: string; regex?: boolean; limit?: number; ignoreCase?: boolean } = {}): string {
  const p = pattern;
  if (!p.trim()) return 'Give text to search for.';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 300);
  const args = ['grep', '-n', '-I', '--no-color', '--untracked', '--exclude-standard', '-e', p];
  if (!opts.regex) args.splice(2, 0, '-F');
  else args.splice(2, 0, '-E');
  if (opts.ignoreCase) args.splice(2, 0, '-i');
  args.push('--', ...(opts.path ? [opts.path] : ['.']), ':!.devctx/local');
  const r = git(args, root, 20_000);
  if (r.code === 1) return `No matches for "${p}".`;
  if (!r.ok) throw new CodeToolError(`search failed: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  const shown = lines.slice(0, limit).map((l) => (l.length > 240 ? `${l.slice(0, 239)}…` : l));
  return [`${lines.length} line(s) match "${p}"${lines.length > limit ? ` (showing ${limit})` : ''}`, ...shown].join('\n');
}
