import fs from 'node:fs';
import zlib from 'node:zlib';
import { Language, Parser } from 'web-tree-sitter';
import { grammarFile } from './files.ts';

/**
 * tree-sitter through WebAssembly. Every grammar ships inside devctx as brotli-compressed wasm
 * (`vendor/grammars/<id>.wasm.br`, provenance in `MANIFEST.json`), so indexing needs no native
 * build, no download and no install scripts.
 */

let init: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser>>();

async function load(id: string): Promise<Parser> {
  init ??= Parser.init();
  await init;
  const wasm = zlib.brotliDecompressSync(fs.readFileSync(grammarFile(id)));
  const language = await Language.load(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** One parser per grammar, created on first use and reused for every file. */
export function parserFor(id: string): Promise<Parser> {
  let p = parsers.get(id);
  if (!p) {
    p = load(id);
    parsers.set(id, p);
    p.catch(() => parsers.delete(id));
  }
  return p;
}
