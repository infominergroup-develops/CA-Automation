import { Router } from 'express';
import { z } from 'zod';
import { verifyAuditChain } from '../audit.ts';
import { all, one, run, tx, now, id, setting } from '../db.ts';
import { auditReq, parse, zText } from '../http.ts';
import { HttpError, destroySession, requireAuth, requireRole } from '../security/session.ts';

export const privacyRouter = Router();

/** Purposes for which client personal data is processed. Only `service` is required to use the portal. */
export const PURPOSES = [
  { code: 'service', required: true, label: 'Providing the accounting, tax and compliance services you engaged us for, including storing your documents and preparing your reports and returns.' },
  { code: 'updates', required: false, label: 'Sending you task updates, document reminders and reports on WhatsApp and SMS.' },
] as const;

function notice() {
  const firm = setting('firm_name');
  return {
    version: setting('privacy_notice_version'),
    firm,
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
      name: setting('grievance_officer_name'),
      email: setting('grievance_officer_email'),
      phone: setting('grievance_officer_phone'),
    },
    responseDays: Number(setting('dpdp_response_days')),
  };
}

privacyRouter.get('/privacy/notice', (_req, res) => res.json(notice()));

privacyRouter.post('/privacy/consent', requireRole('client'), (req, res) => {
  const b = parse(z.object({ purposes: z.array(z.enum(PURPOSES.map((p) => p.code) as [string, ...string[]])).min(1), version: z.string() }), req.body);
  if (b.version !== setting('privacy_notice_version')) throw new HttpError(409, 'The privacy notice has changed. Please read it again.');
  if (!b.purposes.includes('service')) throw new HttpError(400, 'Consent for service delivery is needed to use the portal.');
  const consentId = id();
  tx(() => {
    run('UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND withdrawn_at IS NULL', [now(), req.user!.id]);
    run('INSERT INTO consents (id, user_id, notice_version, purposes, given_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [consentId, req.user!.id, b.version, JSON.stringify(b.purposes), now(), req.ip ?? null]);
  });
  auditReq(req, { action: 'privacy.consent_given', objectType: 'consent', objectId: consentId, details: b });
  res.status(201).json({ ok: true });
});

privacyRouter.post('/privacy/consent/withdraw', requireRole('client'), (req, res) => {
  const b = parse(z.object({ purposes: z.array(z.string()).min(1) }), req.body);
  const current = one<{ id: string; purposes: string; notice_version: string }>(
    'SELECT id, purposes, notice_version FROM consents WHERE user_id = ? AND withdrawn_at IS NULL ORDER BY given_at DESC LIMIT 1', [req.user!.id]);
  if (!current) throw new HttpError(404, 'No active consent.');
  const remaining = (JSON.parse(current.purposes) as string[]).filter((p) => !b.purposes.includes(p));
  tx(() => {
    run('UPDATE consents SET withdrawn_at = ? WHERE id = ?', [now(), current.id]);
    if (remaining.length) {
      run('INSERT INTO consents (id, user_id, notice_version, purposes, given_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
        [id(), req.user!.id, current.notice_version, JSON.stringify(remaining), now(), req.ip ?? null]);
    }
  });
  auditReq(req, { action: 'privacy.consent_withdrawn', objectType: 'consent', objectId: current.id, details: { withdrawn: b.purposes } });
  const lostAccess = !remaining.includes('service');
  if (lostAccess) {
    // Record it for the firm to action, then sign the client out.
    run(`INSERT INTO dpdp_requests (id, user_id, type, details, due_at, created_at) VALUES (?, ?, 'withdraw_consent', ?, ?, ?)`,
      [id(), req.user!.id, 'Client withdrew consent for service delivery through the portal.', dueDate(), now()]);
    destroySession(req, res);
  }
  res.json({ ok: true, signedOut: lostAccess });
});

const dueDate = () => new Date(Date.now() + Number(setting('dpdp_response_days')) * 86400e3).toISOString();

privacyRouter.get('/privacy/mine', requireAuth, (req, res) => {
  res.json({
    consents: all('SELECT notice_version, purposes, given_at, withdrawn_at FROM consents WHERE user_id = ? ORDER BY given_at DESC', [req.user!.id]),
    requests: all('SELECT id, type, details, status, response, due_at, created_at, closed_at FROM dpdp_requests WHERE user_id = ? ORDER BY created_at DESC', [req.user!.id]),
  });
});

/** Right to access (DPDP Act s.11): a machine-readable summary of the person's own data. */
privacyRouter.get('/privacy/my-data', requireAuth, (req, res) => {
  const u = req.user!;
  const profile = one('SELECT id, role, name, email, mobile, created_at FROM users WHERE id = ?', [u.id]);
  const companies = u.role === 'client'
    ? all('SELECT legal_name, pan, gstin FROM companies WHERE group_id = ?', [u.client_group_id ?? '']) : [];
  const uploads = all('SELECT original_name, fy, month, size, sha256, created_at FROM documents WHERE uploaded_by = ? AND deleted_at IS NULL', [u.id]);
  const consents = all('SELECT notice_version, purposes, given_at, withdrawn_at FROM consents WHERE user_id = ?', [u.id]);
  const activity = all('SELECT ts, action, ip FROM audit_log WHERE actor_id = ? OR object_id = ? ORDER BY seq DESC LIMIT 1000', [u.id, u.id]);
  const time = u.role === 'client' ? [] : all('SELECT started_at, ended_at, idle_seconds, source, note FROM time_entries WHERE user_id = ?', [u.id]);
  auditReq(req, { action: 'privacy.data_exported', objectType: 'user', objectId: u.id });
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json({ generatedAt: now(), profile, companies, uploads, consents, timeEntries: time, activity });
});

privacyRouter.post('/privacy/requests', requireAuth, (req, res) => {
  const b = parse(z.object({
    type: z.enum(['access', 'correction', 'erasure', 'grievance', 'nomination']),
    details: zText(4000).min(5),
  }), req.body);
  const reqId = id();
  run('INSERT INTO dpdp_requests (id, user_id, type, details, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [reqId, req.user!.id, b.type, b.details, dueDate(), now()]);
  auditReq(req, { action: 'privacy.request_raised', objectType: 'dpdp_request', objectId: reqId, details: { type: b.type } });
  res.status(201).json({ id: reqId });
});

privacyRouter.get('/privacy/requests', requireRole('director'), (_req, res) => {
  res.json(all(
    `SELECT r.*, u.name AS user_name, u.role AS user_role, h.name AS handled_by_name FROM dpdp_requests r
     JOIN users u ON u.id = r.user_id LEFT JOIN users h ON h.id = r.handled_by
     ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, r.due_at`));
});

privacyRouter.patch('/privacy/requests/:id', requireRole('director'), (req, res) => {
  const b = parse(z.object({ status: z.enum(['in_progress', 'closed', 'rejected']), response: zText(4000).optional() }), req.body);
  if (b.status !== 'in_progress' && !b.response) throw new HttpError(400, 'Write the response sent to the person.');
  const r = run(`UPDATE dpdp_requests SET status = ?, response = COALESCE(?, response), handled_by = ?, closed_at = ? WHERE id = ?`,
    [b.status, b.response ?? null, req.user!.id, b.status === 'in_progress' ? null : now(), String(req.params.id)]);
  if (!r.changes) throw new HttpError(404, 'Not found.');
  auditReq(req, { action: `privacy.request_${b.status}`, objectType: 'dpdp_request', objectId: String(req.params.id) });
  res.json({ ok: true });
});

/* ---------- Breach register (DPDP Act s.8(6)) ---------- */

privacyRouter.get('/privacy/breaches', requireRole('director'), (_req, res) => {
  res.json(all('SELECT b.*, u.name AS created_by_name FROM breach_register b JOIN users u ON u.id = b.created_by ORDER BY detected_at DESC'));
});

const breach = z.object({
  detected_at: z.iso.datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)),
  description: zText(4000).min(10),
  data_affected: zText(2000).min(3),
  principals_affected: z.number().int().min(0).optional(),
});

privacyRouter.post('/privacy/breaches', requireRole('director'), (req, res) => {
  const b = parse(breach, req.body);
  const bId = id();
  run(`INSERT INTO breach_register (id, detected_at, description, data_affected, principals_affected, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [bId, new Date(b.detected_at).toISOString(), b.description, b.data_affected, b.principals_affected ?? null, req.user!.id, now()]);
  auditReq(req, { action: 'privacy.breach_recorded', objectType: 'breach', objectId: bId });
  res.status(201).json({ id: bId });
});

privacyRouter.patch('/privacy/breaches/:id', requireRole('director'), (req, res) => {
  const b = parse(z.object({
    status: z.enum(['open', 'contained', 'closed']).optional(),
    board_intimated: z.boolean().optional(),
    principals_notified: z.boolean().optional(),
  }), req.body);
  const r = run(`UPDATE breach_register SET status = COALESCE(?, status),
                   board_intimated_at = CASE WHEN ? = 1 THEN COALESCE(board_intimated_at, ?) ELSE board_intimated_at END,
                   principals_notified_at = CASE WHEN ? = 1 THEN COALESCE(principals_notified_at, ?) ELSE principals_notified_at END
                 WHERE id = ?`,
  [b.status ?? null, b.board_intimated ? 1 : 0, now(), b.principals_notified ? 1 : 0, now(), String(req.params.id)]);
  if (!r.changes) throw new HttpError(404, 'Not found.');
  auditReq(req, { action: 'privacy.breach_updated', objectType: 'breach', objectId: String(req.params.id), details: b });
  res.json({ ok: true });
});

/* ---------- Audit log ---------- */

privacyRouter.get('/audit', requireRole('director'), (req, res) => {
  const q = parse(z.object({
    before: z.coerce.number().int().optional(),
    action: zText(60).optional(),
    company_id: z.uuid().optional(),
  }), req.query);
  res.json(all(
    `SELECT a.seq, a.ts, a.action, a.object_type, a.object_id, a.ip, a.details, a.hash, COALESCE(a.actor_role, u.role) AS actor_role,
            u.name AS actor, c.legal_name AS company
     FROM audit_log a LEFT JOIN users u ON u.id = COALESCE(a.actor_id, CASE WHEN a.action LIKE 'auth.%' AND a.object_type = 'user' THEN a.object_id END) LEFT JOIN companies c ON c.id = a.company_id
     WHERE (? IS NULL OR a.seq < ?) AND (? IS NULL OR a.action LIKE ? || '%') AND (? IS NULL OR a.company_id = ?)
     ORDER BY a.seq DESC LIMIT 200`,
    [q.before ?? null, q.before ?? null, q.action ?? null, q.action ?? null, q.company_id ?? null, q.company_id ?? null]));
});

privacyRouter.get('/audit/verify', requireRole('director'), (req, res) => {
  const result = verifyAuditChain();
  auditReq(req, { action: 'audit.verified', details: { ok: result.ok, checked: result.checked } });
  res.json(result);
});
