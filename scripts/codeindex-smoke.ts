/**
 * Smoke test of the vendored grammars and extractors: one small file per language must parse
 * without syntax errors, yield the expected declaration and see the expected call. A grammar
 * update that no longer fits an extractor (renamed node types) shows up here as missing symbols
 * or calls instead of as a silently thinner index.
 *
 *   npm run bench:codeindex           # exit 1 on any failed case
 *   npm run bench:codeindex -- -v     # print every case
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFactsChecked, headerDialectOf } from '../src/codeindex/extract/index.ts';
import type { LangId } from '../src/codeindex/facts.ts';
import { LANGUAGES, NOISY_GRAMMARS } from '../src/codeindex/languages.ts';
import { loadGraph } from '../src/codeindex/load.ts';
import { traceCalls } from '../src/codeindex/queries.ts';
import { refreshIndex } from '../src/codeindex/service.ts';
import { normalizeConfig } from '../src/config.ts';
import { git } from '../src/util/git.ts';

const verbose = process.argv.includes('-v');

interface Sample {
  file: string;
  src: string;
  /** Declared name to find (default computeTotal). */
  sym?: string;
  /** Referenced name to find (default helperFn); null when the language has no calls to check. */
  ref?: string | null;
}

// Groovy's grammar flags valid code (see NOISY_GRAMMARS); its symbols and calls are still checked.

const SAMPLES: Record<string, Sample> = {
  java: { file: 'Cart.java', src: 'package shop;\npublic class Cart {\n  int helperFn(int a) { return a; }\n  int computeTotal(int a) { return helperFn(a); }\n}\n' },
  kotlin: { file: 'Cart.kt', src: 'package shop\nclass Cart {\n  fun helperFn(a: Int): Int = a\n  fun computeTotal(a: Int): Int = helperFn(a)\n}\n' },
  go: { file: 'cart.go', src: 'package shop\n\nfunc helperFn(a int) int { return a }\n\nfunc computeTotal(a int) int { return helperFn(a) }\n' },
  python: { file: 'cart.py', src: 'def helperFn(a):\n    return a\n\n\ndef computeTotal(a):\n    return helperFn(a)\n' },
  typescript: { file: 'cart.ts', src: 'export function helperFn(a: number): number { return a; }\nexport function computeTotal(a: number): number { return helperFn(a); }\n' },
  tsx: { file: 'cart.tsx', src: 'export function helperFn(a: number) { return a; }\nexport function computeTotal(a: number) { return <div>{helperFn(a)}</div>; }\n' },
  javascript: { file: 'cart.js', src: 'export function helperFn(a) { return a; }\nexport function computeTotal(a) { return helperFn(a); }\n' },
  jsx: { file: 'cart.jsx', src: 'export function helperFn(a) { return a; }\nexport function computeTotal(a) { return <div>{helperFn(a)}</div>; }\n' },
  vue: { file: 'Cart.vue', src: '<script setup lang="ts">\nfunction helperFn(a: number) { return a }\nfunction computeTotal(a: number) { return helperFn(a) }\n</script>\n<template><div /></template>\n' },
  svelte: { file: 'Cart.svelte', src: '<script>\n  function helperFn(a) { return a }\n  function computeTotal(a) { return helperFn(a) }\n</script>\n<div></div>\n' },
  astro: { file: 'Cart.astro', src: '---\nfunction helperFn(a: number) { return a }\nfunction computeTotal(a: number) { return helperFn(a) }\n---\n<div></div>\n' },
  rust: { file: 'cart.rs', src: 'fn helperFn(a: i32) -> i32 { a }\n\npub fn computeTotal(a: i32) -> i32 { helperFn(a) }\n' },
  c: { file: 'cart.c', src: 'int helperFn(int a) { return a; }\nint computeTotal(int a) { return helperFn(a); }\n' },
  cpp: { file: 'cart.cpp', src: 'namespace shop {\nint helperFn(int a) { return a; }\nint computeTotal(int a) { return helperFn(a); }\n}\n' },
  objc: { file: 'cart.m', src: 'int helperFn(int a) { return a; }\nint computeTotal(int a) { return helperFn(a); }\n' },
  csharp: { file: 'Cart.cs', src: 'namespace Shop {\n  public class Cart {\n    int helperFn(int a) { return a; }\n    int computeTotal(int a) { return helperFn(a); }\n  }\n}\n' },
  fsharp: { file: 'Cart.fs', src: 'module Shop\nlet helperFn a = a\nlet computeTotal a = helperFn a\n' },
  swift: { file: 'Cart.swift', src: 'func helperFn(_ a: Int) -> Int { return a }\nfunc computeTotal(_ a: Int) -> Int { return helperFn(a) }\n' },
  dart: { file: 'cart.dart', src: 'int helperFn(int a) => a;\nint computeTotal(int a) { return helperFn(a); }\n' },
  scala: { file: 'Cart.scala', src: 'object Cart {\n  def helperFn(a: Int): Int = a\n  def computeTotal(a: Int): Int = helperFn(a)\n}\n' },
  groovy: { file: 'Cart.groovy', src: 'class Cart {\n  int helperFn(int a) { return a }\n  int computeTotal(int a) { return helperFn(a) }\n}\n' },
  ruby: { file: 'cart.rb', src: 'def helperFn(a)\n  a\nend\n\ndef computeTotal(a)\n  helperFn(a)\nend\n' },
  php: { file: 'cart.php', src: '<?php\nfunction helperFn($a) { return $a; }\nfunction computeTotal($a) { return helperFn($a); }\n' },
  lua: { file: 'cart.lua', src: 'local function helperFn(a) return a end\nfunction computeTotal(a) return helperFn(a) end\n' },
  perl: { file: 'cart.pl', src: 'sub helperFn { my ($a) = @_; return $a; }\nsub computeTotal { my ($a) = @_; return helperFn($a); }\n' },
  r: { file: 'cart.R', src: 'helperFn <- function(a) { a }\ncomputeTotal <- function(a) { helperFn(a) }\n' },
  julia: { file: 'cart.jl', src: 'function helperFn(a)\n    a\nend\n\nfunction computeTotal(a)\n    helperFn(a)\nend\n' },
  haskell: { file: 'Cart.hs', src: 'module Shop where\n\nhelperFn :: Int -> Int\nhelperFn a = a\n\ncomputeTotal :: Int -> Int\ncomputeTotal a = helperFn a\n' },
  ocaml: { file: 'cart.ml', src: 'let helperFn a = a\nlet computeTotal a = helperFn a\n' },
  elixir: { file: 'cart.ex', src: 'defmodule Shop do\n  def helperFn(a), do: a\n  def computeTotal(a), do: helperFn(a)\nend\n' },
  erlang: { file: 'shop.erl', src: '-module(shop).\n-export([computeTotal/1]).\n\nhelperFn(A) -> A.\n\ncomputeTotal(A) -> helperFn(A).\n' },
  elm: { file: 'Shop.elm', src: 'module Shop exposing (computeTotal)\n\n\nhelperFn : Int -> Int\nhelperFn a =\n    a\n\n\ncomputeTotal : Int -> Int\ncomputeTotal a =\n    helperFn a\n' },
  clojure: { file: 'core.clj', src: '(ns shop.core)\n\n(defn helperFn [a] a)\n\n(defn computeTotal [a] (helperFn a))\n' },
  zig: { file: 'cart.zig', src: 'fn helperFn(a: i32) i32 {\n    return a;\n}\n\npub fn computeTotal(a: i32) i32 {\n    return helperFn(a);\n}\n' },
  bash: { file: 'cart.sh', src: 'helperFn() {\n  echo "$1"\n}\n\ncomputeTotal() {\n  helperFn "$1"\n}\n' },
  powershell: { file: 'cart.ps1', src: 'function helperFn($a) { return $a }\nfunction computeTotal($a) { return helperFn $a }\n' },
  solidity: {
    file: 'Cart.sol',
    src: 'pragma solidity ^0.8.0;\ncontract Cart {\n  function helperFn(uint a) internal pure returns (uint) { return a; }\n  function computeTotal(uint a) public pure returns (uint) { return helperFn(a); }\n}\n',
  },
  hcl: { file: 'main.tf', src: 'variable "region" {\n  default = "ap-northeast-2"\n}\n\nmodule "network" {\n  source = "./network"\n  region = var.region\n}\n', sym: 'module.network', ref: 'var.region' },
  sql: { file: 'shop.sql', src: 'CREATE TABLE orders (id integer, total integer);\nCREATE VIEW computeTotal AS SELECT sum(total) FROM orders;\n', ref: 'orders' },
};

interface Result {
  area: string;
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
const check = (area: string, name: string, ok: boolean, detail = ''): void => {
  results.push({ area, name, ok, detail });
};

// ---------------------------------------------------------------------------------------------
// 1. Every language: clean parse, the declaration and the call
// ---------------------------------------------------------------------------------------------
for (const spec of LANGUAGES) {
  const sample = SAMPLES[spec.id];
  if (!sample) {
    check('languages', `${spec.id}: has a sample`, false, 'add one to SAMPLES');
    continue;
  }
  const sym = sample.sym ?? 'computeTotal';
  const ref = sample.ref === undefined ? 'helperFn' : sample.ref;
  try {
    const { facts, syntaxErrors } = await extractFactsChecked(spec.id as LangId, sample.src, `src/${sample.file}`);
    const names = facts.syms.map((s) => s.name);
    const refs = facts.refs.map((r) => r.name);
    const ok = (!syntaxErrors || NOISY_GRAMMARS.has(spec.id)) && names.includes(sym) && (ref === null || refs.includes(ref));
    check('languages', `${spec.label} (${spec.id})`, ok, `syntaxErrors=${syntaxErrors} syms=[${names.join(',')}] refs=[${[...new Set(refs)].join(',')}]`);
  } catch (error) {
    check('languages', `${spec.label} (${spec.id})`, false, (error as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Details that went wrong before
// ---------------------------------------------------------------------------------------------
{
  const vue = '<script setup lang="ts">\nimport UserCard from \'./UserCard.vue\'\n</script>\n<template>\n  <UserCard />\n  <div>\n    <UserCard />\n  </div>\n</template>\n';
  const { facts } = await extractFactsChecked('vue', vue, 'src/List.vue');
  const lines = facts.refs.filter((r) => r.kind === 'render').map((r) => r.line).join(',');
  check('details', 'a component used twice is referenced at both lines', lines === '5,7', lines);
  check('details', '"::" or "#import" in comments does not change a C header', headerDialectOf('/* Foo::bar */\n// std::x\n/*\n#import y\n*/\nint f(void);\n') === 'c');
  check('details', 'C++ and Objective-C headers are still recognized', headerDialectOf('namespace a {}\n') === 'cpp' && headerDialectOf('@interface A\n@end\n') === 'objc');
  const broken = await extractFactsChecked('typescript', 'export function f( {\n', 'src/broken.ts');
  check('details', 'a syntax error is reported', broken.syntaxErrors);
}

// ---------------------------------------------------------------------------------------------
// 3. Resolution across files in a real repository
// ---------------------------------------------------------------------------------------------
async function repo(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-smoke-'));
  try {
    git(['init', '-q'], root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    git(['add', '.'], root);
    await refreshIndex(root, normalizeConfig({}));
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await repo(
  {
    'shop/__init__.py': '',
    'other/__init__.py': '',
    'shop/pricing.py': 'def total(items):\n    return sum(items)\n',
    'other/pricing.py': 'def total(items):\n    return 0\n',
    'shop/cart.py': 'from .pricing import total\n\ndef checkout(items):\n    return total(items)\n',
  },
  async (root) => {
    const g = loadGraph(root);
    const out = g ? traceCalls(g, 'checkout', { direction: 'callees' }) : 'no graph';
    check('resolution', 'Python relative import picks the sibling module', out.includes('shop/pricing.py') && !out.includes('other/pricing.py'), out.replace(/\n/g, ' | '));
  },
);

await repo(
  {
    'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@money/*": ["libs/money/*"] } } }\n',
    'apps/web/tsconfig.json': '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "strict": true } }\n',
    'libs/money/format.ts': 'export function formatWon(n: number) { return n + "원"; }\n',
    'apps/web/src/format.ts': 'export function formatWon(n: number) { return "x"; }\n',
    'apps/web/src/price.ts': "import { formatWon } from '@money/format';\nexport function price() { return formatWon(3); }\n",
  },
  async (root) => {
    const g = loadGraph(root);
    const out = g ? traceCalls(g, 'price', { direction: 'callees' }) : 'no graph';
    check('resolution', 'inherited tsconfig paths resolve from the config that set them', out.includes('libs/money/format.ts') && !out.includes('apps/web/src/format.ts'), out.replace(/\n/g, ' | '));
  },
);

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) if (verbose || !r.ok) console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${r.area}] ${r.name}${!r.ok || verbose ? `  :: ${r.detail}` : ''}`);
console.log('---');
for (const area of [...new Set(results.map((r) => r.area))]) {
  const list = results.filter((r) => r.area === area);
  console.log(`${area.padEnd(12)} ${list.filter((r) => r.ok).length}/${list.length}`);
}
console.log(`total        ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length > 0 ? 1 : 0;
