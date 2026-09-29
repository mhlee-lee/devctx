import type { Language } from '../types.ts';
import { approxTokens } from '../util/text.ts';
import { codeDbPath } from './files.ts';
import { CodeStore } from './store.ts';

/**
 * Prompt-time code hints: identifiers the user wrote (`OrderService`, `place_order`,
 * `Cart.total`) resolved to where they are declared, from the name table only (no graph load,
 * a few milliseconds), so the agent opens the right file instead of searching for it.
 */

const HEADER: Record<Language, string> = {
  ko: '[devctx] 요청에 나온 코드 위치 (코드 인덱스):',
  en: '[devctx] Code this request mentions (code index):',
};

const STOP = new Set(['README', 'TODO', 'JSON', 'HTTP', 'HTTPS', 'API', 'URL', 'SQL', 'HTML', 'CSS', 'UUID', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OK', 'AI', 'MCP', 'CLI', 'IDE']);

/** Words that look like code names: CamelCase, snake_case, `a.b`, `fn()`; plain words are ignored. */
export function codeNames(prompt: string): string[] {
  const out = new Set<string>();
  const text = prompt.replace(/https?:\/\/\S+/g, ' ');
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const inner = (m[1] ?? '').replace(/\(.*\)$/, '').trim();
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(inner)) out.add(inner);
  }
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(\))?/g)) {
    const word = m[1] ?? '';
    const called = Boolean(m[2]);
    if (word.length < 3 || STOP.has(word)) continue;
    const camel = /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]/.test(word);
    const snake = /[a-z0-9]_[a-z0-9]/i.test(word);
    const dotted = /\./.test(word) && !/\.(md|txt|json|ya?ml|com|io|org|kr)$/i.test(word) && !/^\d/.test(word);
    if (camel || snake || dotted || called) out.add(word);
  }
  return [...out].slice(0, 12);
}

export interface CodeLookup {
  /** Hint block for the prompt (null when nothing resolved or no budget). */
  text: string | null;
  /**
   * Files declaring the symbols the prompt names. Path-scoped decisions for those files are
   * relevant even when the prompt never names a path ("OrderService 고쳐줘" → src/billing/**).
   */
  paths: string[];
}

export function codeLookup(root: string, prompt: string, lang: Language, budgetTokens: number): CodeLookup {
  const none: CodeLookup = { text: null, paths: [] };
  const names = codeNames(prompt);
  if (names.length === 0) return none;
  const store = CodeStore.openExisting(codeDbPath(root));
  if (!store) return none;
  try {
    const lines: string[] = [];
    const seen = new Set<string>();
    const files = new Set<string>();
    let used = approxTokens(HEADER[lang]);
    for (const name of names) {
      const last = name.split('.').pop() ?? name;
      let rows = store.symbolsNamed(last, 6);
      if (name.includes('.')) rows = rows.filter((r) => r.qname.toLowerCase().endsWith(name.toLowerCase()));
      // A name declared in many places is not a pointer anyone needs.
      if (rows.length === 0 || rows.length > 4) continue;
      for (const r of rows) {
        files.add(r.path);
        const key = `${r.path}:${r.line}`;
        if (seen.has(key)) continue;
        const line = `- ${r.kind} ${r.qname}  ${r.path}:${r.line}`;
        const cost = approxTokens(line);
        if (used + cost > budgetTokens) continue;
        seen.add(key);
        lines.push(line);
        used += cost;
      }
    }
    return { text: lines.length > 0 ? [HEADER[lang], ...lines].join('\n') : null, paths: [...files] };
  } catch {
    return none;
  } finally {
    store.close();
  }
}

export function codeHints(root: string, prompt: string, lang: Language, budgetTokens: number): string | null {
  if (budgetTokens <= 0) return null;
  return codeLookup(root, prompt, lang, budgetTokens).text;
}
