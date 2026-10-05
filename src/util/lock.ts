import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Advisory lock file: created exclusively, tagged with an owner token, released only by its
 * owner. A stale lock (dead holder, or older than `staleMs`) is moved aside with an atomic rename,
 * so when several processes find it stale at once only one of them takes it over.
 */

interface LockInfo {
  pid: number;
  at: number;
  token?: string;
}

function readInfo(file: string): { raw: string; info: LockInfo | null } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw) as { pid?: unknown; at?: unknown; token?: unknown };
    const at = typeof o.at === 'number' ? o.at : typeof o.at === 'string' ? Date.parse(o.at) : Number.NaN;
    if (typeof o.pid !== 'number' || !Number.isFinite(at)) return { raw, info: null };
    return { raw, info: { pid: o.pid, at, ...(typeof o.token === 'string' ? { token: o.token } : {}) } };
  } catch {
    return { raw, info: null };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A live holder within `staleMs` keeps the lock. */
export function lockHeld(file: string, staleMs: number): boolean {
  const read = readInfo(file);
  if (!read?.info) return false;
  return alive(read.info.pid) && Date.now() - read.info.at < staleMs;
}

export interface LockHandle {
  release(): void;
}

/**
 * Takes the lock, or returns null when a live holder has it. Errors other than "already exists"
 * (a read-only checkout) are thrown when `throwOnError`, otherwise reported as not acquired.
 */
export function tryLock(file: string, staleMs: number, opts: { throwOnError?: boolean } = {}): LockHandle | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      } finally {
        fs.closeSync(fd);
      }
      return {
        release: () => {
          if (readInfo(file)?.info?.token === token) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (opts.throwOnError) throw error;
        return null;
      }
    }
    const seen = readInfo(file);
    if (!seen) continue; // released meanwhile
    if (seen.info && alive(seen.info.pid) && Date.now() - seen.info.at < staleMs) return null;
    const aside = `${file}.stale-${token}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      continue; // another process moved it first
    }
    // Between reading and renaming, someone may have replaced the stale lock with a live one:
    // put that one back (link never overwrites) and let its holder keep it.
    let moved: string | null = null;
    try {
      moved = fs.readFileSync(aside, 'utf8');
    } catch {
      moved = null;
    }
    if (moved !== null && moved !== seen.raw) {
      try {
        fs.linkSync(aside, file);
      } catch {
        // a newer holder already exists
      }
      fs.rmSync(aside, { force: true });
      return null;
    }
    fs.rmSync(aside, { force: true });
  }
  return null;
}
