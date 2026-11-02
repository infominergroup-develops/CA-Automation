import { Router } from 'express';
import { z } from 'zod';
import { companyScope, assertCompany } from '../authz.ts';
import { all, one, run, tx, now, id, setting } from '../db.ts';
import { auditReq, parse, zEmail, zGstin, zId, zMobile, zPan, zText } from '../http.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../security/crypto.ts';
import { HttpError, endAllSessions, requireAuth, requireRole } from '../security/session.ts';

export const adminRouter = Router();

/* ---------- Staff users ---------- */

adminRouter.get('/users', requireRole('director', 'manager'), (req, res) => {
  const rows = all<Record<string, unknown>>(
    `SELECT id, role, name, email, mobile, status, created_at FROM users
     WHERE role <> 'client' ${req.user!.role === 'manager' ? "AND status = 'active'" : ''}
     ORDER BY role, name`);
  res.json(rows);
});

const newStaff = z.object({
  name: zText(120).min(2),
  role: z.enum(['director', 'manager', 'employee']),
  email: zEmail,
  mobile: zMobile,
  password: z.string().min(12).max(200),
});

adminRouter.post('/users', requireRole('director', 'manager'), async (req, res) => {
  const b = parse(newStaff, req.body);
  if (req.user!.role === 'manager' && b.role !== 'employee') throw new HttpError(403, 'Managers can only add employees.');
  const problem = passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  if (one('SELECT 1 FROM users WHERE email = ? OR mobile = ?', [b.email, b.mobile])) {
    throw new HttpError(409, 'A user with this email or mobile already exists.');
  }
  const userId = id();
  run(`INSERT INTO users (id, role, name, email, mobile, password_hash, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [userId, b.role, b.name, b.email, b.mobile, await hashPassword(b.password), now(), req.user!.id, now()]);
  auditReq(req, { action: 'user.created', objectType: 'user', objectId: userId, details: { role: b.role } });
  res.status(201).json({ id: userId });
});

adminRouter.patch('/users/:id/status', requireRole('director'), (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
  const target = one<{ id: string }>('SELECT id FROM users WHERE id = ?', [String(req.params.id)]);
  if (!target) throw new HttpError(404, 'Not found.');
  if (target.id === req.user!.id) throw new HttpError(400, 'You cannot disable your own account.');
  tx(() => {
    run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, now(), target.id]);
    if (status === 'disabled') {
      endAllSessions(target.id);
      // Disabling someone removes any document access they still hold.
      run(`UPDATE access_grants SET status = 'revoked', decided_at = ? WHERE employee_id = ? AND status IN ('requested','granted')`,
        [now(), target.id]);
    }
  });
  auditReq(req, { action: `user.${status === 'active' ? 'enabled' : 'disabled'}`, objectType: 'user', objectId: target.id });
  res.json({ ok: true });
});

adminRouter.post('/me/password', requireAuth, async (req, res) => {
  const b = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
  if (req.user!.role === 'client') throw new HttpError(400, 'Clients sign in with a one-time code.');
  const u = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [req.user!.id]);
  if (!(await verifyPassword(b.current, u?.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  const problem = passwordProblem(b.next);
  if (problem) throw new HttpError(400, problem);
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [await hashPassword(b.next), now(), req.user!.id]);
  // Sign out every other device.
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [req.user!.id, req.sessionHash!]);
  auditReq(req, { action: 'user.password_changed', objectType: 'user', objectId: req.user!.id });
  res.json({ ok: true });
});

/** Staff acknowledge, once, what the portal records about their work (DPDP Act notice to employees). */
adminRouter.post('/me/monitoring-ack', requireRole('director', 'manager', 'employee'), (req, res) => {
  run('UPDATE users SET monitoring_notice_ack_at = ? WHERE id = ? AND monitoring_notice_ack_at IS NULL', [now(), req.user!.id]);
  auditReq(req, { action: 'privacy.monitoring_notice_ack', objectType: 'user', objectId: req.user!.id });
  res.json({ ok: true });
});

/* ---------- Clients and companies ---------- */

const companyFields = z.object({
  legal_name: zText(200).min(2),
  pan: zPan.optional().or(z.literal('').transform(() => undefined)),
  gstin: zGstin.optional().or(z.literal('').transform(() => undefined)),
  tally_name: zText(200).optional(),
  manager_id: zId.optional(),
});

const contactFields = z.object({ name: zText(120).min(2), mobile: zMobile, email: zEmail.optional().or(z.literal('').transform(() => undefined)) });

function checkManager(managerId: string | undefined) {
  if (managerId && !one(`SELECT 1 FROM users WHERE id = ? AND role IN ('manager','director') AND status = 'active'`, [managerId])) {
    throw new HttpError(400, 'Assigned manager not found.');
  }
}

adminRouter.post('/clients', requireRole('director', 'manager'), (req, res) => {
  const b = parse(z.object({ group_name: zText(200).min(2), company: companyFields, contact: contactFields }), req.body);
  const managerId = b.company.manager_id ?? (req.user!.role === 'manager' ? req.user!.id : undefined);
  checkManager(managerId);
  if (one('SELECT 1 FROM users WHERE mobile = ? OR (email IS NOT NULL AND email = ?)', [b.contact.mobile, b.contact.email ?? ''])) {
    throw new HttpError(409, 'A user with this mobile or email already exists.');
  }
  const groupId = id(), companyId = id(), userId = id();
  tx(() => {
    run('INSERT INTO client_groups (id, name, created_at, created_by) VALUES (?, ?, ?, ?)', [groupId, b.group_name, now(), req.user!.id]);
    run(`INSERT INTO companies (id, group_id, legal_name, pan, gstin, tally_name, manager_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, groupId, b.company.legal_name, b.company.pan ?? null, b.company.gstin ?? null,
      b.company.tally_name ?? null, managerId ?? null, now(), req.user!.id]);
    run(`INSERT INTO users (id, role, name, email, mobile, client_group_id, created_at, created_by, updated_at)
         VALUES (?, 'client', ?, ?, ?, ?, ?, ?, ?)`,
    [userId, b.contact.name, b.contact.email ?? null, b.contact.mobile, groupId, now(), req.user!.id, now()]);
  });
  auditReq(req, { action: 'client.created', objectType: 'client_group', objectId: groupId, companyId });
  res.status(201).json({ groupId, companyId, userId });
});

adminRouter.post('/clients/:groupId/companies', requireRole('director', 'manager'), (req, res) => {
  const b = parse(companyFields, req.body);
  const group = one<{ id: string }>('SELECT id FROM client_groups WHERE id = ?', [String(req.params.groupId)]);
  if (!group) throw new HttpError(404, 'Not found.');
  if (req.user!.role === 'manager' && !one('SELECT 1 FROM companies WHERE group_id = ? AND manager_id = ?', [group.id, req.user!.id])) {
    throw new HttpError(404, 'Not found.');
  }
  const managerId = b.manager_id ?? (req.user!.role === 'manager' ? req.user!.id : undefined);
  checkManager(managerId);
  const companyId = id();
  run(`INSERT INTO companies (id, group_id, legal_name, pan, gstin, tally_name, manager_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [companyId, group.id, b.legal_name, b.pan ?? null, b.gstin ?? null, b.tally_name ?? null, managerId ?? null, now(), req.user!.id]);
  auditReq(req, { action: 'company.created', objectType: 'company', objectId: companyId, companyId });
  res.status(201).json({ id: companyId });
});

adminRouter.post('/clients/:groupId/users', requireRole('director', 'manager'), (req, res) => {
  const b = parse(contactFields, req.body);
  const group = one<{ id: string }>('SELECT id FROM client_groups WHERE id = ?', [String(req.params.groupId)]);
  if (!group) throw new HttpError(404, 'Not found.');
  const scope = companyScope(req.user!);
  if (scope && !one(`SELECT 1 FROM companies WHERE group_id = ? AND id IN (SELECT value FROM json_each(?))`, [group.id, JSON.stringify(scope)])) {
    throw new HttpError(404, 'Not found.');
  }
  if (one('SELECT 1 FROM users WHERE mobile = ? OR (email IS NOT NULL AND email = ?)', [b.mobile, b.email ?? ''])) {
    throw new HttpError(409, 'A user with this mobile or email already exists.');
  }
  const userId = id();
  run(`INSERT INTO users (id, role, name, email, mobile, client_group_id, created_at, created_by, updated_at)
       VALUES (?, 'client', ?, ?, ?, ?, ?, ?, ?)`,
  [userId, b.name, b.email ?? null, b.mobile, group.id, now(), req.user!.id, now()]);
  auditReq(req, { action: 'client.user_added', objectType: 'user', objectId: userId });
  res.status(201).json({ id: userId });
});

adminRouter.get('/companies', requireAuth, (req, res) => {
  const scope = companyScope(req.user!);
  const rows = all<Record<string, unknown>>(
    `SELECT c.id, c.legal_name, c.pan, c.gstin, c.tally_name, c.group_id, g.name AS group_name,
            c.manager_id, m.name AS manager_name,
            (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id AND d.deleted_at IS NULL AND d.review_status = 'pending') AS pending_docs,
            (SELECT COUNT(*) FROM tasks t WHERE t.company_id = c.id AND t.status NOT IN ('approved','cancelled')) AS open_tasks
     FROM companies c JOIN client_groups g ON g.id = c.group_id LEFT JOIN users m ON m.id = c.manager_id
     ${scope ? 'WHERE c.id IN (SELECT value FROM json_each(?))' : ''}
     ORDER BY g.name, c.legal_name`, scope ? [JSON.stringify(scope)] : undefined);
  // Clients and employees do not need internal fields.
  if (req.user!.role === 'client' || req.user!.role === 'employee') {
    return res.json(rows.map(({ id, legal_name, group_name, gstin }) => ({ id, legal_name, group_name, gstin })));
  }
  res.json(rows);
});

adminRouter.get('/companies/:id', requireRole('director', 'manager'), (req, res) => {
  assertCompany(req.user!, String(req.params.id));
  const company = one<Record<string, unknown>>(
    `SELECT c.*, g.name AS group_name, m.name AS manager_name FROM companies c
     JOIN client_groups g ON g.id = c.group_id LEFT JOIN users m ON m.id = c.manager_id WHERE c.id = ?`, [String(req.params.id)]);
  const contacts = all('SELECT id, name, mobile, email, status FROM users WHERE client_group_id = ? ORDER BY name', [company!.group_id as string]);
  res.json({ company, contacts });
});

adminRouter.get('/categories', requireAuth, (_req, res) => {
  res.json(all('SELECT id, name FROM document_categories WHERE active = 1 ORDER BY sort'));
});

/* ---------- Settings ---------- */

const SETTING_KEYS = ['firm_name', 'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone',
  'privacy_notice_version', 'dpdp_response_days'] as const;

adminRouter.get('/settings', requireRole('director'), (_req, res) => {
  res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, setting(k)])));
});

adminRouter.patch('/settings', requireRole('director'), (req, res) => {
  const b = parse(z.object(Object.fromEntries(SETTING_KEYS.map((k) => [k, zText(200).optional()]))), req.body) as Record<string, string | undefined>;
  const changed: string[] = [];
  tx(() => {
    for (const k of SETTING_KEYS) {
      if (b[k] === undefined) continue;
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, b[k]!]);
      changed.push(k);
    }
  });
  // A new notice version makes every client accept the notice again on next sign-in.
  auditReq(req, { action: 'settings.updated', details: { changed } });
  res.json({ ok: true });
});
