import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../facts.ts';
import { Builder, TOP, leadingComment, lineOf, type Scope } from './common.ts';

const CLASS_KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'interface',
};

const PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double', 'void', 'var']);

/** `Map<K, V>` → `Map`, `a.b.C` → `C`, `int[]` → '' (only class names matter for resolution). */
export function javaType(n: Node | null): string {
  if (!n) return '';
  switch (n.type) {
    case 'type_identifier':
      return PRIMITIVES.has(n.text) ? '' : n.text;
    case 'generic_type':
      return javaType(n.namedChildren[0] ?? null);
    case 'scoped_type_identifier': {
      const last = n.namedChildren[n.namedChildren.length - 1];
      return last ? last.text : '';
    }
    case 'array_type':
      return '';
    default:
      return '';
  }
}

/** Receiver of `object.name(...)` in the encoding described on RefFact.recv. */
function receiver(obj: Node | null): string {
  if (!obj) return '';
  switch (obj.type) {
    case 'this':
      return 'this';
    case 'super':
      return 'super';
    case 'identifier':
      return `v:${obj.text}`;
    case 'field_access': {
      const o = obj.childForFieldName('object');
      const f = obj.childForFieldName('field');
      if (!o || !f) return 'x';
      if (o.type === 'this') return `f:${f.text}`;
      if (o.type === 'identifier') return `v:${o.text}.${f.text}`;
      return 'x';
    }
    default:
      return 'x';
  }
}

export function extractJava(b: Builder, root: Node): void {
  const visitAll = (n: Node, s: Scope): void => {
    for (const c of n.namedChildren) if (c) visit(c, s);
  };

  const visit = (n: Node, s: Scope): void => {
    switch (n.type) {
      case 'package_declaration': {
        const id = n.namedChildren.find((c) => c && (c.type === 'scoped_identifier' || c.type === 'identifier'));
        if (id) b.f.pkg = id.text;
        return;
      }
      case 'import_declaration': {
        const m = /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(n.text.replace(/\s+/g, ' '));
        if (!m) return;
        const [, isStatic, target = '', wild] = m;
        if (wild) b.imp('wild', target, '', '');
        else {
          const name = target.slice(target.lastIndexOf('.') + 1);
          b.imp(isStatic ? 'static' : 'named', target, name, name);
        }
        return;
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration':
      case 'annotation_type_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const idx = b.sym(n, name, CLASS_KINDS[n.type] ?? 'class', s.cls, { body, doc: leadingComment(n), exported: !isPrivate(n) });
        const line = lineOf(n);
        const superclass = n.childForFieldName('superclass');
        if (superclass) b.ref(idx, javaType(superclass.namedChildren[0] ?? null), 'inherit', line);
        const lists = [n.childForFieldName('interfaces'), n.namedChildren.find((c) => c?.type === 'extends_interfaces') ?? null];
        for (const list of lists) {
          const types = list?.namedChildren.find((c) => c?.type === 'type_list');
          for (const t of types?.namedChildren ?? []) if (t) b.ref(idx, javaType(t), 'inherit', line);
        }
        if (n.type === 'record_declaration') {
          for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
            if (p?.type === 'formal_parameter') b.variable(idx, p.childForFieldName('name')?.text ?? '', javaType(p.childForFieldName('type')), '', true);
          }
        }
        if (body) visitAll(body, { sym: idx, cls: idx, fn: -1 });
        return;
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const kind: SymbolKind = n.type === 'method_declaration' ? (s.cls >= 0 ? 'method' : 'function') : 'constructor';
        const idx = b.sym(n, name, kind, s.cls, { body, doc: leadingComment(n), returns: javaType(n.childForFieldName('type')), exported: !isPrivate(n) });
        for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
          if (p?.type === 'formal_parameter' || p?.type === 'spread_parameter') {
            b.variable(idx, p.childForFieldName('name')?.text ?? '', javaType(p.childForFieldName('type')), '', false);
          }
        }
        if (body) visitAll(body, { sym: idx, cls: s.cls, fn: idx });
        return;
      }
      case 'field_declaration':
      case 'local_variable_declaration':
      case 'constant_declaration': {
        const field = n.type !== 'local_variable_declaration';
        const declared = javaType(n.childForFieldName('type'));
        for (const d of n.namedChildren) {
          if (d?.type !== 'variable_declarator') continue;
          const value = d.childForFieldName('value');
          let type = declared;
          let call = '';
          if (!type && value?.type === 'object_creation_expression') type = javaType(value.childForFieldName('type'));
          if (!type && value?.type === 'method_invocation') call = invocationText(value);
          b.variable(field ? s.cls : s.fn, d.childForFieldName('name')?.text ?? '', type, call, field);
        }
        visitAll(n, s);
        return;
      }
      case 'enhanced_for_statement': {
        b.variable(s.fn, n.childForFieldName('name')?.text ?? '', javaType(n.childForFieldName('type')), '', false);
        visitAll(n, s);
        return;
      }
      case 'method_invocation': {
        const name = n.childForFieldName('name')?.text ?? '';
        b.ref(s.sym, name, 'call', lineOf(n), receiver(n.childForFieldName('object')));
        visitAll(n, s);
        return;
      }
      case 'method_reference': {
        const parts = n.namedChildren.filter((c): c is Node => c !== null);
        const target = parts[parts.length - 1];
        const head = parts[0];
        if (target && head && target !== head && target.type === 'identifier') {
          b.ref(s.sym, target.text, 'call', lineOf(n), receiver(head));
        }
        return;
      }
      case 'object_creation_expression': {
        b.ref(s.sym, javaType(n.childForFieldName('type')), 'new', lineOf(n));
        visitAll(n, s);
        return;
      }
      default:
        visitAll(n, s);
    }
  };

  visit(root, TOP);
}

function isPrivate(n: Node): boolean {
  const mods = n.namedChildren.find((c) => c?.type === 'modifiers');
  return mods ? /\bprivate\b/.test(mods.text) : false;
}

/** `make()` / `Foo.create()` / `repo.find()`: callee text used to infer a variable's type later. */
function invocationText(n: Node): string {
  const name = n.childForFieldName('name')?.text ?? '';
  const obj = n.childForFieldName('object');
  if (!obj) return name;
  if (obj.type === 'identifier') return `${obj.text}.${name}`;
  return '';
}
