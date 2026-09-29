import type { Node } from 'web-tree-sitter';
import type { RefKind, SymbolKind } from '../facts.ts';
import { Builder, TOP, leadingComment, lineOf, type Scope } from './common.ts';

/**
 * Table-driven extractor: one walker driven by a per-language table of node types, the way
 * codebase-memory-mcp describes its 150+ languages (function / class / call / import node types
 * plus a few name-resolution quirks). Output is the same `FileFacts` the hand-written extractors emit,
 * including each language's imports (`onImport`), so the graph resolves these languages through
 * their import / module rules (modules.ts) and receiver types like the hand-written ones.
 */

export interface CallInfo {
  name: string;
  recv: string;
  kind?: RefKind;
}

export interface DefInfo {
  name: string;
  kind: SymbolKind;
  /** Node whose range the symbol covers (defaults to the matched node). */
  node?: Node;
  body?: Node | null;
  /** Owning type for methods declared outside it (`impl Foo`, `Foo::bar`). */
  owner?: string;
  /** A sibling node that belongs to the declaration (Dart keeps bodies next to signatures). */
  extra?: Node;
  /** Last node of the declaration's range when it extends past `node`. */
  end?: Node;
  /** Explicit signature (when the declaration head is not "text before the body"). */
  sig?: string;
  /** A child that only repeats the declaration (Elixir `def total(x)` head) and must not become a call. */
  skip?: Node;
}

export interface LangSpec {
  /** Declaration node types and the symbol kind they produce (`function` becomes `method` inside a type). */
  defs: Record<string, SymbolKind>;
  /** Call node types. */
  calls?: string[];
  /** Instantiation node types (`new Foo()`); the callee is read like a call. */
  news?: string[];
  /** Import node types: the module path is read from the first string or dotted name. */
  imports?: string[];
  /** Nodes whose children are methods of a type declared elsewhere (Rust `impl`, Swift `extension`). */
  owners?: Record<string, (n: Node) => { owner: string; inherits: string[] } | null>;
  /** Typed member declarations inside types (`field_declaration`, `property_declaration`). */
  fields?: string[];
  /** Typed parameter / local declarations inside functions. */
  params?: string[];
  /** Local assignments whose type comes from the initializer (`let s = Store::open()`, `x = Foo.new`). */
  locals?: string[];
  /** Field holding a function's return type when it is not `return_type` / `returns` / `result`. */
  returnsField?: string;
  /** Records an import node itself (named / module / wild / file imports, see modules.ts). */
  onImport?: (n: Node, s: Scope) => void;
  /** Package / namespace declarations. */
  pkg?: string[];
  /** Name of a declaration; null skips the node (an anonymous lambda, a non-def list). */
  name?: (n: Node) => DefInfo | null;
  /** Callee of a call node; null skips it. */
  callee?: (n: Node) => CallInfo | null;
  /** Supertype names of a type declaration. */
  bases?: (n: Node) => string[];
  /** Typed names of a field/parameter node when the generic reader cannot see them. */
  typed?: (n: Node) => { type: string; names: string[] } | null;
  /** Module name of the file (`module Cart`, `-module(cart).`, OCaml file name): calls like `Cart.total` find it. */
  module?: (root: Node, file: string) => string;
  /** Nodes not to descend into (strings, comments). */
  skip?: string[];
  /**
   * Statements that open a scope for the siblings after them rather than for a body (Perl
   * `package Foo;`): the symbol spans up to the next such statement or the end of its block.
   */
  sequential?: Record<string, (n: Node) => DefInfo | null>;
  /** Runs once before the walk (file-level facts such as Lua's returned module table). */
  prepare?: (root: Node) => void;
  /** Local-variable reader for grammars the generic one cannot read (Dart's selector chains). */
  local?: (n: Node) => { name: string; type?: string; call?: string } | null;
}

/** A type written in source (`Foo`, `Shop::Cart`, `a.b.Foo<T>`) as the name the graph resolves. */
export function qualifiedType(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().replace(/^[&*]+|[?!*&]+$/g, '');
  const wrapped = WRAPPER.exec(t);
  if (wrapped?.[1]) return qualifiedType(wrapped[1]);
  if (/^[A-Za-z_\\][\w\\]*((::|\.|\\)[A-Za-z_]\w*)+/.test(t) && !/^[[(]/.test(t) && !/\s/.test(t.replace(/<.*$/, ''))) {
    const base = t.replace(/[<([].*$/, '');
    const last = typeName(base);
    return last ? dotted(base) : '';
  }
  return typeName(t);
}

/** `@repo`, `self.repo`, `this.repo`, `$this->repo`, `$self->{repo}`, `self$repo`, `self:repo`: the field name. */
function selfField(text: string): string | null {
  const m = /^(?:@|self\.|this\.|\$this\.|self:|\$this->|\$self->\{?|self\$)(\w+)\}?$/.exec(text.replace(/\s+/g, ''));
  return m?.[1] ?? null;
}

const LEAF_NAME = /^(identifier|simple_identifier|type_identifier|field_identifier|property_identifier|constant|name|word|value_name|module_name|constructor|variable|sym_name|atom|function_name|command_name|method_name|package_identifier|namespace_identifier|type_name|tag_name|private_property_identifier|lower_case_identifier|upper_case_identifier|upper_identifier|identifier_name|attribute_name|operator_name|destructor_name|bare_word|bareword|func_name|label_name|simple_name|method|function|package)$/;

export function isNameNode(n: Node): boolean {
  return LEAF_NAME.test(n.type) || (n.namedChildCount === 0 && /identifier|name|constant/.test(n.type));
}

/** Rightmost name-like node inside `n` (`a.b.c` → `c`, `Foo::bar` → `bar`). */
export function lastName(n: Node | null): Node | null {
  if (!n) return null;
  if (isNameNode(n) && (n.namedChildCount === 0 || /^(command_name|function_name|type_name|method_name)$/.test(n.type))) return n;
  for (let i = n.namedChildCount - 1; i >= 0; i--) {
    const c = n.namedChild(i);
    if (!c || /argument|parameter|arguments|type_arguments|generic|block|body/.test(c.type)) continue;
    const found = lastName(c);
    if (found) return found;
  }
  return null;
}

const WRAPPER = /^(?:(?:std|core|alloc|boost)::(?:\w+::)*)?(?:Box|Rc|Arc|RefCell|Cell|Mutex|RwLock|Option|Optional|Weak|Pin|unique_ptr|shared_ptr|weak_ptr|Ref|RefMut|Lazy|Rc|NonNull)\s*<\s*(?:dyn\s+|&\s*(?:mut\s+)?)?(.+)>$/;

const PRIMITIVE = /^(int|long|short|byte|char|bool|boolean|float|double|void|string|str|number|any|object|u?int\d*|i\d+|u\d+|f\d+|usize|isize|var|let|auto|dynamic|mixed|nil|null|none|self|Self|decimal|unit|Unit)$/i;

/** `List<Foo>` → `List`, `&mut Foo` → `Foo`, `a::b::Foo` / `A\B\Foo` / `a.b.Foo` → `Foo`, `Foo?` → `Foo`. */
export function typeName(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim().replace(/^:\s*/, '');
  // Array and tuple literals (`[Item]`, `(A, B)`) are not the element type.
  if (/^[[(]/.test(t)) return '';
  // Smart pointers and optionals (`Box<dyn Repo>`, `std::shared_ptr<Repo>`, `Option<&Cart>`) stand for their content.
  const wrapped = WRAPPER.exec(t);
  if (wrapped?.[1]) return typeName(wrapped[1]);
  t = t.replace(/^(?:&|\*|mut |const |ref |out |in |readonly |final |var |val |let |dyn |impl |struct |class |enum |union |\?)+/, '');
  t = t.replace(/[?!*&]+$/, '');
  const generic = t.search(/[<[(]/);
  if (generic > 0) t = t.slice(0, generic);
  const last = t.split(/::|\\|\.|->/).pop() ?? '';
  const name = last.replace(/[^\w$]/g, '');
  return !name || PRIMITIVE.test(name) ? '' : name;
}

/** `Shop::Pricing`, `\App\Models\User`, `a.b` → `Shop.Pricing`, `App.Models.User`, `a.b`. */
export function dotted(s: string): string {
  return s.replace(/::|\\/g, '.').replace(/^\.+|\.+$/g, '');
}

/** Receiver encoding (see RefFact.recv) from the source text in front of a member name. */
export function receiverText(before: string): string {
  const raw = before.replace(/\s+/g, '');
  const t = raw.replace(/(\?\.|\.|->|::|:|!|\$)$/, '');
  if (!t) return '';
  if (/^(self|this|\$this|\$self|Self|me|base|@|static)$/.test(t)) return 'this';
  if (/^(super|parent|\$super)$/.test(t)) return 'super';
  let m = /^(?:self|this|\$this|@)(?:\.|->|::|\$)?(\w+)$/.exec(t);
  if (m?.[1] && t !== m[1]) return `f:${m[1]}`;
  m = /^\$self->\{?(\w+)\}?$/.exec(t); // Perl `$self->{repo}`
  if (m?.[1]) return `f:${m[1]}`;
  // `Foo::bar`, `Shop::Cart->new`, `\App\Models\User::find`: a module or type path, kept whole.
  if (/::|\\/.test(raw) && /^\\?[A-Za-z_]\w*((::|\\)[A-Za-z_]\w*)*$/.test(t)) return `m:${dotted(t)}`;
  m = /^[$@%]?([A-Za-z_][\w]*)$/.exec(t);
  if (m?.[1]) return `v:${m[1]}`;
  // `a.b.Service`, `repo.store`: a dotted path (a variable's field, a module, a qualified type).
  if (/^[$]?[A-Za-z_]\w*((\.|->|\$)[A-Za-z_]\w*)+$/.test(t)) return `v:${t.replace(/^\$/, '').replace(/->|\$/g, '.')}`;
  return 'x';
}

/** Name of the thing called: `foo()`, `a.b.foo()`, `A::foo()`, `obj->foo()`. */
export function calleeFrom(b: Builder, target: Node | null): CallInfo | null {
  if (!target) return null;
  const name = lastName(target);
  if (!name) return null;
  const before = b.src.slice(target.startIndex, name.startIndex);
  const leaf = name.text.replace(/^[$&@]/, '');
  // A single token that still holds a path (`Shop::Pricing::sum`, `pkg.fn`).
  const sep = /^(.*)(::|\.|->)([\w$!?]+)$/.exec(leaf);
  if (sep?.[1] && sep[3] && !before.trim()) return { name: sep[3], recv: sep[2] === '::' ? `m:${dotted(sep[1])}` : `v:${sep[1].replace(/->/g, '.')}` };
  return { name: leaf, recv: receiverText(before) };
}

export function genericCallee(b: Builder, n: Node): CallInfo | null {
  const target =
    n.childForFieldName('function') ??
    n.childForFieldName('method') ??
    n.childForFieldName('name') ??
    n.childForFieldName('macro') ??
    n.childForFieldName('callee') ??
    n.childForFieldName('constructor') ??
    n.childForFieldName('type') ??
    n.namedChild(0);
  // `f a b` / `f(a)(b)`: the inner call names the function; this node only adds arguments.
  if (!target || target.type === n.type) return null;
  // `recv.method(...)`: some grammars keep receiver and method in separate fields.
  const recv = n.childForFieldName('receiver') ?? n.childForFieldName('object') ?? n.childForFieldName('invocant') ?? n.childForFieldName('scope');
  const info = calleeFrom(b, target);
  if (info && recv && recv.endIndex <= target.startIndex) info.recv = receiverText(recv.text);
  return info;
}

/** Declaration name: the `name` field, the C declarator chain, or the first name-like child. */
export function genericName(n: Node): { node: Node; owner: string } | null {
  const field = n.childForFieldName('name');
  if (field) {
    if (isNameNode(field) && field.namedChildCount === 0) return { node: field, owner: '' };
    const leaf = lastName(field);
    if (leaf) return { node: leaf, owner: ownerPrefix(field, leaf) };
  }
  let d = n.childForFieldName('declarator');
  if (d) {
    // function_definition → function_declarator → (qualified_)identifier; pointers wrap it.
    for (let i = 0; i < 6 && d; i++) {
      const inner: Node | null = d.childForFieldName('declarator');
      if (!inner) break;
      d = inner;
    }
    if (d) {
      const leaf = isNameNode(d) && d.namedChildCount === 0 ? d : lastName(d);
      if (leaf) return { node: leaf, owner: ownerPrefix(d, leaf) };
    }
  }
  for (const c of n.namedChildren) {
    if (c && isNameNode(c) && c.namedChildCount === 0) return { node: c, owner: '' };
  }
  return null;
}

/** `Foo::bar` / `Foo.bar` → `Foo` (the type an out-of-line method belongs to). */
function ownerPrefix(container: Node, leaf: Node): string {
  const text = container.text.slice(0, leaf.startIndex - container.startIndex).replace(/(::|\.|:)$/, '');
  return text ? typeName(text) : '';
}

const HERITAGE = /superclass|super_class|base_list|base_clause|base_class_clause|extends|implements|inheritance|delegation|superclasses|class_heritage|interface_clause|interfaces|conformance|mixins|with_clause|parent|supertype|inherit/;
const TYPE_LEAF = /^(type_identifier|identifier|constant|user_type|scoped_type_identifier|qualified_name|type_name|name|simple_identifier|generic_type|qualified_identifier|scoped_identifier|type|class_type|superclass|base_class|simple_type|template_type)$/;

/** Supertypes: every type named under a heritage-like child (`extends`, `: Base`, `< Base`). */
export function genericBases(n: Node): string[] {
  const out: string[] = [];
  const collect = (h: Node, depth: number): void => {
    for (const c of h.namedChildren) {
      if (!c) continue;
      if (TYPE_LEAF.test(c.type)) {
        const t = typeName(c.text);
        if (t) out.push(t);
      } else if (depth < 3 && !/argument|body|block/.test(c.type)) collect(c, depth + 1);
    }
  };
  for (const c of n.namedChildren) {
    if (!c) continue;
    const field = HERITAGE.test(c.type);
    if (field) {
      if (TYPE_LEAF.test(c.type) && c.namedChildCount === 0) out.push(typeName(c.text));
      else collect(c, 0);
    }
  }
  for (const f of ['superclass', 'superclasses', 'bases', 'base', 'interfaces', 'parent']) {
    for (const c of n.childrenForFieldName(f)) {
      if (!c) continue;
      if (c.namedChildCount === 0) out.push(typeName(c.text));
      else collect(c, 0);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

const BODY = /^(block|body|declaration_list|field_declaration_list|compound_statement|members|do_block|statements|\w+_body|\w+_block|template_body|structure)$/;

function bodyOf(n: Node): Node | null {
  const body = n.childForFieldName('body');
  if (body) return body;
  for (let i = n.namedChildCount - 1; i >= 0; i--) {
    const c = n.namedChild(i);
    if (c && BODY.test(c.type) && !/_(end|start)$/.test(c.type)) return c;
  }
  return null;
}

const CLASSY = new Set<SymbolKind>(['class', 'struct', 'record', 'interface', 'enum', 'module', 'object', 'type']);

/** Module an import names: its string literal (`#include "x.h"`), else the statement minus keywords. */
function importTarget(n: Node): string {
  const str = n.descendantsOfType(['string_literal', 'string', 'system_lib_string', 'string_lit', 'interpreted_string_literal'])[0];
  if (str) {
    const t = str.text.replace(/^["'<`]|["'>`]$/g, '').trim();
    if (t) return t;
  }
  const line = n.text.split('\n')[0] ?? '';
  return line
    .replace(/^\s*(import|use|using|include|require|open|from|extern\s+crate|@import)\s+(static\s+)?/, '')
    .replace(/[;\s]+$/, '')
    .slice(0, 160)
    .trim();
}

export function extractSpec(b: Builder, root: Node, spec: LangSpec, file = ''): void {
  const calls = new Set(spec.calls ?? []);
  const news = new Set(spec.news ?? []);
  const imports = new Set(spec.imports ?? []);
  const fields = new Set(spec.fields ?? []);
  const params = new Set(spec.params ?? []);
  const locals = new Set(spec.locals ?? []);
  const pkgs = new Set(spec.pkg ?? []);
  const skip = new Set(spec.skip ?? ['comment', 'line_comment', 'block_comment', 'string', 'string_literal', 'raw_string_literal', 'heredoc_body']);
  /** Sibling bodies already walked with their declaration (Dart). */
  const consumed = new Set<number>();
  if (spec.module) b.f.pkg = spec.module(root, file) || b.f.pkg;

  const nameOf = (n: Node): DefInfo | null => {
    // Own keys only: node types such as `constructor` would otherwise hit Object.prototype.
    const kind = Object.hasOwn(spec.defs, n.type) ? spec.defs[n.type] : undefined;
    if (!kind) return null;
    if (spec.name) return spec.name(n);
    const g = genericName(n);
    return g ? { name: g.node.text, kind, owner: g.owner } : null;
  };

  const record = (s: Scope, field: boolean, names: string[], type: string): void => {
    for (const name of names) {
      const clean = name.replace(/^[$@]/, '');
      if (field && s.cls >= 0) b.variable(s.cls, clean, type, '', true);
      else if (!field) b.variable(s.fn >= 0 ? s.fn : -1, clean, type, '', false);
    }
  };

  const typed = (n: Node, s: Scope, field: boolean): void => {
    const custom = spec.typed?.(n);
    if (custom) {
      const type = qualifiedType(custom.type);
      if (type) record(s, field, custom.names, type);
      return;
    }
    const annotation = n.namedChildren.find((c) => c?.type === 'type_annotation');
    const typeNode =
      n.childForFieldName('type') ??
      n.namedChildren.find((c) => c?.childForFieldName('type'))?.childForFieldName('type') ??
      annotation?.namedChildren[0] ??
      null;
    const type = typeNode ? qualifiedType(typeNode.text) : '';
    if (!type) return;
    const names: string[] = [];
    const declarators = n.descendantsOfType(['variable_declarator', 'init_declarator', 'property_element', 'pattern']);
    for (const d of declarators) {
      if (!d) continue;
      const nm = d.childForFieldName('name') ?? d.childForFieldName('declarator') ?? lastName(d);
      if (nm) names.push(lastName(nm)?.text ?? nm.text);
    }
    if (names.length === 0) {
      // `Cart cart = …` (Solidity) keeps the name next to the type, in the declaration child.
      const holder = typeNode?.parent && typeNode.parent !== n ? typeNode.parent : n;
      const nm = holder.childForFieldName('name') ?? holder.childForFieldName('pattern') ?? holder.childForFieldName('declarator') ?? n.childForFieldName('name');
      const leaf = nm ? (lastName(nm) ?? nm) : null;
      if (leaf) names.push(leaf.text);
    }
    record(s, field, names, type);
  };

  /**
   * `x = Foo.new()` / `let s = Store::open()` / `var q = new Queue()`: remember how `x` was
   * made; `@repo = Repo.new` / `self.repo = Repo.new()` inside a type make a field.
   */
  const localVar = (n: Node, s: Scope): void => {
    const nameNode =
      n.childForFieldName('name') ??
      n.childForFieldName('pattern') ??
      n.childForFieldName('left') ??
      n.childForFieldName('lhs') ??
      n.namedChildren.find((c) => c !== null && ((isNameNode(c) && c.namedChildCount === 0) || /variable_list|scalar|instance_variable|field_expression|dot_index|left_assignment_expression/.test(c.type))) ??
      null;
    if (!nameNode) return;
    const field = s.cls >= 0 ? selfField(nameNode.text.replace(/^local\s+/, '')) : null;
    const leaf = field ? null : nameNode.namedChildCount === 0 ? nameNode : lastName(nameNode);
    // `a.b = …`, `x[i] = …`, `obj->f = …`: not a variable of this scope.
    if (!field && (!leaf || leaf.text.includes('.') || /[.[(]|->|\$\w+\$/.test(nameNode.text.replace(/^(my|local|our)\s+/, '')))) return;
    let value: Node | null = n.childForFieldName('value') ?? n.childForFieldName('right') ?? n.childForFieldName('rhs') ?? n.namedChild(n.namedChildCount - 1);
    // `this.repo = repo` in a constructor: the field has the parameter's type.
    if (field && value && isNameNode(value) && value.namedChildCount === 0 && s.fn >= 0) {
      const param = b.varIn(s.fn, value.text.replace(/^[$@]/, ''));
      if (param) b.variable(s.cls, field, param.type, param.call, true);
      return;
    }
    // Unwrap `await x`, `try x`, `(x)`, `expression(x)` (PowerShell nests a dozen levels).
    for (let i = 0; i < 16 && value && !calls.has(value.type) && !news.has(value.type) && value.namedChildCount >= 1 && !value.equals(nameNode); i++) {
      value = value.namedChild(value.namedChildCount - 1);
    }
    if (!value || value.equals(nameNode) || (!calls.has(value.type) && !news.has(value.type))) return;
    const info = spec.callee ? spec.callee(value) : genericCallee(b, value);
    if (!info?.name) return;
    const kind = info.kind ?? (news.has(value.type) ? 'new' : 'call');
    const name = field ?? (leaf?.text ?? '').replace(/^[$@]/, '');
    const scope = field ? s.cls : s.fn >= 0 ? s.fn : -1;
    if (kind === 'new') {
      // `new Cart.cart (…)` / `new pricing.Calc()`: keep the module qualifier with the type.
      const q = info.recv.startsWith('v:') || info.recv.startsWith('m:') ? info.recv.slice(2) : '';
      b.variable(scope, name, q ? `${q}.${qualifiedType(info.name)}` : qualifiedType(info.name), '', field !== null);
    }
    else if (kind === 'call') {
      const q = info.recv.startsWith('v:') || info.recv.startsWith('m:') ? info.recv.slice(2) : null;
      const call = q ? `${q}.${info.name}` : info.recv === '' ? info.name : '';
      if (call) b.variable(scope, name, '', call, field !== null);
    }
  };

  const openSequential = (c: Node, s: Scope): Scope | null => {
    const info = spec.sequential && Object.hasOwn(spec.sequential, c.type) ? spec.sequential[c.type]?.(c) : null;
    if (!info?.name) return null;
    const idx = b.sym(c, info.name, info.kind, s.cls, { body: null, doc: leadingComment(c), exported: true, ...(info.sig ? { sig: info.sig } : {}) });
    for (const base of spec.bases?.(c) ?? []) if (base) b.ref(idx, base, 'inherit', lineOf(c));
    return { sym: idx, cls: idx, fn: -1 };
  };

  const visitAll = (n: Node, s: Scope): void => {
    let scope = s;
    let open = -1;
    for (const c of n.namedChildren) {
      if (!c) continue;
      const seq = spec.sequential && s.fn < 0 ? openSequential(c, s) : null;
      if (seq) {
        open = seq.sym;
        scope = seq;
        continue;
      }
      visit(c, scope);
      const sym = open >= 0 ? b.f.syms[open] : undefined;
      if (sym) sym.end = Math.max(sym.end, c.endPosition.row + 1);
    }
  };

  const visit = (n: Node, s: Scope): void => {
    if (skip.has(n.type) || consumed.has(n.id)) return;
    const ownerFn = spec.owners && Object.hasOwn(spec.owners, n.type) ? spec.owners[n.type] : undefined;
    if (ownerFn) {
      const o = ownerFn(n);
      if (o) {
        for (const base of o.inherits) b.ref(-1, base, 'inherit', lineOf(n), `o:${o.owner}`);
        const body = bodyOf(n) ?? n;
        for (const c of body.namedChildren) if (c) visit(c, { ...s, owner: o.owner } as Scope & { owner: string });
        return;
      }
    }
    const def = nameOf(n);
    if (def && def.name) {
      const inType = s.cls >= 0 && s.fn < 0;
      const parentKind = inType ? b.f.syms[s.cls]?.kind : undefined;
      const owner = def.owner || (s as Scope & { owner?: string }).owner || '';
      let kind = def.kind;
      // Functions inside a type (or declared for one) are methods; inside a module they stay functions.
      if (kind === 'function' && ((inType && parentKind !== 'module') || owner)) kind = 'method';
      const node = def.node ?? n;
      const body = def.body !== undefined ? def.body : bodyOf(node);
      const ret = CLASSY.has(kind) ? null : (n.childForFieldName('return_type') ?? n.childForFieldName('returns') ?? n.childForFieldName('result') ?? (n.childForFieldName('declarator') ? n.childForFieldName('type') : null) ?? (spec.returnsField ? n.childForFieldName(spec.returnsField) : null));
      // `-> Self` / `: this` returns the type the method belongs to.
      const selfType = owner || (inType ? (b.f.syms[s.cls]?.name ?? '') : '');
      const returns = ret ? (/^(Self|this|static|self)$/.test(ret.text.trim()) ? selfType : typeName(ret.text)) : '';
      const idx = b.sym(node, def.name, kind, inType ? s.cls : CLASSY.has(kind) ? s.cls : -1, {
        body,
        ...(def.sig ? { sig: def.sig } : {}),
        ...(returns ? { returns } : {}),
        owner: inType ? '' : owner,
        doc: leadingComment(node),
        exported: kind === 'constructor' || !def.name.startsWith('_'),
      });
      if (def.end) {
        const sym = b.f.syms[idx];
        if (sym) sym.end = def.end.endPosition.row + 1;
      }
      // A method declared for a type of this file (`function Cart:checkout()`, `impl Cart`) sees
      // that type's fields as `self.x`.
      const ownerIdx = !inType && owner ? b.f.syms.findIndex((x) => x.parent === -1 && x.name === owner && CLASSY.has(x.kind)) : -1;
      const inner: Scope = CLASSY.has(kind) ? { sym: idx, cls: idx, fn: -1 } : { sym: idx, cls: ownerIdx >= 0 ? ownerIdx : s.cls, fn: idx };
      if (CLASSY.has(kind)) {
        for (const base of (spec.bases ?? genericBases)(n)) if (base && base !== def.name) b.ref(idx, base, 'inherit', lineOf(n));
      }
      if (def.skip) consumed.add(def.skip.id);
      visitAll(n, inner);
      if (def.extra) {
        consumed.add(def.extra.id);
        visitAll(def.extra, inner);
      }
      return;
    }
    if (calls.has(n.type) || news.has(n.type)) {
      const info = spec.callee ? spec.callee(n) : genericCallee(b, n);
      // Operators called like functions (`(* v 2)`, `(+)`) are not symbols.
      if (info && info.name && /[A-Za-z_$]/.test(info.name)) {
        const kind = info.kind ?? (news.has(n.type) ? 'new' : 'call');
        const name = kind === 'new' || kind === 'inherit' ? qualifiedType(info.name) || info.name : info.name;
        b.ref(kind === 'inherit' ? s.cls : s.sym, name, kind, lineOf(n), info.recv);
      }
    } else if (imports.has(n.type)) {
      if (spec.onImport) spec.onImport(n, s);
      else {
        const target = importTarget(n);
        if (target) b.imp('module', target, '', '');
      }
      return;
    } else if (pkgs.has(n.type) && !b.f.pkg) {
      // `package a.b;`, `namespace A.B`, `package_clause a.b`: the whole qualified name.
      const nm = n.childForFieldName('name') ?? n.namedChildren.find((c) => c !== null && /identifier|qualified|scoped|name/.test(c.type)) ?? lastName(n);
      if (nm) b.f.pkg = dotted(nm.text.replace(/\s+/g, ''));
    }
    // Constructor-promoted members (PHP 8) are fields even though they sit in a parameter list.
    if (fields.has(n.type) && s.cls >= 0 && (s.fn < 0 || n.type.includes('promotion'))) typed(n, s, true);
    else if (params.has(n.type) && s.fn >= 0) typed(n, s, false);
    // Locals of functions and file-level variables; a type's members are fields, not locals.
    if (locals.has(n.type) && (s.fn >= 0 || s.cls < 0)) {
      const custom = spec.local ? spec.local(n) : undefined;
      if (custom) b.variable(s.fn >= 0 ? s.fn : -1, custom.name, custom.type ?? '', custom.call ?? '', false);
      else if (custom === undefined) localVar(n, s);
    }
    visitAll(n, s);
  };

  spec.prepare?.(root);
  visit(root, TOP);
}
