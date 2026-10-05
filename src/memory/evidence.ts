import { normalizeForMatch, stripPasted } from '../util/text.ts';

/**
 * An extracted rule is only accepted when its evidence quote really occurs in what the developer
 * wrote (pasted code/logs/quotes excluded). This blocks invented rules and instructions smuggled in
 * through pasted content or tool output.
 */
export function isQuoteValid(message: string, quote: string): boolean {
  const q = normalizeForMatch(quote).replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');
  const whole = normalizeForMatch(stripPasted(message));
  // A short quote is only evidence when it is the whole message: a bare "응" accepting a proposal.
  if (q.length < 4) return q.length > 0 && q === whole.replace(/[\s.!~]+$/u, '');
  return whole.includes(q);
}

/** Generic words a Korean statement may add in Latin letters without naming anything new. */
export const GENERIC_TERMS = new Set(
  (
    'api apis ui ux ci cd pr prs id ids url urls uri http https json yaml yml xml csv sql db dto orm sdk cli ide ' +
    'test tests code file files log logs error errors bug fix class type types function method module package repo git ' +
    'commit branch main master merge dev prod build run script config env ok true false null none utf utc'
  ).split(' '),
);

/**
 * Names and numbers in a statement that none of its sources contain. Cheap models sometimes
 * "improve" a rule with a tool, version or name the developer never mentioned (Cognee documents
 * the same drift); such a rule is kept only as a proposal. Korean statements are checked for every
 * Latin word (they are names), English ones only for name-like tokens (camelCase, digits, `./_-+#`).
 */
export function unsupportedTerms(statement: string, sources: readonly (string | null)[]): string[] {
  const haystack = normalizeForMatch(sources.filter(Boolean).join('\n'));
  const korean = /[\uac00-\ud7a3]/.test(statement);
  const out = new Set<string>();
  for (const m of statement.normalize('NFKC').matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._+#-][A-Za-z0-9]+)*[+#]*|\d+(?:\.\d+)+|\d{2,}/g)) {
    const term = m[0];
    const lower = term.toLowerCase();
    const numeric = /^\d/.test(term);
    const nameLike = numeric || /[a-z][A-Z]|[A-Z].*[A-Z]|\d|[._+#-]/.test(term);
    if (!numeric && (lower.length < 2 || GENERIC_TERMS.has(lower))) continue;
    if (!korean && !nameLike) continue;
    if (!haystack.includes(lower)) out.add(term);
  }
  return [...out];
}

/**
 * What a masked value becomes: a placeholder naming its kind, so a reader still sees what the
 * prompt was about ("배포 토큰은 {token}이야", "DB 접속은 postgres://app:{password}@db") without
 * the value.
 */
export type SecretKind = 'password' | 'token' | 'api_key' | 'secret' | 'private_key';

const placeholder = (kind: SecretKind): string => `{${kind}}`;

// Values recognizable by their shape alone.
const SECRET_SHAPES: [RegExp, SecretKind][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private_key'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, 'api_key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, 'token'],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, 'api_key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'api_key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, 'token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'token'],
];

// `Authorization: Bearer <value>` and the password in a connection URL (scheme://user:pass@host).
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;

// `password: x`, `"api_key": "x"`, `TOKEN=x` in code, config and commands.
const ASSIGNED =
  /\b(password|passwd|passcode|pwd|secret|client[_-]?secret|token|access[_-]?token|auth[_-]?token|api[_-]?key|access[_-]?key)(["'`]?\s*[:=]\s*)(["'`]?)([^\s"'`]+)/gi;

function kindOf(label: string): SecretKind {
  const l = label.toLowerCase().replace(/[\s_-]/g, '');
  if (/^(password|passwd|passcode|pwd|pw|비밀번호|비번|패스워드|암호)$/.test(l)) return 'password';
  if (/^(apikey|api키|accesskey)$/.test(l)) return 'api_key';
  if (/^(secret|clientsecret|시크릿)$/.test(l)) return 'secret';
  return 'token';
}

/** A reference to where the value lives, not the value: `${API_KEY}`, `process.env.TOKEN`, `os.getenv("X")`. */
function isReference(value: string): boolean {
  return (
    /^[$<{%]/.test(value) ||
    /^[A-Z][A-Z0-9_]*$/.test(value) ||
    /[([]/.test(value) ||
    /^[\w-]+(\.[A-Za-z_][\w-]*)+[,;]?$/.test(value) ||
    /^(required|optional|none|null|undefined|true|false)[,;]?$/i.test(value)
  );
}

// A credential said in a sentence ("비번은 hunter2", "the password is Tr0ub4dor"): a label, a
// particle or "is", then a value. Hangul ends the value ("hunter2야" masks "hunter2").
const PROSE_SECRET =
  /(비밀\s?번호|비번|패스워드|암호|토큰|시크릿|api\s?키|\bpassword|\bpasswd|\bpasscode|\bpwd?\b|\btoken|\bsecret|\bapi[\s_-]?key)((?:\s*(?:은|는|이|가|을|를|:|=)\s*)|(?:\s+(?:is|was|=|:)?\s*))([^\s,;'"`\uac00-\ud7a3]{4,64})/giu;

// What follows a name used in a rule: a particle of place or means ("localStorage에", "Argon2id로")
// or a noun it modifies ("HttpOnly 쿠키", "X-Api-Key header"). A credential ends the clause or is
// followed by a copula ("hunter2야", "Abc!2345 입니다").
const USED_AS_NAME = /^(에서|에게|에|으로|로|를|을|와|과|만|도|처럼|보다|의|만큼)/;
const COPULA = /^\s+(입니다|이다|임|야|이야|이에요|예요|이고|이며|and|for|on|in)(\s|$|[.,!?])/i;

/**
 * Whether the value after a credential label is a credential rather than the name of a thing the
 * rule is about. Names (localStorage, HttpOnly, X-Api-Key, process.env.TOKEN, Argon2id로) stay, so
 * rule text keeps its meaning; a long random-looking value is masked whatever follows it.
 */
function looksLikeSecret(value: string, after: string): boolean {
  if (/^[$<{%.]/.test(value)) return false; // ${API_KEY}, <token>, {{secret}}, .env
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false; // an environment variable's name
  if (/^[\w-]+(\.[A-Za-z_][\w-]*)+$/.test(value) || value.includes('/')) return false; // process.env.X, a path
  // Mixed case or a hyphen alone is an identifier (camelCase, header names), not a credential.
  if (!/\d/.test(value) && !/[!@#$%^&*+=?~]/.test(value)) return false;
  if (value.length >= 12 && /[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  if (USED_AS_NAME.test(after)) return false;
  if (/^\s+[\uac00-\ud7a3A-Za-z]/.test(after) && !COPULA.test(after)) return false;
  return true;
}

/**
 * Replaces credentials with placeholders (`{password}`, `{token}`, `{api_key}`, `{secret}`,
 * `{private_key}`) before text is stored, leaves the machine or lands in git. Idempotent: masked
 * text passes through unchanged.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, kind] of SECRET_SHAPES) out = out.replace(pattern, placeholder(kind));
  out = out.replace(BEARER, (_all, lead: string) => `${lead}${placeholder('token')}`);
  out = out.replace(URL_PASSWORD, (_all, lead: string, _pass: string, at: string) => `${lead}${placeholder('password')}${at}`);
  out = out.replace(ASSIGNED, (all: string, label: string, sep: string, quote: string, value: string) => {
    if (isReference(value)) return all;
    const tail = value.match(/[,;)\]}]+$/)?.[0] ?? '';
    return `${label}${sep}${quote}${placeholder(kindOf(label))}${tail}`;
  });
  out = out.replace(PROSE_SECRET, (all: string, label: string, sep: string, value: string, offset: number, whole: string) =>
    looksLikeSecret(value, whole.slice(offset + all.length)) ? `${label}${sep}${placeholder(kindOf(label))}` : all,
  );
  return out;
}

/** Whether `text` contains a placeholder `redactSecrets` writes. */
export function hasMaskedSecret(text: string): boolean {
  return /\{(password|token|api_key|secret|private_key)\}/.test(text);
}

/** Removes zero-width and bidi control characters that can hide instructions in rule files. */
export function stripInvisible(text: string): string {
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '');
}
