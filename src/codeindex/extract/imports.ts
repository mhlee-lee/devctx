import type { Node } from 'web-tree-sitter';
import type { Builder } from './common.ts';

/**
 * Import statements of the table-driven languages as `named` / `module` / `wild` / `file`
 * facts (see modules.ts for what each kind means to the resolver). Most are read from the
 * statement text: import syntax is small and stable, while grammar node shapes differ a lot
 * between grammar versions.
 */

/** Splits on commas outside `{}`, `[]` and `()`. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (s: string): string => s.trim().replace(/^["'`<]|["'`>]$/g, '');

/** `use a::b::{C, d as e, self}`, `use a::*`, `pub use x as y;` */
export function rustUse(b: Builder, n: Node): void {
  const t = n.text
    .replace(/^\s*(pub(\([^)]*\))?\s+)?use\s+/, '')
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(::|,|\{|\})\s*/g, '$1')
    .trim();
  const join = (a: string, c: string): string => (a && c ? `${a}::${c}` : a || c);
  const walk = (prefix: string, tree: string): void => {
    if (!tree) return;
    const brace = tree.indexOf('{');
    if (brace >= 0 && tree.endsWith('}')) {
      const head = tree.slice(0, brace).replace(/::$/, '');
      for (const part of splitTop(tree.slice(brace + 1, -1))) walk(join(prefix, head), part);
      return;
    }
    const m = /^(.*?)(?: as (\w+))?$/.exec(tree);
    const full = join(prefix, m?.[1] ?? tree);
    const alias = m?.[2];
    if (full.endsWith('::*') || full === '*') {
      b.imp('wild', full.replace(/::\*$|^\*$/, ''), '', '');
      return;
    }
    const segs = full.split('::');
    const last = segs.pop() ?? '';
    const mod = segs.join('::');
    if (last === 'self') {
      const name = alias ?? segs[segs.length - 1] ?? '';
      if (name) b.imp('module', mod, '', name);
      return;
    }
    const name = alias ?? last;
    if (!name || name === '_') return;
    // `use crate::pricing;` may name a module or an item: both bindings, the resolver tries each.
    b.imp('named', mod, last, name);
    b.imp('module', full, '', name);
  };
  walk('', t);
}

/** `#include "x.h"` / `#import <x.h>`, C++ `using namespace a::b;`, `using a::B;`, `namespace x = a::b;`. */
export function cImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').trim();
  const inc = /^#\s*(?:include|import)\s*[<"]([^>"]+)[>"]/.exec(t);
  if (inc?.[1]) {
    b.imp('file', inc[1], '', '');
    return;
  }
  let m = /^using namespace ([\w:]+)\s*;?$/.exec(t);
  if (m?.[1]) {
    b.imp('wild', m[1].replace(/^::/, ''), '', '');
    return;
  }
  m = /^using ([\w:]+)::(\w+)\s*;?$/.exec(t);
  if (m?.[1] && m[2]) {
    b.imp('named', m[1].replace(/^::/, ''), m[2], m[2]);
    return;
  }
  m = /^namespace (\w+) = ([\w:]+)\s*;?$/.exec(t);
  if (m?.[1] && m[2]) b.imp('module', m[2].replace(/^::/, ''), '', m[1]);
}

/** C#: `using A.B;`, `using static A.B.C;`, `using M = A.B.C;`, `global using …`. */
export function csUsing(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').replace(/^global /, '').replace(/;\s*$/, '').trim();
  let m = /^using static ([\w.]+)$/.exec(t);
  if (m?.[1]) {
    b.imp('wild', m[1], '', '');
    return;
  }
  m = /^using (\w+) ?= ?([\w.]+)(?:<.*>)?$/.exec(t);
  if (m?.[1] && m[2]) {
    const dot = m[2].lastIndexOf('.');
    if (dot > 0) b.imp('named', m[2].slice(0, dot), m[2].slice(dot + 1), m[1]);
    b.imp('module', m[2], '', m[1]);
    return;
  }
  m = /^using ([\w.]+)$/.exec(t);
  if (m?.[1]) b.imp('wild', m[1], '', '');
}

/** Dart: `import 'x.dart' as p show a, b hide c;` (`export` re-exports are not followed). */
export function dartImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').trim();
  const m = /^import\s+(['"])(.+?)\1(.*?);?$/.exec(t);
  if (!m?.[2]) return;
  const spec = m[2];
  const rest = m[3] ?? '';
  const alias = /\bas (\w+)/.exec(rest)?.[1];
  const show = /\bshow ([\w\s,]+?)(?:\bhide\b|$)/.exec(rest)?.[1];
  if (alias) b.imp('module', spec, '', alias);
  if (show) for (const name of show.split(',').map((s) => s.trim()).filter(Boolean)) b.imp('named', spec, name, name);
  else if (!alias) b.imp('wild', spec, '', '');
}

/** PHP: `use A\B\C;`, `use A\B\C as D;`, `use function A\f;`, `use A\{B, C as D};`. */
export function phpUse(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').replace(/^use\s+/, '').replace(/;\s*$/, '').trim();
  const kind = /^(function|const)\s+/.exec(t)?.[1];
  const body = kind ? t.slice(kind.length).trim() : t;
  const bind = (full: string): void => {
    const m = /^\\?([\w\\]+?)(?: as (\w+))?$/.exec(full.trim());
    if (!m?.[1]) return;
    const path = m[1];
    const cut = path.lastIndexOf('\\');
    const name = cut >= 0 ? path.slice(cut + 1) : path;
    b.imp('named', cut >= 0 ? path.slice(0, cut) : '', name, m[2] ?? name);
  };
  const group = /^\\?([\w\\]+)\\\{(.*)\}$/.exec(body);
  if (group?.[1] && group[2] !== undefined) {
    for (const part of splitTop(group[2])) bind(`${group[1]}\\${part.replace(/^(function|const)\s+/, '')}`);
    return;
  }
  for (const part of splitTop(body)) bind(part);
}

/** Solidity: `import "./x.sol";`, `import "./x.sol" as X;`, `import * as X from "…";`, `import {A, B as C} from "…";`. */
export function solidityImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
  const spec = /["']([^"']+)["']/.exec(t)?.[1];
  if (!spec) return;
  const named = /^import \{(.*)\} from/.exec(t);
  if (named?.[1]) {
    for (const part of splitTop(named[1])) {
      const m = /^(\w+)(?: as (\w+))?$/.exec(part);
      if (m?.[1]) b.imp('named', spec, m[1], m[2] ?? m[1]);
    }
    return;
  }
  const alias = /^import \* as (\w+) from/.exec(t)?.[1] ?? /["'] as (\w+)$/.exec(t)?.[1];
  if (alias) b.imp('module', spec, '', alias);
  else b.imp('wild', spec, '', '');
}

/** Haskell: `import qualified M as P`, `import M (a, B(..))`, `import M hiding (x)`, `import M`. */
export function haskellImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').trim();
  const m = /^import\s+(?:safe\s+)?(qualified\s+)?(?:"[^"]*"\s+)?([A-Z][\w.]*)(\s+qualified)?(?:\s+as\s+([A-Z][\w.]*))?\s*(hiding\s*)?(\((.*)\))?\s*$/.exec(t);
  if (!m?.[2]) return;
  const mod = m[2];
  const qualified = Boolean(m[1] || m[3]);
  const alias = m[4] ?? mod;
  b.imp('module', mod, '', alias);
  if (qualified) return;
  const hiding = Boolean(m[5]);
  const list = m[7];
  if (list !== undefined && !hiding) {
    for (const item of splitTop(list)) {
      const name = /^\(?([\w']+|[^\w\s(),]+)\)?/.exec(item.trim())?.[1];
      if (name) b.imp('named', mod, name, name);
    }
  } else b.imp('wild', mod, '', '');
}

/** Elm: `import M as A exposing (x, T(..))`, `exposing (..)`. */
export function elmImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').trim();
  const m = /^import ([A-Z][\w.]*)(?: as ([A-Z]\w*))?(?: exposing \((.*)\))?$/.exec(t);
  if (!m?.[1]) return;
  b.imp('module', m[1], '', m[2] ?? m[1]);
  const exposing = m[3]?.trim();
  if (exposing === '..') b.imp('wild', m[1], '', '');
  else if (exposing) {
    for (const item of splitTop(exposing)) {
      const name = /^\(?([\w']+)/.exec(item)?.[1];
      if (name) b.imp('named', m[1], name, name);
    }
  }
}

/** Julia: `using .M`, `using A, B`, `using M: a, b`, `import .M: f`, `import M`, `import M as N`. */
export function juliaImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, ' ').trim();
  const m = /^(using|import) (.+)$/.exec(t);
  if (!m?.[1] || !m[2]) return;
  const strip = (s: string): string => s.trim().replace(/^\.+/, '');
  const colon = m[2].indexOf(':');
  if (colon > 0) {
    const mod = strip(m[2].slice(0, colon));
    for (const part of splitTop(m[2].slice(colon + 1))) {
      const p = /^(\S+)(?: as (\S+))?$/.exec(part.trim());
      if (p?.[1]) b.imp('named', mod, p[1], p[2] ?? p[1]);
    }
    return;
  }
  for (const part of splitTop(m[2])) {
    const p = /^(\S+)(?: as (\S+))?$/.exec(part.trim());
    if (!p?.[1]) continue;
    const mod = strip(p[1]);
    b.imp('module', mod, '', p[2] ?? mod.split('.').pop() ?? mod);
    if (m[1] === 'using') b.imp('wild', mod, '', '');
  }
}

/** Erlang `-import(mod, [f/1, g/2]).` */
export function erlangImport(b: Builder, n: Node): void {
  const t = n.text.replace(/\s+/g, '');
  const m = /^-import\(([\w@]+),\[(.*)\]\)\.?$/.exec(t);
  if (m?.[1] && m[2] !== undefined) {
    for (const fa of m[2].split(',')) {
      const name = fa.split('/')[0];
      if (name) b.imp('named', m[1], name, name);
    }
    return;
  }
  const inc = /^-include(?:_lib)?\("([^"]+)"\)/.exec(t);
  if (inc?.[1]) b.imp('file', inc[1], '', '');
}

/**
 * Clojure `(ns a.b (:require [x.y :as y :refer [f g]] [z :refer :all] w) (:use [u :only [h]]))`.
 */
export function clojureNs(b: Builder, ns: Node): void {
  const sym = (n: Node | null | undefined): string => (n && n.type === 'sym_lit' ? n.text : '');
  const kwd = (n: Node | null | undefined): string => (n && n.type === 'kwd_lit' ? n.text : '');
  const values = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null && c.type !== 'meta_lit' && c.type !== 'comment');
  for (const clause of values(ns)) {
    if (clause.type !== 'list_lit') continue;
    const [head, ...specs] = values(clause);
    const form = kwd(head);
    if (form !== ':require' && form !== ':use') continue;
    for (const spec of specs) {
      if (spec.type === 'sym_lit') {
        b.imp('module', spec.text, '', spec.text);
        if (form === ':use') b.imp('wild', spec.text, '', '');
        continue;
      }
      if (spec.type !== 'vec_lit' && spec.type !== 'list_lit') continue;
      const [first, ...opts] = values(spec);
      const mod = sym(first);
      if (!mod) continue;
      let alias = mod;
      let wild = form === ':use';
      for (let i = 0; i < opts.length; i++) {
        const key = kwd(opts[i]);
        const val = opts[i + 1];
        if (key === ':as' && sym(val)) alias = sym(val);
        else if ((key === ':refer' || key === ':only') && val) {
          if (kwd(val) === ':all') wild = true;
          else {
            wild = false;
            for (const r of values(val)) if (sym(r)) b.imp('named', mod, sym(r), sym(r));
          }
        }
      }
      b.imp('module', mod, '', alias);
      if (wild) b.imp('wild', mod, '', '');
    }
  }
}

/**
 * Perl `use` statements: `use Foo qw(a b);` names; `use parent -norequire, 'Base';` and
 * `use base qw(Base)` return the supertypes for the enclosing package.
 */
export function perlUse(b: Builder, n: Node): string[] {
  const t = n.text.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
  const m = /^use ([\w:]+)\s*(.*)$/.exec(t);
  if (!m?.[1]) return [];
  const words = (s: string): string[] => {
    const qw = /qw\s*[(/{[]([^)/}\]]*)[)/}\]]/.exec(s);
    if (qw?.[1] !== undefined) return qw[1].split(/\s+/).filter(Boolean);
    return [...s.matchAll(/["']([^"']+)["']/g)].map((x) => x[1] as string);
  };
  if (m[1] === 'parent' || m[1] === 'base') return words(m[2] ?? '').filter((w) => !w.startsWith('-'));
  for (const name of words(m[2] ?? '')) if (/^[&$@%]?\w+$/.test(name)) b.imp('named', m[1], name.replace(/^[&$@%]/, ''), name.replace(/^[&$@%]/, ''));
  return [];
}
