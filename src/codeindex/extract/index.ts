import type { Node } from 'web-tree-sitter';
import type { FileFacts, LangId } from '../facts.ts';
import { languageById } from '../languages.ts';
import { parserFor } from '../parser.ts';
import { Builder } from './common.ts';
import { extractEmbedded } from './embedded.ts';
import { extractGo } from './go.ts';
import { extractJava } from './java.ts';
import { extractJs } from './js.ts';
import { extractKotlin } from './kotlin.ts';
import { extractPython } from './python.ts';
import { extractSpec } from './spec.ts';
import { specFor } from './specs.ts';

const DEEP: Record<string, (b: Builder, root: Node) => void> = {
  java: extractJava,
  kotlin: extractKotlin,
  go: extractGo,
  python: extractPython,
  javascript: extractJs,
  jsx: extractJs,
  typescript: extractJs,
  tsx: extractJs,
};

/** `.h` is shared by C, C++ and Objective-C: the content decides which grammar reads it. */
function headerDialect(src: string): 'c' | 'cpp' | 'objc' {
  // Comments and string/char literals ("see Foo::bar", "#import" in a doc block) say nothing.
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '));
  if (/^\s*(@interface|@protocol|@implementation|#import)\b/m.test(code)) return 'objc';
  if (/^\s*(class|namespace|template)\b|::|\bpublic:|\bprivate:/m.test(code)) return 'cpp';
  return 'c';
}

/** For tests: which grammar a `.h` file is read with. */
export const headerDialectOf = headerDialect;

/** Parses a source string with one grammar and runs the matching extractor into `b`. */
export async function parseInto(b: Builder, lang: LangId, src: string, file: string): Promise<void> {
  const spec = languageById(lang);
  if (!spec) throw new Error(`unknown language ${lang}`);
  const dialect = lang === 'c' && file.endsWith('.h') ? headerDialect(src) : lang;
  const grammar = dialect === lang ? spec.grammar : (languageById(dialect)?.grammar ?? spec.grammar);
  if (!grammar) throw new Error(`no grammar for ${lang}`);
  const parser = await parserFor(grammar);
  const tree = parser.parse(src);
  if (!tree) throw new Error('parser returned no tree');
  if (tree.rootNode.hasError) b.syntaxErrors = true;
  try {
    const deep = DEEP[dialect];
    if (deep) deep(b, tree.rootNode);
    else {
      const table = specFor(dialect, b);
      if (!table) throw new Error(`no extractor for ${dialect}`);
      extractSpec(b, tree.rootNode, table, file);
    }
  } finally {
    tree.delete();
  }
}

/** Parses one file and returns its facts (symbols, references, imports, typed variables). */
export async function extractFacts(lang: LangId, src: string, file = ''): Promise<FileFacts> {
  return (await extractFactsChecked(lang, src, file)).facts;
}

/** The facts, and whether the parser met syntax errors on the way (counted by `code status`). */
export async function extractFactsChecked(lang: LangId, src: string, file = ''): Promise<{ facts: FileFacts; syntaxErrors: boolean }> {
  if (lang === 'vue' || lang === 'svelte' || lang === 'astro') return extractEmbedded(lang, src, file);
  const b = new Builder(lang, src);
  await parseInto(b, lang, src, file);
  return { facts: b.f, syntaxErrors: b.syntaxErrors };
}
