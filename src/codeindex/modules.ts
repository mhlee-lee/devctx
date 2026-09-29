import path from 'node:path';
import type { LangId } from './facts.ts';

/**
 * How each language finds names across files, for the languages resolved by the generic
 * resolver (everything except the JVM, JS/TS, Go and Python resolvers in graph.ts). One table
 * row per language: whether imports are file paths or module names, whether a file's package is
 * the namespace of its symbols, and which scopes are implicit (same target, same directory,
 * global linkage). graph.ts applies the rows; the extractors emit imports in the shape below.
 *
 * Import facts for these languages:
 * - `named`  module M, name N, alias A: `A` means symbol `N` of module `M`.
 * - `module` module M, alias A: `A.x` / `A::x` / `A:x` / `A/x` means `x` of module `M`.
 * - `wild`   module M: every top-level name of `M` is visible unqualified.
 * - `file`   module P: the file at path P is included/sourced; its names become visible.
 */
export interface LangRules {
  /** `named`/`module`/`wild` specs are file paths (relative to the importing file, then the repository). */
  paths?: boolean;
  /** Extensions tried for a path spec without one (`./pricing` → `./pricing.dart`). */
  exts?: string[];
  /** The file's package/module declaration (or its path-derived module) prefixes its symbols. */
  pkgPrefix?: boolean;
  /** Parent namespaces of the package are in scope too (C#, C++, F#). */
  pkgParents?: boolean;
  /** Names are global once defined (C linkage, Ruby constants, Elixir/Erlang modules, shell functions, SQL objects, R). */
  global?: boolean;
  /** Files in one directory share top-level names (Terraform modules). */
  sameDir?: boolean;
  /** Files of one build target share top-level names (Swift modules). */
  sameTarget?: boolean;
  /** A bare name inside a type can mean one of its members (`log(s)` for `this.log(s)`). */
  implicitThis?: boolean;
  /** Included/sourced files' own includes are visible too (C headers, shell `source`). */
  transitive?: boolean;
  /** Lower-case module names map to file names with `_` for `-` (Clojure). */
  hyphens?: boolean;
  /** The path-derived module (first key) is the package when the file declares none (Rust). */
  pathPkg?: boolean;
  /** Methods of type classes / protocols are module-level names too (Haskell, Clojure). */
  topMembers?: boolean;
  /** A module spec names a directory whose files together are the module (Terraform). */
  dirModules?: boolean;
  /** A bare name is looked up in the schema of the object that uses it first (SQL). */
  schemas?: boolean;
  /**
   * Functions (not only types and modules) are global names: C linkage, PHP's global namespace,
   * R's environment, SQL routines. Elsewhere a function needs an import, include or scope.
   */
  globalFunctions?: boolean;
  /** The last path segment of a file is its module name, capitalized (OCaml). */
  capitalize?: boolean;
}

const C_EXTS = ['.h', '.hpp', '.hh', '.hxx', '.inl', '.ipp'];

export const RULES: Record<LangId, LangRules> = {
  rust: { pkgPrefix: true, pathPkg: true },
  c: { paths: true, exts: C_EXTS, global: true, globalFunctions: true, transitive: true },
  cpp: { paths: true, exts: C_EXTS, global: true, globalFunctions: true, transitive: true, implicitThis: true, pkgParents: true },
  objc: { paths: true, exts: C_EXTS, global: true, globalFunctions: true, transitive: true, implicitThis: true },
  csharp: { pkgPrefix: true, pkgParents: true, implicitThis: true },
  fsharp: { pkgPrefix: true, pkgParents: true },
  swift: { sameTarget: true, implicitThis: true },
  dart: { paths: true, exts: ['.dart'], implicitThis: true },
  ruby: { exts: ['.rb'], global: true, implicitThis: true, pkgParents: true },
  php: { pkgPrefix: true, global: true, globalFunctions: true },
  lua: { exts: ['.lua'] },
  perl: { global: true },
  r: { paths: true, exts: ['.R', '.r'], global: true, globalFunctions: true, transitive: true },
  julia: { exts: ['.jl'], implicitThis: true, transitive: true },
  haskell: { pkgPrefix: true, topMembers: true },
  ocaml: { pkgPrefix: true, capitalize: true },
  elixir: { global: true, implicitThis: true },
  erlang: { pkgPrefix: true, global: true },
  elm: { pkgPrefix: true },
  clojure: { pkgPrefix: true, hyphens: true, topMembers: true },
  zig: { paths: true, exts: ['.zig'] },
  bash: { paths: true, exts: ['.sh', '.bash'], global: true, transitive: true },
  powershell: { paths: true, exts: ['.ps1', '.psm1'], global: true, transitive: true },
  solidity: { paths: true, exts: ['.sol'], implicitThis: true },
  hcl: { sameDir: true, dirModules: true },
  sql: { global: true, globalFunctions: true, schemas: true },
};

export function rulesFor(lang: LangId): LangRules {
  return RULES[lang] ?? {};
}

/** `Shop::Pricing`, `Shop\Pricing`, `shop/pricing`, `.Pricing` → `Shop.Pricing` style keys. */
export function normModule(spec: string): string {
  return spec
    .trim()
    .replace(/^["'<`]|["'>`]$/g, '')
    .replace(/::|\\|\//g, '.')
    .replace(/^\.+|\.+$/g, '');
}

const INDEX_FILES = new Set(['init', 'mod', 'index', '__init__', 'lib', 'main']);

/**
 * Module names a file answers to, most specific first: its path without the extension as
 * dotted suffixes (`src/shop/pricing.lua` → `src.shop.pricing`, `shop.pricing`, `pricing`).
 * Rust crates also get their crate-relative module path first (`src/a/b.rs` → `a.b`).
 */
export function pathKeys(rel: string, lang: LangId, rules: LangRules): string[] {
  const noExt = rel.replace(/\.[^./]+$/, '');
  let segs = noExt.split('/').filter(Boolean);
  const out: string[] = [];
  if (lang === 'rust') {
    const src = segs.lastIndexOf('src');
    const inCrate = src >= 0 ? segs.slice(src + 1) : segs;
    const last = inCrate[inCrate.length - 1];
    const mod = last && INDEX_FILES.has(last) ? inCrate.slice(0, -1) : inCrate;
    out.push(mod.join('.'));
  }
  if (lang === 'swift') {
    // Swift Package Manager: `Sources/<Target>/…` is the module; an Xcode app is one module.
    const i = segs.findIndex((s) => s === 'Sources' || s === 'Tests');
    out.push(i >= 0 && segs[i + 1] ? (segs[i + 1] as string) : '');
    return out;
  }
  const last = segs[segs.length - 1];
  if (last && INDEX_FILES.has(last) && segs.length > 1 && lang !== 'c' && lang !== 'cpp') segs = segs.slice(0, -1);
  if (rules.capitalize) segs = segs.map((s, i) => (i === segs.length - 1 && s ? s[0]?.toUpperCase() + s.slice(1) : s));
  for (let i = 0; i < segs.length; i++) {
    const key = segs.slice(i).join('.');
    out.push(key);
    if (rules.hyphens && key.includes('_')) out.push(key.replace(/_/g, '-'));
  }
  return out;
}

/**
 * Repository paths a file-path import may mean, most likely first: relative to the importing
 * file, then to the repository root; `package:<pkg>/x.dart` maps to `lib/x.dart`. Shell-style
 * specs keep only their literal tail (`"$(dirname "$0")/lib/x.sh"` → `lib/x.sh`).
 */
export function pathCandidates(fromDir: string, spec: string, rules: LangRules): string[] {
  let s = spec.trim().replace(/^["'<`]|["'>`]$/g, '');
  const pkg = /^package:[^/]+\/(.+)$/.exec(s);
  const out: string[] = [];
  const add = (p: string): void => {
    const n = path.posix.normalize(p).replace(/^\.\//, '');
    if (n.startsWith('..')) return;
    if (!out.includes(n)) out.push(n);
    const hasExt = /\.[A-Za-z0-9]+$/.test(n);
    if (!hasExt) for (const ext of rules.exts ?? []) if (!out.includes(`${n}${ext}`)) out.push(`${n}${ext}`);
  };
  if (pkg?.[1]) {
    add(`lib/${pkg[1]}`);
    return out;
  }
  // `$PSScriptRoot/x.ps1`, `$(dirname "$0")/x.sh`, `${DIR}/x.sh`: the variable part is the file's directory.
  const dynamic = /^(.*[$)}])[/\\](.+)$/.exec(s);
  if (dynamic?.[2] && !/[$`]/.test(dynamic[2])) s = `./${dynamic[2]}`;
  if (/[$`]/.test(s)) return out;
  s = s.replace(/\\/g, '/');
  if (s.startsWith('/')) return out;
  add(path.posix.join(fromDir, s));
  add(s);
  return out;
}
