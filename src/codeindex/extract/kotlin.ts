import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../facts.ts';
import { Builder, TOP, firstNamed, hasToken, leadingComment, lineOf, type Scope } from './common.ts';

const TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type', 'parenthesized_type']);
const BODY_NODES = new Set(['class_body', 'enum_class_body']);

/** `List<Cart>` → `List`, `a.b.Cart?` → `Cart`. */
export function kotlinType(n: Node | null): string {
  if (!n) return '';
  if (n.type === 'nullable_type' || n.type === 'parenthesized_type') return kotlinType(n.namedChildren[0] ?? null);
  if (n.type !== 'user_type') return '';
  let name = '';
  for (const c of n.namedChildren) if (c?.type === 'identifier' || c?.type === 'type_identifier') name = c.text;
  return name;
}

function receiver(n: Node | null): string {
  if (!n) return '';
  switch (n.type) {
    case 'identifier':
      return `v:${n.text}`;
    case 'this_expression':
      return 'this';
    case 'super_expression':
      return 'super';
    case 'navigation_expression': {
      const [head, tail] = n.namedChildren;
      if (!head || !tail || tail.type !== 'identifier') return 'x';
      if (head.type === 'this_expression') return `f:${tail.text}`;
      if (head.type === 'identifier') return `v:${head.text}.${tail.text}`;
      return 'x';
    }
    default:
      return 'x';
  }
}

/** Callee text of an initializer (`Foo()` → `Foo`, `Foo.create()` → `Foo.create`). */
function calleeText(call: Node): string {
  const callee = call.namedChildren[0];
  if (!callee) return '';
  if (callee.type === 'identifier') return callee.text;
  if (callee.type === 'navigation_expression') {
    const [head, tail] = callee.namedChildren;
    if (head?.type === 'identifier' && tail?.type === 'identifier') return `${head.text}.${tail.text}`;
  }
  return '';
}

function classKind(n: Node): SymbolKind {
  if (n.type === 'object_declaration') return 'object';
  if (hasToken(n, 'interface', 12)) return 'interface';
  const mods = firstNamed(n, 'modifiers');
  if (mods && /\benum\b/.test(mods.text)) return 'enum';
  return 'class';
}

export function extractKotlin(b: Builder, root: Node): void {
  const visitAll = (n: Node, s: Scope): void => {
    for (const c of n.namedChildren) if (c) visit(c, s);
  };

  const params = (list: Node | null, scope: number): void => {
    for (const p of list?.namedChildren ?? []) {
      if (p?.type !== 'parameter') continue;
      const name = firstNamed(p, 'identifier')?.text ?? '';
      b.variable(scope, name, kotlinType(firstNamed(p, TYPE_NODES)), '', false);
    }
  };

  const visit = (n: Node, s: Scope): void => {
    switch (n.type) {
      case 'package_header': {
        const id = firstNamed(n, 'qualified_identifier') ?? firstNamed(n, 'identifier');
        if (id) b.f.pkg = id.text;
        return;
      }
      case 'import': {
        const id = firstNamed(n, 'qualified_identifier') ?? firstNamed(n, 'identifier');
        if (!id) return;
        const target = id.text.replace(/\s+/g, '');
        if (/\*\s*$/.test(n.text)) {
          b.imp('wild', target, '', '');
          return;
        }
        const alias = n.namedChildren.find((c) => c !== id && c?.type === 'identifier')?.text;
        const name = target.slice(target.lastIndexOf('.') + 1);
        b.imp('named', target, name, alias ?? name);
        return;
      }
      case 'class_declaration':
      case 'object_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = firstNamed(n, BODY_NODES);
        const idx = b.sym(n, name, classKind(n), s.cls, { body, doc: leadingComment(n), exported: !/\bprivate\b/.test(firstNamed(n, 'modifiers')?.text ?? '') });
        const line = lineOf(n);
        const ctor = firstNamed(n, 'primary_constructor');
        for (const p of firstNamed(ctor ?? n, 'class_parameters')?.namedChildren ?? []) {
          if (p?.type !== 'class_parameter') continue;
          const pname = firstNamed(p, 'identifier')?.text ?? '';
          const type = kotlinType(firstNamed(p, TYPE_NODES));
          // `val`/`var` parameters are properties; plain ones are only visible in initializers.
          b.variable(idx, pname, type, '', hasToken(p, 'val', 6) || hasToken(p, 'var', 6));
        }
        for (const spec of firstNamed(n, 'delegation_specifiers')?.namedChildren ?? []) {
          if (!spec) continue;
          const inner = spec.namedChildren[0];
          const t = inner?.type === 'constructor_invocation' || inner?.type === 'explicit_delegation' ? firstNamed(inner, 'user_type') : inner;
          b.ref(idx, kotlinType(t ?? null), 'inherit', line);
          if (inner?.type === 'constructor_invocation') visitAll(inner, { sym: idx, cls: idx, fn: -1 });
        }
        if (body) visitAll(body, { sym: idx, cls: idx, fn: -1 });
        return;
      }
      case 'companion_object': {
        // Companion members are called through the class name, so they belong to the class.
        const body = firstNamed(n, 'class_body');
        if (body) visitAll(body, s);
        return;
      }
      case 'function_declaration': {
        const nameNode = n.childForFieldName('name');
        const body = firstNamed(n, 'function_body');
        const paramList = firstNamed(n, 'function_value_parameters');
        // The return type follows the parameter list (a type before the name is an extension receiver).
        let returns = '';
        if (paramList) {
          for (const c of n.namedChildren) {
            if (c && c.startIndex > paramList.startIndex && TYPE_NODES.has(c.type)) {
              returns = kotlinType(c);
              break;
            }
          }
        }
        const idx = b.sym(n, nameNode?.text ?? '', s.cls >= 0 ? 'method' : 'function', s.cls, {
          body,
          returns,
          doc: leadingComment(n),
          exported: !/\bprivate\b/.test(firstNamed(n, 'modifiers')?.text ?? ''),
        });
        params(paramList, idx);
        if (body) visitAll(body, { sym: idx, cls: s.cls, fn: idx });
        return;
      }
      case 'secondary_constructor': {
        const owner = s.cls >= 0 ? (b.f.syms[s.cls]?.name ?? '') : '';
        const body = firstNamed(n, 'block');
        const idx = b.sym(n, owner, 'constructor', s.cls, { body });
        params(firstNamed(n, 'function_value_parameters'), idx);
        visitAll(n, { sym: idx, cls: s.cls, fn: idx });
        return;
      }
      case 'type_alias': {
        const name = firstNamed(n, 'identifier')?.text ?? n.childForFieldName('type')?.text ?? '';
        b.sym(n, name, 'type', s.cls, { exported: true });
        return;
      }
      case 'property_declaration': {
        const decl = firstNamed(n, 'variable_declaration');
        const name = decl ? (firstNamed(decl, 'identifier')?.text ?? '') : '';
        let type = decl ? kotlinType(firstNamed(decl, TYPE_NODES)) : '';
        let call = '';
        const value = decl ? n.namedChildren.find((c) => c !== null && c.startIndex >= decl.endIndex) : undefined;
        if (!type && value?.type === 'call_expression') call = calleeText(value);
        const field = s.fn < 0 && s.cls >= 0;
        b.variable(field ? s.cls : s.fn, name, type, call, field);
        visitAll(n, s);
        return;
      }
      case 'call_expression': {
        const callee = n.namedChildren[0];
        if (callee?.type === 'identifier') b.ref(s.sym, callee.text, 'call', lineOf(n));
        else if (callee?.type === 'navigation_expression') {
          const parts = callee.namedChildren;
          const name = parts[parts.length - 1];
          if (name?.type === 'identifier' && parts.length >= 2) b.ref(s.sym, name.text, 'call', lineOf(n), receiver(parts[0] ?? null));
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
