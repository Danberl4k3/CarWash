import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'cw_admin_session';
const SESSION_HOURS = 8;

export interface AdminSession {
  adminId: number;
  username: string;
  csrfToken: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  db: Database.Database,
  reply: FastifyReply,
  adminId: number,
): AdminSession {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), adminId, csrfToken, expires.toISOString());
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    signed: true,
    expires,
  });
  const admin = db.prepare('SELECT username FROM admins WHERE id = ?').get(adminId) as { username: string };
  return { adminId, username: admin.username, csrfToken };
}

export function getSession(db: Database.Database, request: FastifyRequest): AdminSession | null {
  const signedValue = request.cookies[COOKIE_NAME];
  if (!signedValue) return null;
  const unsigned = request.unsignCookie(signedValue);
  if (!unsigned.valid || !unsigned.value) return null;
  const row = db.prepare(`
    SELECT s.admin_id, s.csrf_token, a.username
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(hashToken(unsigned.value), new Date().toISOString()) as
    | { admin_id: number; csrf_token: string; username: string }
    | undefined;
  return row ? { adminId: row.admin_id, username: row.username, csrfToken: row.csrf_token } : null;
}

export function destroySession(db: Database.Database, request: FastifyRequest, reply: FastifyReply): void {
  const signedValue = request.cookies[COOKIE_NAME];
  if (signedValue) {
    const unsigned = request.unsignCookie(signedValue);
    if (unsigned.valid && unsigned.value) {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(unsigned.value));
    }
  }
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export function verifyCredentials(
  db: Database.Database,
  username: string,
  password: string,
): { id: number; username: string } | null {
  const admin = db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) return null;
  return { id: admin.id, username: admin.username };
}

export function assertCsrf(session: AdminSession, submitted: unknown): boolean {
  if (typeof submitted !== 'string') return false;
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(submitted);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
