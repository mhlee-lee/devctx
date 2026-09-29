import type { Node } from 'web-tree-sitter';
import type { Builder } from './common.ts';
import { ancestor, child, lastSeg, oneLine, qualifiedCall, text } from './helpers.ts';
import { cImport, csUsing, dartImport, perlUse, phpUse, rustUse } from './imports.ts';
import { dotted, genericCallee, genericName, lastName, qualifiedType, receiverText, typeName, type CallInfo, type DefInfo, type LangSpec } from './spec.ts';
import { moreSpecFor } from './specs-more.ts';

/**
 * Language tables for the languages without a hand-written extractor. Node types follow
 * codebase-memory-mcp's `lang_specs.c` (MIT, DeusData), checked against the vendored grammars.
 * Each table also emits the language's imports as named / module / wild / file facts, so the
 * graph resolves names the way the language does (modules.ts). This file: the C family, Rust,
 * C#, F#, Swift, Dart, Scala, Groovy, Ruby, PHP, Lua and Perl; specs-more.ts has the rest.
 */

type Kind = DefInfo['kind'];

// ---- C, C++, Objective-C --------------------------------------------------------------------------

/** C-family structs/classes are declarations only when they have a body (`struct x *p` is a use). */
function cBody(kind: Kind) {
  return (n: Node): DefInfo | null => {
    if (!n.childForFieldName('body')) return null;
    const name = n.childForFieldName('name');
    return name ? { name: lastSeg(name.text), kind } : null;
  };
}

/** Where a function prototype names a function (a header, a namespace, `extern "C"`), not a local declaration. */
const PROTOTYPE_PARENTS = ['translation_unit', 'declaration_list', 'linkage_specification', 'preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif'];

/** Prototypes: members in a class body, and functions declared at file or namespace level. */
function cDeclaration(n: Node): DefInfo | null {
  let d = n.childForFieldName('declarator');
  while (d && d.type !== 'function_declarator') d = d.childForFieldName('declarator');
  if (!d) return null;
  const inClass = n.parent?.type === 'field_declaration_list';
  if (!inClass && !PROTOTYPE_PARENTS.includes(n.parent?.type ?? '')) return null;
  const g = genericName(d);
  if (!g) return null;
  return { name: g.node.text, kind: inClass ? 'method' : 'function', body: null, sig: oneLine(n), ...(inClass ? {} : { owner: g.owner }) };
}

function cFunction(n: Node): DefInfo | null {
  const g = genericName(n);
  if (!g) return null;
  // `Cart::Cart(…)` / `Cart::~Cart()`: constructors defined outside the class.
  const ctor = g.owner && (g.node.text === g.owner || g.node.text === `~${g.owner}`);
  return { name: g.node.text, kind: ctor ? 'constructor' : 'function', owner: g.owner };
}

const C_DEFS: Partial<Record<string, (n: Node) => DefInfo | null>> = {
  function_definition: cFunction,
  struct_specifier: cBody('struct'),
  union_specifier: cBody('struct'),
  enum_specifier: cBody('enum'),
  class_specifier: cBody('class'),
  field_declaration: cDeclaration,
  declaration: cDeclaration,
  type_definition: (n) => {
    const d = n.childForFieldName('declarator');
    return d && d.type === 'type_identifier' ? { name: d.text, kind: 'type', body: null } : null;
  },
  // `namespace pricing { … }` (C++): a module whose members other files reach as `pricing::x`.
  namespace_definition: (n) => {
    const nm = n.childForFieldName('name');
    return nm ? { name: dotted(nm.text), kind: 'module' } : null;
  },
  template_declaration: () => null,
};

function dispatchName(table: Partial<Record<string, (n: Node) => DefInfo | null>>) {
  return (n: Node): DefInfo | null => {
    const fn = Object.hasOwn(table, n.type) ? table[n.type] : undefined;
    return fn ? fn(n) : null;
  };
}

function cSpec(b: Builder): LangSpec {
  return {
    defs: {
      function_definition: 'function',
      struct_specifier: 'struct',
      union_specifier: 'struct',
      enum_specifier: 'enum',
      class_specifier: 'class',
      field_declaration: 'method',
      declaration: 'function',
      type_definition: 'type',
      namespace_definition: 'module',
    },
    name: dispatchName(C_DEFS),
    calls: ['call_expression'],
    news: ['new_expression'],
    imports: ['preproc_include', 'using_declaration', 'namespace_alias_definition'],
    onImport: (n) => cImport(b, n),
    fields: ['field_declaration'],
    params: ['parameter_declaration', 'declaration'],
    locals: ['init_declarator'],
  };
}

/** `[Pricing total:x]`, `[self.repo save:s]`, `[[Cart alloc] initWithRepo:r]`, `[SqlRepo new]`. */
function objcCallee(b: Builder, n: Node): CallInfo | null {
  if (n.type !== 'message_expression') return genericCallee(b, n);
  const method = n.childForFieldName('method');
  if (!method) return null;
  let recv = n.childForFieldName('receiver');
  // `[[X alloc] init…]`: the initializer runs on class X.
  if (recv?.type === 'message_expression' && /^(alloc|new)$/.test(recv.childForFieldName('method')?.text ?? '')) recv = recv.childForFieldName('receiver');
  if (!recv) return { name: method.text, recv: '' };
  if (recv.type === 'message_expression') return { name: method.text, recv: 'x' };
  return { name: method.text, recv: recv.text === 'super' ? 'super' : receiverText(recv.text) };
}

function objcSpec(b: Builder): LangSpec {
  const c = cSpec(b);
  return {
    ...c,
    defs: {
      ...c.defs,
      class_interface: 'class',
      class_implementation: 'class',
      category_interface: 'class',
      category_implementation: 'class',
      protocol_declaration: 'interface',
      method_definition: 'method',
      method_declaration: 'method',
    },
    name: (n) => {
      const cdef = Object.hasOwn(C_DEFS, n.type) ? C_DEFS[n.type] : undefined;
      if (cdef) return cdef(n);
      const id = child(n, 'identifier');
      if (!id) return null;
      const kind: Kind = n.type === 'protocol_declaration' ? 'interface' : /^(class|category)_/.test(n.type) ? 'class' : 'method';
      if (kind !== 'method') return { name: id.text, kind, body: null };
      // Definitions end at their body; declarations are prototypes (`- (void)save:(double)v;`).
      const body = child(n, 'compound_statement');
      return { name: id.text, kind, body: body ?? null, ...(body ? {} : { sig: oneLine(n) }) };
    },
    bases: (n) => {
      const out: string[] = [];
      const sup = n.childForFieldName('superclass');
      if (sup) out.push(sup.text);
      for (const list of n.namedChildren) {
        if (list?.type !== 'protocol_reference_list' && list?.type !== 'parameterized_arguments') continue;
        for (const t of list.namedChildren) if (t) out.push(typeName(t.text));
      }
      return out;
    },
    calls: ['call_expression', 'message_expression'],
    callee: (n) => objcCallee(b, n),
    imports: ['preproc_include', 'preproc_import'],
    fields: ['property_declaration'],
    // `@property id<Repo> repo;` is typed by its protocol; `@property SqlRepo *repo;` by its class.
    typed: (n) => {
      if (n.type !== 'property_declaration') return null;
      const proto = n.descendantsOfType('protocol_reference_list')[0]?.namedChildren[0];
      const cls = n.descendantsOfType('type_identifier')[0];
      const decl = n.descendantsOfType('struct_declarator')[0];
      const nm = decl ? lastName(decl) : null;
      const type = proto?.text ?? cls?.text ?? '';
      return type && nm ? { type, names: [nm.text] } : null;
    },
    params: ['declaration', 'parameter_declaration'],
  };
}

// ---- Rust -----------------------------------------------------------------------------------------

const RUST_DEFS: Record<string, Kind> = {
  function_item: 'function',
  function_signature_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  union_item: 'struct',
  trait_item: 'interface',
  type_item: 'type',
  mod_item: 'module',
  macro_definition: 'macro',
};

/** Calls inside macro arguments (`println!("{}", format_money(v))`), which the grammar keeps as token trees. */
function tokenTreeCall(n: Node): CallInfo | null {
  if (!n.text.startsWith('(')) return null;
  const prev = n.previousSibling;
  if (!prev || prev.type !== 'identifier' || prev.endIndex !== n.startIndex) return null;
  const sep = prev.previousSibling;
  if (sep?.type === '::') {
    const q = sep.previousSibling;
    return { name: prev.text, recv: q?.type === 'identifier' ? (q.text === 'Self' ? 'this' : `m:${q.text}`) : 'x' };
  }
  if (sep?.type === '.') {
    const q = sep.previousSibling;
    const qq = q?.previousSibling?.type === '.' ? q.previousSibling.previousSibling : null;
    if (q?.type === 'identifier' && qq?.text === 'self') return { name: prev.text, recv: `f:${q.text}` };
    return { name: prev.text, recv: q?.type === 'identifier' ? (q.text === 'self' ? 'this' : `v:${q.text}`) : 'x' };
  }
  if (sep?.type === '!') return null;
  return { name: prev.text, recv: '' };
}

function rustSpec(b: Builder): LangSpec {
  return {
    defs: RUST_DEFS,
    name: (n) => {
      // `mod billing;` only declares that `billing.rs` exists; the file is the module.
      if (n.type === 'mod_item' && !n.childForFieldName('body')) return null;
      const g = genericName(n);
      const kind = RUST_DEFS[n.type];
      return g && kind ? { name: g.node.text, kind, owner: g.owner } : null;
    },
    owners: {
      impl_item: (n) => {
        const type = typeName(text(n.childForFieldName('type')));
        if (!type) return null;
        const trait = qualifiedType(text(n.childForFieldName('trait')));
        return { owner: type, inherits: trait ? [trait] : [] };
      },
    },
    bases: (n) => (n.type === 'trait_item' ? (child(n, 'trait_bounds')?.namedChildren ?? []).map((t) => qualifiedType(text(t))) : []),
    calls: ['call_expression', 'macro_invocation', 'token_tree'],
    callee: (n) => (n.type === 'token_tree' ? tokenTreeCall(n) : genericCallee(b, n)),
    news: ['struct_expression'],
    imports: ['use_declaration'],
    onImport: (n) => rustUse(b, n),
    fields: ['field_declaration'],
    params: ['parameter', 'let_declaration'],
    locals: ['let_declaration'],
  };
}

// ---- C# / F# --------------------------------------------------------------------------------------

function csharpSpec(b: Builder): LangSpec {
  return {
    defs: {
      class_declaration: 'class',
      struct_declaration: 'struct',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      method_declaration: 'method',
      constructor_declaration: 'constructor',
      destructor_declaration: 'method',
      local_function_statement: 'function',
      delegate_declaration: 'type',
    },
    calls: ['invocation_expression'],
    news: ['object_creation_expression'],
    imports: ['using_directive'],
    onImport: (n) => csUsing(b, n),
    fields: ['field_declaration', 'property_declaration'],
    params: ['parameter', 'local_declaration_statement'],
    locals: ['variable_declarator'],
    pkg: ['namespace_declaration', 'file_scoped_namespace_declaration'],
  };
}

function fsharpSpec(b: Builder): LangSpec {
  return {
    defs: { function_or_value_defn: 'function', type_definition: 'type', member_defn: 'method', module_defn: 'module' },
    name: (n) => {
      if (n.type === 'function_or_value_defn') {
        const left = child(n, 'function_declaration_left');
        const id = left ? (child(left, 'identifier') ?? lastName(left)) : null;
        return id ? { name: id.text, kind: 'function' } : null;
      }
      if (n.type === 'type_definition') {
        const defn = n.namedChildren[0];
        const nm = defn ? child(defn, 'type_name') : null;
        return nm ? { name: nm.text, kind: /union|record/.test(defn?.type ?? '') ? 'type' : 'class' } : null;
      }
      if (n.type === 'member_defn') {
        const abstract = child(n, 'member_signature');
        if (abstract) {
          const id = child(abstract, 'identifier');
          return id ? { name: id.text, kind: 'method', body: null } : null;
        }
        const m = child(n, 'method_or_prop_defn');
        const nm = m?.childForFieldName('name');
        const leaf = nm?.childForFieldName('method') ?? (nm ? lastName(nm) : null);
        return leaf ? { name: leaf.text, kind: 'method' } : null;
      }
      const nm = n.childForFieldName('name') ?? child(n, 'identifier');
      return nm ? { name: nm.text, kind: 'module' } : null;
    },
    // `interface IRepo with …` inside a type: the type implements IRepo.
    bases: (n) => {
      if (n.type !== 'type_definition') return [];
      const out: string[] = [];
      for (const impl of n.descendantsOfType(['interface_implementation', 'class_inherits_decl'])) {
        if (!impl || ancestor(impl, ['type_definition'])?.id !== n.id) continue;
        const t = impl.namedChildren.find((c) => c !== null && /type/.test(c.type));
        if (t) out.push(qualifiedType(t.text));
      }
      return out;
    },
    calls: ['application_expression'],
    callee: (n) => {
      const f = n.namedChildren[0];
      if (!f) return null;
      return qualifiedCall(f.text.replace(/\s+/g, ''));
    },
    imports: ['import_decl'],
    onImport: (n) => {
      const mod = n.namedChildren.find((c) => c?.type === 'long_identifier')?.text;
      if (mod) b.imp('wild', mod, '', '');
    },
    // `type Cart(repo: IRepo)`: constructor arguments are fields; typed patterns elsewhere are parameters.
    fields: ['typed_pattern'],
    params: ['typed_pattern'],
    typed: (n) => {
      if (n.type !== 'typed_pattern') return null;
      const id = n.descendantsOfType('identifier')[0];
      const type = n.namedChildren.find((c) => c !== null && /type/.test(c.type));
      return id && type ? { type: type.text.split(/\s+/)[0] ?? '', names: [id.text] } : null;
    },
    locals: ['function_or_value_defn'],
    // `let cart = Cart(SqlRepo())`: the value's head names the constructor or function.
    local: (n) => {
      const left = child(n, 'value_declaration_left');
      const id = left?.descendantsOfType('identifier')[0];
      const body = n.childForFieldName('body');
      if (!id || body?.type !== 'application_expression') return null;
      const head = body.namedChildren[0]?.text.replace(/\s+/g, '') ?? '';
      return /^[\w.]+$/.test(head) ? { name: id.text, call: head } : null;
    },
    module: (root) => {
      const decl = root.namedChildren.find((c) => c?.type === 'named_module' || c?.type === 'namespace');
      return decl ? dotted(text(decl.childForFieldName('name')).replace(/\s+/g, '')) : '';
    },
  };
}

// ---- Swift / Dart ---------------------------------------------------------------------------------

function swiftBases(n: Node): string[] {
  return n.namedChildren
    .filter((c): c is Node => c?.type === 'inheritance_specifier')
    .map((c) => qualifiedType(text(c.childForFieldName('inherits_from') ?? c)))
    .filter(Boolean);
}

function swiftSpec(b: Builder): LangSpec {
  return {
    defs: {
      class_declaration: 'class',
      protocol_declaration: 'interface',
      function_declaration: 'function',
      protocol_function_declaration: 'method',
      init_declaration: 'constructor',
      typealias_declaration: 'type',
    },
    owners: {
      class_declaration: (n) => (n.child(0)?.type === 'extension' ? { owner: typeName(text(n.childForFieldName('name'))), inherits: swiftBases(n) } : null),
    },
    name: (n) => {
      if (n.type === 'init_declaration') return { name: 'init', kind: 'constructor' };
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      if (n.type === 'class_declaration') {
        const kw = n.child(0)?.type === 'modifiers' ? n.childForFieldName('declaration_kind')?.type : n.child(0)?.type;
        return { name: typeName(nm.text) || nm.text, kind: kw === 'struct' ? 'struct' : kw === 'enum' ? 'enum' : 'class' };
      }
      return { name: nm.text, kind: n.type === 'protocol_declaration' ? 'interface' : n.type === 'typealias_declaration' ? 'type' : n.type === 'protocol_function_declaration' ? 'method' : 'function' };
    },
    bases: swiftBases,
    calls: ['call_expression'],
    imports: ['import_declaration'],
    onImport: (n) => {
      const mod = n.namedChildren.find((c) => c?.type === 'identifier')?.text;
      if (mod) b.imp('wild', mod.replace(/\s+/g, ''), '', '');
    },
    fields: ['property_declaration'],
    params: ['parameter'],
    locals: ['property_declaration'],
  };
}

/** Dart puts a function's body next to its signature, not inside it. */
function dartBody(n: Node): Pick<DefInfo, 'extra' | 'end'> {
  const next = n.nextNamedSibling;
  return next?.type === 'function_body' ? { extra: next, end: next } : {};
}

/** `final s = pricing.total(items)`: Dart spreads a call over an identifier and selectors. */
function dartLocal(n: Node): { name: string; call: string } | null {
  if (n.type !== 'initialized_variable_definition') return null;
  const nm = n.childForFieldName('name');
  const values = n.childrenForFieldName('value').filter((v): v is Node => v !== null);
  if (!nm || values.length < 2) return null;
  const last = values[values.length - 1];
  if (last?.type !== 'selector' || !child(last, 'argument_part')) return null;
  const parts: string[] = [];
  for (const v of values.slice(0, -1)) {
    if (v.type === 'identifier') parts.push(v.text);
    else if (v.type === 'selector' && child(v, 'unconditional_assignable_selector')) parts.push(lastName(v)?.text ?? '');
    else return null; // a call in the middle of the chain: its result type is unknown here
  }
  return parts.every(Boolean) ? { name: nm.text, call: parts.join('.') } : null;
}

function dartSpec(b: Builder): LangSpec {
  return {
    defs: {
      class_definition: 'class',
      mixin_declaration: 'interface',
      enum_declaration: 'enum',
      extension_declaration: 'object',
      function_signature: 'function',
      method_signature: 'method',
      constructor_signature: 'constructor',
      type_alias: 'type',
    },
    name: (n) => {
      if (n.type === 'method_signature') {
        const inner = n.namedChildren.find((c) => c && /signature$/.test(c.type));
        const nm = inner?.childForFieldName('name') ?? (inner ? child(inner, 'identifier') : null);
        if (!nm) return null;
        return { name: nm.text, kind: inner?.type === 'constructor_signature' ? 'constructor' : 'method', ...dartBody(n) };
      }
      if (n.parent?.type === 'method_signature') return null;
      const nm = n.childForFieldName('name') ?? child(n, 'identifier');
      if (!nm) return null;
      const kind: Kind =
        n.type === 'class_definition'
          ? 'class'
          : n.type === 'mixin_declaration'
            ? 'interface'
            : n.type === 'enum_declaration'
              ? 'enum'
              : n.type === 'constructor_signature'
                ? 'constructor'
                : n.type === 'type_alias'
                  ? 'type'
                  : n.type === 'extension_declaration'
                    ? 'object'
                    : 'function';
      return { name: nm.text, kind, ...(n.type.endsWith('signature') ? dartBody(n) : {}) };
    },
    calls: ['selector'],
    callee: (n) => {
      if (!n.namedChildren.some((c) => c?.type === 'argument_part')) return null;
      const prev = n.previousNamedSibling;
      if (!prev) return null;
      const nameNode = prev.type === 'identifier' ? prev : prev.type === 'selector' ? lastName(prev) : null;
      if (!nameNode) return null;
      const before = prev.type === 'selector' ? prev.previousNamedSibling : null;
      return { name: nameNode.text, recv: before ? receiverText(before.text) : '' };
    },
    imports: ['import_or_export'],
    onImport: (n) => dartImport(b, n),
    typed: (n) => {
      if (n.type !== 'declaration' && n.type !== 'formal_parameter') return null;
      const type = n.namedChildren.find((c) => c?.type === 'type_identifier');
      const names = n.descendantsOfType('initialized_identifier').map((i) => text(i ? child(i, 'identifier') : null));
      const single = n.childForFieldName('name');
      return type ? { type: type.text, names: single ? [single.text] : names.filter(Boolean) } : null;
    },
    fields: ['declaration'],
    params: ['formal_parameter', 'local_variable_declaration'],
    locals: ['initialized_variable_definition'],
    local: dartLocal,
  };
}

// ---- Scala / Groovy (resolved with Java's rules: packages, imports, fully qualified names) --------

/** JVM-style `import a.b.C`, `import a.b.{C, D => E}`, `import a.b._` / `.*` as named/wild imports. */
function jvmImport(b: Builder, n: Node): void {
  const raw = n.text.replace(/^\s*import\s+(static\s+)?/, '').replace(/[;\s]+$/, '').replace(/\s+/g, '');
  const group = /^(.*)\.\{(.*)\}$/.exec(raw);
  if (group?.[1] !== undefined && group[2] !== undefined) {
    for (const part of group[2].split(',')) {
      const [name, alias] = part.split(/=>|as/);
      if (!name) continue;
      if (name === '_' || name === '*') b.imp('wild', group[1], '', '');
      else b.imp('named', `${group[1]}.${name}`, name, alias && alias !== '_' ? alias : name);
    }
    return;
  }
  if (/\.(_|\*)$/.test(raw)) {
    b.imp('wild', raw.replace(/\.(_|\*)$/, ''), '', '');
    return;
  }
  const name = lastSeg(raw);
  if (name) b.imp('named', raw, name, name);
}

function scalaSpec(b: Builder): LangSpec {
  return {
    defs: {
      class_definition: 'class',
      object_definition: 'object',
      trait_definition: 'interface',
      enum_definition: 'enum',
      function_definition: 'function',
      function_declaration: 'function',
      type_definition: 'type',
    },
    calls: ['call_expression'],
    news: ['instance_expression'],
    imports: ['import_declaration'],
    onImport: (n) => jvmImport(b, n),
    fields: ['class_parameter', 'val_definition', 'var_definition'],
    params: ['parameter', 'val_definition'],
    locals: ['val_definition', 'var_definition'],
    pkg: ['package_clause'],
  };
}

function groovySpec(b: Builder): LangSpec {
  return {
    defs: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      function_definition: 'function',
      method_declaration: 'method',
      constructor_declaration: 'constructor',
    },
    calls: ['method_invocation', 'juxt_function_call', 'function_call'],
    news: ['object_creation_expression'],
    imports: ['groovy_import', 'import_declaration'],
    onImport: (n) => jvmImport(b, n),
    fields: ['field_declaration'],
    params: ['formal_parameter', 'local_variable_declaration'],
    locals: ['variable_declarator', 'assignment_expression'],
    pkg: ['package_declaration'],
  };
}

// ---- Ruby / PHP ------------------------------------------------------------------------------------

function rubySpec(b: Builder): LangSpec {
  return {
    defs: { class: 'class', module: 'module', method: 'method', singleton_method: 'method', singleton_class: 'class' },
    name: (n) => {
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      const kind: Kind = n.type === 'module' ? 'module' : n.type === 'class' ? 'class' : nm.text === 'initialize' ? 'constructor' : 'method';
      // `class Shop::Cart` keeps its namespace: the resolver looks constants up by full name.
      return { name: kind === 'module' || kind === 'class' ? dotted(nm.text) : nm.text, kind };
    },
    bases: (n) => {
      const sup = n.childForFieldName('superclass');
      const t = sup?.namedChildren[0] ?? sup;
      return t ? [dotted(t.text.replace(/^<\s*/, ''))] : [];
    },
    calls: ['call'],
    callee: (n) => {
      const method = n.childForFieldName('method');
      if (!method) return null;
      const recv = n.childForFieldName('receiver');
      const name = method.text;
      if (!recv && name === 'require_relative') {
        const arg = n.childForFieldName('arguments')?.namedChildren[0];
        const spec = arg ? arg.text.replace(/^["']|["']$/g, '') : '';
        if (spec) b.imp('file', spec, '', '');
        return null;
      }
      if (!recv && (name === 'require' || name === 'load')) return null;
      if (!recv && (name === 'include' || name === 'extend' || name === 'prepend')) {
        const mod = n.childForFieldName('arguments')?.namedChildren[0];
        return mod ? { name: dotted(mod.text), recv: '', kind: 'inherit' } : null;
      }
      if (recv && name === 'new' && /^[A-Z]/.test(lastSeg(recv.text))) return { name: dotted(recv.text), recv: '', kind: 'new' };
      return { name, recv: recv ? receiverText(recv.text) : '' };
    },
    locals: ['assignment'],
  };
}

const PHP_KIND: Record<string, Kind> = { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'interface', enum_declaration: 'enum', function_definition: 'function', method_declaration: 'method' };

function phpSpec(b: Builder): LangSpec {
  return {
    defs: PHP_KIND,
    name: (n) => {
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      const kind = PHP_KIND[n.type] ?? 'function';
      return { name: nm.text, kind: nm.text === '__construct' ? 'constructor' : kind };
    },
    calls: ['function_call_expression', 'member_call_expression', 'nullsafe_member_call_expression', 'scoped_call_expression'],
    news: ['object_creation_expression'],
    imports: ['namespace_use_declaration'],
    onImport: (n) => phpUse(b, n),
    fields: ['property_declaration', 'property_promotion_parameter'],
    params: ['simple_parameter'],
    locals: ['assignment_expression'],
    pkg: ['namespace_definition'],
  };
}

// ---- Lua / Perl ------------------------------------------------------------------------------------

function luaSpec(b: Builder): LangSpec {
  return {
    defs: { function_declaration: 'function', variable_declaration: 'object' },
    name: (n) => {
      if (n.type === 'variable_declaration') {
        // `local Cart = {}` at file level: the table methods are attached to.
        if (n.parent?.type !== 'chunk') return null;
        const assign = child(n, 'assignment_statement');
        const value = assign?.namedChildren.find((c) => c?.type === 'expression_list')?.namedChildren[0];
        const nm = assign?.namedChildren.find((c) => c?.type === 'variable_list')?.namedChildren[0];
        return value?.type === 'table_constructor' && nm?.type === 'identifier' ? { name: nm.text, kind: 'object', body: null } : null;
      }
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      if (nm.type === 'identifier') return { name: nm.text, kind: 'function' };
      const leaf = nm.childForFieldName('field') ?? nm.childForFieldName('method');
      const table = nm.childForFieldName('table');
      return leaf ? { name: leaf.text, kind: 'function', owner: table?.type === 'identifier' ? table.text : '' } : null;
    },
    calls: ['function_call'],
    callee: (n) => {
      const info = genericCallee(b, n);
      if (info?.name === 'require' && !info.recv) {
        const arg = n.childForFieldName('arguments')?.namedChildren[0];
        const spec = arg ? arg.text.replace(/^["'[]+|["'\]]+$/g, '') : '';
        // `local pricing = require("shop.pricing")`: the local names the module.
        const decl = ancestor(n, ['assignment_statement'], 3);
        const alias = decl?.namedChildren.find((c) => c?.type === 'variable_list')?.namedChildren[0];
        if (spec) b.imp('module', spec, '', alias?.type === 'identifier' ? alias.text : '');
        return null;
      }
      return info;
    },
    locals: ['assignment_statement'],
    // `return M` at the end of a module: `require` returns that table.
    prepare: (root) => {
      for (const c of root.namedChildren) {
        if (c?.type !== 'return_statement') continue;
        const value = c.namedChildren.find((x) => x?.type === 'expression_list')?.namedChildren[0] ?? c.namedChildren[0];
        if (value?.type === 'identifier') b.f.exps.push(['*', value.text]);
      }
    },
  };
}

function perlSpec(b: Builder): LangSpec {
  return {
    defs: { subroutine_declaration_statement: 'function', method_declaration_statement: 'method', class_statement: 'class', package_statement: 'module' },
    name: (n) => {
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      // `package Foo { … }` is a block; `package Foo;` scopes the statements after it (sequential).
      if (n.type === 'package_statement') return child(n, 'block') ? { name: dotted(nm.text), kind: 'module' } : null;
      return { name: nm.text, kind: n.type === 'class_statement' ? 'class' : n.type === 'method_declaration_statement' ? 'method' : 'function' };
    },
    sequential: {
      package_statement: (n) => {
        if (child(n, 'block')) return null;
        const nm = n.childForFieldName('name');
        return nm ? { name: dotted(nm.text), kind: 'module' } : null;
      },
    },
    calls: ['function_call_expression', 'method_call_expression', 'ambiguous_function_call_expression'],
    callee: (n) => {
      const fn = n.childForFieldName('function') ?? n.childForFieldName('method');
      if (!fn) return null;
      const t = fn.text;
      const sep = t.lastIndexOf('::');
      const inv = n.childForFieldName('invocant');
      const recv = inv ? receiverText(inv.text) : sep > 0 ? `m:${dotted(t.slice(0, sep))}` : '';
      return { name: sep > 0 ? t.slice(sep + 2) : t, recv };
    },
    imports: ['use_statement'],
    onImport: (n, s) => {
      for (const base of perlUse(b, n)) if (s.cls >= 0) b.ref(s.cls, dotted(base), 'inherit', n.startPosition.row + 1);
    },
    locals: ['assignment_expression'],
  };
}

export function specFor(lang: string, b: Builder): LangSpec | null {
  switch (lang) {
    case 'c':
    case 'cpp':
    case 'cuda':
      return cSpec(b);
    case 'objc':
      return objcSpec(b);
    case 'rust':
      return rustSpec(b);
    case 'csharp':
      return csharpSpec(b);
    case 'fsharp':
      return fsharpSpec(b);
    case 'swift':
      return swiftSpec(b);
    case 'dart':
      return dartSpec(b);
    case 'scala':
      return scalaSpec(b);
    case 'groovy':
      return groovySpec(b);
    case 'ruby':
      return rubySpec(b);
    case 'php':
      return phpSpec(b);
    case 'lua':
      return luaSpec(b);
    case 'perl':
      return perlSpec(b);
    default:
      return moreSpecFor(lang, b);
  }
}

export type { CallInfo };
