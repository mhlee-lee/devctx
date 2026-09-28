import os from 'node:os';
import { runProcess } from '../exec.ts';
import type { FailureKind, LlmRawResult } from '../types.ts';

const helpCache = new Map<string, string>();

/** Cached `--help` output, used to only pass flags the installed CLI version supports. */
export async function helpText(bin: string, args: readonly string[] = ['--help']): Promise<string> {
  const key = `${bin}\u0000${args.join(' ')}`;
  let text = helpCache.get(key);
  if (text === undefined) {
    const r = await runProcess(bin, args, { cwd: os.tmpdir(), timeoutMs: 20_000 });
    text = `${r.stdout}\n${r.stderr}`;
    helpCache.set(key, text);
  }
  return text;
}

export function supports(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=[\\s=,<\\[]|$)`, 'm').test(help);
}

/** Values a flag accepts according to `--help`: "(low, medium, high)" or "[possible values: a, b]". */
export function helpChoices(help: string, flag: string): string[] {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = help.match(new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s=,<\\[])[\\s\\S]{0,400}?(?=\\n\\s*-{1,2}[a-zA-Z]|(?![\\s\\S]))`));
  if (!block) return [];
  const list = block[0].match(/possible values:\s*([^\]]+)\]/i)?.[1] ?? block[0].match(/\(([a-z0-9_, -]+)\)/i)?.[1];
  if (!list) return [];
  return list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9_-]+$/.test(s));
}

export async function versionOf(bin: string, args: readonly string[] = ['--version']): Promise<string | null> {
  const r = await runProcess(bin, args, { cwd: os.tmpdir(), timeoutMs: 15_000 });
  const match = `${r.stdout} ${r.stderr}`.match(/\d+\.\d+(\.\d+)?/);
  return match ? match[0] : null;
}

const AUTH_ERROR =
  /(authenticat|oauth|\blog ?in\b|logged in|sign ?in|unauthori[sz]ed|forbidden|credential|api[ _-]?key|\b401\b|\b403\b|session expired|token (has )?expired)/i;
const QUOTA_ERROR =
  /(quota|rate.?limit|too many requests|\b429\b|usage limit|limit reached|exceeded your|insufficient (credit|balance)|out of credits)/i;

/**
 * Account problems (expired login, exhausted quota) say nothing about a model's quality, so the
 * router treats them differently from a bad answer.
 */
export function classifyFailure(text: string, fallback: FailureKind): FailureKind {
  if (AUTH_ERROR.test(text)) return 'auth';
  if (QUOTA_ERROR.test(text)) return 'quota';
  return fallback;
}

/** `fallback`: 'answer' when the CLI answered but not with usable JSON, 'infra' otherwise. */
export function failure(error: string, ms: number, text = '', fallback: FailureKind = 'infra'): LlmRawResult {
  return { ok: false, error: error.slice(0, 500), text, ms, kind: classifyFailure(`${error}\n${text}`, fallback) };
}

export function tail(text: string, max = 400): string {
  const clean = text.trim();
  return clean.length > max ? clean.slice(clean.length - max) : clean;
}
