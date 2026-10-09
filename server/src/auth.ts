import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: number;
  username: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.';
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

export class AuthService {
  constructor(private db: Db) {}

  hasUsers(): boolean {
    return this.db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
  }

  async createUser(username: string, password: string): Promise<User> {
    const hash = await hashPassword(password);
    const res = this.db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    return { id: Number(res.lastInsertRowid), username };
  }

  /** Create the user, or reset its password if it already exists. */
  async upsertUser(username: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.db
      .prepare(
        `INSERT INTO users (username, password_hash) VALUES (?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
      )
      .run(username, hash);
  }

  async checkLogin(username: string, password: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) as { id: number; username: string; password_hash: string } | undefined;
    if (!row) {
      // Spend comparable time so response timing doesn't reveal which usernames exist.
      await hashPassword(password);
      return null;
    }
    return (await verifyPassword(password, row.password_hash)) ? { id: row.id, username: row.username } : null;
  }

  createSession(userId: number): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_TTL_MS);
    return token;
  }

  getSessionUser(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, Date.now()) as { id: number; username: string } | undefined;
    return row ? { id: row.id, username: row.username } : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  pruneSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
}
