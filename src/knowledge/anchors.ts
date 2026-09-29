import path from 'node:path';
import { keyTerms } from '../memory/dedupe.ts';
import { GENERIC_TERMS } from '../memory/evidence.ts';
import type { Language } from '../types.ts';
import { readText } from '../util/fsx.ts';
import { git } from '../util/git.ts';
import { matchGlob } from '../util/glob.ts';
import type { Anchors, KnowledgeItem } from './types.ts';

/**
 * Code evidence for rules, without an LLM. When a rule is recorded, devctx notes what in the
 * repository it depends on: dependency or tool names it names that the manifests, lockfiles or
 * config files contain, and path globs that match tracked files. Later, when those are gone (the
 * team moved from Jest to Vitest in a PR nobody discussed with the AI), the rule is marked as
 * possibly outdated instead of being delivered as settled. Everything is computed from tracked
 * files, so every clone at the same commit reaches the same result.
 */

export interface RepoContext {
  /** Tracked files (repository-relative, `/`-separated); null outside git. */
  files: string[] | null;
  /** Lower-case dependency, package manager and tool names. */
  vocab: Set<string>;
}

const BY_NAME: Record<string, string[]> = {
  'pnpm-lock.yaml': ['pnpm'],
  'pnpm-workspace.yaml': ['pnpm'],
  'yarn.lock': ['yarn'],
  'package-lock.json': ['npm'],
  'npm-shrinkwrap.json': ['npm'],
  'bun.lockb': ['bun'],
  'bun.lock': ['bun'],
  'deno.json': ['deno'],
  'deno.jsonc': ['deno'],
  'poetry.lock': ['poetry'],
  'uv.lock': ['uv'],
  Pipfile: ['pipenv'],
  'Pipfile.lock': ['pipenv'],
  'Cargo.toml': ['cargo'],
  'go.mod': ['go'],
  Gemfile: ['bundler'],
  'composer.json': ['composer'],
  'pom.xml': ['maven'],
  'build.gradle': ['gradle'],
  'build.gradle.kts': ['gradle'],
  'settings.gradle': ['gradle'],
  'settings.gradle.kts': ['gradle'],
  Dockerfile: ['docker'],
  'docker-compose.yml': ['docker', 'docker-compose'],
  'docker-compose.yaml': ['docker', 'docker-compose'],
  'compose.yml': ['docker', 'docker-compose'],
  'compose.yaml': ['docker', 'docker-compose'],
  'tsconfig.json': ['typescript'],
  'turbo.json': ['turbo', 'turborepo'],
  'nx.json': ['nx'],
  'lerna.json': ['lerna'],
  'biome.json': ['biome'],
  'biome.jsonc': ['biome'],
  Makefile: ['make'],
  Justfile: ['just'],
  justfile: ['just'],
  'pytest.ini': ['pytest'],
  'tox.ini': ['tox'],
  'ruff.toml': ['ruff'],
  '.ruff.toml': ['ruff'],
  'Chart.yaml': ['helm'],
  'Jenkinsfile': ['jenkins'],
  '.gitlab-ci.yml': ['gitlab-ci'],
  'renovate.json': ['renovate'],
  '.pre-commit-config.yaml': ['pre-commit'],
  'serverless.yml': ['serverless'],
  'flyway.conf': ['flyway'],
  'flyway.toml': ['flyway'],
};

const BY_PATTERN: [RegExp, string[]][] = [
  [/^jest\.config\./, ['jest']],
  [/^vitest\.(config|workspace)\./, ['vitest']],
  [/^(\.eslintrc|eslint\.config\.)/, ['eslint']],
  [/^(\.prettierrc|prettier\.config\.)/, ['prettier']],
  [/^vite\.config\./, ['vite']],
  [/^webpack\.config\./, ['webpack']],
  [/^rollup\.config\./, ['rollup']],
  [/^tailwind\.config\./, ['tailwind', 'tailwindcss']],
  [/^next\.config\./, ['next']],
  [/^nuxt\.config\./, ['nuxt']],
  [/^svelte\.config\./, ['svelte']],
  [/^astro\.config\./, ['astro']],
  [/^playwright\.config\./, ['playwright']],
  [/^cypress\.config\./, ['cypress']],
  [/^(babel\.config\.|\.babelrc)/, ['babel']],
  [/^(\.stylelintrc|stylelint\.config\.)/, ['stylelint']],
  [/^\.golangci\./, ['golangci-lint']],
  [/\.tf$/, ['terraform']],
  [/^V\d+(_\d+)*__.+\.sql$/, ['flyway']],
];

const BY_DIR: [RegExp, string[]][] = [
  [/^\.github\/workflows\//, ['github-actions']],
  [/^\.circleci\//, ['circleci']],
  [/^\.husky\//, ['husky']],
  [/^\.storybook\//, ['storybook']],
];

function addName(vocab: Set<string>, raw: string): void {
  const name = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!name || name.length > 120) return;
  vocab.add(name);
  const scoped = /^@([^/]+)\/(.+)$/.exec(name);
  if (scoped) {
    vocab.add(scoped[1] as string);
    vocab.add(scoped[2] as string);
  }
  const slash = name.split('/');
  if (slash.length > 1) vocab.add((slash[slash.length - 1] as string).replace(/^v\d+$/, slash[slash.length - 2] ?? ''));
}

function objectKeys(v: unknown): string[] {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
}

function tomlSectionKeys(text: string, section: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inside = section.test(header[1] as string);
      continue;
    }
    const key = inside ? /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line) : null;
    if (key) out.push(key[1] as string);
  }
  return out;
}

/** Names declared in one manifest file. */
function manifestNames(base: string, text: string): string[] {
  const out: string[] = [];
  try {
    if (base === 'package.json') {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) out.push(...objectKeys(pkg[k]));
      if (typeof pkg.packageManager === 'string') out.push(pkg.packageManager.split('@')[0] ?? '');
      return out;
    }
    if (base === 'composer.json') {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      for (const k of ['require', 'require-dev']) out.push(...objectKeys(pkg[k]));
      return out;
    }
  } catch {
    return out;
  }
  if (/^requirements.*\.txt$|^constraints.*\.txt$/.test(base)) {
    for (const line of text.split('\n')) {
      const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.replace(/#.*/, ''));
      if (name) out.push(name[1] as string);
    }
  } else if (base === 'pyproject.toml') {
    for (const m of text.matchAll(/^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;].*)?["']\s*,?\s*$/gm)) out.push(m[1] as string);
    out.push(...tomlSectionKeys(text, /^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/));
    for (const m of text.matchAll(/^\s*\[tool\.([A-Za-z0-9_-]+)/gm)) out.push(m[1] as string);
  } else if (base === 'go.mod') {
    for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v\d/gm)) out.push(m[1] as string);
  } else if (base === 'Cargo.toml') {
    out.push(...tomlSectionKeys(text, /^(workspace\.)?(dev-|build-)?dependencies$/));
  } else if (base === 'build.gradle' || base === 'build.gradle.kts' || base === 'libs.versions.toml') {
    for (const m of text.matchAll(/["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::[^"']*)?["']/g)) out.push(m[2] as string, m[1] as string);
    for (const m of text.matchAll(/\bid\s*\(?\s*["']([A-Za-z0-9_.-]+)["']/g)) {
      const id = m[1] as string;
      out.push(id, id.split('.').pop() ?? id);
    }
    for (const m of text.matchAll(/\bkotlin\s*\(\s*["']([A-Za-z0-9_.-]+)["']/g)) out.push('kotlin', `kotlin-${m[1] as string}`);
    for (const m of text.matchAll(/\bname\s*=\s*["']([A-Za-z0-9_.-]+)["']/g)) out.push(m[1] as string);
  } else if (base === 'pom.xml') {
    for (const m of text.matchAll(/<(artifactId|groupId)>\s*([A-Za-z0-9_.-]+)\s*<\//g)) out.push(m[2] as string);
  } else if (base === 'Gemfile') {
    for (const m of text.matchAll(/^\s*gem\s+["']([A-Za-z0-9_.-]+)["']/gm)) out.push(m[1] as string);
  }
  return out;
}

const MANIFESTS = /^(package\.json|composer\.json|pyproject\.toml|go\.mod|Cargo\.toml|build\.gradle(\.kts)?|libs\.versions\.toml|pom\.xml|Gemfile|requirements.*\.txt|constraints.*\.txt)$/;

/** Files in the git index: the same on every clone at the same commit (untracked files are not). */
export function trackedFiles(root: string): string[] | null {
  const r = git(['ls-files', '-z', '--cached'], root, 30_000);
  if (!r.ok) return null;
  return r.stdout.split('\0').filter(Boolean);
}

/** Dependency, package manager and tool names the repository uses, from tracked files only. */
export function repoVocabulary(root: string, files: readonly string[]): Set<string> {
  const vocab = new Set<string>();
  for (const rel of files) {
    const base = rel.split('/').pop() ?? rel;
    for (const n of BY_NAME[base] ?? []) vocab.add(n);
    for (const [re, names] of BY_PATTERN) if (re.test(base)) for (const n of names) vocab.add(n);
    for (const [re, names] of BY_DIR) if (re.test(rel)) for (const n of names) vocab.add(n);
    if (!MANIFESTS.test(base) || rel.includes('node_modules/') || rel.includes('/vendor/')) continue;
    const text = readText(path.join(root, rel));
    if (text === null || text.length > 2_000_000) continue;
    for (const name of manifestNames(base, text)) addName(vocab, name);
  }
  return vocab;
}

export function repoContext(root: string): RepoContext {
  const files = trackedFiles(root);
  return { files, vocab: files ? repoVocabulary(root, files) : new Set() };
}

const NAME = String.raw`([A-Za-z][\w.+#@/-]*)`;
const NEGATIVE: RegExp[] = [
  // "Jest 대신", "npm 말고", "moment 금지", "any 쓰지 마"
  new RegExp(`${NAME}\\s*(?:을|를|은|는|이|가|로|으로|와|과)?\\s*(?:대신|말고|빼고|금지|쓰지|사용하지|사용 금지|쓰면 안|제외)`, 'g'),
  // "npm에서 pnpm으로 바꾼다": the first one is being left
  new RegExp(`${NAME}\\s*에서\\s*[A-Za-z][\\w.+#@/-]*\\s*(?:으로|로)`, 'g'),
  // "instead of Jest", "never use npm", "no lodash", "switch from X to Y"
  new RegExp(`\\b(?:instead of|rather than|not|never|no|avoid|without|stop using|don't use|do not use|drop|remove|replace|from)\\s+(?:the\\s+|using\\s+|use\\s+)?${NAME}`, 'gi'),
];

/** Names the rule tells people to use (not the ones it tells them to stop using). */
export function positiveTerms(statement: string): string[] {
  const negative = new Set<string>();
  for (const re of NEGATIVE) {
    for (const m of statement.matchAll(re)) negative.add((m[1] as string).toLowerCase().replace(/[.,;:!?)'"]+$/, ''));
  }
  return [...keyTerms(statement)].filter((t) => !/^\d/.test(t) && t.length >= 2 && !GENERIC_TERMS.has(t) && !negative.has(t));
}

/** The name as the vocabulary knows it ("Next.js" → "next"). */
function inVocab(term: string, vocab: ReadonlySet<string>): string | null {
  if (vocab.has(term)) return term;
  const bare = term.replace(/\.js$/, '').replace(/js$/, '');
  if (bare !== term && vocab.has(bare)) return bare;
  return null;
}

function globMatches(glob: string, files: readonly string[]): boolean {
  for (const f of files) if (matchGlob(f, glob)) return true;
  return false;
}

/** What a new rule depends on, recorded in its file. Null when nothing is checkable. */
export function anchorsFor(item: Pick<KnowledgeItem, 'summary' | 'scope'>, ctx: RepoContext): Anchors | null {
  if (!ctx.files) return null;
  const terms = [...new Set(positiveTerms(item.summary).map((t) => inVocab(t, ctx.vocab)).filter((t): t is string => t !== null))].sort();
  const paths = item.scope.paths.filter((g) => globMatches(g, ctx.files as string[]));
  return terms.length > 0 || paths.length > 0 ? { terms, paths } : null;
}

const MARK: Record<Language, (what: string) => string> = {
  ko: (what) => `확인 필요: 저장소에서 ${what}을(를) 찾을 수 없음`,
  en: (what) => `check needed: ${what} no longer in the repository`,
};

/** Why a rule may be outdated: its anchors are gone. Null when they are all still there. */
export function staleReason(item: KnowledgeItem, ctx: RepoContext, lang: Language): string | null {
  if (!item.anchors || !ctx.files) return null;
  const missing = [
    ...item.anchors.terms.filter((t) => !ctx.vocab.has(t)).map((t) => `\`${t}\``),
    ...item.anchors.paths.filter((g) => !globMatches(g, ctx.files as string[])).map((g) => `\`${g}\``),
  ];
  return missing.length > 0 ? MARK[lang](missing.slice(0, 3).join(', ')) : null;
}
