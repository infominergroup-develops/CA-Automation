import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.ts';
import { one, run, now, id } from '../db.ts';
import { hmac, safeEqualHex } from './crypto.ts';

/**
 * Creates a login challenge. For unknown identifiers we still create one (with no user),
 * so the response looks identical and accounts cannot be enumerated.
 */
export function createChallenge(userId: string | null, ip: string | null) {
  const challengeId = id();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  run(
    `INSERT INTO login_challenges (id, user_id, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [challengeId, userId, hmac(`${challengeId}:${code}`),
      new Date(Date.now() + config.otpTtlMinutes * 60e3).toISOString(), ip, now()],
  );
  return { challengeId, code };
}

export type VerifyResult = { ok: true; userId: string } | { ok: false; reason: 'invalid' | 'expired' | 'locked' };

export function verifyChallenge(challengeId: string, code: string): VerifyResult {
  const c = one<{ user_id: string | null; code_hash: string; expires_at: string; attempts: number; used_at: string | null }>(
    'SELECT user_id, code_hash, expires_at, attempts, used_at FROM login_challenges WHERE id = ?', [challengeId]);
  if (!c || c.used_at) return { ok: false, reason: 'invalid' };
  if (Date.parse(c.expires_at) < Date.now()) return { ok: false, reason: 'expired' };
  if (c.attempts >= config.otpMaxAttempts) return { ok: false, reason: 'locked' };
  run('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?', [challengeId]);
  const match = /^\d{6}$/.test(code) && safeEqualHex(hmac(`${challengeId}:${code}`), c.code_hash);
  if (!match || !c.user_id) return { ok: false, reason: 'invalid' };
  run('UPDATE login_challenges SET used_at = ? WHERE id = ?', [now(), challengeId]);
  return { ok: true, userId: c.user_id };
}

/** Sends the code. Replace the 'sms' branch with a DLT-registered SMS/WhatsApp provider before go-live. */
export async function deliverCode(to: { name: string; mobile: string | null; email: string | null }, code: string) {
  if (config.otpProvider === 'file') {
    // Automated UI tests only: latest code per user, readable by the test runner. Refused in production by config.ts.
    const file = path.join(config.dataDir, 'dev-otp.json');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    all[to.mobile ?? to.email ?? ''] = code;
    fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    return;
  }
  if (config.otpProvider === 'console') {
    // Development only: config.ts refuses this provider in production.
    console.log(`\n[DEV OTP] ${to.name} <${to.mobile ?? to.email}>: ${code}\n`);
    return;
  }
  throw new Error('SMS OTP provider is not configured. Implement it in server/security/otp.ts.');
}

export function purgeExpiredChallenges() {
  run('DELETE FROM login_challenges WHERE expires_at < ?', [new Date(Date.now() - 24 * 3600e3).toISOString()]);
  run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
}
