import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';

/**
 * Rules and wording shared by the SQLite server and the Firestore server, so both behave the same.
 * Must not import a database module.
 */

/* ---------- Input validation ---------- */

export const zId = z.uuid();
export const zText = (max: number) => z.string().trim().max(max);
export const zFy = z.string().regex(/^20\d{2}-\d{2}$/, 'Use a financial year like 2025-26');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const zMobile = z.string().trim().transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'));
export const zEmail = z.string().trim().toLowerCase().pipe(z.email());
export const zPan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN');
export const zGstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

export const TASK_TYPES = ['GST return', 'TDS return', 'Income tax return', 'Bookkeeping', 'Bank reconciliation',
  'Audit', 'ROC filing', 'Certificate', 'Other'] as const;

/** What a client sees instead of internal statuses. */
export const CLIENT_STATUS: Record<string, string> = {
  requested: 'Received', assigned: 'Received', in_progress: 'In progress', rework: 'In progress',
  submitted: 'Under review', approved: 'Completed', cancelled: 'Cancelled',
};

export const NON_TASK = ['Training', 'Internal meeting', 'Admin', 'Client visit', 'Travel'] as const;

/* ---------- Privacy notice ---------- */

/** Purposes for which client personal data is processed. Only `service` is required to use the portal. */
export const PURPOSES = [
  { code: 'service', required: true, label: 'Providing the accounting, tax and compliance services you engaged us for, including storing your documents and preparing your reports and returns.' },
  { code: 'updates', required: false, label: 'Sending you task updates, document reminders and reports on WhatsApp and SMS.' },
] as const;

export const NOTICE_SETTING_KEYS = ['firm_name', 'privacy_notice_version', 'grievance_officer_name',
  'grievance_officer_email', 'grievance_officer_phone', 'dpdp_response_days'] as const;

export function privacyNotice(s: Record<(typeof NOTICE_SETTING_KEYS)[number], string>) {
  return {
    version: s.privacy_notice_version,
    firm: s.firm_name,
    purposes: PURPOSES,
    dataCollected: [
      'Your name, mobile number and email address',
      'Business and tax identifiers (PAN, GSTIN) of the companies we serve for you',
      'Financial records and documents you upload, and reports generated from your books',
      'Sign-in records (time, IP address, device) kept for security',
    ],
    rights: [
      'See a summary of the personal data we hold about you (download it any time from this page)',
      'Ask for correction or completion of inaccurate data',
      'Ask for erasure, subject to records we must legally keep (tax and audit records are typically kept 8 years)',
      'Withdraw consent at any time; this is as easy as giving it, but stops portal access for the purposes withdrawn',
      'Nominate a person to exercise these rights on your behalf',
      'Raise a grievance with our Grievance Officer, and if unresolved, complain to the Data Protection Board of India',
    ],
    retention: 'Documents and financial records are kept for as long as the law requires us to (typically 8 years from the end of the relevant financial year), then deleted. Sign-in records are kept for 1 year.',
    security: 'Documents are encrypted at rest, each file is fingerprinted (SHA-256) and checked on every download, and every access is recorded in a tamper-evident log. Data is hosted in India.',
    grievanceOfficer: {
      name: s.grievance_officer_name,
      email: s.grievance_officer_email,
      phone: s.grievance_officer_phone,
    },
    responseDays: Number(s.dpdp_response_days),
  };
}

/* ---------- Uploads ---------- */

/** Allowed types are decided from the file's bytes, never from its name or the browser's claim. */
const ALLOWED: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  cfb: 'application/vnd.ms-excel',
  zip: 'application/zip',
};

export async function detectType(buf: Buffer, name: string): Promise<string | null> {
  const t = await fileTypeFromBuffer(buf);
  if (t && ALLOWED[t.ext]) return ALLOWED[t.ext];
  // CSV and plain text have no signature: accept only by extension, and only if the bytes are text.
  if (!t && /\.(csv|txt)$/i.test(name) && !buf.subarray(0, 8192).includes(0)) {
    return name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain';
  }
  return null;
}

export function cleanName(name: string) {
  // multer gives latin1-decoded names; restore UTF-8 and strip path and control characters.
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return path.basename(utf8).replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').slice(0, 180) || 'file';
}
