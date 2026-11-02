import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { audit, type AuditEntry } from './audit.ts';
import { hasCurrentConsent } from './consents.ts';
import { destroySession, loadValidSession, touchSession } from './sessions.ts';
import { getUserById } from './users.ts';
import type { Role, UserDoc } from './types.ts';

/**
 * Request layer for the Firestore app: async session middleware, role/consent guards, CSRF defence, and
 * input validation. Mirrors the SQLite server's security exactly, but awaits Firestore.
 */

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export interface SessionUser {
  id: string; role: Role; name: string; email: string | null; mobile: string | null;
  client_group_id: string | null; monitoring_notice_ack_at: string | null;
}
// Reuses the project-wide Express.Request augmentation (req.user / req.sessionHash) declared by the SQLite
// session module; we only ever set these at runtime here, never import that module.

export const clientIp = (req: Request) => req.ip ?? null;

export function setSessionCookie(res: Response, token: string) {
  res.cookie(config.cookieName, token, {
    httpOnly: true, secure: config.isProd, sameSite: 'strict', path: '/', maxAge: config.sessionAbsoluteHours * 3600e3,
  });
}
export function clearSessionCookie(res: Response) {
  res.clearCookie(config.cookieName, { path: '/', httpOnly: true, secure: config.isProd, sameSite: 'strict' });
}

const toSessionUser = (u: UserDoc): SessionUser => ({
  id: u.id, role: u.role, name: u.name, email: u.email, mobile: u.mobile,
  client_group_id: u.client_group_id, monitoring_notice_ack_at: u.monitoring_notice_ack_at,
});

/** Attaches req.user when a valid, unexpired session cookie is present. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[config.cookieName];
    const s = typeof token === 'string' ? await loadValidSession(token) : null;
    if (!s) return next();
    const u = await getUserById(s.userId);
    if (!u || u.status !== 'active') { await destroySession(s.hash); return next(); }
    if (req.path !== '/api/time/heartbeat') await touchSession(s.hash); // heartbeats must not keep an idle session alive
    req.user = toSessionUser(u);
    req.sessionHash = s.hash;
    next();
  } catch (e) { next(e); }
}

/**
 * CSRF defence for state-changing requests: SameSite=Strict cookies, a required custom header (cross-site
 * forms cannot set it), and an Origin check when the browser sends one.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'fetch') return next(new HttpError(403, 'Request blocked.', 'csrf'));
  const origin = req.headers.origin;
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

/** Clients must accept the current privacy notice before their data is processed (DPDP s.5–6). */
export async function requireConsent(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.user?.role === 'client' && !(await hasCurrentConsent(req.user.id))) {
      return next(new HttpError(403, 'Please review and accept the privacy notice.', 'consent_required'));
    }
    next();
  } catch (e) { next(e); }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'input'}: ${first.message}`, 'validation');
  }
  return r.data;
}

/** Audit helper that fills in who and where from the request. */
export const auditReq = (req: Request, e: Omit<AuditEntry, 'actorId' | 'actorRole' | 'ip'>) =>
  audit({ ...e, actorId: req.user?.id ?? null, actorRole: req.user?.role ?? null, ip: clientIp(req) });

/** Wraps an async route so thrown errors reach the Express error handler. */
export const h = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export const mask = (v: string | null): string | null =>
  !v ? null : v.includes('@') ? `${v.slice(0, 2)}***@${v.split('@')[1]}` : `******${v.slice(-4)}`;
