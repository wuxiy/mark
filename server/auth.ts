import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

function hashPassword(password: string, salt: Buffer): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export function initializePassword(db: DatabaseSync, file?: string): void {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get();
  if (existing || !file) return;
  const password = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (password.length < 12) throw new Error('初始密码至少需要 12 个字符');
  const salt = randomBytes(16);
  db.prepare("INSERT INTO settings(key, value) VALUES ('password_hash', ?)").run(`${salt.toString('hex')}:${hashPassword(password, salt)}`);
}

export function configured(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM settings WHERE key = 'password_hash'").get());
}

export function verifyPassword(db: DatabaseSync, password: string): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as { value: string } | undefined;
  if (!row) return false;
  const [saltHex, expectedHex] = row.value.split(':');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(hashPassword(password, Buffer.from(saltHex, 'hex')), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSession(db: DatabaseSync): { token: string; csrf: string } {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions(token_hash, csrf_token, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash, csrf, Date.now() + 30 * 24 * 60 * 60 * 1_000);
  return { token, csrf };
}

export function getSession(db: DatabaseSync, token?: string): { csrf: string; tokenHash: string } | null {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT csrf_token, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as { csrf_token: string; expires_at: number } | undefined;
  return row && row.expires_at > Date.now() ? { csrf: row.csrf_token, tokenHash } : null;
}

export function deleteSession(db: DatabaseSync, tokenHash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function cookieToken(header?: string): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith('mark_session='))?.slice('mark_session='.length);
}
