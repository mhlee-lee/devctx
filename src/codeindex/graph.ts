import path from 'node:path';
import { decodeFacts, type FileFacts, type ImportFact, type RefFact, type RefKind, type SymbolKind, type VarFact } from './facts.ts';
import { familyOf, type Family } from './languages.ts';
import { normModule, pathCandidates, pathKeys, rulesFor, type LangRules } from './modules.ts';
import type { CodeStore } from './store.ts';
import type { ProjectInfo } from './sync.ts';

/**
 * In-memory code graph rebuilt from per-file facts. Resolution follows each language's own rules
 * (imports, packages, receiver types, inheritance) instead of matching names globally; a name
 * match without type evidence is kept only when it is unique and marked `weak`.
 */

export const CLASS_LIKE: ReadonlySet<SymbolKind> = new Set(['class', 'interface', 'enum', 'record', 'object', 'struct', 'type', 'module']);
const CALLABLE: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'constructor', 'component', 'hook', 'macro']);
/**
 * Families with a hand-written resolver below (Java/Kotlin/Scala/Groovy packages, JS/TS module
 * specifiers, Go packages, Python modules). Every other family goes through the generic resolver,
 * driven by the per-language rules in modules.ts.
 */
const DEEP_FAMILIES: ReadonlySet<Family> = new Set(['jvm', 'js', 'go', 'python']);

/** Standard-library method names: an unknown receiver calling one of these is not linked by name. */
const COMMON = new Set(
  (
    'get set add put remove delete push pop shift unshift map filter find findIndex forEach reduce some every includes indexOf ' +
    'join split slice splice concat keys values entries has clear size length toString valueOf equals hashCode compareTo ' +
    'then catch finally apply call bind log error warn info debug trace print println printf format sprintf append len cap ' +
    'close open read write flush next iterator stream collect toList of from subscribe pipe json text trim replace replaceAll ' +
    'match test exec sort reverse copy clone isEmpty isNotEmpty contains containsKey getOrDefault first last lower upper strip ' +
    'startswith endswith startsWith endsWith items update setdefault encode decode lock unlock wait notify sleep run Error New ' +
    'String Sprintf Println Printf Errorf Is As Unwrap invoke let also apply run with takeIf use forEachIndexed mapNotNull'
  ).split(' '),
);

export interface Edge {
  /** Calling symbol, or null for file-level code. */
  from: Sym | null;
  file: FileNode;
  to: Sym;
  kind: RefKind;
  line: number;
  /** Linked by a unique name only (no import or type evidence). */
  weak: boolean;
}

export interface Sym {
  id: number;
  file: FileNode;
  local: number;
  name: string;
  kind: SymbolKind;
  parent: Sym | null;
  line: number;
  end: number;
  sig: string;
  exported: boolean;
  returns: string;
  doc: string;
  /** Members of class-like symbols by name (Go methods and Kotlin companion members included). */
  members: Map<string, Sym[]> | null;
  bases: Sym[];
  subs: Sym[];
  out: Edge[];
  in: Edge[];
}

export interface FileNode {
  path: string;
  dir: string;
  facts: FileFacts;
  family: Family;
  syms: Sym[];
  /** File-level symbols by name (for Go: functions and types, not methods). */
  top: Map<string, Sym[]>;
  bindings: Map<string, ImportFact[]>;
  /** Typed variables: scope index (-1 file level) → name → fact; fields separately per class. */
  locals: Map<number, Map<string, VarFact>>;
  fields: Map<number, Map<string, VarFact>>;
  /** References made from file-level code. */
  out: Edge[];
  /** Module rules of the file's language (modules.ts). */
  rules: LangRules;
  /** Module names the file answers to (declared package first, then path-derived). */
  keys: string[];
  /** Included / sourced files, transitively where the language does that (resolved lazily). */
  incl: FileNode[] | null;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function qualifiedName(s: Sym): string {
  const parts: string[] = [s.name];
  for (let p = s.parent; p; p = p.parent) parts.unshift(p.name);
  return parts.join('.');
}

export function enclosingClass(s: Sym | null): Sym | null {
  for (let c = s; c; c = c.parent) if (CLASS_LIKE.has(c.kind)) return c;
  return null;
}

interface Resolved {
  syms: Sym[];
  weak: boolean;
}

const NONE: Resolved = { syms: [], weak: false };

/** Bump when the snapshot layout (not the resolution rules) changes. */
export const SNAPSHOT_VERSION = 1;

/**
 * Resolved graph in positional JSON, stored next to the facts so a query process skips
 * resolution (the expensive part: ~0.5 s on 3k files) and only rebuilds objects.
 */
export interface GraphSnapshot {
  v: number;
  gen: string;
  stats: { refs: number; resolved: number; weak: number };
  /** [path, lang, pkg, imports as [kind, module, name, alias]] */
  files: [string, string, string, [ImportFact['kind'], string, string, string][]][];
  /** [file index, local index, name, kind, parent id, line, end, sig, exported, returns, doc] */
  syms: [number, number, string, SymbolKind, number, number, number, string, number, string, string][];
  /** Flat 6-tuples in creation order: from id (-1 file level), file index, to id, kind index, line, weak. */
  edges: number[];
  /** Flat pairs in creation order: subtype id, supertype id. */
  bases: number[];
}

const EDGE_KINDS: readonly RefKind[] = ['call', 'new', 'render', 'inherit', 'type'];

export class Graph {
  readonly files = new Map<string, FileNode>();
  readonly syms: Sym[] = [];
  readonly generation: string;
  readonly stats = { refs: 0, resolved: 0, weak: 0 };
  /** Every edge and supertype link in creation order (what a snapshot replays). */
  private readonly edges: Edge[] = [];
  private readonly baseLinks: [Sym, Sym][] = [];
  private readonly byName = new Map<Family, Map<string, Sym[]>>();
  private readonly fqn = new Map<string, Sym[]>();
  private readonly packages = new Map<string, FileNode[]>();
  /** `${family}\0${dir}` → files (a Go package, a Terraform module, a file's neighbours). */
  private readonly dirs = new Map<string, FileNode[]>();
  /** `${family}\0${last segment of the file's module/package}` → files (`Pricing.sum` in OCaml, Erlang, Perl, ...). */
  private readonly modules = new Map<string, FileNode[]>();
  private readonly pyModules = new Map<string, FileNode[]>();
  /** Generic resolver: `${family}\0${namespace-qualified name}` → symbols (C#, C++, Ruby, Elixir, …). */
  private readonly qn = new Map<string, Sym[]>();
  /** Generic resolver: `${family}\0${module key}` → files (see modules.ts pathKeys). */
  private readonly mods = new Map<string, FileNode[]>();
  /** File name → files, for include specs relative to an include directory (`"pricing.h"`). */
  private readonly byBase = new Map<string, FileNode[]>();
  private readonly specCache = new Map<string, FileNode[]>();
  private readonly project: ProjectInfo;
  private readonly jsCache = new Map<string, FileNode | null>();

  constructor(entries: { path: string; facts: FileFacts }[], project: ProjectInfo, generation: string) {
    this.project = project;
    this.generation = generation;
    for (const e of entries) this.addFile(e.path, e.facts);
    this.attachGoMethods();
    this.indexQualified();
    this.resolveAll();
  }

  /** The resolved graph without the per-file facts it was built from. */
  snapshot(): GraphSnapshot {
    const fileIndex = new Map<FileNode, number>();
    const files: GraphSnapshot['files'] = [];
    for (const f of this.files.values()) {
      fileIndex.set(f, files.length);
      files.push([f.path, f.facts.lang, f.facts.pkg, f.facts.imps.map((i) => [i.kind, i.module, i.name, i.alias])]);
    }
    const syms: GraphSnapshot['syms'] = this.syms.map((s) => [
      fileIndex.get(s.file) ?? 0,
      s.local,
      s.name,
      s.kind,
      s.parent ? s.parent.id : -1,
      s.line,
      s.end,
      s.sig,
      s.exported ? 1 : 0,
      s.returns,
      s.doc,
    ]);
    const edges: number[] = [];
    for (const e of this.edges) edges.push(e.from ? e.from.id : -1, fileIndex.get(e.file) ?? 0, e.to.id, EDGE_KINDS.indexOf(e.kind), e.line, e.weak ? 1 : 0);
    const bases: number[] = [];
    for (const [sub, sup] of this.baseLinks) bases.push(sub.id, sup.id);
    return { v: SNAPSHOT_VERSION, gen: this.generation, stats: { ...this.stats }, files, syms, edges, bases };
  }

  /** Rebuilds a resolved graph from `snapshot()` output (no resolution runs). */
  static fromSnapshot(snap: GraphSnapshot): Graph | null {
    if (snap.v !== SNAPSHOT_VERSION) return null;
    const g = new Graph([], { tsconfigs: [], gomods: [], packages: [] }, snap.gen);
    Object.assign(g.stats, snap.stats);
    const files: FileNode[] = snap.files.map(([p, lang, pkg, imps]) => {
      const node: FileNode = {
        path: p,
        dir: path.posix.dirname(p),
        facts: { v: 0, lang, pkg, syms: [], refs: [], imps: imps.map(([kind, module, name, alias]) => ({ kind, module, name, alias })), vars: [], exps: [] },
        family: familyOf(lang),
        syms: [],
        top: new Map(),
        bindings: new Map(),
        locals: new Map(),
        fields: new Map(),
        out: [],
        rules: rulesFor(lang),
        keys: [],
        incl: null,
      };
      g.files.set(p, node);
      return node;
    });
    for (const [fi, local, name, kind, , line, end, sig, exported, returns, doc] of snap.syms) {
      const file = files[fi];
      if (!file) return null;
      const sym: Sym = {
        id: g.syms.length,
        file,
        local,
        name,
        kind,
        parent: null,
        line,
        end,
        sig,
        exported: exported === 1,
        returns,
        doc,
        members: CLASS_LIKE.has(kind) || kind === 'component' ? new Map() : null,
        bases: [],
        subs: [],
        out: [],
        in: [],
      };
      g.syms.push(sym);
      file.syms.push(sym);
    }
    snap.syms.forEach((row, id) => {
      const sym = g.syms[id];
      const parent = row[4] >= 0 ? g.syms[row[4]] : undefined;
      if (!sym || !parent) return;
      sym.parent = parent;
      if (parent.members) push(parent.members, sym.name, sym);
    });
    for (let i = 0; i + 1 < snap.bases.length; i += 2) {
      const sub = g.syms[snap.bases[i] as number];
      const sup = g.syms[snap.bases[i + 1] as number];
      if (!sub || !sup) continue;
      sub.bases.push(sup);
      sup.subs.push(sub);
      g.baseLinks.push([sub, sup]);
    }
    for (let i = 0; i + 5 < snap.edges.length; i += 6) {
      const e = snap.edges;
      const from = (e[i] as number) >= 0 ? (g.syms[e[i] as number] ?? null) : null;
      const file = files[e[i + 1] as number];
      const to = g.syms[e[i + 2] as number];
      if (!file || !to) continue;
      g.link(file, from, to, EDGE_KINDS[e[i + 3] as number] ?? 'call', e[i + 4] as number, e[i + 5] === 1);
    }
    return g;
  }

  static load(store: CodeStore): Graph {
    const entries: { path: string; facts: FileFacts }[] = [];
    for (const row of store.allFacts()) {
      const facts = decodeFacts(row.facts);
      if (facts) entries.push({ path: row.path, facts });
    }
    let project: ProjectInfo = { tsconfigs: [], gomods: [], packages: [] };
    try {
      project = { ...project, ...(JSON.parse(store.meta('project') ?? '{}') as Partial<ProjectInfo>) };
    } catch {
      // keep defaults
    }
    return new Graph(entries, project, store.meta('generation') ?? '0');
  }

  // ---- construction ---------------------------------------------------------------------------

  private addFile(rel: string, facts: FileFacts): void {
    const file: FileNode = {
      path: rel,
      dir: path.posix.dirname(rel),
      facts,
      family: familyOf(facts.lang),
      syms: [],
      top: new Map(),
      bindings: new Map(),
      locals: new Map(),
      fields: new Map(),
      out: [],
      rules: rulesFor(facts.lang),
      keys: [],
      incl: null,
    };
    this.files.set(rel, file);
    push(this.dirs, `${file.family}\0${file.dir}`, file);
    if (!DEEP_FAMILIES.has(file.family)) {
      const pkg = facts.pkg ? normModule(facts.pkg) : '';
      const pkgSuffixes = pkg ? pkg.split('.').map((_, i, a) => a.slice(i).join('.')) : [];
      file.keys = [...new Set([...pkgSuffixes, ...pathKeys(rel, facts.lang, file.rules)])];
      for (const key of file.keys) push(this.mods, `${file.family}\0${key}`, file);
      push(this.byBase, path.posix.basename(rel), file);
      if (pkg) push(this.modules, `${file.family}\0${pkgSuffixes[pkgSuffixes.length - 1] ?? pkg}`, file);
    }
    facts.syms.forEach((s, local) => {
      const sym: Sym = {
        id: this.syms.length,
        file,
        local,
        name: s.name,
        kind: s.kind,
        parent: null,
        line: s.line,
        end: s.end,
        sig: s.sig,
        exported: s.exported,
        returns: s.returns,
        doc: s.doc,
        members: CLASS_LIKE.has(s.kind) || s.kind === 'component' ? new Map() : null,
        bases: [],
        subs: [],
        out: [],
        in: [],
      };
      this.syms.push(sym);
      file.syms.push(sym);
    });
    facts.syms.forEach((s, local) => {
      const sym = file.syms[local];
      if (!sym) return;
      const parent = s.parent >= 0 ? file.syms[s.parent] : undefined;
      if (parent) {
        sym.parent = parent;
        if (parent.members) push(parent.members, sym.name, sym);
      } else if (!s.owner) push(file.top, sym.name, sym);
      if (!this.byName.has(file.family)) this.byName.set(file.family, new Map());
      push(this.byName.get(file.family) as Map<string, Sym[]>, sym.name, sym);
    });
    for (const imp of facts.imps) if (imp.alias) push(file.bindings, imp.alias, imp);
    for (const v of facts.vars) {
      const target = v.field ? file.fields : file.locals;
      let m = target.get(v.scope);
      if (!m) target.set(v.scope, (m = new Map()));
      if (!m.has(v.name)) m.set(v.name, v);
    }
    if (file.family === 'jvm') {
      if (facts.pkg) push(this.packages, facts.pkg, file);
      const addFqn = (sym: Sym, prefix: string): void => {
        const name = `${prefix}${sym.name}`;
        push(this.fqn, name, sym);
        for (const list of sym.members?.values() ?? []) for (const m of list) if (CLASS_LIKE.has(m.kind)) addFqn(m, `${name}.`);
      };
      for (const list of file.top.values()) for (const s of list) addFqn(s, facts.pkg ? `${facts.pkg}.` : '');
    } else if (file.family === 'python') {
      const segs = rel.replace(/\.pyi?$/, '').split('/');
      if (segs[segs.length - 1] === '__init__') segs.pop();
      for (let i = 0; i < segs.length; i++) push(this.pyModules, segs.slice(i).join('.'), file);
    }
  }

  /**
   * Methods declared outside their type (Go receivers, Rust `impl`, Swift `extension`, C++
   * `Foo::bar`, Lua `function M:bar`) join the type: same file, then same directory, then the
   * only type of that name in the language family.
   */
  private attachGoMethods(): void {
    for (const file of this.files.values()) {
      file.facts.syms.forEach((s, local) => {
        if (!s.owner) return;
        const sym = file.syms[local];
        const owner = this.ownerType(file, s.owner);
        if (!sym || !owner || owner === sym) return;
        sym.parent = owner;
        if (owner.members) push(owner.members, sym.name, sym);
      });
    }
  }

  private ownerType(file: FileNode, name: string): Sym | null {
    const classy = (list: Sym[] | undefined): Sym | undefined => list?.find((t) => CLASS_LIKE.has(t.kind) && t.members !== null);
    const own = classy(file.top.get(name));
    if (own) return own;
    const near = classy(this.dirTop(file, name));
    if (near) return near;
    // `double legacy::total(…)` in legacy.cpp: the namespace or class comes from an included header.
    if (!DEEP_FAMILIES.has(file.family)) {
      const inc = classy(this.included(file).flatMap((f) => f.top.get(name) ?? []));
      if (inc) return inc;
    }
    const all = this.familyNames(file.family, name).filter((t) => CLASS_LIKE.has(t.kind));
    return all.length === 1 ? (all[0] ?? null) : null;
  }

  /** File-level symbols named `name` in the directory of `file` (same language family). */
  private dirTop(file: FileNode, name: string): Sym[] {
    return this.goTop(`${file.family}\0${file.dir}`, name);
  }

  private goTop(key: string, name: string): Sym[] {
    const k = key.includes('\0') ? key : `go\0${key}`;
    const out: Sym[] = [];
    for (const f of this.dirs.get(k) ?? []) out.push(...(f.top.get(name) ?? []));
    return out;
  }

  // ---- generic resolver: the languages without a hand-written one (rules in modules.ts) ----------

  /** The namespace a file's symbols live in: its package declaration or path-derived module. */
  private pkgOf(file: FileNode): string {
    if (!file.rules.pkgPrefix) return '';
    if (file.facts.pkg) return normModule(file.facts.pkg);
    return file.rules.pathPkg ? (file.keys[0] ?? '') : '';
  }

  /** `Shop.Pricing.total`: the package prefix plus the enclosing symbols. */
  private qualified(s: Sym): string {
    const pkg = this.pkgOf(s.file);
    const own = normModule(qualifiedName(s));
    return pkg ? `${pkg}.${own}` : own;
  }

  private indexQualified(): void {
    for (const s of this.syms) {
      const f = s.file;
      if (DEEP_FAMILIES.has(f.family)) continue;
      push(this.qn, `${f.family}\0${this.qualified(s)}`, s);
      // Haskell class methods and Clojure protocol functions are called as plain module names.
      if (f.rules.topMembers && s.parent?.kind === 'interface') {
        const pkg = this.pkgOf(f);
        push(this.qn, `${f.family}\0${pkg ? `${pkg}.` : ''}${s.name}`, s);
      }
    }
  }

  private qnGet(family: Family, key: string): Sym[] {
    return this.qn.get(`${family}\0${key}`) ?? [];
  }

  /**
   * Namespaces a bare name is looked up in from `from`, innermost first: enclosing modules
   * (and classes, where members are reachable without `this`), the file's package, and for
   * C#/C++/Ruby-style nesting their parents.
   */
  private scopes(file: FileNode, from: Sym | null): string[] {
    const out: string[] = [];
    for (let c = enclosingClass(from); c; c = enclosingClass(c.parent)) {
      if (c.kind === 'module' || file.rules.implicitThis) out.push(this.qualified(c));
    }
    const pkg = this.pkgOf(file);
    if (pkg) out.push(pkg);
    // SQL: `FROM orders` inside `shop.report` means `shop.orders` first (the search path).
    if (file.rules.schemas && from && from.name.includes('.')) out.push(from.name.slice(0, from.name.lastIndexOf('.')));
    if (file.rules.pkgParents) {
      for (const s of [...out]) for (let p = s.lastIndexOf('.'); p > 0; p = s.lastIndexOf('.', p - 1)) out.push(s.slice(0, p));
    }
    return [...new Set(out.filter(Boolean))];
  }

  /** Normalized module name of an import spec (`crate::a::b` → `a.b`, Rust `self::`/`super::`). */
  private moduleKey(file: FileNode, spec: string): string {
    let key = normModule(spec);
    if (file.facts.lang === 'rust') {
      const here = file.keys[0] ?? '';
      const parent = here.includes('.') ? here.slice(0, here.lastIndexOf('.')) : '';
      if (key === 'crate' || key.startsWith('crate.')) key = key.slice(6);
      else if (key === 'self' || key.startsWith('self.')) key = [here, key.slice(5)].filter(Boolean).join('.');
      else if (key === 'super' || key.startsWith('super.')) key = [parent, key.slice(6)].filter(Boolean).join('.');
    }
    return key;
  }

  /** Among several files, the ones sharing the longest directory prefix with `from`. */
  private closest(files: FileNode[], from: FileNode): FileNode[] {
    if (files.length <= 1) return files;
    const b = from.path.split('/');
    const score = (f: FileNode): number => {
      const a = f.path.split('/');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    const best = Math.max(...files.map(score));
    return files.filter((f) => score(f) === best);
  }

  /** Files a path spec names: relative to the file, then the repository, then an include directory. */
  private pathFiles(file: FileNode, spec: string): FileNode[] {
    for (const cand of pathCandidates(file.dir, spec, file.rules)) {
      const f = this.files.get(cand);
      if (f && f.family === file.family) return [f];
    }
    const named: FileNode[] = [];
    for (const tail of pathCandidates('.', spec, file.rules)) {
      for (const f of this.byBase.get(path.posix.basename(tail)) ?? []) {
        if (f.family === file.family && (f.path === tail || f.path.endsWith(`/${tail}`)) && !named.includes(f)) named.push(f);
      }
      if (named.length > 0) break;
    }
    return this.closest(named, file);
  }

  /** Files a module spec names: a path for path-based languages, else a module name. */
  private specFiles(file: FileNode, spec: string): FileNode[] {
    // Same directory, same spec, same answer (a namespace can span hundreds of files).
    const key = `${file.family}\0${file.dir}\0${spec}`;
    const cached = this.specCache.get(key);
    if (cached) return cached;
    const found = this.specFilesUncached(file, spec);
    this.specCache.set(key, found);
    return found;
  }

  private specFilesUncached(file: FileNode, spec: string): FileNode[] {
    if (file.rules.dirModules && spec.startsWith('.')) {
      const dir = path.posix.normalize(path.posix.join(file.dir, spec.replace(/^["']|["']$/g, ''))).replace(/\/$/, '');
      return this.dirs.get(`${file.family}\0${dir}`) ?? [];
    }
    if (file.rules.paths) return this.pathFiles(file, spec);
    return this.closest(this.mods.get(`${file.family}\0${this.moduleKey(file, spec)}`) ?? [], file);
  }

  /** Top-level `name` of each file, else a member of the table or struct the file returns (Lua). */
  private exported(files: readonly FileNode[], name: string): Sym[] {
    const out: Sym[] = [];
    // A namespace's files are already in the qualified-name index: scanning them adds nothing.
    if (files.length > 0 && files[0]?.rules.pkgPrefix && files.length > 8) return out;
    for (const f of files) {
      const top = f.top.get(name);
      if (top && top.length > 0) {
        out.push(...top);
        continue;
      }
      for (const [exp, local] of f.facts.exps) {
        if (exp !== '*') continue;
        for (const t of f.top.get(local) ?? []) out.push(...this.memberOf(t, name));
      }
    }
    return out;
  }

  /** The table/struct a module file returns (`local M = {} … return M`), for `local R = require(…)`. */
  private moduleValue(file: FileNode, spec: string): Sym[] {
    const out: Sym[] = [];
    for (const f of this.specFiles(file, spec)) for (const [exp, local] of f.facts.exps) if (exp === '*') out.push(...(f.top.get(local) ?? []));
    return out;
  }

  /** What a `named` import binds: symbol `name` of `module` (namespace-qualified, else from its files). */
  private importedSyms(file: FileNode, imp: ImportFact): Sym[] {
    // Namespaces first (C++ `using a::f` in a path-include language too), then the module's files.
    const key = this.moduleKey(file, imp.module);
    const byName = this.namesAreGlobal(file) ? this.qnGet(file.family, key ? `${key}.${imp.name}` : imp.name) : [];
    if (byName.length > 0 && !file.rules.paths) return byName;
    const files = this.exported(this.specFiles(file, imp.module), imp.name);
    return files.length > 0 ? files : byName;
  }

  /**
   * Whether qualified names mean the same thing everywhere in the language (namespaces, module
   * names). Not so where imports are file paths without global names (Dart, Solidity, Zig): two
   * files may both declare `library Pricing`, and only the import says which one is meant.
   */
  private namesAreGlobal(file: FileNode): boolean {
    return !file.rules.paths || Boolean(file.rules.global);
  }

  /** Included / sourced files (`#include`, `source`, `. ./x.ps1`, `include("x.jl")`), transitively where the language does that. */
  private included(file: FileNode): FileNode[] {
    if (file.incl) return file.incl;
    file.incl = [];
    const out: FileNode[] = [];
    const seen = new Set<FileNode>([file]);
    const visit = (f: FileNode, depth: number): void => {
      for (const imp of f.facts.imps) {
        if (imp.kind !== 'file') continue;
        for (const t of this.pathFiles(f, imp.module)) {
          if (seen.has(t)) continue;
          seen.add(t);
          out.push(t);
          if (file.rules.transitive && depth < 8) visit(t, depth + 1);
        }
      }
    };
    visit(file, 0);
    file.incl = out;
    return out;
  }

  /**
   * C-family prototypes plus their definitions: every non-`static` function with the same
   * qualified name, preferring the files that include the prototype's header.
   */
  private withDefinitions(found: Sym[]): Sym[] {
    const out = [...found];
    for (const proto of found) {
      if (!proto.sig.endsWith(';') || proto.file.family !== 'c') continue;
      const defs = this.qnGet(proto.file.family, this.qualified(proto)).filter((d) => !d.sig.endsWith(';') && !/^static\b/.test(d.sig));
      const near = defs.filter((d) => d.file === proto.file || this.included(d.file).includes(proto.file));
      for (const d of near.length > 0 ? near : defs) if (!out.includes(d)) out.push(d);
    }
    return out;
  }

  /** Bare `name` in `file`: imports, enclosing namespaces, includes, the build target, global names. */
  private genericName(file: FileNode, name: string, from: Sym | null): Resolved {
    const found = (syms: Sym[]): Resolved | null => (syms.length > 0 ? { syms: this.withDefinitions(syms), weak: false } : null);
    for (const imp of file.bindings.get(name) ?? []) {
      const r = imp.kind === 'named' ? found(this.importedSyms(file, imp)) : imp.kind === 'module' ? found(this.moduleValue(file, imp.module)) : null;
      if (r) return r;
    }
    const global = this.namesAreGlobal(file);
    if (global) {
      for (const ns of this.scopes(file, from)) {
        const r = found(this.qnGet(file.family, `${ns}.${name}`));
        if (r) return r;
      }
    }
    for (const imp of file.facts.imps) {
      if (imp.kind !== 'wild') continue;
      const key = this.moduleKey(file, imp.module);
      const r = found([...(global ? this.qnGet(file.family, `${key}.${name}`) : []), ...this.exported(this.specFiles(file, imp.module), name)]);
      if (r) return r;
    }
    const inc: Sym[] = [];
    for (const f of this.included(file)) inc.push(...(f.top.get(name) ?? []));
    const r = found(inc);
    if (r) return r;
    if (file.rules.sameTarget) {
      const same = found(this.exported(this.mods.get(`${file.family}\0${file.keys[0] ?? ''}`) ?? [], name));
      if (same) return same;
    }
    if (file.rules.sameDir) {
      const near = found(this.dirTop(file, name));
      if (near) return near;
    }
    if (file.rules.global) {
      // Global names (C linkage, Ruby constants, Erlang modules, SQL objects): one definition is it.
      const all = this.qnGet(file.family, name).filter((s) => (!/^static\b/.test(s.sig) || s.file === file) && (file.rules.globalFunctions || CLASS_LIKE.has(s.kind)));
      const names = new Set(all.map((s) => this.qualified(s)));
      if (all.length > 0 && names.size === 1) {
        const bodies = all.filter((s) => !s.sig.endsWith(';'));
        if (bodies.length <= 1) return { syms: all, weak: false };
      }
    }
    return NONE;
  }

  /**
   * `Q.name` where `Q` is an import alias, a module or namespace (by its full name, or relative
   * to the enclosing ones), or a type (static member; `X.new()` of a class without `new`).
   */
  private genericQualified(file: FileNode, from: Sym | null, q: string, name: string, depth: number): Resolved {
    const found = (syms: Sym[]): Resolved | null => (syms.length > 0 ? { syms: this.withDefinitions(syms), weak: false } : null);
    const dot = q.indexOf('.');
    const head = dot < 0 ? q : q.slice(0, dot);
    const rest = dot < 0 ? '' : q.slice(dot + 1);
    for (const imp of file.bindings.get(head) ?? []) {
      let r: Resolved | null = null;
      if (imp.kind === 'module') {
        const key = this.moduleKey(file, imp.module);
        if (rest) r = found(this.qnGet(file.family, `${key}.${rest}.${name}`));
        else r = found(this.exported(this.specFiles(file, imp.module), name)) ?? found(this.qnGet(file.family, `${key}.${name}`));
      } else if (imp.kind === 'named') {
        for (let t of this.importedSyms(file, imp)) {
          for (const seg of rest ? rest.split('.') : []) t = this.memberOf(t, seg).find((m) => CLASS_LIKE.has(m.kind)) ?? t;
          r = found(this.membersOf(t, name)) ?? (name === 'new' && CLASS_LIKE.has(t.kind) ? { syms: [t], weak: false } : null);
          if (r) break;
        }
      }
      if (r) return r;
    }
    // A module or namespace by its full name, then relative to the enclosing namespaces. Where
    // imports are file paths and names are not global (Dart, Solidity, Zig), only imports count.
    if (this.namesAreGlobal(file)) {
      const key = this.moduleKey(file, q);
      const r = found(this.qnGet(file.family, `${key}.${name}`)) ?? (file.rules.paths ? null : found(this.exported(this.specFiles(file, q), name)));
      if (r) return r;
      for (const ns of this.scopes(file, from)) {
        const inner = found(this.qnGet(file.family, `${ns}.${key}.${name}`));
        if (inner) return inner;
      }
    }
    const owner = depth < 6 ? this.typeByName(file, q, from) : null;
    if (owner) {
      const m = this.membersOf(owner, name);
      if (m.length > 0) return { syms: m, weak: false };
      if (name === 'new') return { syms: [owner], weak: false };
    }
    return NONE;
  }

  /**
   * The other declarations of a C-family class: Objective-C `@interface` / `@implementation`
   * pairs and categories share members, fields and supertypes.
   */
  private twins(cls: Sym | null): Sym[] {
    if (!cls || cls.file.family !== 'c' || !CLASS_LIKE.has(cls.kind)) return [];
    return this.qnGet('c', this.qualified(cls)).filter((t) => t !== cls && CLASS_LIKE.has(t.kind));
  }

  /** Members named `name` (including the twins' and supertypes'), with definitions for prototypes. */
  private membersOf(cls: Sym | null, name: string): Sym[] {
    const own = this.memberOf(cls, name);
    if (own.length > 0) return this.withDefinitions(own);
    const out: Sym[] = [];
    for (const twin of this.twins(cls)) out.push(...this.memberOf(twin, name));
    return this.withDefinitions(out);
  }

  /** Generic-resolver version of `resolveRef` (same receiver encodings). */
  private resolveGeneric(file: FileNode, from: Sym | null, ref: RefFact, depth: number): Resolved {
    const { name, recv } = ref;
    const cls = enclosingClass(from);
    const found = (syms: Sym[]): Resolved | null => (syms.length > 0 ? { syms, weak: false } : null);
    const qualifier = recv.startsWith('v:') || recv.startsWith('m:') ? recv.slice(2) : '';

    if (ref.kind === 'new' || ref.kind === 'render' || ref.kind === 'type') {
      // Terraform addresses (`var.cidr`, `aws_s3_bucket.assets`) are names, not module paths.
      if (ref.kind === 'type' && !qualifier && file.rules.sameDir) {
        const r = this.resolveName(file, name, from);
        return r.syms.length > 0 ? r : this.fallback(file, name, 'new', from);
      }
      if (qualifier) {
        const r = this.genericQualified(file, from, qualifier, name, depth);
        const types = r.syms.filter((s) => CLASS_LIKE.has(s.kind) || ref.kind === 'type');
        if (types.length > 0) return { syms: types, weak: false };
      }
      const t = ref.kind !== 'render' ? this.typeByName(file, name, from) : null;
      if (t) return { syms: [t], weak: false };
      const r = this.resolveName(file, name, from);
      if (r.syms.length > 0) return r;
      return this.fallback(file, name, 'new', from);
    }

    if (recv === '') {
      for (let c = cls; c; c = enclosingClass(c.parent)) {
        if (c.kind !== 'module' && !file.rules.implicitThis) continue;
        const m = found(this.membersOf(c, name));
        if (m) return m;
      }
      const r = this.resolveName(file, name, from);
      if (r.syms.length > 0) return r;
      return this.fallback(file, name, 'call', from);
    }
    if (recv === 'this') {
      const m = found(this.membersOf(cls, name));
      if (m || cls) return m ?? NONE;
      return found((file.top.get(name) ?? []).filter((s) => s !== from)) ?? this.fallback(file, name, 'call', from, true);
    }
    if (recv === 'super') {
      for (const b of cls ? [...cls.bases, ...this.twins(cls).flatMap((t) => t.bases)] : []) {
        const m = found(this.membersOf(b, name));
        if (m) return m;
      }
      return NONE;
    }
    if (recv.startsWith('f:')) {
      const t = this.fieldType(cls, recv.slice(2), depth) ?? this.twins(cls).map((c) => this.fieldType(c, recv.slice(2), depth)).find(Boolean) ?? null;
      if (t) return found(this.membersOf(t, name)) ?? NONE;
      return this.fallback(file, name, 'call', from, true);
    }
    if (qualifier) {
      if (recv.startsWith('v:')) {
        // A typed local, parameter or field first: `repo.save()`, `c.repo.save()`.
        const [headVar = '', ...fields] = qualifier.split('.');
        let t = this.varType(file, from, headVar, depth);
        for (const f of fields) t = t ? this.fieldType(t, f, depth) : null;
        if (t) return found(this.membersOf(t, name)) ?? NONE;
      }
      const r = this.genericQualified(file, from, qualifier, name, depth);
      if (r.syms.length > 0) return r;
      // `Math.round`, `Console.WriteLine`, `IO.puts`: a type or module outside the repository.
      if (/^[A-Z]/.test(qualifier.split('.').pop() ?? '') || recv.startsWith('m:')) return NONE;
      return this.fallback(file, name, 'call', from, true);
    }
    return this.fallback(file, name, 'call', from, true);
  }

  private resolveAll(): void {
    const pendingInherit: { file: FileNode; from: Sym; ref: RefFact }[] = [];
    for (const file of this.files.values()) {
      for (const ref of file.facts.refs) {
        if (ref.kind !== 'inherit') continue;
        // `impl Trait for Type` / `extension Type: Proto`: the subtype is named by the owner.
        const from = ref.from >= 0 ? file.syms[ref.from] : ref.recv.startsWith('o:') ? this.ownerType(file, ref.recv.slice(2)) : null;
        if (from) pendingInherit.push({ file, from, ref: ref.recv.startsWith('o:') ? { ...ref, recv: '' } : ref });
      }
    }
    // Supertypes first: member lookup walks them.
    for (const { file, from, ref } of pendingInherit) {
      const target = this.typeRef(file, ref.name, ref.recv, from);
      if (target && target !== from) {
        this.addBase(from, target);
        this.link(file, from, target, 'inherit', ref.line, false);
      }
    }
    this.goImplicitInterfaces();
    for (const file of this.files.values()) {
      for (const ref of file.facts.refs) {
        if (ref.kind === 'inherit') continue;
        this.stats.refs++;
        const from = ref.from >= 0 ? (file.syms[ref.from] ?? null) : null;
        const res = this.resolveRef(file, from, ref, 0);
        // A C/C++/Objective-C prototype and its definition are one function: link the definition.
        const bodies = res.syms.filter((s) => !s.sig.endsWith(';'));
        const targets = (bodies.length > 0 ? bodies : res.syms).slice(0, 4);
        if (targets.length === 0) continue;
        this.stats.resolved++;
        if (res.weak) this.stats.weak++;
        for (const to of targets) {
          const kind: RefKind = ref.kind === 'call' && CLASS_LIKE.has(to.kind) ? 'new' : ref.kind;
          this.link(file, from, to, kind, ref.line, res.weak);
        }
      }
    }
  }

  private link(file: FileNode, from: Sym | null, to: Sym, kind: RefKind, line: number, weak: boolean): void {
    const edge: Edge = { from, file, to, kind, line, weak };
    if (from) from.out.push(edge);
    else file.out.push(edge);
    to.in.push(edge);
    this.edges.push(edge);
  }

  private addBase(sub: Sym, sup: Sym): void {
    sub.bases.push(sup);
    sup.subs.push(sub);
    this.baseLinks.push([sub, sup]);
  }

  /** Go has no `implements`: a struct satisfies every interface whose method names it has. */
  private goImplicitInterfaces(): void {
    if (!this.byName.has('go')) return;
    const byMethod = new Map<string, Sym[]>();
    const ifaces: Sym[] = [];
    for (const s of this.syms) {
      if (s.file.family !== 'go' || !s.members) continue;
      if (s.kind === 'interface') ifaces.push(s);
      else for (const name of s.members.keys()) push(byMethod, name, s);
    }
    for (const iface of ifaces) {
      const names = [...this.memberNames(iface, new Set())];
      if (names.length === 0) continue;
      names.sort((a, b) => (byMethod.get(a)?.length ?? 0) - (byMethod.get(b)?.length ?? 0));
      const first = names[0];
      if (first === undefined) continue;
      for (const s of byMethod.get(first) ?? []) {
        if (names.every((n) => s.members?.has(n)) && !s.bases.includes(iface)) this.addBase(s, iface);
      }
    }
  }

  private memberNames(s: Sym, seen: Set<Sym>): Set<string> {
    const out = new Set<string>(s.members?.keys() ?? []);
    seen.add(s);
    for (const b of s.bases) if (!seen.has(b)) for (const n of this.memberNames(b, seen)) out.add(n);
    return out;
  }

  // ---- lookups ----------------------------------------------------------------------------------

  /** Members named `name` in `cls` or its supertypes (nearest first). */
  memberOf(cls: Sym | null, name: string, seen = new Set<Sym>()): Sym[] {
    if (!cls || seen.has(cls)) return [];
    seen.add(cls);
    const own = cls.members?.get(name);
    if (own && own.length > 0) return own;
    for (const b of cls.bases) {
      const m = this.memberOf(b, name, seen);
      if (m.length > 0) return m;
    }
    return [];
  }

  private familyNames(family: Family, name: string): Sym[] {
    return this.byName.get(family)?.get(name) ?? [];
  }

  /** Symbols `name` refers to at file level of `file`, following the language's import rules. */
  private resolveName(file: FileNode, name: string, from: Sym | null = null): Resolved {
    const local = file.top.get(name);
    if (local && local.length > 0) return { syms: DEEP_FAMILIES.has(file.family) ? local : this.withDefinitions(local), weak: false };
    switch (file.family) {
      case 'js':
        return this.jsName(file, name);
      case 'jvm':
        return this.jvmName(file, name);
      case 'go': {
        const same = this.goTop(file.dir, name);
        if (same.length > 0) return { syms: same, weak: false };
        for (const imp of file.facts.imps) {
          if (imp.alias !== '.') continue;
          const dir = this.goDir(imp.module);
          const found = dir ? this.goTop(dir, name) : [];
          if (found.length > 0) return { syms: found, weak: false };
        }
        return NONE;
      }
      case 'python':
        return this.pyName(file, name);
      default:
        return this.genericName(file, name, from);
    }
  }

  private jsName(file: FileNode, name: string): Resolved {
    for (const imp of file.bindings.get(name) ?? []) {
      if (imp.kind !== 'named' && imp.kind !== 'default') continue;
      const target = this.jsModule(file, imp.module);
      if (!target) continue;
      const found = this.jsExport(target, imp.kind === 'default' ? 'default' : imp.name, 0);
      if (found.length > 0) return { syms: found, weak: false };
    }
    return NONE;
  }

  /** What `name` means when imported from `file` (own symbols, `export {}`, re-exports). */
  private jsExport(file: FileNode, name: string, depth: number): Sym[] {
    if (depth > 4) return [];
    for (const [exported, local] of file.facts.exps) {
      if (exported !== name) continue;
      const found = file.top.get(local);
      if (found && found.length > 0) return found;
      const imported = this.jsName(file, local);
      if (imported.syms.length > 0) return imported.syms;
    }
    if (name !== 'default') {
      const own = file.top.get(name);
      if (own && own.length > 0) return own;
    }
    for (const imp of file.facts.imps) {
      if (imp.kind === 'rx' && imp.alias === name) {
        const target = this.jsModule(file, imp.module);
        const found = target ? this.jsExport(target, imp.name, depth + 1) : [];
        if (found.length > 0) return found;
      } else if (imp.kind === 'rx*' && name !== 'default') {
        const target = this.jsModule(file, imp.module);
        const found = target ? this.jsExport(target, name, depth + 1) : [];
        if (found.length > 0) return found;
      }
    }
    return [];
  }

  /** Resolves an import specifier to a repository file (relative, tsconfig paths, workspace packages). */
  jsModule(from: FileNode, spec: string): FileNode | null {
    const key = `${from.dir}\0${spec}`;
    const cached = this.jsCache.get(key);
    if (cached !== undefined) return cached;
    let found: FileNode | null = null;
    if (spec.startsWith('.')) found = this.jsPath(path.posix.normalize(path.posix.join(from.dir, spec)));
    else {
      const configs = this.project.tsconfigs
        .filter((c) => c.dir === '.' || from.path.startsWith(`${c.dir}/`))
        .sort((a, b) => b.dir.length - a.dir.length);
      for (const c of configs) {
        const base = c.baseUrl ?? c.dir;
        for (const [pattern, targets] of Object.entries(c.paths)) {
          const star = pattern.indexOf('*');
          let rest: string | null = null;
          if (star < 0) rest = spec === pattern ? '' : null;
          else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) {
            rest = spec.slice(star, spec.length - (pattern.length - star - 1));
          }
          if (rest === null) continue;
          for (const t of targets) {
            found = this.jsPath(path.posix.normalize(path.posix.join(base, t.replace('*', rest))));
            if (found) break;
          }
          if (found) break;
        }
        if (!found && c.baseUrl) found = this.jsPath(path.posix.normalize(path.posix.join(c.baseUrl, spec)));
        if (found) break;
      }
      if (!found) {
        for (const pkg of this.project.packages) {
          if (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)) continue;
          const sub = spec.slice(pkg.name.length + 1);
          const candidates = sub ? [`${pkg.dir}/${sub}`, `${pkg.dir}/src/${sub}`] : [`${pkg.dir}/src/index`, `${pkg.dir}/index`, `${pkg.dir}/src/main`, `${pkg.dir}/lib/index`];
          for (const c of candidates) {
            found = this.jsPath(path.posix.normalize(c.replace(/^\.\//, '')));
            if (found) break;
          }
          if (found) break;
        }
      }
    }
    this.jsCache.set(key, found);
    return found;
  }

  private jsPath(base: string): FileNode | null {
    const b = base.replace(/^\.\//, '');
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts'];
    for (const ext of exts) {
      const f = this.files.get(`${b}${ext}`);
      if (f && f.family === 'js') return f;
    }
    // TypeScript ESM style: `./user.js` in source means `./user.ts`.
    const m = /^(.*)\.(m?js|jsx)$/.exec(b);
    if (m) {
      for (const ext of ['.ts', '.tsx', '.mts']) {
        const f = this.files.get(`${m[1]}${ext}`);
        if (f) return f;
      }
    }
    for (const ext of exts.slice(1)) {
      const f = this.files.get(`${b}/index${ext}`);
      if (f && f.family === 'js') return f;
    }
    return null;
  }

  private jvmName(file: FileNode, name: string): Resolved {
    for (const imp of file.bindings.get(name) ?? []) {
      if (imp.kind === 'named') {
        const found = this.fqn.get(imp.module);
        if (found && found.length > 0) return { syms: found, weak: false };
      } else if (imp.kind === 'static') {
        const owner = imp.module.slice(0, imp.module.lastIndexOf('.'));
        const cls = this.fqn.get(owner)?.[0] ?? null;
        const found = this.memberOf(cls, imp.name);
        if (found.length > 0) return { syms: found, weak: false };
      }
    }
    for (const f of this.packages.get(file.facts.pkg) ?? []) {
      const found = f.top.get(name);
      if (found && found.length > 0) return { syms: found, weak: false };
    }
    for (const imp of file.facts.imps) {
      if (imp.kind !== 'wild') continue;
      for (const f of this.packages.get(imp.module) ?? []) {
        const found = f.top.get(name);
        if (found && found.length > 0) return { syms: found, weak: false };
      }
      const cls = this.fqn.get(imp.module)?.[0];
      const member = cls ? this.memberOf(cls, name) : [];
      if (member.length > 0) return { syms: member, weak: false };
    }
    return NONE;
  }

  private goDir(importPath: string): string | null {
    const mods = [...this.project.gomods].sort((a, b) => b.module.length - a.module.length);
    for (const m of mods) {
      if (importPath !== m.module && !importPath.startsWith(`${m.module}/`)) continue;
      const rest = importPath.slice(m.module.length + 1);
      const dir = path.posix.normalize(m.dir === '.' ? rest || '.' : rest ? `${m.dir}/${rest}` : m.dir);
      return this.dirs.has(`go\0${dir}`) ? dir : null;
    }
    // No go.mod (GOPATH layout): match the import path's tail against package directories.
    for (const key of this.dirs.keys()) {
      if (!key.startsWith('go\0')) continue;
      const dir = key.slice(3);
      if (importPath.endsWith(`/${dir}`) || importPath === dir) return dir;
    }
    return null;
  }

  /** Package directory bound to `alias` in a Go file (explicit alias, package name or last segment). */
  private goPackage(file: FileNode, alias: string): string | null {
    for (const imp of file.facts.imps) {
      if (imp.kind !== 'module') continue;
      if (imp.alias && imp.alias !== alias) continue;
      const dir = this.goDir(imp.module);
      if (!dir) continue;
      if (imp.alias === alias) return dir;
      const pkg = this.dirs.get(`go\0${dir}`)?.[0]?.facts.pkg;
      const last = imp.module.split('/').filter((s) => !/^v\d+$/.test(s)).pop();
      if (pkg === alias || (!pkg && last === alias)) return dir;
    }
    return null;
  }

  private pyModule(file: FileNode, mod: string): FileNode[] {
    if (mod.startsWith('.')) {
      const dots = /^\.+/.exec(mod)?.[0].length ?? 1;
      let dir = file.dir;
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      const rest = mod.slice(dots).replace(/\./g, '/');
      const base = rest ? (dir === '.' ? rest : `${dir}/${rest}`) : dir;
      const out: FileNode[] = [];
      for (const c of [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]) {
        const f = this.files.get(c.replace(/^\.\//, ''));
        if (f) out.push(f);
      }
      return out;
    }
    const candidates = this.pyModules.get(mod) ?? [];
    if (candidates.length <= 1) return candidates;
    // Several roots define the module: the one sharing the longest path prefix wins.
    const score = (f: FileNode): number => {
      const a = f.path.split('/');
      const b = file.path.split('/');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    const best = Math.max(...candidates.map(score));
    return candidates.filter((f) => score(f) === best);
  }

  private pyName(file: FileNode, name: string): Resolved {
    for (const imp of file.bindings.get(name) ?? []) {
      if (imp.kind !== 'named') continue;
      for (const target of this.pyModule(file, imp.module)) {
        const found = target.top.get(imp.name);
        if (found && found.length > 0) return { syms: found, weak: false };
      }
    }
    for (const imp of file.facts.imps) {
      if (imp.kind !== 'wild') continue;
      for (const target of this.pyModule(file, imp.module)) {
        const found = target.top.get(name);
        if (found && found.length > 0) return { syms: found, weak: false };
      }
    }
    return NONE;
  }

  /** Files behind a module-like receiver (`fmt.title()`, `events.Notifier()`, `stock.NewService()`). */
  private moduleFiles(file: FileNode, alias: string): FileNode[] | null {
    switch (file.family) {
      case 'js': {
        const out: FileNode[] = [];
        for (const imp of file.bindings.get(alias) ?? []) {
          if (imp.kind !== 'ns') continue;
          const target = this.jsModule(file, imp.module);
          if (target) out.push(target);
        }
        return out.length > 0 ? out : null;
      }
      case 'python': {
        const out: FileNode[] = [];
        for (const imp of file.bindings.get(alias) ?? []) {
          if (imp.kind === 'module') out.push(...this.pyModule(file, imp.module));
          else if (imp.kind === 'named') {
            // `from . import events`: a submodule when no symbol of that name exists.
            const parents = this.pyModule(file, imp.module);
            if (parents.some((p) => p.top.has(imp.name))) continue;
            const sub = imp.module.endsWith('.') ? `${imp.module}${imp.name}` : `${imp.module}.${imp.name}`;
            out.push(...this.pyModule(file, sub));
          }
        }
        return out.length > 0 ? out : null;
      }
      case 'go': {
        const dir = this.goPackage(file, alias);
        return dir ? (this.dirs.get(`go\0${dir}`) ?? null) : null;
      }
      default:
        return this.modules.get(`${file.family}\0${alias}`) ?? null;
    }
  }

  private inModules(files: FileNode[], name: string): Sym[] {
    const out: Sym[] = [];
    for (const f of files) {
      const found = f.family === 'js' ? this.jsExport(f, name, 0) : (f.top.get(name) ?? []);
      out.push(...found);
      if (out.length > 0) break;
    }
    return out;
  }

  /** A class-like symbol named `name` (optionally qualified by a module receiver). */
  private typeRef(file: FileNode, name: string, recv: string, ctx: Sym | null): Sym | null {
    if (!name) return null;
    if (!DEEP_FAMILIES.has(file.family)) {
      if (recv.startsWith('v:') || recv.startsWith('m:')) {
        const t = this.genericQualified(file, ctx, recv.slice(2), name, 0).syms.find((s) => CLASS_LIKE.has(s.kind));
        if (t) return t;
      }
      return this.typeByName(file, name, ctx);
    }
    if (recv.startsWith('v:')) {
      const mods = this.moduleFiles(file, recv.slice(2));
      const found = mods ? this.inModules(mods, name) : [];
      const t = found.find((s) => CLASS_LIKE.has(s.kind));
      if (t) return t;
    }
    return this.typeByName(file, name, ctx);
  }

  typeByName(file: FileNode, type: string, ctx: Sym | null, depth = 0): Sym | null {
    if (!type || depth > 8) return null;
    const generic = !DEEP_FAMILIES.has(file.family);
    const dot = type.lastIndexOf('.');
    if (dot > 0) {
      if (generic) {
        const r = this.genericQualified(file, ctx, type.slice(0, dot), type.slice(dot + 1), depth + 1);
        const t = r.syms.find((s) => CLASS_LIKE.has(s.kind));
        if (t) return t;
        const exact = this.qnGet(file.family, normModule(type)).find((s) => CLASS_LIKE.has(s.kind));
        if (exact) return exact;
      } else {
        const mods = this.moduleFiles(file, type.slice(0, dot));
        const found = mods ? this.inModules(mods, type.slice(dot + 1)) : [];
        const t = found.find((s) => CLASS_LIKE.has(s.kind));
        if (t) return t;
      }
      return this.typeByName(file, type.slice(dot + 1), ctx, depth + 1);
    }
    // Nested types of the enclosing classes first.
    for (let c = enclosingClass(ctx); c; c = enclosingClass(c.parent)) {
      const nested = c.members?.get(type)?.find((s) => CLASS_LIKE.has(s.kind));
      if (nested) return nested;
    }
    const found = this.resolveName(file, type, ctx).syms.find((s) => CLASS_LIKE.has(s.kind));
    if (found) return found;
    // Where top-level names are shared without imports (global names, one build target, one
    // Terraform module), a type name unique in the language is that type.
    if (generic && (file.rules.global || file.rules.sameTarget || file.rules.sameDir)) {
      const all = this.familyNames(file.family, type).filter((s) => CLASS_LIKE.has(s.kind));
      if (all.length === 1) return all[0] ?? null;
    }
    return null;
  }

  private fieldType(cls: Sym | null, name: string, depth: number, seen = new Set<Sym>()): Sym | null {
    if (!cls || seen.has(cls)) return null;
    seen.add(cls);
    const v = cls.file.fields.get(cls.local)?.get(name);
    if (v) return this.valueType(cls.file, v, cls, depth);
    for (const b of cls.bases) {
      const t = this.fieldType(b, name, depth, seen);
      if (t) return t;
    }
    return null;
  }

  /** Type of a local, parameter, field of the enclosing class, or file-level variable. */
  private varType(file: FileNode, from: Sym | null, name: string, depth: number): Sym | null {
    for (let s = from; s; s = s.parent) {
      if (CLASS_LIKE.has(s.kind)) {
        const t = this.fieldType(s, name, depth);
        if (t) return t;
        continue;
      }
      const v = file.locals.get(s.local)?.get(name);
      if (v && s.file === file) return this.valueType(file, v, from, depth);
    }
    const top = file.locals.get(-1)?.get(name);
    return top ? this.valueType(file, top, from, depth) : null;
  }

  private valueType(file: FileNode, v: VarFact, ctx: Sym | null, depth: number): Sym | null {
    if (v.type) {
      const t = this.typeByName(file, v.type, ctx);
      if (t) return t;
    }
    if (!v.call || depth > 3) return null;
    const dot = v.call.lastIndexOf('.');
    const ref: RefFact = dot > 0 ? { from: -1, name: v.call.slice(dot + 1), kind: 'call', line: 0, recv: `v:${v.call.slice(0, dot)}` } : { from: -1, name: v.call, kind: 'call', line: 0, recv: '' };
    const res = this.resolveRef(file, ctx, ref, depth + 1);
    for (const target of res.syms) {
      if (CLASS_LIKE.has(target.kind)) return target;
      if (target.returns) {
        const t = this.typeByName(target.file, target.returns, target);
        if (t) return t;
      }
      // Constructors without a declared type (`Foo->new`, `Foo.new()`, `Foo:new()`, `init`)
      // make the class they are called on, which may be a subclass of the one declaring them.
      if (target.kind === 'constructor' || target.name === 'new') {
        const onType = dot > 0 ? this.typeByName(file, v.call.slice(0, dot), ctx) : null;
        if (onType) return onType;
        if (target.parent && CLASS_LIKE.has(target.parent.kind)) return target.parent;
      }
    }
    return null;
  }

  /**
   * Last resort: the only declaration of that name in the language family. A member call
   * (`x.save()`) can only reach a member, and a call never links to its own caller by name.
   */
  private fallback(file: FileNode, name: string, kind: RefKind, from: Sym | null = null, member = false): Resolved {
    if (COMMON.has(name) || name.length < 3) return NONE;
    const candidates = this.familyNames(file.family, name).filter(
      (s) => s !== from && (!member || s.parent !== null) && (kind === 'call' ? CALLABLE.has(s.kind) : CLASS_LIKE.has(s.kind) || s.kind === 'component'),
    );
    if (candidates.length === 1) return { syms: candidates, weak: true };
    // An interface method and its implementations are one target: link the declaration.
    // (Only for a handful of candidates: the check is quadratic, and more is ambiguous anyway.)
    if (candidates.length > 6) return NONE;
    const roots = candidates.filter((c) => !candidates.some((o) => o !== c && o.parent && c.parent && this.isSubtype(c.parent, o.parent)));
    if (roots.length === 1) return { syms: roots, weak: true };
    return NONE;
  }

  isSubtype(sub: Sym, sup: Sym, seen = new Set<Sym>()): boolean {
    if (seen.has(sub)) return false;
    seen.add(sub);
    for (const b of sub.bases) if (b === sup || this.isSubtype(b, sup, seen)) return true;
    return false;
  }

  /** Targets of one reference. */
  private resolveRef(file: FileNode, from: Sym | null, ref: RefFact, depth: number): Resolved {
    if (!DEEP_FAMILIES.has(file.family)) return this.resolveGeneric(file, from, ref, depth);
    const { name, recv } = ref;
    const cls = enclosingClass(from);
    const found = (syms: Sym[]): Resolved | null => (syms.length > 0 ? { syms, weak: false } : null);

    if (ref.kind === 'new' || ref.kind === 'render' || ref.kind === 'type') {
      if (recv.startsWith('v:')) {
        const mods = this.moduleFiles(file, recv.slice(2));
        const r = mods ? found(this.inModules(mods, name)) : null;
        if (r) return r;
        const owner = this.typeByName(file, recv.slice(2), from);
        const m = owner ? found(this.memberOf(owner, name)) : null;
        if (m) return m;
      }
      const t = ref.kind !== 'render' ? this.typeByName(file, name, from) : null;
      if (t) return { syms: [t], weak: false };
      const r = this.resolveName(file, name);
      if (r.syms.length > 0) return ref.kind === 'type' ? { ...r, syms: r.syms.filter((s) => CLASS_LIKE.has(s.kind)) } : r;
      return this.fallback(file, name, 'new', from);
    }

    switch (true) {
      case recv === '': {
        // Most languages call members (and outer-class members) without `this`; JS, Python and
        // Go never do, so there a bare name is always a free function or an import.
        if (file.family === 'jvm' || !DEEP_FAMILIES.has(file.family)) {
          for (let c = cls; c; c = enclosingClass(c.parent)) {
            const m = found(this.memberOf(c, name));
            if (m) return m;
          }
        }
        // Script functions of a Vue/Svelte/Astro component are its members.
        const comp = from?.kind === 'component' ? from : from?.parent?.kind === 'component' ? from.parent : null;
        if (comp) {
          const m = found(this.memberOf(comp, name));
          if (m) return m;
        }
        const r = this.resolveName(file, name);
        if (r.syms.length > 0) return r;
        return this.fallback(file, name, 'call', from);
      }
      case recv === 'this': {
        const m = found(this.memberOf(cls, name));
        if (m || cls) return m ?? NONE;
        // `$self->discount` (Perl), `self:discount` without a table type: the file's own functions.
        return found((file.top.get(name) ?? []).filter((s) => s !== from)) ?? this.fallback(file, name, 'call', from, true);
      }
      case recv.startsWith('m:'): {
        // An explicit module or type qualifier (`pricing:sum`, `Pricing.sum`, `Shop::Pricing::sum`).
        const target = recv.slice(2);
        const mods = this.moduleFiles(file, target);
        const inMod = mods ? this.inModules(mods, name) : [];
        if (inMod.length > 0) return { syms: inMod, weak: false };
        const owner = this.typeByName(file, target, from);
        return owner ? (found(this.memberOf(owner, name)) ?? NONE) : NONE;
      }
      case recv === 'super': {
        for (const b of cls?.bases ?? []) {
          const m = found(this.memberOf(b, name));
          if (m) return m;
        }
        return NONE;
      }
      case recv.startsWith('f:'): {
        const t = this.fieldType(cls, recv.slice(2), depth);
        if (t) return found(this.memberOf(t, name)) ?? NONE;
        return this.fallback(file, name, 'call', from, true);
      }
      case recv.startsWith('v:'): {
        const target = recv.slice(2);
        const dot = target.indexOf('.');
        if (dot < 0) {
          const t = this.varType(file, from, target, depth);
          if (t) return found(this.memberOf(t, name)) ?? NONE;
          const mods = this.moduleFiles(file, target);
          if (mods) return found(this.inModules(mods, name)) ?? NONE;
          const owner = this.typeByName(file, target, from);
          if (owner) return found(this.memberOf(owner, name)) ?? NONE;
          // `Math.round`, `Console.WriteLine`, `HashMap::new`: a type or module outside the repository.
          if (/^[A-Z]/.test(target)) return NONE;
          return this.fallback(file, name, 'call', from, true);
        }
        const mods = this.moduleFiles(file, target);
        if (mods) return found(this.inModules(mods, name)) ?? NONE;
        const head = target.slice(0, dot);
        const field = target.slice(dot + 1);
        const owner = this.varType(file, from, head, depth) ?? this.typeByName(file, head, from);
        const t = owner ? this.fieldType(owner, field, depth) : null;
        if (t) return found(this.memberOf(t, name)) ?? NONE;
        const headMods = this.moduleFiles(file, head);
        if (headMods) {
          const obj = this.inModules(headMods, field).find((s) => CLASS_LIKE.has(s.kind));
          if (obj) return found(this.memberOf(obj, name)) ?? NONE;
        }
        if (/^[A-Z]/.test(head)) return NONE;
        return this.fallback(file, name, 'call', from, true);
      }
      default:
        return this.fallback(file, name, 'call', from, true);
    }
  }
}
