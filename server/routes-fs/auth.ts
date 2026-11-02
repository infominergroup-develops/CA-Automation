import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.ts';
import { verifyPassword } from '../security/crypto.ts';
import { createChallenge, verifyChallenge } from '../firestore/challenges.ts';
import { hasCurrentConsent } from '../firestore/consents.ts';
import { createSession, destroySession } from '../firestore/sessions.ts';
import { getSetting } from '../firestore/settings.ts';
import { clearLoginFailures, findUserByIdentifier, getUserById, isLocked, recordLoginFailure } from '../firestore/users.ts';
import { HttpError, auditReq, clientIp, h, mask, parse, requireAuth, setSessionCookie, clearSessionCookie } from '../firestore/http.ts';

export const authRouter = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

/** Delivers the one-time code. Swap the 'sms' branch for a DLT-registered provider before go-live. */
async function deliverCode(to: { name: string; mobile: string | null; email: string | null }, code: string) {
  if (config.otpProvider === 'file') {
    const file = path.join(config.dataDir, 'dev-otp.json');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    all[to.mobile ?? to.email ?? ''] = code;
    fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    return;
  }
  if (config.otpProvider === 'console') { console.log(`\n[DEV OTP] ${to.name} <${to.mobile ?? to.email}>: ${code}\n`); return; }
  throw new Error('SMS OTP provider is not configured.');
}

const loginSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('client'), identifier: z.string().trim().min(3).max(200) }),
  z.object({ mode: z.literal('staff'), identifier: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }),
]);

/** Step 1: identify. Clients → OTP. Staff → password + OTP. Same response whether or not the account exists. */
authRouter.post('/login', loginLimiter, h(async (req, res) => {
  const body = parse(loginSchema, req.body);
  const u = await findUserByIdentifier(body.identifier);

  if (body.mode === 'client') {
    if (config.otpProvider === 'off') throw new HttpError(403, 'Client sign-in is unavailable right now. Please contact the firm.');
    const valid = !!u && u.role === 'client' && u.status === 'active' && !isLocked(u);
    const { challengeId, code } = await createChallenge(valid ? u!.id : null, clientIp(req));
    if (valid) await deliverCode(u!, code);
    await auditReq(req, { action: 'auth.otp_requested', objectType: 'user', objectId: valid ? u!.id : undefined, details: valid ? undefined : { unknownIdentifier: true } });
    return res.json({ challengeId, sentTo: valid ? mask(u!.mobile ?? u!.email) : mask(body.identifier) });
  }

  const passwordOk = await verifyPassword(body.password, u?.password_hash);
  if (!u || u.role === 'client' || u.status !== 'active') {
    await auditReq(req, { action: 'auth.login_failed', details: { reason: 'unknown_or_inactive' } });
    throw new HttpError(401, 'Incorrect email or password.');
  }
  if (isLocked(u)) { await auditReq(req, { action: 'auth.login_blocked', objectType: 'user', objectId: u.id }); throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.'); }
  if (!passwordOk) {
    await recordLoginFailure(u);
    await auditReq(req, { action: 'auth.login_failed', objectType: 'user', objectId: u.id, details: { reason: 'password' } });
    throw new HttpError(401, 'Incorrect email or password.');
  }
  if (config.otpProvider === 'off') { await startSession(req, res, u.id); return res.json({ ok: true, signedIn: true }); }
  const { challengeId, code } = await createChallenge(u.id, clientIp(req));
  await deliverCode(u, code);
  await auditReq(req, { action: 'auth.otp_requested', objectType: 'user', objectId: u.id });
  res.json({ challengeId, sentTo: mask(u.mobile ?? u.email) });
}));

/** Step 2: verify the code and start a session. */
authRouter.post('/verify', verifyLimiter, h(async (req, res) => {
  const body = parse(z.object({ challengeId: z.uuid(), code: z.string().trim().max(10) }), req.body);
  const r = await verifyChallenge(body.challengeId, body.code);
  if (!r.ok) {
    await auditReq(req, { action: 'auth.otp_failed', details: { reason: r.reason } });
    throw new HttpError(401, r.reason === 'expired' ? 'Code expired. Request a new one.' : r.reason === 'locked' ? 'Too many wrong codes. Request a new one.' : 'Incorrect code.');
  }
  await startSession(req, res, r.userId);
  res.json({ ok: true });
}));

async function startSession(req: Request, res: Response, userId: string) {
  await clearLoginFailures(userId);
  const token = await createSession(userId, clientIp(req), String(req.headers['user-agent'] ?? ''));
  setSessionCookie(res, token);
  const u = await getUserById(userId);
  await auditReq(req, { action: 'auth.login', objectType: 'user', objectId: userId, details: { role: u?.role, otp: config.otpProvider !== 'off' } });
}

authRouter.post('/logout', requireAuth, h(async (req, res) => {
  await auditReq(req, { action: 'auth.logout', objectType: 'user', objectId: req.user!.id });
  if (req.sessionHash) await destroySession(req.sessionHash);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

authRouter.get('/me', h(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = req.user;
  res.json({
    user: u,
    needsConsent: u.role === 'client' && !(await hasCurrentConsent(u.id)),
    needsMonitoringAck: u.role !== 'client' && !u.monitoring_notice_ack_at,
    noticeVersion: await getSetting('privacy_notice_version'),
    firmName: await getSetting('firm_name'),
    serverTime: new Date().toISOString(),
    features: { tally: false }, // Tally sync and reports are not on Firestore yet
  });
}));
