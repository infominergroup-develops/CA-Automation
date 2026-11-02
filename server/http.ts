import type { Request } from 'express';
import { z } from 'zod';
import { audit, type AuditEntry } from './audit.ts';
import { HttpError } from './security/session.ts';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'input'}: ${first.message}`, 'validation');
  }
  return r.data;
}

/** Audit helper that fills in who and where from the request. */
export function auditReq(req: Request, e: Omit<AuditEntry, 'actorId' | 'actorRole' | 'ip'>) {
  audit({ ...e, actorId: req.user?.id ?? null, actorRole: req.user?.role ?? null, ip: req.ip ?? null });
}

export { zDate, zEmail, zFy, zGstin, zId, zMobile, zPan, zText } from './shared.ts';

/** Masks a mobile or email for display, e.g. ******3210. */
export function mask(v: string | null): string | null {
  if (!v) return null;
  if (v.includes('@')) {
    const [u, d] = v.split('@');
    return `${u.slice(0, 2)}***@${d}`;
  }
  return `******${v.slice(-4)}`;
}
