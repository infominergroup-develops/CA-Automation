import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.ts';
import { one, run, now, setting } from '../db.ts';
import { auditReq, mask, parse } from '../http.ts';
import { verifyPassword } from '../security/crypto.ts';
import { createChallenge, deliverCode, verifyChallenge } from '../security/otp.ts';
import {
  HttpError, createSession, destroySession, hasCurrentConsent, requireAuth,
} from '../security/session.ts';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

interface LoginUser {
  id: string;
  role: string;
  name: string;
  email: string | null;
  mobile: string | null;
  password_hash: string | null;
  status: string;
  failed_logins: number;
  locked_until: string | null;
}

function findUser(identifier: string): LoginUser | undefined {
  const v = identifier.trim();
  const mobile = v.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
  return one<LoginUser>(
    'SELECT id, role, name, email, mobile, password_hash, status, failed_logins, locked_until FROM users WHERE email = ? OR mobile = ?',
    [v.toLowerCase(), mobile]);
}

const isLocked = (u: LoginUser) => !!u.locked_until && Date.parse(u.locked_until) > Date.now();

function recordFailure(u: LoginUser) {
  const failed = u.failed_logins + 1;
  const lock = failed >= config.maxFailedLogins ? new Date(Date.now() + config.lockMinutes * 60e3).toISOString() : null;
  run('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?',
    [lock ? 0 : failed, lock, u.id]);
}

const loginSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('client'), identifier: z.string().trim().min(3).max(200) }),
  z.object({ mode: z.literal('staff'), identifier: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }),
]);

/** Step 1: identify. Clients: mobile/email → OTP. Staff: email + password → OTP (two factors). */
authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const u = findUser(body.identifier);

  if (body.mode === 'client') {
    if (config.otpProvider === 'off') throw new HttpError(403, 'Client sign-in is unavailable right now. Please contact the firm.');
    const valid = !!u && u.role === 'client' && u.status === 'active' && !isLocked(u);
    const { challengeId, code } = createChallenge(valid ? u.id : null, req.ip ?? null);
    if (valid) await deliverCode(u, code);
    auditReq(req, { action: 'auth.otp_requested', objectType: 'user', objectId: valid ? u.id : undefined,
      details: valid ? undefined : { unknownIdentifier: true } });
    // Same response whether or not the account exists.
    return res.json({ challengeId, sentTo: valid ? mask(u.mobile ?? u.email) : mask(body.identifier) });
  }

  const passwordOk = await verifyPassword(body.password, u?.password_hash);
  if (!u || u.role === 'client' || u.status !== 'active') {
    auditReq(req, { action: 'auth.login_failed', details: { reason: 'unknown_or_inactive' } });
    throw new HttpError(401, 'Incorrect email or password.');
  }
  if (isLocked(u)) {
    auditReq(req, { action: 'auth.login_blocked', objectType: 'user', objectId: u.id });
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }
  if (!passwordOk) {
    recordFailure(u);
    auditReq(req, { action: 'auth.login_failed', objectType: 'user', objectId: u.id, details: { reason: 'password' } });
    throw new HttpError(401, 'Incorrect email or password.');
  }
  if (config.otpProvider === 'off') { startSession(req, res, u.id); return res.json({ ok: true, signedIn: true }); }
  const { challengeId, code } = createChallenge(u.id, req.ip ?? null);
  await deliverCode(u, code);
  auditReq(req, { action: 'auth.otp_requested', objectType: 'user', objectId: u.id });
  res.json({ challengeId, sentTo: mask(u.mobile ?? u.email) });
});

/** Step 2: verify the one-time code and start a session. */
authRouter.post('/verify', verifyLimiter, (req, res) => {
  const body = parse(z.object({ challengeId: z.uuid(), code: z.string().trim().max(10) }), req.body);
  const r = verifyChallenge(body.challengeId, body.code);
  if (!r.ok) {
    auditReq(req, { action: 'auth.otp_failed', details: { reason: r.reason } });
    const msg = r.reason === 'expired' ? 'Code expired. Request a new one.'
      : r.reason === 'locked' ? 'Too many wrong codes. Request a new one.' : 'Incorrect code.';
    throw new HttpError(401, msg);
  }
  startSession(req, res, r.userId);
  res.json({ ok: true });
});

function startSession(req: Request, res: Response, userId: string) {
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [userId]);
  createSession(res, req, userId);
  const u = one<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
  auditReq(req, { action: 'auth.login', objectType: 'user', objectId: userId, details: { role: u?.role, otp: config.otpProvider !== 'off' } });
}

authRouter.post('/logout', requireAuth, (req, res) => {
  auditReq(req, { action: 'auth.logout', objectType: 'user', objectId: req.user!.id });
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = req.user;
  res.json({
    user: u,
    needsConsent: u.role === 'client' && !hasCurrentConsent(u.id),
    needsMonitoringAck: u.role !== 'client' && !u.monitoring_notice_ack_at,
    noticeVersion: setting('privacy_notice_version'),
    firmName: setting('firm_name'),
    serverTime: now(),
  });
});
