import type { Node } from 'web-tree-sitter';
import { FACTS_VERSION, type FileFacts, type ImportKind, type LangId, type RefKind, type SymbolKind, type VarFact } from '../facts.ts';

/** Where the walker is: innermost symbol, innermost class-like symbol, innermost function. */
export interface Scope {
  sym: number;
  cls: number;
  fn: number;
}

export const TOP: Scope = { sym: -1, cls: -1, fn: -1 };

const SIG_MAX = 200;
const DOC_MAX = 120;

export function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

export function endOf(n: Node): number {
  return n.endPosition.row + 1;
}

export function firstNamed(n: Node, types: ReadonlySet<string> | string): Node | null {
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (typeof types === 'string' ? c.type === types : types.has(c.type)) return c;
  }
  return null;
}

export function namedOfType(n: Node, type: string): Node[] {
  return n.namedChildren.filter((c): c is Node => c !== null && c.type === type);
}

/** True when one of the first `limit` children (named or not) has the given type. */
export function hasToken(n: Node, type: string, limit = 8): boolean {
  const count = Math.min(n.childCount, limit);
  for (let i = 0; i < count; i++) if (n.child(i)?.type === type) return true;
  return false;
}

/** First line of a comment block, without comment markers. */
export function cleanDoc(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#)\s?/, '')
      .replace(/\*\/\s*$/, '')
      .trim();
    if (line && !line.startsWith('@')) return line.length > DOC_MAX ? `${line.slice(0, DOC_MAX - 1)}…` : line;
  }
  return '';
}

const COMMENT_TYPES = new Set(['comment', 'block_comment', 'line_comment', 'multiline_comment']);

/** The comment directly above `n` (at most one blank line apart). */
export function leadingComment(n: Node): string {
  const prev = n.previousNamedSibling;
  if (!prev || !COMMENT_TYPES.has(prev.type)) return '';
  if (n.startPosition.row - prev.endPosition.row > 1) return '';
  return cleanDoc(prev.text);
}

export class Builder {
  readonly f: FileFacts;
  readonly src: string;

  constructor(lang: LangId, src: string) {
    this.src = src;
    this.f = { v: FACTS_VERSION, lang, pkg: '', syms: [], refs: [], imps: [], vars: [], exps: [] };
  }

  /** Declaration head: from the node start to its body, annotations stripped, one line. */
  signature(n: Node, body: Node | null): string {
    let end = body ? body.startIndex : Math.min(n.endIndex, n.startIndex + SIG_MAX * 4);
    if (!body) {
      // No body to stop at: the declaration's first line is its head.
      const nl = this.src.indexOf('\n', n.startIndex);
      if (nl > n.startIndex && nl < end) end = nl;
    }
    let text = this.src.slice(n.startIndex, end);
    text = text
      .replace(/\s+/g, ' ')
      .replace(/^(@[\w.]+(\([^)]*\))?\s*)+/, '')
      .replace(/^export\s+(default\s+)?/, '')
      .replace(/[\s{:=]+$/, '')
      .trim();
    return text.length > SIG_MAX ? `${text.slice(0, SIG_MAX - 1)}…` : text;
  }

  sym(
    n: Node,
    name: string,
    kind: SymbolKind,
    parent: number,
    opts: { body?: Node | null; sig?: string; exported?: boolean; owner?: string; returns?: string; doc?: string } = {},
  ): number {
    this.f.syms.push({
      name,
      kind,
      parent,
      line: lineOf(n),
      end: endOf(n),
      sig: opts.sig ?? this.signature(n, opts.body ?? null),
      exported: opts.exported ?? false,
      owner: opts.owner ?? '',
      returns: opts.returns ?? '',
      doc: opts.doc ?? '',
    });
    return this.f.syms.length - 1;
  }

  ref(from: number, name: string, kind: RefKind, line: number, recv = ''): void {
    if (!name) return;
    this.f.refs.push({ from, name, kind, line, recv });
  }

  imp(kind: ImportKind, module: string, name: string, alias: string): void {
    if (this.f.imps.some((i) => i.kind === kind && i.module === module && i.name === name && i.alias === alias)) return;
    this.f.imps.push({ kind, module, name, alias });
  }

  variable(scope: number, name: string, type: string, call: string, field: boolean): void {
    if (!name || (!type && !call)) return;
    this.f.vars.push({ scope, name, type, call, field });
  }

  /** A typed variable already recorded in `scope` (e.g. a parameter assigned to a field). */
  varIn(scope: number, name: string): VarFact | undefined {
    for (let i = this.f.vars.length - 1; i >= 0; i--) {
      const v = this.f.vars[i];
      if (v && v.scope === scope && v.name === name) return v;
    }
    return undefined;
  }
}

export function isPascal(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}
