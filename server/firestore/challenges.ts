import crypto from 'node:crypto';
import { config } from '../config.ts';
import { hmac, safeEqualHex } from '../security/crypto.ts';
import { db } from './client.ts';
import { getById, newId, now, query } from './store.ts';
import { C, type ChallengeDoc } from './types.ts';

/**
 * One-time sign-in codes. The code is never stored — only its HMAC — so a database leak reveals no codes.
 * Unknown identifiers still get a challenge (with no user), so the response is identical and accounts can't
 * be enumerated. Codes expire, and a limited number of wrong attempts are allowed.
 */
export async function createChallenge(userId: string | null, ip: string | null): Promise<{ challengeId: string; code: string }> {
  const challengeId = newId();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const doc: Omit<ChallengeDoc, 'id'> = {
    user_id: userId,
    code_hash: hmac(`${challengeId}:${code}`),
    expires_at: new Date(Date.now() + config.otpTtlMinutes * 60e3).toISOString(),
    attempts: 0,
    used_at: null,
    ip,
    created_at: now(),
  };
  await db.collection(C.challenges).doc(challengeId).set(doc);
  return { challengeId, code };
}

export type VerifyResult = { ok: true; userId: string } | { ok: false; reason: 'invalid' | 'expired' | 'locked' };

export async function verifyChallenge(challengeId: string, code: string): Promise<VerifyResult> {
  const ref = db.collection(C.challenges).doc(challengeId);
  const c = await getById<ChallengeDoc>(C.challenges, challengeId);
  if (!c || c.used_at) return { ok: false, reason: 'invalid' };
  if (Date.parse(c.expires_at) < Date.now()) return { ok: false, reason: 'expired' };
  if (c.attempts >= config.otpMaxAttempts) return { ok: false, reason: 'locked' };
  await ref.update({ attempts: c.attempts + 1 });
  const match = /^\d{6}$/.test(code) && safeEqualHex(hmac(`${challengeId}:${code}`), c.code_hash);
  if (!match || !c.user_id) return { ok: false, reason: 'invalid' };
  await ref.update({ used_at: now() });
  return { ok: true, userId: c.user_id };
}

export async function purgeExpiredChallenges(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString();
  const old = await query<ChallengeDoc>(C.challenges, { where: [['expires_at', '<', cutoff]] });
  await Promise.all(old.map((c) => db.collection(C.challenges).doc(c.id).delete()));
}
