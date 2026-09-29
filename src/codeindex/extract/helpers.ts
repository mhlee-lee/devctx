import type { Node } from 'web-tree-sitter';
import { dotted, receiverText, type CallInfo } from './spec.ts';

/** Small readers shared by the language tables (specs.ts, specs-more.ts). */

export const text = (n: Node | null | undefined): string => (n ? n.text : '');

export const child = (n: Node, type: string): Node | null => n.namedChildren.find((c) => c?.type === type) ?? null;

export const lastSeg = (s: string): string => s.split(/::|\.|\\|\//).filter(Boolean).pop() ?? s;

export function baseName(file: string): string {
  const b = file.slice(file.lastIndexOf('/') + 1);
  return b.replace(/\.[^.]+$/, '');
}

export function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : s;
}

/** Declaration text on one line (C prototypes, which have no body to stop at). */
export function oneLine(n: Node, max = 200): string {
  const t = n.text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Nearest ancestor of one of the given types (stops at `limit` levels). */
export function ancestor(n: Node, types: readonly string[], limit = 12): Node | null {
  let p = n.parent;
  for (let i = 0; p && i < limit; i++, p = p.parent) if (types.includes(p.type)) return p;
  return null;
}

/**
 * `Mod.Sub.fn` in ML-family languages: an upper-case qualifier is a module path (kept whole),
 * a lower-case one a value (`repo.Save`, `this.Log`).
 */
export function qualifiedCall(t: string): CallInfo | null {
  if (!/^[\w.'$]+$/.test(t)) return null;
  const dot = t.lastIndexOf('.');
  if (dot < 0) return { name: t, recv: '' };
  const qual = t.slice(0, dot);
  const first = qual.split('.')[0] ?? '';
  return { name: t.slice(dot + 1), recv: /^[A-Z]/.test(first) ? `m:${dotted(qual)}` : receiverText(`${qual}.`) };
}
