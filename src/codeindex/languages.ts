import path from 'node:path';
import type { LangId } from './facts.ts';

/**
 * Languages the code index parses. Every one gets the same analysis: symbols, calls, instantiations
 * and inheritance, resolved through that language's own import / module / namespace rules and
 * receiver types (hand-written resolvers for the JVM, JS/TS, Go and Python; the per-language
 * rules in modules.ts for the rest). Every other text file is still covered by text search.
 */

/** Resolution never crosses families (a Kotlin call can reach Java or Scala, not Python). */
export type Family = string;

export interface LanguageSpec {
  id: LangId;
  label: string;
  extensions: string[];
  /** Exact file names (`Rakefile`, `Jenkinsfile`). */
  files?: string[];
  /** Vendored grammar (`vendor/grammars/<grammar>.wasm.br`); embedded languages parse their scripts. */
  grammar: string | null;
  family: Family;
}

const L = (id: string, label: string, extensions: string[], grammar: string | null, family: Family, files?: string[]): LanguageSpec => ({
  id,
  label,
  extensions,
  grammar,
  family,
  ...(files ? { files } : {}),
});

export const LANGUAGES: readonly LanguageSpec[] = [
  L('java', 'Java', ['.java'], 'java', 'jvm'),
  L('kotlin', 'Kotlin', ['.kt', '.kts'], 'kotlin', 'jvm'),
  L('go', 'Go', ['.go'], 'go', 'go'),
  L('python', 'Python', ['.py', '.pyi', '.pyw'], 'python', 'python'),
  L('typescript', 'TypeScript', ['.ts', '.mts', '.cts'], 'typescript', 'js'),
  L('tsx', 'React (TSX)', ['.tsx'], 'tsx', 'js'),
  L('javascript', 'JavaScript', ['.js', '.mjs', '.cjs'], 'javascript', 'js'),
  L('jsx', 'React (JSX)', ['.jsx'], 'javascript', 'js'),
  L('vue', 'Vue', ['.vue'], null, 'js'),
  L('svelte', 'Svelte', ['.svelte'], null, 'js'),
  L('astro', 'Astro', ['.astro'], null, 'js'),
  L('rust', 'Rust', ['.rs'], 'rust', 'rust'),
  L('c', 'C', ['.c', '.h'], 'c', 'c'),
  L('cpp', 'C++', ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.ipp', '.inl', '.cu', '.cuh'], 'cpp', 'c'),
  L('objc', 'Objective-C', ['.m', '.mm'], 'objc', 'c'),
  L('csharp', 'C#', ['.cs'], 'csharp', 'dotnet'),
  L('fsharp', 'F#', ['.fs', '.fsi', '.fsx'], 'fsharp', 'dotnet'),
  L('swift', 'Swift', ['.swift'], 'swift', 'swift'),
  L('dart', 'Dart', ['.dart'], 'dart', 'dart'),
  L('scala', 'Scala', ['.scala', '.sc'], 'scala', 'jvm'),
  L('groovy', 'Groovy', ['.groovy', '.gradle', '.gvy'], 'groovy', 'jvm', ['Jenkinsfile']),
  L('ruby', 'Ruby', ['.rb', '.rake', '.gemspec', '.ru'], 'ruby', 'ruby', ['Rakefile', 'Gemfile', 'Guardfile']),
  L('php', 'PHP', ['.php', '.phtml'], 'php', 'php'),
  L('lua', 'Lua', ['.lua'], 'lua', 'lua'),
  L('perl', 'Perl', ['.pl', '.pm'], 'perl', 'perl'),
  L('r', 'R', ['.r', '.R'], 'r', 'r'),
  L('julia', 'Julia', ['.jl'], 'julia', 'julia'),
  L('haskell', 'Haskell', ['.hs'], 'haskell', 'haskell'),
  L('ocaml', 'OCaml', ['.ml'], 'ocaml', 'ocaml'),
  L('elixir', 'Elixir', ['.ex', '.exs'], 'elixir', 'beam'),
  L('erlang', 'Erlang', ['.erl', '.hrl'], 'erlang', 'beam'),
  L('elm', 'Elm', ['.elm'], 'elm', 'elm'),
  L('clojure', 'Clojure', ['.clj', '.cljs', '.cljc'], 'clojure', 'clojure'),
  L('zig', 'Zig', ['.zig'], 'zig', 'zig'),
  L('bash', 'Shell', ['.sh', '.bash', '.zsh', '.ksh'], 'bash', 'shell'),
  L('powershell', 'PowerShell', ['.ps1', '.psm1'], 'powershell', 'powershell'),
  L('solidity', 'Solidity', ['.sol'], 'solidity', 'solidity'),
  L('hcl', 'Terraform / HCL', ['.tf', '.hcl'], 'hcl', 'hcl'),
  L('sql', 'SQL', ['.sql'], 'sql', 'sql'),
];

/**
 * Grammars that report syntax errors on valid, idiomatic code (tree-sitter-groovy is Java-based:
 * no semicolons and untyped parameters read as errors). Their files still yield symbols and calls;
 * the syntax-error count of these languages says nothing about a grammar mismatch.
 */
export const NOISY_GRAMMARS: ReadonlySet<string> = new Set(['groovy']);

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));
const BY_EXTENSION = new Map<string, LanguageSpec>();
const BY_FILE = new Map<string, LanguageSpec>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) BY_EXTENSION.set(ext, lang);
  for (const f of lang.files ?? []) BY_FILE.set(f, lang);
}

export function languageById(id: LangId): LanguageSpec | null {
  return BY_ID.get(id) ?? null;
}

export function languageOf(file: string): LanguageSpec | null {
  const base = path.basename(file);
  const byFile = BY_FILE.get(base);
  if (byFile) return byFile;
  const ext = path.extname(file);
  return BY_EXTENSION.get(ext) ?? BY_EXTENSION.get(ext.toLowerCase()) ?? null;
}

export function familyOf(lang: LangId): Family {
  return BY_ID.get(lang)?.family ?? lang;
}

export interface DetectedLanguage {
  id: string;
  label: string;
  files: number;
}

/** Source languages among the given repository files, most files first. */
export function detectLanguages(files: readonly string[]): DetectedLanguage[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const lang = languageOf(file);
    if (lang) counts.set(lang.id, (counts.get(lang.id) ?? 0) + 1);
  }
  return LANGUAGES.filter((l) => counts.has(l.id))
    .map((l) => ({ id: l.id, label: l.label, files: counts.get(l.id) ?? 0 }))
    .sort((a, b) => b.files - a.files);
}
