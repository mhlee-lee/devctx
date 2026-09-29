import type { Node } from 'web-tree-sitter';
import { Builder, TOP, cleanDoc, lineOf, type Scope } from './common.ts';

const BUILTIN_TYPES = new Set(['int', 'str', 'float', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'None', 'object', 'Any']);

/** `Foo`, `"Foo"`, `Optional[Foo]`, `mod.Foo` → the class name ('' for builtins). */
export function pyType(n: Node | null): string {
  if (!n) return '';
  const inner = n.type === 'type' ? n.namedChildren[0] : n;
  if (!inner) return '';
  let text = inner.text.replace(/^["']|["']$/g, '').trim();
  const opt = /^(?:typing\.)?Optional\[(.+)\]$/.exec(text);
  if (opt?.[1]) text = opt[1];
  text = text.replace(/\s*\|\s*None$/, '');
  if (!/^[A-Za-z_][\w.]*$/.test(text)) return '';
  const name = text.slice(text.lastIndexOf('.') + 1);
  return BUILTIN_TYPES.has(name) ? '' : text;
}

function receiver(obj: Node | null): string {
  if (!obj) return 'x';
  if (obj.type === 'identifier') return obj.text === 'self' || obj.text === 'cls' ? 'this' : `v:${obj.text}`;
  if (obj.type === 'attribute') {
    const o = obj.childForFieldName('object');
    const a = obj.childForFieldName('attribute');
    if (!o || !a) return 'x';
    if (o.type === 'identifier' && (o.text === 'self' || o.text === 'cls')) return `f:${a.text}`;
    if (o.type === 'identifier') return `v:${o.text}.${a.text}`;
    return 'x';
  }
  if (obj.type === 'call' && obj.childForFieldName('function')?.text === 'super') return 'super';
  return 'x';
}

/** `Foo()` → `Foo`, `mod.Foo()` → `mod.Foo`. */
function callText(n: Node | null): string {
  if (n?.type !== 'call') return '';
  const fn = n.childForFieldName('function');
  if (fn?.type === 'identifier') return fn.text;
  if (fn?.type === 'attribute') {
    const o = fn.childForFieldName('object');
    const a = fn.childForFieldName('attribute');
    if (o?.type === 'identifier' && a) return `${o.text}.${a.text}`;
  }
  return '';
}

function docstring(body: Node | null): string {
  const first = body?.namedChildren[0];
  if (first?.type !== 'expression_statement') return '';
  const str = first.namedChildren[0];
  return str?.type === 'string' ? cleanDoc(str.text.replace(/^[rbuf]*("""|'''|"|')|("""|'''|"|')$/g, '')) : '';
}

export function extractPython(b: Builder, root: Node): void {
  const visitAll = (n: Node, s: Scope): void => {
    for (const c of n.namedChildren) if (c) visit(c, s);
  };

  const visit = (n: Node, s: Scope): void => {
    switch (n.type) {
      case 'import_statement':
        for (const c of n.childrenForFieldName('name')) {
          if (!c) continue;
          if (c.type === 'aliased_import') {
            b.imp('module', c.childForFieldName('name')?.text ?? '', '', c.childForFieldName('alias')?.text ?? '');
          } else b.imp('module', c.text, '', c.text);
        }
        return;
      case 'import_from_statement': {
        const mod = n.childForFieldName('module_name')?.text.replace(/\s+/g, '') ?? '';
        if (n.namedChildren.some((c) => c?.type === 'wildcard_import')) {
          b.imp('wild', mod, '', '');
          return;
        }
        for (const c of n.childrenForFieldName('name')) {
          if (!c) continue;
          if (c.type === 'aliased_import') {
            const name = c.childForFieldName('name')?.text ?? '';
            b.imp('named', mod, name, c.childForFieldName('alias')?.text ?? name);
          } else b.imp('named', mod, c.text, c.text);
        }
        return;
      }
      case 'decorated_definition': {
        for (const d of n.namedChildren) if (d?.type === 'decorator') visitAll(d, s);
        const def = n.childForFieldName('definition');
        if (def) visit(def, s);
        return;
      }
      case 'class_definition': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const idx = b.sym(n, name, 'class', s.cls, { body, doc: docstring(body), exported: !name.startsWith('_') });
        for (const base of n.childForFieldName('superclasses')?.namedChildren ?? []) {
          if (base?.type === 'identifier') b.ref(idx, base.text, 'inherit', lineOf(n));
          else if (base?.type === 'attribute') {
            const o = base.childForFieldName('object');
            b.ref(idx, base.childForFieldName('attribute')?.text ?? '', 'inherit', lineOf(n), o?.type === 'identifier' ? `v:${o.text}` : 'x');
          }
        }
        if (body) visitAll(body, { sym: idx, cls: idx, fn: -1 });
        return;
      }
      case 'function_definition': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const inClass = s.cls >= 0 && s.fn < 0;
        const kind = inClass ? (name === '__init__' ? 'constructor' : 'method') : 'function';
        const idx = b.sym(n, name, kind, inClass ? s.cls : -1, {
          body,
          returns: pyType(n.childForFieldName('return_type')),
          doc: docstring(body),
          exported: !name.startsWith('_') || name === '__init__',
        });
        for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
          if (p?.type === 'typed_parameter') {
            const pname = p.namedChildren.find((c) => c?.type === 'identifier')?.text ?? '';
            b.variable(idx, pname, pyType(p.childForFieldName('type')), '', false);
          } else if (p?.type === 'typed_default_parameter') {
            b.variable(idx, p.childForFieldName('name')?.text ?? '', pyType(p.childForFieldName('type')), '', false);
          }
        }
        if (body) visitAll(body, { sym: idx, cls: inClass ? s.cls : -1, fn: idx });
        return;
      }
      case 'assignment': {
        const left = n.childForFieldName('left');
        const right = n.childForFieldName('right');
        const declared = pyType(n.childForFieldName('type'));
        const call = declared ? '' : callText(right);
        if (left?.type === 'identifier') {
          const field = s.fn < 0 && s.cls >= 0;
          b.variable(field ? s.cls : s.fn, left.text, declared, call, field);
        } else if (left?.type === 'attribute' && s.cls >= 0) {
          const o = left.childForFieldName('object');
          const attr = left.childForFieldName('attribute')?.text ?? '';
          if (o?.type === 'identifier' && o.text === 'self') {
            // `self.repo = repo` takes the parameter's annotated type.
            const fromParam = right?.type === 'identifier' ? b.varIn(s.fn, right.text) : undefined;
            b.variable(s.cls, attr, declared || fromParam?.type || '', fromParam ? '' : call, true);
          }
        }
        visitAll(n, s);
        return;
      }
      case 'call': {
        const fn = n.childForFieldName('function');
        if (fn?.type === 'identifier') {
          if (fn.text !== 'super') b.ref(s.sym, fn.text, 'call', lineOf(n));
        } else if (fn?.type === 'attribute') {
          const attr = fn.childForFieldName('attribute');
          if (attr) b.ref(s.sym, attr.text, 'call', lineOf(n), receiver(fn.childForFieldName('object')));
        }
        visitAll(n, s);
        return;
      }
      default:
        visitAll(n, s);
    }
  };

  visit(root, TOP);
}
