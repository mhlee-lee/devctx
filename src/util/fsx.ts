import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  const text = readText(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Writes through a temp file + rename so readers never see a partial file. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Guards writes and deletes that devctx performs on its own: the target must stay inside
 * `allowedRoot` after resolving symlinks, and must not itself be a symlink.
 */
export function assertSafeTarget(target: string, allowedRoot: string): void {
  const resolvedRoot = fs.existsSync(allowedRoot) ? fs.realpathSync(allowedRoot) : path.resolve(allowedRoot);
  let dir = path.dirname(path.resolve(target));
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realDir = fs.realpathSync(dir);
  const rest = path.relative(dir, path.dirname(path.resolve(target)));
  const realParent = path.join(realDir, rest);
  if (!isInside(realParent, resolvedRoot)) {
    throw new Error(`refusing to write outside ${allowedRoot}: ${target}`);
  }
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`refusing to write through symlink: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, predicate));
    else if (entry.isFile() && predicate(entry.name)) out.push(full);
  }
  return out.sort();
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
