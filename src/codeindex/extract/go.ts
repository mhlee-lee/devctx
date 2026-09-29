import type { Node } from 'web-tree-sitter';
import { Builder, TOP, leadingComment, lineOf, type Scope } from './common.ts';

/** `*Service` → `Service`, `stock.Service` → `stock.Service`, `Box[T]` → `Box`; others ''. */
export function goType(n: Node | null): string {
  if (!n) return '';
  switch (n.type) {
    case 'type_identifier':
      return n.text;
    case 'pointer_type':
      return goType(n.namedChildren[0] ?? null);
    case 'qualified_type': {
      const pkg = n.childForFieldName('package')?.text;
      const name = n.childForFieldName('name')?.text;
      return pkg && name ? `${pkg}.${name}` : '';
    }
    case 'generic_type':
      return goType(n.childForFieldName('type'));
    case 'parameter_list': {
      const first = n.namedChildren.find((c) => c?.type === 'parameter_declaration');
      return first ? goType(first.childForFieldName('type')) : '';
    }
    default:
      return '';
  }
}

function bare(type: string): string {
  return type.slice(type.lastIndexOf('.') + 1);
}

function receiver(operand: Node | null): string {
  if (!operand) return 'x';
  if (operand.type === 'identifier') return `v:${operand.text}`;
  if (operand.type === 'selector_expression') {
    const o = operand.childForFieldName('operand');
    const f = operand.childForFieldName('field');
    if (o?.type === 'identifier' && f) return `v:${o.text}.${f.text}`;
  }
  return 'x';
}

/** Type or constructor call behind `x := <expr>`. */
function valueType(v: Node | null): { type: string; call: string } {
  if (!v) return { type: '', call: '' };
  if (v.type === 'composite_literal') return { type: goType(v.childForFieldName('type')), call: '' };
  if (v.type === 'unary_expression') return valueType(v.childForFieldName('operand'));
  if (v.type === 'call_expression') {
    const fn = v.childForFieldName('function');
    if (fn?.type === 'identifier') return { type: '', call: fn.text };
    if (fn?.type === 'selector_expression') {
      const o = fn.childForFieldName('operand');
      const f = fn.childForFieldName('field');
      if (o?.type === 'identifier' && f) return { type: '', call: `${o.text}.${f.text}` };
    }
  }
  return { type: '', call: '' };
}

export function extractGo(b: Builder, root: Node): void {
  const visitAll = (n: Node, s: Scope): void => {
    for (const c of n.namedChildren) if (c) visit(c, s);
  };

  const params = (list: Node | null, scope: number): void => {
    for (const p of list?.namedChildren ?? []) {
      if (p?.type !== 'parameter_declaration' && p?.type !== 'variadic_parameter_declaration') continue;
      const type = goType(p.childForFieldName('type'));
      for (const name of p.childrenForFieldName('name')) if (name) b.variable(scope, name.text, type, '', false);
    }
  };

  const importSpec = (spec: Node): void => {
    const pathNode = spec.childForFieldName('path');
    const target = pathNode ? pathNode.text.replace(/^["`]|["`]$/g, '') : '';
    const name = spec.childForFieldName('name')?.text ?? '';
    if (!target || name === '_') return;
    b.imp('module', target, '', name);
  };

  const visit = (n: Node, s: Scope): void => {
    switch (n.type) {
      case 'package_clause':
        b.f.pkg = n.namedChildren[0]?.text ?? '';
        return;
      case 'import_declaration':
        for (const c of n.namedChildren) {
          if (c?.type === 'import_spec') importSpec(c);
          else if (c?.type === 'import_spec_list') for (const spec of c.namedChildren) if (spec?.type === 'import_spec') importSpec(spec);
        }
        return;
      case 'function_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const idx = b.sym(n, name, 'function', -1, { body, returns: goType(n.childForFieldName('result')), doc: leadingComment(n), exported: /^[A-Z]/.test(name) });
        params(n.childForFieldName('parameters'), idx);
        if (body) visitAll(body, { sym: idx, cls: -1, fn: idx });
        return;
      }
      case 'method_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const recv = n.childForFieldName('receiver')?.namedChildren.find((c) => c?.type === 'parameter_declaration');
        const owner = bare(goType(recv?.childForFieldName('type') ?? null));
        const idx = b.sym(n, name, 'method', -1, { body, owner, returns: goType(n.childForFieldName('result')), doc: leadingComment(n), exported: /^[A-Z]/.test(name) });
        const recvName = recv?.childForFieldName('name')?.text;
        if (recvName) b.variable(idx, recvName, owner, '', false);
        params(n.childForFieldName('parameters'), idx);
        if (body) visitAll(body, { sym: idx, cls: -1, fn: idx });
        return;
      }
      case 'type_declaration':
        for (const spec of n.namedChildren) {
          if (spec?.type !== 'type_spec' && spec?.type !== 'type_alias') continue;
          const name = spec.childForFieldName('name')?.text ?? '';
          const type = spec.childForFieldName('type');
          const kind = type?.type === 'struct_type' ? 'struct' : type?.type === 'interface_type' ? 'interface' : 'type';
          const docNode = n.namedChildren.length === 1 ? n : spec;
          const idx = b.sym(spec, name, kind, -1, { sig: `type ${b.signature(spec, kind === 'type' ? null : (type?.namedChildren[0] ?? null))}`, doc: leadingComment(docNode), exported: /^[A-Z]/.test(name) });
          const line = lineOf(spec);
          if (type?.type === 'struct_type') {
            const fields = type.namedChildren.find((c) => c?.type === 'field_declaration_list');
            for (const fd of fields?.namedChildren ?? []) {
              if (fd?.type !== 'field_declaration') continue;
              const ftype = goType(fd.childForFieldName('type'));
              const names = fd.childrenForFieldName('name');
              if (names.length === 0) b.ref(idx, bare(ftype), 'inherit', lineOf(fd), ftype.includes('.') ? `v:${ftype.split('.')[0]}` : '');
              for (const fname of names) if (fname) b.variable(idx, fname.text, ftype, '', true);
            }
          } else if (type?.type === 'interface_type') {
            for (const el of type.namedChildren) {
              if (el?.type === 'method_elem') {
                b.sym(el, el.childForFieldName('name')?.text ?? '', 'method', idx, { returns: goType(el.childForFieldName('result')), doc: leadingComment(el), exported: true });
              } else if (el?.type === 'type_elem') {
                const t = goType(el.namedChildren[0] ?? null);
                if (t) b.ref(idx, bare(t), 'inherit', line, t.includes('.') ? `v:${t.split('.')[0]}` : '');
              }
            }
          }
        }
        return;
      case 'call_expression': {
        const fn = n.childForFieldName('function');
        if (fn?.type === 'identifier') b.ref(s.sym, fn.text, 'call', lineOf(n));
        else if (fn?.type === 'selector_expression') {
          const field = fn.childForFieldName('field');
          if (field) b.ref(s.sym, field.text, 'call', lineOf(n), receiver(fn.childForFieldName('operand')));
        }
        visitAll(n, s);
        return;
      }
      case 'composite_literal': {
        const t = goType(n.childForFieldName('type'));
        if (t) b.ref(s.sym, bare(t), 'new', lineOf(n), t.includes('.') ? `v:${t.split('.')[0]}` : '');
        visitAll(n, s);
        return;
      }
      case 'short_var_declaration': {
        const left = n.childForFieldName('left')?.namedChildren ?? [];
        const right = n.childForFieldName('right')?.namedChildren ?? [];
        left.forEach((l, i) => {
          if (l?.type !== 'identifier') return;
          const { type, call } = valueType(right.length === left.length ? (right[i] ?? null) : i === 0 ? (right[0] ?? null) : null);
          b.variable(s.fn, l.text, type, call, false);
        });
        visitAll(n, s);
        return;
      }
      case 'var_spec': {
        const declared = goType(n.childForFieldName('type'));
        const values = n.childForFieldName('value')?.namedChildren ?? [];
        n.childrenForFieldName('name').forEach((name, i) => {
          if (!name) return;
          const inferred = declared ? { type: declared, call: '' } : valueType(values[i] ?? null);
          b.variable(s.fn, name.text, inferred.type, inferred.call, false);
        });
        visitAll(n, s);
        return;
      }
      default:
        visitAll(n, s);
    }
  };

  visit(root, TOP);
}
