import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;

/** Append-only JSON-lines log. Never throws: logging must not break hooks. */
export function logLine(file: string, level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // file does not exist yet
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // ignore
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
