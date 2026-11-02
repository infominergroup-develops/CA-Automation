import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.ts';
import { one, run, now, setting } from '../db.ts';
import { randomToken, sha256 } from './crypto.ts';

export type Role = 'director' | 'manager' | 'employee' | 'client';

export interface SessionUser {
  id: string;
  role: Role;
  name: string;
  email: string | null;
  mobile: string | null;
  client_group_id: string | null;
  monitoring_notice_ack_at: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionHash?: string;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const clientIp = (req: Request) => req.ip ?? null;

export function createSession(res: Response, req: Request, userId: string) {
  const token = randomToken();
  const t = Date.now();
  run(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, now(), now(), new Date(t + config.sessionAbsoluteHours * 3600e3).toISOString(),
      clientIp(req), String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionAbsoluteHours * 3600e3,
  });
}

export function destroySession(req: Request, res: Response) {
  if (req.sessionHash) run('DELETE FROM sessions WHERE token_hash = ?', [req.sessionHash]);
  res.clearCookie(config.cookieName, { path: '/', httpOnly: true, secure: config.isProd, sameSite: 'strict' });
}

export function endAllSessions(userId: string) {
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

/** Attaches req.user when a valid, unexpired session cookie is present. */
export function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[config.cookieName];
  if (typeof token !== 'string' || token.length < 20) return next();
  const hash = sha256(token);
  const s = one<{ user_id: string; last_seen: string; expires_at: string }>(
    'SELECT user_id, last_seen, expires_at FROM sessions WHERE token_hash = ?', [hash]);
  if (!s) return next();
  const t = Date.now();
  if (Date.parse(s.expires_at) < t || Date.parse(s.last_seen) + config.sessionIdleMinutes * 60e3 < t) {
    run('DELETE FROM sessions WHERE token_hash = ?', [hash]);
    return next();
  }
  const user = one<SessionUser & { status: string }>(
    `SELECT id, role, name, email, mobile, client_group_id, monitoring_notice_ack_at, status FROM users WHERE id = ?`,
    [s.user_id]);
  if (!user || user.status !== 'active') {
    run('DELETE FROM sessions WHERE token_hash = ?', [hash]);
    return next();
  }
  // Heartbeat calls from the timer must not keep an idle session alive.
  if (req.path !== '/api/time/heartbeat') run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', [now(), hash]);
  const { status: _s, ...u } = user;
  req.user = u;
  req.sessionHash = hash;
  next();
}

/**
 * CSRF defence for state-changing requests: SameSite=Strict cookies, plus a custom header
 * (cross-site forms cannot set it) and an Origin check when the browser sends one.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (req.headers['x-requested-with'] !== 'fetch') return next(new HttpError(403, 'Request blocked.', 'csrf'));
  if (origin && origin !== config.appOrigin) return next(new HttpError(403, 'Request blocked.', 'csrf'));
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have access to this.', 'forbidden'));
  next();
};

export function hasCurrentConsent(userId: string): boolean {
  return !!one(
    'SELECT 1 FROM consents WHERE user_id = ? AND notice_version = ? AND withdrawn_at IS NULL',
    [userId, setting('privacy_notice_version')]);
}

/** Clients must accept the current privacy notice (DPDP Act s.5–6) before their data is processed in the portal. */
export function requireConsent(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role === 'client' && !hasCurrentConsent(req.user.id)) {
    return next(new HttpError(403, 'Please review and accept the privacy notice.', 'consent_required'));
  }
  next();
}
