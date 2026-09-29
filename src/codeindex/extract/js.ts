import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../facts.ts';
import { Builder, TOP, hasToken, isHookName, isPascal, leadingComment, lineOf, type Scope } from './common.ts';

/**
 * JavaScript, JSX, TypeScript and TSX share one extractor: the grammars use the same node types
 * for everything that matters here, TypeScript only adds type annotations.
 */

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CLASS_NODES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const PREDEFINED = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'object', 'undefined', 'null', 'bigint', 'symbol']);

/** Type annotation → a class-like name: `Foo`, `Foo<T>` → `Foo`, `ns.Foo` → `Foo`, `Foo | null` → `Foo`. */
export function tsType(n: Node | null): string {
  if (!n) return '';
  switch (n.type) {
    case 'type_annotation':
      return tsType(n.namedChildren[0] ?? null);
    case 'type_identifier':
      return PREDEFINED.has(n.text) ? '' : n.text;
    case 'generic_type': {
      const name = tsType(n.childForFieldName('name') ?? n.namedChildren[0] ?? null);
      // Promise<Foo> is Foo once awaited, which is how such values are used.
      if (name === 'Promise') return tsType(n.childForFieldName('type_arguments')?.namedChildren[0] ?? null);
      return name;
    }
    case 'nested_type_identifier':
      return n.childForFieldName('name')?.text ?? '';
    case 'union_type': {
      for (const c of n.namedChildren) {
        const t = tsType(c);
        if (t) return t;
      }
      return '';
    }
    case 'parenthesized_type':
      return tsType(n.namedChildren[0] ?? null);
    default:
      return '';
  }
}

function stringValue(n: Node | null): string {
  if (!n || n.type !== 'string') return '';
  const frag = n.namedChildren.find((c) => c?.type === 'string_fragment');
  return frag ? frag.text : '';
}

function receiver(obj: Node | null): string {
  if (!obj) return 'x';
  switch (obj.type) {
    case 'this':
      return 'this';
    case 'super':
      return 'super';
    case 'identifier':
      return `v:${obj.text}`;
    case 'member_expression': {
      const o = obj.childForFieldName('object');
      const p = obj.childForFieldName('property');
      if (!o || !p) return 'x';
      if (o.type === 'this') return `f:${p.text}`;
      if (o.type === 'identifier') return `v:${o.text}.${p.text}`;
      return 'x';
    }
    case 'non_null_expression':
    case 'parenthesized_expression':
      return receiver(obj.namedChildren[0] ?? null);
    default:
      return 'x';
  }
}

/** Callee text of an initializer: `make()` → `make`, `api.create()` → `api.create`. */
function callText(n: Node | null): string {
  if (!n) return '';
  if (n.type === 'await_expression') return callText(n.namedChildren[0] ?? null);
  if (n.type !== 'call_expression') return '';
  const fn = n.childForFieldName('function');
  if (fn?.type === 'identifier') return fn.text;
  if (fn?.type === 'member_expression') {
    const o = fn.childForFieldName('object');
    const p = fn.childForFieldName('property');
    if (o?.type === 'identifier' && p) return `${o.text}.${p.text}`;
  }
  return '';
}

function newType(n: Node | null): string {
  if (!n) return '';
  if (n.type === 'await_expression') return newType(n.namedChildren[0] ?? null);
  if (n.type !== 'new_expression') return '';
  const c = n.childForFieldName('constructor');
  if (c?.type === 'identifier') return c.text;
  if (c?.type === 'member_expression') return c.childForFieldName('property')?.text ?? '';
  return '';
}

function requireSource(n: Node | null): string {
  if (n?.type !== 'call_expression') return '';
  if (n.childForFieldName('function')?.text !== 'require') return '';
  return stringValue(n.childForFieldName('arguments')?.namedChildren[0] ?? null);
}

export function extractJs(b: Builder, root: Node): void {
  /** Symbols whose body rendered JSX (components). */
  const rendersJsx = new Set<number>();

  const visitAll = (n: Node, s: Scope): void => {
    for (const c of n.namedChildren) if (c) visit(c, s);
  };

  const params = (list: Node | null, scope: number, cls: number): void => {
    for (const p of list?.namedChildren ?? []) {
      if (!p) continue;
      if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') continue;
      const pattern = p.childForFieldName('pattern');
      if (pattern?.type !== 'identifier') continue;
      const type = tsType(p.childForFieldName('type'));
      b.variable(scope, pattern.text, type, '', false);
      // TypeScript parameter properties (`constructor(private repo: Repo)`) are fields.
      const isProperty = p.namedChildren.some((c) => c?.type === 'accessibility_modifier' || c?.type === 'override_modifier') || hasToken(p, 'readonly', 4);
      if (isProperty && cls >= 0) b.variable(cls, pattern.text, type, '', true);
    }
  };

  /** Function-like symbol; PascalCase functions that render JSX become components, `useX` hooks. */
  const fn = (
    n: Node,
    name: string,
    s: Scope,
    kind: SymbolKind,
    value: Node,
    opts: { exported: boolean; sig?: string; docNode: Node },
  ): number => {
    const body = value.childForFieldName('body');
    const finalKind: SymbolKind = kind === 'function' && isHookName(name) ? 'hook' : kind;
    // Functions declared inside a method are local helpers, not members of the class.
    const idx = b.sym(n, name, finalKind, kind === 'function' ? -1 : s.cls, {
      body,
      sig: opts.sig,
      exported: opts.exported,
      returns: tsType(value.childForFieldName('return_type')),
      doc: leadingComment(opts.docNode),
    });
    params(value.childForFieldName('parameters'), idx, kind === 'constructor' ? s.cls : -1);
    if (body) visit(body, { sym: idx, cls: s.cls, fn: idx });
    if (rendersJsx.has(idx) && finalKind === 'function' && isPascal(name)) {
      const sym = b.f.syms[idx];
      if (sym) sym.kind = 'component';
    }
    return idx;
  };

  const declaration = (n: Node, s: Scope, exported: boolean, docNode: Node, isDefault: boolean): void => {
    switch (n.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        fn(n, name, s, 'function', n, { exported, docNode });
        if (isDefault && name) b.f.exps.push(['default', name]);
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const idx = b.sym(n, name, 'class', s.cls, { body, exported, doc: leadingComment(docNode) });
        const heritage = n.namedChildren.find((c) => c?.type === 'class_heritage');
        for (const h of heritage?.namedChildren ?? []) {
          if (!h) continue;
          const items = h.type === 'extends_clause' || h.type === 'implements_clause' ? h.namedChildren : [h];
          for (const t of items) {
            if (!t) continue;
            if (t.type === 'identifier' || t.type === 'type_identifier') b.ref(idx, t.text, 'inherit', lineOf(n));
            else if (t.type === 'member_expression' || t.type === 'nested_type_identifier') {
              const name2 = t.childForFieldName(t.type === 'member_expression' ? 'property' : 'name')?.text ?? '';
              const o = t.childForFieldName(t.type === 'member_expression' ? 'object' : 'module');
              b.ref(idx, name2, 'inherit', lineOf(n), o?.type === 'identifier' ? `v:${o.text}` : 'x');
            } else if (t.type === 'generic_type') b.ref(idx, tsType(t), 'inherit', lineOf(n));
          }
        }
        if (isDefault && name) b.f.exps.push(['default', name]);
        if (body) classBody(body, { sym: idx, cls: idx, fn: -1 });
        return;
      }
      case 'interface_declaration': {
        const name = n.childForFieldName('name')?.text ?? '';
        const body = n.childForFieldName('body');
        const idx = b.sym(n, name, 'interface', s.cls, { body, exported, doc: leadingComment(docNode) });
        const ext = n.namedChildren.find((c) => c?.type === 'extends_type_clause');
        for (const t of ext?.namedChildren ?? []) if (t) b.ref(idx, tsType(t) || t.text, 'inherit', lineOf(n));
        for (const m of body?.namedChildren ?? []) {
          if (m?.type === 'method_signature') {
            b.sym(m, m.childForFieldName('name')?.text ?? '', 'method', idx, { exported: true, returns: tsType(m.childForFieldName('return_type')), doc: leadingComment(m) });
          } else if (m?.type === 'property_signature') {
            b.variable(idx, m.childForFieldName('name')?.text ?? '', tsType(m.childForFieldName('type')), '', true);
          }
        }
        return;
      }
      case 'type_alias_declaration':
        b.sym(n, n.childForFieldName('name')?.text ?? '', 'type', s.cls, { exported, doc: leadingComment(docNode) });
        return;
      case 'enum_declaration':
        b.sym(n, n.childForFieldName('name')?.text ?? '', 'enum', s.cls, { body: n.childForFieldName('body'), exported, doc: leadingComment(docNode) });
        return;
      case 'lexical_declaration':
      case 'variable_declaration': {
        const keyword = n.child(0)?.type ?? 'const';
        for (const d of n.namedChildren) if (d?.type === 'variable_declarator') declarator(d, s, exported, docNode, keyword);
        return;
      }
      default:
        visit(n, s);
    }
  };

  const declarator = (d: Node, s: Scope, exported: boolean, docNode: Node, keyword: string): void => {
    const nameNode = d.childForFieldName('name');
    const value = d.childForFieldName('value');
    const source = requireSource(value);
    if (source && nameNode) {
      if (nameNode.type === 'identifier') b.imp('ns', source, '', nameNode.text);
      else if (nameNode.type === 'object_pattern') {
        for (const p of nameNode.namedChildren) {
          if (p?.type === 'shorthand_property_identifier_pattern') b.imp('named', source, p.text, p.text);
          else if (p?.type === 'pair_pattern') {
            const key = p.childForFieldName('key')?.text ?? '';
            const val = p.childForFieldName('value');
            if (val?.type === 'identifier') b.imp('named', source, key, val.text);
          }
        }
      }
      return;
    }
    if (nameNode?.type !== 'identifier') {
      if (value) visit(value, s);
      return;
    }
    const name = nameNode.text;
    if (value && FUNCTION_VALUES.has(value.type)) {
      const body = value.childForFieldName('body');
      const head = b.src.slice(d.startIndex, body ? body.startIndex : d.endIndex).replace(/\s+/g, ' ').trim();
      fn(d, name, s, 'function', value, { exported, docNode, sig: `${keyword} ${head}`.slice(0, 200) });
      return;
    }
    const scope = s.fn >= 0 ? s.fn : -1;
    b.variable(scope, name, tsType(d.childForFieldName('type')) || newType(value), callText(value), false);
    if (value) visit(value, s);
  };

  const classBody = (body: Node, s: Scope): void => {
    for (const m of body.namedChildren) {
      if (!m) continue;
      switch (m.type) {
        case 'method_definition': {
          const name = m.childForFieldName('name')?.text ?? '';
          fn(m, name, s, name === 'constructor' ? 'constructor' : 'method', m, { exported: true, docNode: m });
          break;
        }
        case 'abstract_method_signature':
        case 'method_signature':
          b.sym(m, m.childForFieldName('name')?.text ?? '', 'method', s.cls, { exported: true, returns: tsType(m.childForFieldName('return_type')), doc: leadingComment(m) });
          break;
        case 'public_field_definition':
        case 'field_definition': {
          const nameNode = m.childForFieldName('name') ?? m.childForFieldName('property');
          const name = nameNode?.text ?? '';
          const value = m.childForFieldName('value');
          if (value && FUNCTION_VALUES.has(value.type)) {
            fn(m, name, s, 'method', value, { exported: true, docNode: m });
          } else {
            b.variable(s.cls, name, tsType(m.childForFieldName('type')) || newType(value), callText(value), true);
            if (value) visit(value, s);
          }
          break;
        }
        default:
          visit(m, s);
      }
    }
  };

  const jsxName = (n: Node, s: Scope): void => {
    rendersJsx.add(s.sym);
    const name = n.childForFieldName('name');
    if (!name) return;
    if (name.type === 'identifier' && isPascal(name.text)) b.ref(s.sym, name.text, 'render', lineOf(n));
    else if (name.type === 'member_expression') {
      const o = name.childForFieldName('object');
      const p = name.childForFieldName('property');
      if (p) b.ref(s.sym, p.text, 'render', lineOf(n), o?.type === 'identifier' ? `v:${o.text}` : 'x');
    }
  };

  const visit = (n: Node, s: Scope): void => {
    switch (n.type) {
      case 'import_statement': {
        const source = stringValue(n.childForFieldName('source'));
        const clause = n.namedChildren.find((c) => c?.type === 'import_clause');
        for (const c of clause?.namedChildren ?? []) {
          if (!c) continue;
          if (c.type === 'identifier') b.imp('default', source, 'default', c.text);
          else if (c.type === 'namespace_import') {
            const id = c.namedChildren.find((x) => x?.type === 'identifier');
            if (id) b.imp('ns', source, '', id.text);
          } else if (c.type === 'named_imports') {
            for (const spec of c.namedChildren) {
              if (spec?.type !== 'import_specifier') continue;
              const name = spec.childForFieldName('name')?.text ?? '';
              b.imp('named', source, name, spec.childForFieldName('alias')?.text ?? name);
            }
          }
        }
        return;
      }
      case 'export_statement': {
        const source = stringValue(n.childForFieldName('source'));
        const clause = n.namedChildren.find((c) => c?.type === 'export_clause');
        if (source) {
          if (!clause) {
            const ns = n.namedChildren.find((c) => c?.type === 'namespace_export');
            if (ns) b.imp('rx', source, '*', ns.namedChildren[0]?.text ?? '');
            else b.imp('rx*', source, '', '');
          }
          for (const spec of clause?.namedChildren ?? []) {
            if (spec?.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name')?.text ?? '';
            b.imp('rx', source, name, spec.childForFieldName('alias')?.text ?? name);
          }
          return;
        }
        for (const spec of clause?.namedChildren ?? []) {
          if (spec?.type !== 'export_specifier') continue;
          const name = spec.childForFieldName('name')?.text ?? '';
          b.f.exps.push([spec.childForFieldName('alias')?.text ?? name, name]);
        }
        const decl = n.childForFieldName('declaration');
        const isDefault = hasToken(n, 'default', 4);
        if (decl) {
          for (const d of n.childrenForFieldName('decorator')) if (d) visit(d, s);
          declaration(decl, s, true, n, isDefault);
          return;
        }
        const value = n.childForFieldName('value');
        if (value && isDefault) {
          if (value.type === 'identifier') b.f.exps.push(['default', value.text]);
          else if (FUNCTION_VALUES.has(value.type) || CLASS_NODES.has(value.type)) {
            // `export default () => ...`: named after nothing, so it is only reachable as the default export.
            if (CLASS_NODES.has(value.type)) declaration(value, s, true, n, true);
            else {
              fn(value, 'default', s, 'function', value, { exported: true, docNode: n });
              b.f.exps.push(['default', 'default']);
            }
            return;
          }
          visit(value, s);
        }
        return;
      }
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration':
        declaration(n, s, false, n, false);
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        declaration(n, s, false, n, false);
        return;
      case 'expression_statement': {
        const e = n.namedChildren[0];
        if (e?.type === 'assignment_expression' && commonJsExport(e, s)) return;
        visitAll(n, s);
        return;
      }
      case 'assignment_expression': {
        // `this.repo = new Repo()` in a constructor types the field.
        const left = n.childForFieldName('left');
        const right = n.childForFieldName('right');
        if (left?.type === 'member_expression' && left.childForFieldName('object')?.type === 'this' && s.cls >= 0) {
          const prop = left.childForFieldName('property')?.text ?? '';
          const fromParam = right?.type === 'identifier' ? b.varIn(s.fn, right.text) : undefined;
          b.variable(s.cls, prop, newType(right) || fromParam?.type || '', callText(right), true);
        }
        visitAll(n, s);
        return;
      }
      case 'call_expression': {
        const f = n.childForFieldName('function');
        if (f?.type === 'identifier') {
          if (f.text !== 'require') b.ref(s.sym, f.text, 'call', lineOf(n));
        } else if (f?.type === 'member_expression') {
          const p = f.childForFieldName('property');
          if (p) b.ref(s.sym, p.text, 'call', lineOf(n), receiver(f.childForFieldName('object')));
        }
        visitAll(n, s);
        return;
      }
      case 'new_expression': {
        const c = n.childForFieldName('constructor');
        if (c?.type === 'identifier') b.ref(s.sym, c.text, 'new', lineOf(n));
        else if (c?.type === 'member_expression') {
          const o = c.childForFieldName('object');
          b.ref(s.sym, c.childForFieldName('property')?.text ?? '', 'new', lineOf(n), o?.type === 'identifier' ? `v:${o.text}` : 'x');
        }
        visitAll(n, s);
        return;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element':
        jsxName(n, s);
        visitAll(n, s);
        return;
      case 'jsx_closing_element':
        return;
      case 'class':
        declaration(n, s, false, n, false);
        return;
      // Functions in object literals outside any function (`export default { methods: { f() {} } }`,
      // store/action objects) are symbols too; inside functions they stay anonymous.
      case 'pair': {
        const key = n.childForFieldName('key');
        const value = n.childForFieldName('value');
        if (s.fn < 0 && s.cls < 0 && key && value && FUNCTION_VALUES.has(value.type) && (key.type === 'property_identifier' || key.type === 'string')) {
          fn(n, key.text.replace(/^["']|["']$/g, ''), s, 'function', value, { exported: false, docNode: n });
          return;
        }
        visitAll(n, s);
        return;
      }
      case 'method_definition':
        if (s.fn < 0 && s.cls < 0) {
          fn(n, n.childForFieldName('name')?.text ?? '', s, 'function', n, { exported: false, docNode: n });
          return;
        }
        visitAll(n, s);
        return;
      default:
        visitAll(n, s);
    }
  };

  /** `module.exports = X`, `module.exports = { A, B }`, `exports.name = X`. */
  const commonJsExport = (e: Node, s: Scope): boolean => {
    const left = e.childForFieldName('left');
    const right = e.childForFieldName('right');
    if (left?.type !== 'member_expression' || !right) return false;
    const obj = left.childForFieldName('object');
    const prop = left.childForFieldName('property')?.text ?? '';
    const isModuleExports = obj?.text === 'module' && prop === 'exports';
    const isExportsProp = obj?.text === 'exports' || (obj?.type === 'member_expression' && obj.text === 'module.exports');
    if (!isModuleExports && !isExportsProp) return false;
    if (isModuleExports) {
      if (right.type === 'identifier') b.f.exps.push(['default', right.text]);
      else if (right.type === 'object') {
        for (const p of right.namedChildren) {
          if (p?.type === 'shorthand_property_identifier') b.f.exps.push([p.text, p.text]);
          else if (p?.type === 'pair') {
            const key = p.childForFieldName('key')?.text ?? '';
            const val = p.childForFieldName('value');
            if (val?.type === 'identifier') b.f.exps.push([key, val.text]);
            else if (val) visit(val, s);
          }
        }
      } else if (FUNCTION_VALUES.has(right.type) || CLASS_NODES.has(right.type)) {
        const name = right.childForFieldName('name')?.text ?? 'default';
        if (CLASS_NODES.has(right.type)) declaration(right, s, true, e, true);
        else {
          fn(right, name, s, 'function', right, { exported: true, docNode: e });
          b.f.exps.push(['default', name]);
        }
      } else visit(right, s);
      return true;
    }
    if (right.type === 'identifier') b.f.exps.push([prop, right.text]);
    else if (FUNCTION_VALUES.has(right.type)) {
      fn(right, prop, s, 'function', right, { exported: true, docNode: e });
      b.f.exps.push([prop, prop]);
    } else visit(right, s);
    return true;
  };

  visit(root, TOP);
  // Exported names declared elsewhere in the file (`export { a }`, CommonJS) mark their symbols.
  const exported = new Set(b.f.exps.map(([, local]) => local));
  for (const sym of b.f.syms) if (sym.parent === -1 && exported.has(sym.name)) sym.exported = true;
}
