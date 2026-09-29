import type { StateDb } from './db.ts';

export interface ExtractionHealth {
  /** Worker runs in a row where rules were to be extracted and no model answered. */
  streak: number;
  since: string | null;
  lastError: string | null;
}

const KEY = 'extract_health';

export function readExtractionHealth(db: StateDb): ExtractionHealth {
  try {
    return { streak: 0, since: null, lastError: null, ...(JSON.parse(db.kvGet(KEY) ?? '{}') as Partial<ExtractionHealth>) };
  } catch {
    return { streak: 0, since: null, lastError: null };
  }
}

/**
 * Extraction that keeps failing (a CLI changed, a login expired everywhere) would otherwise stop
 * the memory silently: rules fall back to unconfirmed proposals. The streak is reported by the
 * session hook and the git hooks until a run succeeds again.
 */
export function recordExtractionHealth(db: StateDb, ok: boolean, error: string | null): void {
  const h = readExtractionHealth(db);
  const next: ExtractionHealth = ok
    ? { streak: 0, since: null, lastError: null }
    : { streak: h.streak + 1, since: h.since ?? new Date().toISOString(), lastError: (error ?? '').slice(0, 200) };
  db.kvSet(KEY, JSON.stringify(next));
}
