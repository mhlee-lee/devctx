import type { DevctxConfig } from './config.ts';
import { ensureGitAttributes } from './init/attributes.ts';
import { installAgentAccess, removeLegacyMcp } from './init/access.ts';
import { hookInstalled, installToolHooks } from './init/hookconfigs.ts';
import type { StateDb } from './state/db.ts';
import type { Language } from './types.ts';
import { readExtractionHealth } from './state/health.ts';
import { today } from './util/text.ts';

/**
 * Keeping devctx itself working without anyone looking after it. Runs at most once a day per
 * clone, from whichever runs first: an AI tool's session hook or a git hook. The git hooks matter
 * here: when a tool update drops devctx's entries from its hook file, the session hook no longer
 * fires, but commits still happen.
 */
export function dailyUpkeep(root: string, cfg: DevctxConfig, db: StateDb): string[] {
  if (db.kvGet('access_checked') === today()) return [];
  const changed: string[] = [];
  // Hook entries a tool update or a settings rewrite removed.
  for (const tool of cfg.targets) {
    if (hookInstalled(root, tool)) continue;
    const res = installToolHooks(root, tool);
    if (res.action === 'created' || res.action === 'updated') changed.push(`${res.action} ${res.file}`);
  }
  if (ensureGitAttributes(root)) changed.push('updated .gitattributes');
  // The skill and its pre-approvals follow the devctx version and config (a teammate's machine
  // gets the per-machine entries without running init); the old MCP server entry is removed.
  for (const a of [
    ...removeLegacyMcp(root),
    ...installAgentAccess(root, cfg.targets, { enabled: cfg.code_index.enabled, preapprove: cfg.code_index.preapprove, language: cfg.language }),
  ]) {
    if (a.action !== 'unchanged' && a.action !== 'skipped') changed.push(`${a.action} ${a.file}`);
  }
  db.kvSet('access_checked', today());
  return changed;
}

const DAY_MS = 86_400_000;
/** No AI hook event for this long while commits continue: capture has probably stopped. */
const CAPTURE_SILENCE_DAYS = 14;
const CAPTURE_MIN_COMMITS = 5;
/** Worker runs in a row without any model answering before people are told. */
const EXTRACTION_STREAK = 3;

const TEXT: Record<Language, { capture: (days: number, last: string) => string; extract: (n: number, err: string) => string }> = {
  ko: {
    capture: (days, last) =>
      `devctx: AI 도구 hook 기록이 ${days}일째 없다 (마지막 ${last}). AI 도구를 쓰는 중이면 hook이 꺼졌을 수 있다. 확인: .devctx/bin/devctx doctor`,
    extract: (n, err) =>
      `devctx: 규칙 추출이 ${n}번 연속 실패해 새 결정이 확정되지 않고 있다${err ? ` (${err})` : ''}. 확인: .devctx/bin/devctx doctor`,
  },
  en: {
    capture: (days, last) =>
      `devctx: no AI tool hook events for ${days} days (last ${last}). If you are using an AI tool, its hooks may be off. Check: .devctx/bin/devctx doctor`,
    extract: (n, err) =>
      `devctx: rule extraction failed ${n} runs in a row, so new decisions are not being confirmed${err ? ` (${err})` : ''}. Check: .devctx/bin/devctx doctor`,
  },
};

/** Counts commits since the last AI hook event (pre-commit calls this). */
export function noteCommit(db: StateDb): void {
  const last = db.lastHookEventTs() ?? '';
  let state = { since: last, n: 0 };
  try {
    state = { ...state, ...(JSON.parse(db.kvGet('commits_after_event') ?? '{}') as Partial<typeof state>) };
  } catch {
    // start over
  }
  if (state.since !== last) state = { since: last, n: 0 };
  state.n += 1;
  db.kvSet('commits_after_event', JSON.stringify(state));
}

/**
 * Problems people should hear about, at most once per `everyDays` per kind. Printed by the git
 * hooks (visible when a person or an agent commits) and added to the session context (the agent
 * tells the user). Never written into AGENTS.md: that file must be the same on every clone.
 */
export function healthNotices(db: StateDb, lang: Language, opts: { capture: boolean; everyDays: number }): string[] {
  const out: string[] = [];
  const now = Date.now();
  const due = (key: string): boolean => {
    const last = db.kvGet(`notice:${key}`);
    return !last || now - Date.parse(last) >= opts.everyDays * DAY_MS;
  };
  const shown = (key: string): void => db.kvSet(`notice:${key}`, new Date(now).toISOString());
  const t = TEXT[lang];

  const health = readExtractionHealth(db);
  if (health.streak >= EXTRACTION_STREAK && due('extract')) {
    out.push(t.extract(health.streak, (health.lastError ?? '').slice(0, 80)));
    shown('extract');
  }
  if (opts.capture) {
    const last = db.lastHookEventTs();
    let commits = 0;
    try {
      const state = JSON.parse(db.kvGet('commits_after_event') ?? '{}') as { since?: string; n?: number };
      commits = state.since === (last ?? '') ? (state.n ?? 0) : 0;
    } catch {
      commits = 0;
    }
    if (last) {
      const days = Math.floor((now - Date.parse(last)) / DAY_MS);
      if (days >= CAPTURE_SILENCE_DAYS && commits >= CAPTURE_MIN_COMMITS && due('capture')) {
        out.push(t.capture(days, last.slice(0, 10)));
        shown('capture');
      }
    }
  }
  return out;
}
