import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface UserSummary extends User {
  createdAt: string;
}

type UserRow = { id: number; username: string; is_admin: number };
const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, isAdmin: r.is_admin === 1 });

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

  async createUser(username: string, password: string, isAdmin = false): Promise<User> {
    const hash = await hashPassword(password);
    const res = this.db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hash, isAdmin ? 1 : 0);
    return { id: Number(res.lastInsertRowid), username, isAdmin };
  }

  /** Create the admin from the environment, or reset its password (and admin rights) if it already exists. */
  async upsertAdmin(username: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.db
      .prepare(
        `INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, is_admin = 1`,
      )
      .run(username, hash);
  }

  listUsers(): UserSummary[] {
    const rows = this.db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username COLLATE NOCASE').all() as (UserRow & { created_at: string })[];
    return rows.map((r) => ({ ...toUser(r), createdAt: r.created_at }));
  }

  getUser(id: number): User | null {
    const row = this.db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  usernameTaken(username: string): boolean {
    return this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username) !== undefined;
  }

  adminCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
  }

  /** New password signs the user out everywhere. */
  async setPassword(id: number, password: string): Promise<void> {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  setAdmin(id: number, isAdmin: boolean): void {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }

  deleteUser(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  async checkLogin(username: string, password: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT id, username, is_admin, password_hash FROM users WHERE username = ?')
      .get(username) as (UserRow & { password_hash: string }) | undefined;
    if (!row) {
      // Spend comparable time so response timing doesn't reveal which usernames exist.
      await hashPassword(password);
      return null;
    }
    return (await verifyPassword(password, row.password_hash)) ? toUser(row) : null;
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
        `SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, Date.now()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  pruneSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
}
