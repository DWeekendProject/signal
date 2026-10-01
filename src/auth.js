import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.js';

const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

export function verifyPassword(password, encoded) {
  const [salt, expectedHex] = String(encoded).split(':');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSession(ownerId) {
  const id = randomBytes(32).toString('hex');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare('INSERT INTO sessions (id, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(id, ownerId, expiresAt, createdAt);
  return { id, expiresAt };
}

export function readSession(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      const key = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      if (key) cookies[key] = value;
    } catch {
      // Ignore malformed cookies instead of allowing an unauthenticated request to fail the server.
    }
  }
  const sessionId = cookies.gtm_session;
  if (!sessionId) return null;
  const session = db.prepare(`
    SELECT sessions.id, sessions.expires_at, owners.id AS owner_id, owners.email
    FROM sessions JOIN owners ON owners.id = sessions.owner_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).get(sessionId, now());
  return session || null;
}

export function sessionCookie(session, secure = false) {
  return `gtm_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(session.expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure = false) {
  return `gtm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
