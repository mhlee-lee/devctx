import crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: sortable by creation time, collision-safe across branches (no shared counter). */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i++) random += ALPHABET[(bytes[i] ?? 0) % 32];
  return time + random;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
