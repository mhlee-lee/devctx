import type { Node } from 'web-tree-sitter';
import type { Builder } from './common.ts';
import { ancestor, baseName, capitalize, child, lastSeg, qualifiedCall, text } from './helpers.ts';
import { clojureNs, elmImport, erlangImport, haskellImport, juliaImport, solidityImport, splitTop } from './imports.ts';
import { calleeFrom, dotted, genericCallee, lastName, receiverText, typeName, type CallInfo, type DefInfo, type LangSpec } from './spec.ts';

/**
 * Language tables, part two: R, Julia, Haskell, OCaml, Elixir, Erlang, Elm, Clojure, Zig,
 * shell, PowerShell, Solidity, Terraform/HCL and SQL (see specs.ts for the approach).
 */

type Kind = DefInfo['kind'];

const values = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null && c.type !== 'meta_lit' && c.type !== 'comment');

function rSpec(b: Builder): LangSpec {
  const inClassCall = (n: Node): boolean => {
    for (let p = n.parent, i = 0; p && i < 8; p = p.parent, i++) {
      if (p.type === 'call' && /(^|::)(R6Class|setRefClass)$/.test(text(p.childForFieldName('function')))) return true;
    }
    return false;
  };
  return {
    defs: { binary_operator: 'function', argument: 'method' },
    name: (n) => {
      if (n.type === 'argument') {
        // R6 / Reference classes: `public = list(checkout = function(items) …)`.
        const nm = n.childForFieldName('name');
        if (!nm || n.childForFieldName('value')?.type !== 'function_definition' || !inClassCall(n)) return null;
        return { name: nm.text, kind: nm.text === 'initialize' ? 'constructor' : 'method' };
      }
      const lhs = n.childForFieldName('lhs');
      const rhs = n.childForFieldName('rhs');
      if (!lhs || !rhs || !/^(<-|<<-|=|->)$/.test(n.childForFieldName('operator')?.text ?? n.child(1)?.text ?? '')) return null;
      if (lhs.type !== 'identifier' && lhs.type !== 'string') return null;
      if (rhs.type === 'function_definition') return { name: lhs.text.replace(/^["'`]|["'`]$/g, ''), kind: 'function' };
      const fn = rhs.type === 'call' ? (rhs.childForFieldName('function')?.text ?? '') : '';
      if (/(^|::)(R6Class|setRefClass|setClass)$/.test(fn)) return { name: lhs.text, kind: 'class' };
      return null;
    },
    // `R6Class("SqlRepo", inherit = Repo, …)`
    bases: (n) => {
      const args = n.childForFieldName('rhs')?.childForFieldName('arguments');
      const inherit = args?.namedChildren.find((a) => a?.type === 'argument' && a.childForFieldName('name')?.text === 'inherit');
      const v = inherit?.childForFieldName('value');
      return v ? [v.text] : [];
    },
    calls: ['call'],
    callee: (n) => {
      const info = calleeFrom(b, n.childForFieldName('function'));
      if (info && !info.recv && /^(source|sys\.source)$/.test(info.name)) {
        const arg = n.childForFieldName('arguments')?.namedChildren[0];
        const spec = arg ? text(arg.childForFieldName('value') ?? arg).replace(/^["']|["']$/g, '') : '';
        if (spec) b.imp('file', spec, '', '');
        return null;
      }
      if (info && !info.recv && /^(library|require|requireNamespace)$/.test(info.name)) return null;
      return info;
    },
    locals: ['binary_operator'],
  };
}

function juliaSpec(b: Builder): LangSpec {
  const typeHead = (n: Node): Node | null => {
    const head = child(n, 'type_head');
    const first = head?.namedChildren[0] ?? null;
    return first?.type === 'binary_expression' ? (first.namedChildren[0] ?? null) : first;
  };
  return {
    defs: { function_definition: 'function', short_function_definition: 'function', assignment: 'function', struct_definition: 'struct', abstract_definition: 'type', module_definition: 'module', macro_definition: 'macro' },
    name: (n) => {
      if (n.type === 'module_definition') {
        const nm = n.childForFieldName('name');
        return nm ? { name: nm.text, kind: 'module', body: null } : null;
      }
      if (n.type === 'struct_definition' || n.type === 'abstract_definition') {
        const id = typeHead(n);
        const leaf = id ? (id.type === 'identifier' ? id : lastName(id)) : null;
        return leaf ? { name: leaf.text, kind: n.type === 'struct_definition' ? 'struct' : 'type', body: null } : null;
      }
      const sig = n.type === 'assignment' ? n.namedChildren[0] : (child(n, 'signature')?.namedChildren[0] ?? n.namedChildren[0]);
      const call = sig?.type === 'typed_expression' || sig?.type === 'where_expression' ? sig.namedChildren[0] : sig;
      if (call?.type !== 'call_expression') return null;
      const id = call.namedChildren[0];
      if (!id || (id.type !== 'identifier' && id.type !== 'field_expression')) return null;
      const leaf = id.type === 'identifier' ? id : lastName(id);
      return leaf ? { name: leaf.text, kind: n.type === 'macro_definition' ? 'macro' : 'function', body: null } : null;
    },
    // `struct SqlRepo <: Repo`
    bases: (n) => {
      const head = child(n, 'type_head')?.namedChildren[0];
      if (head?.type !== 'binary_expression' || !/<:/.test(head.text)) return [];
      const sup = head.namedChildren[head.namedChildCount - 1];
      return sup ? [typeName(sup.text)] : [];
    },
    calls: ['call_expression', 'broadcast_call_expression', 'macrocall_expression'],
    callee: (n) => {
      if (n.parent?.type === 'signature' || (n.parent?.type === 'assignment' && n.parent.namedChildren[0] === n)) return null;
      const info = calleeFrom(b, n.namedChildren[0] ?? null);
      if (info?.name === 'include' && !info.recv) {
        const arg = n.namedChildren[1]?.namedChildren[0];
        const spec = arg ? arg.text.replace(/^"|"$/g, '') : '';
        if (spec) b.imp('file', spec, '', '');
        return null;
      }
      return info;
    },
    imports: ['import_statement', 'using_statement'],
    onImport: (n) => juliaImport(b, n),
    locals: ['assignment'],
  };
}

function haskellSpec(b: Builder): LangSpec {
  return {
    defs: { function: 'function', bind: 'function', data_type: 'type', newtype: 'type', class: 'interface', type_synomym: 'type', signature: 'method' },
    name: (n) => {
      if (n.type === 'signature' && n.parent?.type !== 'class_declarations') return null;
      // `let s = …` / `where` bindings are locals of the enclosing function, not symbols.
      if ((n.type === 'bind' || n.type === 'function') && !/^(declarations|class_declarations|instance_declarations)$/.test(n.parent?.type ?? '')) return null;
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      const kind: Kind = n.type === 'class' ? 'interface' : n.type === 'data_type' || n.type === 'newtype' || n.type === 'type_synomym' ? 'type' : n.type === 'signature' ? 'method' : 'function';
      return { name: nm.text, kind, ...(n.type === 'signature' ? { body: null } : {}) };
    },
    // `instance Repo SqlRepo where save … = …`: SqlRepo implements Repo with these methods.
    owners: {
      instance: (n) => {
        const cls = text(n.childForFieldName('name'));
        const type = n.childForFieldName('patterns')?.namedChildren[0];
        const owner = type ? typeName(type.text.replace(/^\(|\)$/g, '').split(/\s+/)[0] ?? '') : '';
        return owner ? { owner, inherits: cls ? [cls] : [] } : null;
      },
    },
    calls: ['apply'],
    // Type applications in signatures (`Repo r => Cart r`) are not calls.
    callee: (n) => (ancestor(n, ['signature', 'context', 'type_params', 'data_type', 'newtype'], 30) ? null : genericCallee(b, n)),
    imports: ['import'],
    onImport: (n) => haskellImport(b, n),
    module: (root) => dotted(text(child(root, 'header')?.childForFieldName('module')).replace(/\s+/g, '')),
  };
}

function ocamlSpec(b: Builder): LangSpec {
  const newInfo = (n: Node): CallInfo | null => {
    const p = child(n, 'class_path');
    if (!p) return null;
    const info = qualifiedCall(p.text.replace(/\s+/g, ''));
    return info ? { ...info, kind: 'new' } : null;
  };
  return {
    defs: { let_binding: 'function', module_binding: 'module', type_binding: 'type', class_binding: 'class', method_definition: 'method' },
    name: (n) => {
      if (n.type === 'let_binding') {
        if (n.parent?.type !== 'value_definition' || n.parent.parent?.type === 'let_expression') return null;
        const p = n.childForFieldName('pattern');
        return p && (p.type === 'value_name' || p.type === 'parenthesized_operator') ? { name: p.text, kind: 'function' } : null;
      }
      const nm = n.childForFieldName('name') ?? child(n, 'module_name') ?? child(n, 'type_constructor') ?? child(n, 'class_name') ?? child(n, 'method_name');
      if (!nm) return null;
      const kind: Kind = n.type === 'module_binding' ? 'module' : n.type === 'type_binding' ? 'type' : n.type === 'class_binding' ? 'class' : 'method';
      return { name: nm.text, kind };
    },
    // `inherit repo` inside the class body.
    bases: (n) =>
      n
        .descendantsOfType('inheritance_definition')
        .filter((d): d is Node => d !== null && ancestor(d, ['class_binding'])?.id === n.id)
        .map((d) => dotted(text(d.childForFieldName('class') ?? child(d, 'class_path')).replace(/\s+/g, '')))
        .filter(Boolean),
    calls: ['application_expression', 'method_invocation'],
    news: ['new_expression'],
    callee: (n) => {
      if (n.type === 'new_expression') return n.parent?.type === 'application_expression' && n.parent.childForFieldName('function')?.equals(n) ? null : newInfo(n);
      const f = n.type === 'application_expression' ? n.childForFieldName('function') : null;
      if (f?.type === 'new_expression') return newInfo(f);
      return genericCallee(b, n);
    },
    imports: ['open_module'],
    onImport: (n) => {
      const mod = n.namedChildren.find((c) => c !== null && /module_path|module_name/.test(c.type))?.text;
      if (mod) b.imp('wild', mod.replace(/\s+/g, ''), '', '');
    },
    // `class cart (r : Repo.repo) = …`: the class parameter is a typed field.
    fields: ['parameter'],
    params: ['parameter'],
    typed: (n) => {
      const p = n.childForFieldName('pattern');
      if (p?.type !== 'typed_pattern') return null;
      const nm = p.childForFieldName('pattern');
      const type = p.childForFieldName('type');
      return nm && type ? { type: type.text, names: [nm.text] } : null;
    },
    locals: ['let_binding'],
    module: (_root, file) => capitalize(baseName(file)),
  };
}

function elixirAlias(b: Builder, n: Node): void {
  const args = child(n, 'arguments');
  const first = args?.namedChildren[0];
  if (!first) return;
  const t = first.text.replace(/\s+/g, '');
  const as = args?.namedChildren
    .find((c) => c?.type === 'keywords')
    ?.namedChildren.find((p) => p?.childForFieldName('key')?.text.replace(/[:\s]/g, '') === 'as')
    ?.childForFieldName('value')?.text;
  const multi = /^([\w.]+)\.\{(.*)\}$/.exec(t);
  if (multi?.[1] && multi[2] !== undefined) {
    for (const part of splitTop(multi[2])) b.imp('module', `${multi[1]}.${part}`, '', lastSeg(part));
    return;
  }
  if (/^[A-Z][\w.]*$/.test(t)) b.imp('module', t, '', as ?? lastSeg(t));
}

function elixirSpec(b: Builder): LangSpec {
  return {
    defs: { call: 'function' },
    name: (n) => {
      const target = n.childForFieldName('target');
      const form = target?.type === 'identifier' ? target.text : '';
      const args = child(n, 'arguments');
      if (form === 'defmodule' || form === 'defprotocol' || form === 'defimpl') {
        const alias = args?.namedChildren[0];
        // Modules keep their full name (`Shop.Pricing`): other modules call them by it.
        return alias ? { name: dotted(alias.text.replace(/\s+/g, '')), kind: form === 'defprotocol' ? 'interface' : 'module', body: child(n, 'do_block') } : null;
      }
      if (!/^(def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate)$/.test(form)) return null;
      let head = args?.namedChildren[0] ?? null;
      if (head?.type === 'binary_operator') head = head.childForFieldName('left'); // `def f(x) when ...`
      const nm = head?.type === 'call' ? head.childForFieldName('target') : head?.type === 'identifier' ? head : null;
      if (!nm || !head) return null;
      return {
        name: nm.text,
        kind: form.startsWith('defmacro') ? 'macro' : 'function',
        body: null,
        sig: `${form} ${head.text}`.replace(/\s+/g, ' ').slice(0, 200),
        ...(head.type === 'call' ? { skip: head } : {}),
      };
    },
    calls: ['call'],
    callee: (n) => {
      const target = n.childForFieldName('target');
      if (!target) return null;
      if (target.type === 'identifier') {
        const name = target.text;
        if (name === 'alias') {
          elixirAlias(b, n);
          return null;
        }
        if (name === 'import') {
          const mod = child(n, 'arguments')?.namedChildren[0]?.text.replace(/\s+/g, '');
          if (mod && /^[A-Z][\w.]*$/.test(mod)) b.imp('wild', mod, '', '');
          return null;
        }
        // `@behaviour Shop.Repo`: the module implements that behaviour.
        if (name === 'behaviour' && n.parent?.type === 'unary_operator') {
          const mod = child(n, 'arguments')?.namedChildren[0]?.text;
          return mod ? { name: dotted(mod), recv: '', kind: 'inherit' } : null;
        }
        return /^(require|use|def\w*|moduledoc|doc|spec|type|typep|callback|impl|behaviour|defstruct|defexception|if|unless|case|cond|with|for|fn|quote|unquote|raise|receive|try)$/.test(name) ? null : { name, recv: '' };
      }
      if (target.type === 'dot') {
        const left = target.childForFieldName('left');
        const right = target.childForFieldName('right');
        // `Pricing.sum()` names a module (by alias or full name); `conn.close()` a variable.
        const recv = left ? (left.type === 'alias' ? `m:${dotted(left.text.replace(/\s+/g, ''))}` : receiverText(left.text)) : '';
        return right ? { name: right.text, recv } : null;
      }
      return null;
    },
  };
}

function erlangSpec(b: Builder): LangSpec {
  return {
    defs: { fun_decl: 'function', record_decl: 'type', type_alias: 'type' },
    name: (n) => {
      if (n.type === 'fun_decl') {
        const clause = n.childForFieldName('clause') ?? child(n, 'function_clause');
        const nm = clause?.childForFieldName('name');
        return nm ? { name: nm.text, kind: 'function' } : null;
      }
      const nm = n.childForFieldName('name');
      return nm ? { name: (nm.childForFieldName('name') ?? nm).text, kind: 'type' } : null;
    },
    calls: ['call', 'remote'],
    callee: (n) => {
      if (n.type === 'remote') {
        const mod = n.childForFieldName('module');
        const fun = n.childForFieldName('fun');
        const nm = fun?.type === 'call' ? fun.childForFieldName('expr') : fun;
        return nm ? { name: nm.text, recv: mod ? `m:${mod.text.replace(/:$/, '').trim()}` : '' } : null;
      }
      if (n.parent?.type === 'remote') return null;
      const expr = n.childForFieldName('expr');
      return expr?.type === 'atom' ? { name: expr.text, recv: '' } : null;
    },
    imports: ['pp_include', 'pp_include_lib', 'import_attribute'],
    onImport: (n) => erlangImport(b, n),
    module: (root) => text(root.descendantsOfType('module_attribute')[0]?.childForFieldName('name') ?? null),
  };
}

function elmSpec(b: Builder): LangSpec {
  return {
    defs: { value_declaration: 'function', type_declaration: 'type', type_alias_declaration: 'type', port_annotation: 'function' },
    name: (n) => {
      if (n.type === 'value_declaration') {
        const left = child(n, 'function_declaration_left');
        const id = left ? child(left, 'lower_case_identifier') : null;
        return id ? { name: id.text, kind: 'function' } : null;
      }
      const nm = n.childForFieldName('name');
      return nm ? { name: nm.text, kind: n.type === 'port_annotation' ? 'function' : 'type' } : null;
    },
    calls: ['function_call_expr'],
    callee: (n) => qualifiedCall(text(n.childForFieldName('target')).replace(/\s+/g, '')),
    imports: ['import_clause'],
    onImport: (n) => elmImport(b, n),
    module: (root) => text(child(root, 'module_declaration')?.childForFieldName('name')).replace(/\s+/g, ''),
  };
}

const CLJ_DEFS: Record<string, Kind> = { defn: 'function', 'defn-': 'function', defmacro: 'macro', defmulti: 'function', defprotocol: 'interface', defrecord: 'record', deftype: 'class', definterface: 'interface' };
const CLJ_METHOD_HOSTS = /^(defprotocol|defrecord|deftype|definterface|extend-protocol|extend-type|reify)$/;

function clojureSpec(b: Builder): LangSpec {
  return {
    defs: { list_lit: 'function' },
    name: (n) => {
      const [head, second] = values(n);
      if (head?.type !== 'sym_lit') return null;
      // `(save [this v] …)` inside defprotocol / defrecord / deftype: a method of that type.
      const host = n.parent?.type === 'list_lit' ? values(n.parent)[0]?.text : undefined;
      if (host && CLJ_METHOD_HOSTS.test(host) && second?.type === 'vec_lit') return { name: head.text, kind: 'method' };
      const kind = Object.hasOwn(CLJ_DEFS, head.text) ? CLJ_DEFS[head.text] : undefined;
      return kind && second?.type === 'sym_lit' ? { name: second.text, kind } : null;
    },
    // `(defrecord SqlRepo [] Repo (save …))`: protocols named after the field vector.
    bases: (n) => {
      const [head, , fieldsVec, ...rest] = values(n);
      if (head?.text !== 'defrecord' && head?.text !== 'deftype') return [];
      return fieldsVec?.type === 'vec_lit' ? rest.filter((c) => c.type === 'sym_lit').map((c) => c.text) : [];
    },
    calls: ['list_lit'],
    callee: (n) => {
      const head = values(n)[0];
      if (head?.type !== 'sym_lit') return null;
      const t = head.text;
      if (t === 'ns') {
        clojureNs(b, n);
        return null;
      }
      if (/^(def\w*|fn|let|if|when|cond|do|loop|recur|->|->>|quote|require|import|ns)$/.test(t)) return null;
      const slash = t.indexOf('/');
      const qual = slash > 0 ? t.slice(0, slash) : '';
      const name = slash > 0 ? t.slice(slash + 1) : t;
      // `(->SqlRepo)`, `(map->SqlRepo m)`, `(SqlRepo. x)`: record constructors.
      const ctor = /^(?:map)?->([A-Z][\w-]*)$/.exec(name)?.[1] ?? /^([A-Z][\w-]*)\.$/.exec(name)?.[1];
      if (ctor) return { name: ctor, recv: qual ? `m:${qual}` : '', kind: 'new' };
      return { name, recv: qual ? `m:${qual}` : '' };
    },
    module: (root) => {
      const ns = root.namedChildren.find((c) => c?.type === 'list_lit' && values(c)[0]?.text === 'ns');
      return ns ? text(values(ns)[1]) : '';
    },
  };
}

function zigSpec(b: Builder): LangSpec {
  return {
    defs: { function_declaration: 'function', struct_declaration: 'struct', enum_declaration: 'enum', union_declaration: 'struct', test_declaration: 'function' },
    name: (n) => {
      if (n.type === 'function_declaration') {
        const nm = n.childForFieldName('name');
        return nm ? { name: nm.text, kind: 'function' } : null;
      }
      if (n.type === 'test_declaration') {
        const s = n.namedChildren.find((c) => c?.type === 'string' || c?.type === 'identifier');
        return s ? { name: `test ${s.text.replace(/^"|"$/g, '')}`, kind: 'function' } : null;
      }
      // `const Queue = struct { ... }`: the container is named by its declaration.
      const decl = n.parent?.type === 'variable_declaration' ? n.parent : null;
      const nm = decl ? child(decl, 'identifier') : null;
      return nm ? { name: nm.text, kind: n.type === 'enum_declaration' ? 'enum' : 'struct', node: decl ?? n, body: n } : null;
    },
    calls: ['call_expression', 'builtin_function'],
    callee: (n) => {
      if (n.type === 'builtin_function') {
        if (n.namedChildren[0]?.text !== '@import') return null;
        const spec = (n.descendantsOfType('string')[0]?.text ?? '').replace(/^"|"$/g, '');
        if (!spec) return null;
        // `const pricing = @import("pricing.zig");` / `const Repo = @import("repo.zig").Repo;`
        const decl = n.parent?.type === 'variable_declaration' ? n.parent : null;
        const member = n.parent?.type === 'field_expression' ? n.parent : null;
        if (decl) b.imp('module', spec, '', text(child(decl, 'identifier')));
        else if (member?.parent?.type === 'variable_declaration') {
          const field = text(member.childForFieldName('member'));
          if (field) b.imp('named', spec, field, text(child(member.parent, 'identifier')) || field);
        } else b.imp('module', spec, '', '');
        return null;
      }
      return genericCallee(b, n);
    },
    news: ['struct_initializer'],
    fields: ['container_field'],
    params: ['parameter'],
    locals: ['variable_declaration'],
    returnsField: 'type',
  };
}

function bashSpec(b: Builder): LangSpec {
  return {
    defs: { function_definition: 'function' },
    calls: ['command'],
    callee: (n) => {
      const nm = n.childForFieldName('name');
      if (!nm) return null;
      const cmd = nm.text;
      if (cmd === 'source' || cmd === '.') {
        const arg = n.childForFieldName('argument');
        const spec = arg ? arg.text.replace(/^["']|["']$/g, '') : '';
        if (spec) b.imp('file', spec, '', '');
        return null;
      }
      return /^[\w-]+$/.test(cmd) ? { name: cmd, recv: '' } : null;
    },
  };
}

function powershellSpec(b: Builder): LangSpec {
  const typeOf = (n: Node | null | undefined): string => (n ? n.text.replace(/^\[|\]$/g, '').trim() : '');
  return {
    defs: { function_statement: 'function', class_statement: 'class', class_method_definition: 'method', enum_statement: 'enum' },
    name: (n) => {
      if (n.type === 'function_statement') {
        const nm = child(n, 'function_name');
        return nm ? { name: nm.text, kind: 'function' } : null;
      }
      const nm = child(n, 'simple_name');
      if (!nm) return null;
      if (n.type === 'class_method_definition') {
        const cls = ancestor(n, ['class_statement']);
        const own = cls ? child(cls, 'simple_name')?.text : '';
        return { name: nm.text, kind: nm.text === own ? 'constructor' : 'method' };
      }
      return { name: nm.text, kind: n.type === 'enum_statement' ? 'enum' : 'class' };
    },
    // `class SqlRepo : Repo, IDisposable`
    bases: (n) => (n.type === 'class_statement' ? n.namedChildren.filter((c): c is Node => c?.type === 'simple_name').slice(1).map((c) => c.text) : []),
    calls: ['command', 'invokation_expression'],
    callee: (n) => {
      if (n.type === 'command') {
        const nm = n.childForFieldName('command_name');
        if (!nm || !/^[\w-]+$/.test(nm.text)) return null;
        if (/^Import-Module$/i.test(nm.text)) {
          const arg = n.namedChildren.find((c) => c !== null && c !== nm && /path|generic|string|expandable/.test(c.type));
          const spec = arg ? arg.text.replace(/^["']|["']$/g, '').replace(/^\$PSScriptRoot[/\\]/, './') : '';
          if (spec) b.imp('file', spec, '', '');
          return null;
        }
        return { name: nm.text, recv: '' };
      }
      // `$obj.Method()`, `$this.Repo.Save()`, `[Cart]::new()`, `[Math]::Round()`
      const member = child(n, 'member_name');
      const target = n.namedChildren[0];
      if (!member || !target) return null;
      if (target.type === 'type_literal') {
        const type = typeOf(target);
        return member.text.toLowerCase() === 'new' ? { name: type, recv: '', kind: 'new' } : { name: member.text, recv: `m:${type}` };
      }
      return { name: member.text, recv: receiverText(`${target.text}.`) };
    },
    fields: ['class_property_definition'],
    params: ['class_method_parameter'],
    typed: (n) => {
      const type = child(n, 'type_literal');
      const v = child(n, 'variable');
      return type && v ? { type: typeOf(type), names: [v.text.replace(/^\$/, '')] } : null;
    },
    locals: ['assignment_expression'],
    // `. $PSScriptRoot/x.ps1` dot-sourcing: the grammar reads the path as an expression.
    prepare: () => {
      for (const m of b.src.matchAll(/^[ \t]*\.[ \t]+["']?(?:\$PSScriptRoot[/\\])?([^\s"'|;]+\.ps[m]?1)["']?/gm)) if (m[1]) b.imp('file', m[1].replace(/\\/g, '/'), '', '');
    },
  };
}

const SOL_KIND: Record<string, Kind> = {
  contract_declaration: 'class',
  interface_declaration: 'interface',
  library_declaration: 'module',
  struct_declaration: 'struct',
  enum_declaration: 'enum',
  function_definition: 'function',
  modifier_definition: 'function',
  event_definition: 'function',
  error_declaration: 'type',
};

function soliditySpec(b: Builder): LangSpec {
  return {
    defs: { ...SOL_KIND, constructor_definition: 'constructor' },
    name: (n) => {
      if (n.type === 'constructor_definition') return { name: 'constructor', kind: 'constructor' };
      const nm = n.childForFieldName('name');
      return nm ? { name: nm.text, kind: SOL_KIND[n.type] ?? 'function' } : null;
    },
    calls: ['call_expression', 'emit_statement'],
    callee: (n) => {
      if (n.type === 'emit_statement') {
        const nm = n.childForFieldName('name');
        return nm ? { name: lastName(nm)?.text ?? nm.text, recv: '' } : null;
      }
      return genericCallee(b, n);
    },
    news: ['new_expression'],
    imports: ['import_directive'],
    onImport: (n) => solidityImport(b, n),
    fields: ['state_variable_declaration'],
    params: ['parameter', 'variable_declaration_statement'],
  };
}

/** Terraform/HCL top-level blocks under the names expressions use to reference them. */
function hclName(b: Builder, n: Node): DefInfo | null {
  if (n.type === 'attribute') {
    // Only attributes of a top-level `locals` block are symbols (`local.<name>`).
    const block = n.parent?.parent;
    if (block?.type !== 'block' || block.namedChildren[0]?.text !== 'locals') return null;
    const id = n.namedChildren[0];
    return id ? { name: `local.${id.text}`, kind: 'type', body: null } : null;
  }
  if (n.parent?.parent?.type !== 'config_file') return null;
  const [type, ...rest] = n.namedChildren.filter((c): c is Node => c !== null && (c.type === 'identifier' || c.type === 'string_lit'));
  if (!type) return null;
  const labels = rest.map((l) => l.text.replace(/^"|"$/g, ''));
  const kw = type.text;
  switch (kw) {
    case 'resource':
      return labels.length >= 2 ? { name: `${labels[0]}.${labels[1]}`, kind: 'object' } : null;
    case 'data':
      return labels.length >= 2 ? { name: `data.${labels[0]}.${labels[1]}`, kind: 'object' } : null;
    case 'module': {
      if (!labels[0]) return null;
      // `source = "./modules/network"`: `module.network.x` reads outputs of that directory.
      const body = n.namedChildren.find((c) => c?.type === 'body');
      const source = body?.namedChildren.find((a) => a?.type === 'attribute' && a.namedChildren[0]?.text === 'source');
      const spec = source ? (source.namedChildren[source.namedChildCount - 1]?.text ?? '').replace(/^"|"$/g, '') : '';
      if (spec.startsWith('.')) b.imp('module', spec, '', labels[0]);
      return { name: `module.${labels[0]}`, kind: 'module' };
    }
    case 'variable':
      return labels[0] ? { name: `var.${labels[0]}`, kind: 'type' } : null;
    case 'output':
      return labels[0] ? { name: `output.${labels[0]}`, kind: 'type' } : null;
    case 'provider':
      return labels[0] ? { name: `provider.${labels[0]}`, kind: 'object' } : null;
    case 'locals':
      return null;
    default:
      return labels[0] ? { name: `${kw}.${labels.join('.')}`, kind: 'object' } : null;
  }
}

function hclSpec(b: Builder): LangSpec {
  return {
    defs: { block: 'object', attribute: 'type' },
    name: (n) => hclName(b, n),
    calls: ['expression'],
    callee: (n) => {
      const parts = n.namedChildren.filter((c): c is Node => c !== null);
      const head = parts[0];
      if (head?.type !== 'variable_expr') return null;
      const attrs = parts
        .slice(1)
        .filter((c) => c.type === 'get_attr')
        .map((c) => c.text.replace(/^\./, ''));
      const root = head.text;
      if (/^(each|count|self|path|terraform)$/.test(root)) return null;
      // `module.network.subnet_id`: output `subnet_id` of the module's source directory.
      if (root === 'module' && attrs.length >= 2) return { name: `output.${attrs[1]}`, recv: `v:${attrs[0]}`, kind: 'type' };
      const want = root === 'data' ? 2 : 1;
      if (attrs.length < want) return null;
      return { name: `${root}.${attrs.slice(0, want).join('.')}`, recv: '', kind: 'type' };
    },
  };
}

const SQL_KIND: Record<string, Kind> = { create_table: 'type', create_view: 'type', create_materialized_view: 'type', create_function: 'function', create_procedure: 'function', create_type: 'type', create_index: 'object' };

/** `shop.orders` for a schema-qualified object, `orders` otherwise. */
function sqlName(ref: Node | null): string {
  if (!ref) return '';
  const nm = ref.childForFieldName('name') ?? lastName(ref);
  if (!nm) return '';
  const schema = ref.childForFieldName('schema');
  return schema ? `${schema.text}.${nm.text}` : nm.text;
}

function sqlSpec(): LangSpec {
  return {
    defs: SQL_KIND,
    name: (n) => {
      const name = sqlName(child(n, 'object_reference'));
      return name ? { name, kind: SQL_KIND[n.type] ?? 'type', body: null } : null;
    },
    calls: ['relation', 'invocation'],
    callee: (n) => {
      const name = sqlName(child(n, 'object_reference'));
      if (!name) return null;
      return n.type === 'relation' ? { name, recv: '', kind: 'type' } : { name, recv: '' };
    },
    skip: ['comment', 'marginalia'],
  };
}

export function moreSpecFor(lang: string, b: Builder): LangSpec | null {
  switch (lang) {
    case 'r':
      return rSpec(b);
    case 'julia':
      return juliaSpec(b);
    case 'haskell':
      return haskellSpec(b);
    case 'ocaml':
      return ocamlSpec(b);
    case 'elixir':
      return elixirSpec(b);
    case 'erlang':
      return erlangSpec(b);
    case 'elm':
      return elmSpec(b);
    case 'clojure':
      return clojureSpec(b);
    case 'zig':
      return zigSpec(b);
    case 'bash':
      return bashSpec(b);
    case 'powershell':
      return powershellSpec(b);
    case 'solidity':
      return soliditySpec(b);
    case 'hcl':
      return hclSpec(b);
    case 'sql':
      return sqlSpec();
    default:
      return null;
  }
}
