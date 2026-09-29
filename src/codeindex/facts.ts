/**
 * Per-file facts produced by the extractors. They are the only thing persisted per file
 * (`.devctx/local/code.sqlite`); the call graph is rebuilt from them in memory, so a changed file
 * never needs more than its own re-parse.
 */

/** Bump when extractors change what they emit: every file is re-parsed on the next sync. */
export const FACTS_VERSION = 2;

/** Language id from `languages.ts` (`java`, `rust`, `tsx`, ...). */
export type LangId = string;

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'record'
  | 'object'
  | 'struct'
  | 'type'
  | 'module'
  | 'function'
  | 'method'
  | 'constructor'
  | 'component'
  | 'hook'
  | 'macro';

/**
 * `call` a call, `new` an instantiation, `render` a JSX element, `inherit` extends/implements,
 * `type` a type, table or constant reference (Terraform addresses, SQL relations).
 */
export type RefKind = 'call' | 'new' | 'render' | 'inherit' | 'type';

/**
 * `named` binds `name` from `module` as `alias`; `default` binds the default export; `ns` binds the
 * whole module (`import * as x`, `const x = require()`); `module` binds a module as `alias`
 * (Python/Go imports, `use a::b`, `alias Shop.Pricing`, `import X as P`); `static` a Java
 * static member import; `wild` makes every name of a module visible; `file` includes or sources
 * a file by path (`#include`, `source`, `. ./x.ps1`); `rx`/`rx*` are re-exports.
 */
export type ImportKind = 'named' | 'default' | 'ns' | 'module' | 'static' | 'wild' | 'rx' | 'rx*' | 'file';

export interface SymbolFact {
  name: string;
  kind: SymbolKind;
  /** Index of the enclosing class-like symbol in the same file, -1 at file level. */
  parent: number;
  line: number;
  end: number;
  /** Declaration head without the body, whitespace collapsed. */
  sig: string;
  exported: boolean;
  /** Go methods: receiver type name (the type may live in another file of the package). */
  owner: string;
  /** Declared return type (simple or `pkg.Type` name) for receiver type inference. */
  returns: string;
  doc: string;
}

export interface RefFact {
  /** Enclosing symbol index, -1 for file-level code. */
  from: number;
  name: string;
  kind: RefKind;
  line: number;
  /**
   * Receiver of a member call: '' none, 'this', 'super', 'f:<field>' (field of this),
   * 'v:<name>' or 'v:<name>.<field>' (identifier receivers), 'x' anything else.
   */
  recv: string;
}

export interface ImportFact {
  kind: ImportKind;
  module: string;
  name: string;
  alias: string;
}

/** A typed local, parameter, file-level variable or field (`field` = member of `scope`). */
export interface VarFact {
  scope: number;
  name: string;
  /** Declared or constructed type name ('' if unknown). */
  type: string;
  /** Initializer call (`make`, `pkg.New`, `Foo.create`) when the type must come from its return type. */
  call: string;
  field: boolean;
}

export interface FileFacts {
  v: number;
  lang: LangId;
  /** Java/Kotlin package, Go package name. */
  pkg: string;
  syms: SymbolFact[];
  refs: RefFact[];
  imps: ImportFact[];
  vars: VarFact[];
  /** JS/TS exports: [exported name, local name]; `default` for the default export. */
  exps: [string, string][];
}

// Append only: positions are stored in code.sqlite.
const KINDS: readonly SymbolKind[] = ['class', 'interface', 'enum', 'record', 'object', 'struct', 'type', 'function', 'method', 'constructor', 'component', 'hook', 'module', 'macro'];
const REF_KINDS: readonly RefKind[] = ['call', 'new', 'render', 'inherit', 'type'];
const IMPORT_KINDS: readonly ImportKind[] = ['named', 'default', 'ns', 'module', 'static', 'wild', 'rx', 'rx*', 'file'];

/** Compact positional JSON: facts of a large repository stay small and parse fast. */
export function encodeFacts(f: FileFacts): string {
  return JSON.stringify([
    f.v,
    f.lang,
    f.pkg,
    f.syms.map((s) => [s.name, KINDS.indexOf(s.kind), s.parent, s.line, s.end, s.sig, s.exported ? 1 : 0, s.owner, s.returns, s.doc]),
    f.refs.map((r) => [r.from, r.name, REF_KINDS.indexOf(r.kind), r.line, r.recv]),
    f.imps.map((i) => [IMPORT_KINDS.indexOf(i.kind), i.module, i.name, i.alias]),
    f.vars.map((v) => [v.scope, v.name, v.type, v.call, v.field ? 1 : 0]),
    f.exps,
  ]);
}

type Row = unknown[];

export function decodeFacts(text: string): FileFacts | null {
  try {
    const a = JSON.parse(text) as Row;
    if (a[0] !== FACTS_VERSION) return null;
    return {
      v: a[0] as number,
      lang: a[1] as LangId,
      pkg: a[2] as string,
      syms: (a[3] as Row[]).map((s) => ({
        name: s[0] as string,
        kind: KINDS[s[1] as number] ?? 'function',
        parent: s[2] as number,
        line: s[3] as number,
        end: s[4] as number,
        sig: s[5] as string,
        exported: s[6] === 1,
        owner: s[7] as string,
        returns: s[8] as string,
        doc: s[9] as string,
      })),
      refs: (a[4] as Row[]).map((r) => ({
        from: r[0] as number,
        name: r[1] as string,
        kind: REF_KINDS[r[2] as number] ?? 'call',
        line: r[3] as number,
        recv: r[4] as string,
      })),
      imps: (a[5] as Row[]).map((i) => ({
        kind: IMPORT_KINDS[i[0] as number] ?? 'named',
        module: i[1] as string,
        name: i[2] as string,
        alias: i[3] as string,
      })),
      vars: (a[6] as Row[]).map((v) => ({ scope: v[0] as number, name: v[1] as string, type: v[2] as string, call: v[3] as string, field: v[4] === 1 })),
      exps: a[7] as [string, string][],
    };
  } catch {
    return null;
  }
}
