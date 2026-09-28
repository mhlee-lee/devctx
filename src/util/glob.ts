// Minimal glob matcher for scope patterns (`**`, `*`, `?`, `{a,b}`, `[abc]`).
// Patterns without a slash match the basename anywhere, like .gitignore.

const cache = new Map<string, RegExp>();

function escapeChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; ) {
    const ch = g[i] ?? '';
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atSegmentStart = i === 0 || g[i - 1] === '/';
        const followedBySlash = g[i + 2] === '/';
        if (atSegmentStart && followedBySlash) {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      re += '(?:';
      i += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      re += ')';
      i += 1;
      continue;
    }
    if (ch === ',' && depth > 0) {
      re += '|';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i + 1) {
        const body = g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        re += `[${body}]`;
        i = end + 1;
        continue;
      }
    }
    re += escapeChar(ch);
    i += 1;
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

export function matchGlob(file: string, glob: string): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const pattern = glob.trim();
  if (!pattern) return false;
  if (!pattern.includes('/')) {
    const base = normalized.split('/').pop() ?? normalized;
    return globToRegExp(pattern).test(base) || globToRegExp(pattern).test(normalized);
  }
  return globToRegExp(pattern).test(normalized);
}

export function matchAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(file, g));
}
