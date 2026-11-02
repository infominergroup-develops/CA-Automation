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

export const zId = z.uuid();
export const zText = (max: number) => z.string().trim().max(max);
export const zFy = z.string().regex(/^20\d{2}-\d{2}$/, 'Use a financial year like 2025-26');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const zMobile = z.string().trim().transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'));
export const zEmail = z.string().trim().toLowerCase().pipe(z.email());
export const zPan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN');
export const zGstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

/** Masks a mobile or email for display, e.g. ******3210. */
export function mask(v: string | null): string | null {
  if (!v) return null;
  if (v.includes('@')) {
    const [u, d] = v.split('@');
    return `${u.slice(0, 2)}***@${d}`;
  }
  return `******${v.slice(-4)}`;
}
