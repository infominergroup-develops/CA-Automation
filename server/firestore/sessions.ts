import { config } from '../config.ts';
import { randomToken, sha256 } from '../security/crypto.ts';
import { db } from './client.ts';
import { getById, now, query } from './store.ts';
import { C, type SessionDoc } from './types.ts';

/**
 * Sessions. The raw 256-bit token lives only in the user's httpOnly cookie; we store sha256(token) as the
 * document id, so a database leak cannot be used to impersonate anyone. Both an idle timeout and an
 * absolute lifetime are enforced on every request.
 */

/** Creates a session and returns the raw token to set as the cookie. */
export async function createSession(userId: string, ip: string | null, userAgent: string | null): Promise<string> {
  const token = randomToken();
  const doc: Omit<SessionDoc, 'id'> = {
    user_id: userId,
    created_at: now(),
    last_seen: now(),
    expires_at: new Date(Date.now() + config.sessionAbsoluteHours * 3600e3).toISOString(),
    ip,
    user_agent: (userAgent ?? '').slice(0, 300) || null,
  };
  await db.collection(C.sessions).doc(sha256(token)).set(doc);
  return token;
}

export interface LoadedSession { hash: string; userId: string }

/** Returns the valid session for a raw token, or null. Expired sessions are deleted. */
export async function loadValidSession(token: string): Promise<LoadedSession | null> {
  if (typeof token !== 'string' || token.length < 20) return null;
  const hash = sha256(token);
  const s = await getById<SessionDoc>(C.sessions, hash);
  if (!s) return null;
  const t = Date.now();
  if (Date.parse(s.expires_at) < t || Date.parse(s.last_seen) + config.sessionIdleMinutes * 60e3 < t) {
    await db.collection(C.sessions).doc(hash).delete();
    return null;
  }
  return { hash, userId: s.user_id };
}

export const touchSession = (hash: string) => db.collection(C.sessions).doc(hash).update({ last_seen: now() });
export const destroySession = (hash: string) => db.collection(C.sessions).doc(hash).delete();

/** Signs a user out everywhere (e.g. on disable or password change). */
export async function endAllSessions(userId: string, exceptHash?: string): Promise<void> {
  const sessions = await query<SessionDoc>(C.sessions, { where: [['user_id', '==', userId]] });
  await Promise.all(sessions.filter((s) => s.id !== exceptHash).map((s) => db.collection(C.sessions).doc(s.id).delete()));
}

export async function purgeExpiredSessions(): Promise<void> {
  const expired = await query<SessionDoc>(C.sessions, { where: [['expires_at', '<', now()]] });
  await Promise.all(expired.map((s) => db.collection(C.sessions).doc(s.id).delete()));
}
