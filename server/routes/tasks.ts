import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { assertCompany, companyScope, inScope, isTaskOwner, loadTask, type TaskRow } from '../authz.ts';
import { all, one, run, tx, now, id } from '../db.ts';
import { auditReq, parse, zDate, zId, zText } from '../http.ts';
import { HttpError, requireAuth, requireRole } from '../security/session.ts';

export const tasksRouter = Router();

export const TASK_TYPES = ['GST return', 'TDS return', 'Income tax return', 'Bookkeeping', 'Bank reconciliation',
  'Audit', 'ROC filing', 'Certificate', 'Other'] as const;

/** What a client sees instead of internal statuses. */
const CLIENT_STATUS: Record<string, string> = {
  requested: 'Received', assigned: 'Received', in_progress: 'In progress', rework: 'In progress',
  submitted: 'Under review', approved: 'Completed', cancelled: 'Cancelled',
};

function transition(req: Request, t: TaskRow, to: string, comment?: string, extra: Record<string, unknown> = {}) {
  const sets = Object.keys(extra).map((k) => `${k} = ?`);
  tx(() => {
    run(`UPDATE tasks SET status = ?, updated_at = ?${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = ? AND status = ?`,
      [to, now(), ...(Object.values(extra) as (string | number | null)[]), t.id, t.status]);
    run('INSERT INTO task_events (id, task_id, from_status, to_status, actor_id, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id(), t.id, t.status, to, req.user!.id, comment ?? null, now()]);
  });
  auditReq(req, { action: `task.${to}`, objectType: 'task', objectId: t.id, companyId: t.company_id, details: { from: t.status } });
}

function requireStatus(t: TaskRow, ...allowed: string[]) {
  if (!allowed.includes(t.status)) throw new HttpError(409, `This task is ${t.status.replace('_', ' ')}; that action is not allowed now.`);
}

function checkAssignee(assigneeId: string, reviewerId: string) {
  if (!one(`SELECT 1 FROM users WHERE id = ? AND role IN ('employee','manager') AND status = 'active'`, [assigneeId])) {
    throw new HttpError(400, 'Assignee must be an active employee or manager.');
  }
  if (!one(`SELECT 1 FROM users WHERE id = ? AND role IN ('manager','director') AND status = 'active'`, [reviewerId])) {
    throw new HttpError(400, 'Reviewer must be an active manager or director.');
  }
  // Segregation of duties: nobody approves their own work.
  if (assigneeId === reviewerId) throw new HttpError(400, 'The reviewer cannot be the same person as the assignee.');
}

/* ---------- Listing ---------- */

tasksRouter.get('/tasks', requireAuth, (req, res) => {
  const u = req.user!;
  const q = parse(z.object({
    view: z.enum(['mine', 'review', 'all', 'requests']).default('all'),
    status: z.string().max(20).optional(),
    company_id: zId.optional(),
  }), req.query);
  const where: string[] = [];
  const args: (string | null)[] = [];
  if (u.role === 'employee' || q.view === 'mine') { where.push('t.assignee_id = ?'); args.push(u.id); }
  if (q.view === 'review') { where.push(`t.status = 'submitted' AND (t.reviewer_id = ? OR ? = 'director')`); args.push(u.id, u.role); }
  if (q.view === 'requests') where.push(`t.status = 'requested'`);
  const scope = companyScope(u);
  if (scope && u.role !== 'employee') { where.push('t.company_id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(scope)); }
  if (q.status) { where.push('t.status = ?'); args.push(q.status); }
  if (q.company_id) { where.push('t.company_id = ?'); args.push(q.company_id); }

  const rows = all<Record<string, unknown>>(
    `SELECT t.id, t.company_id, c.legal_name AS company, t.type, t.title, t.period, t.status, t.priority, t.due_date,
            t.statutory_due, t.rework_count, t.estimate_hours, t.updated_at, t.client_note, t.created_at,
            a.name AS assignee, r.name AS reviewer, t.assignee_id, t.reviewer_id,
            (SELECT COALESCE(SUM((julianday(COALESCE(e.ended_at, e.last_heartbeat, e.started_at)) - julianday(e.started_at)) * 86400 - e.idle_seconds), 0)
               FROM time_entries e WHERE e.task_id = t.id AND e.status = 'ok') AS seconds_logged
     FROM tasks t JOIN companies c ON c.id = t.company_id
     LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users r ON r.id = t.reviewer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE t.status WHEN 'approved' THEN 2 WHEN 'cancelled' THEN 3 ELSE 1 END, COALESCE(t.due_date, '9999') , t.updated_at DESC
     LIMIT 500`, args);

  if (u.role === 'client') {
    return res.json(rows.map((r) => ({
      id: r.id, company: r.company, type: r.type, title: r.title, period: r.period,
      status: CLIENT_STATUS[r.status as string], updated_at: r.updated_at, client_note: r.client_note,
    })));
  }
  res.json(rows);
});

tasksRouter.get('/tasks/meta', requireAuth, (_req, res) => res.json({ types: TASK_TYPES }));

tasksRouter.get('/tasks/:id', requireAuth, (req, res) => {
  const u = req.user!;
  const t = loadTask(u, String(req.params.id));
  const company = one<{ legal_name: string }>('SELECT legal_name FROM companies WHERE id = ?', [t.company_id]);
  if (u.role === 'client') {
    return res.json({
      id: t.id, company: company?.legal_name, type: t.type, title: t.title, period: t.period,
      status: CLIENT_STATUS[t.status], updated_at: t.updated_at, client_note: t.client_note,
    });
  }
  const events = all(
    `SELECT e.from_status, e.to_status, e.comment, e.created_at, u.name AS actor FROM task_events e
     JOIN users u ON u.id = e.actor_id WHERE e.task_id = ? ORDER BY e.created_at`, [t.id]);
  const grants = all<Record<string, unknown> & { category_ids: string }>(
    `SELECT g.id, g.category_ids, g.reason, g.status, g.expires_at, g.decision_note, g.created_at, d.name AS decided_by_name
     FROM access_grants g LEFT JOIN users d ON d.id = g.decided_by WHERE g.task_id = ? ORDER BY g.created_at DESC`, [t.id])
    .map((g) => ({ ...g, category_ids: JSON.parse(g.category_ids) as number[] }));
  const names = one<{ assignee: string | null; reviewer: string | null; creator: string }>(
    `SELECT a.name AS assignee, r.name AS reviewer, c.name AS creator FROM tasks t
     LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users r ON r.id = t.reviewer_id JOIN users c ON c.id = t.created_by
     WHERE t.id = ?`, [t.id]);
  const logged = one<{ s: number }>(
    `SELECT COALESCE(SUM(MAX(0, (julianday(COALESCE(ended_at, last_heartbeat, started_at)) - julianday(started_at)) * 86400 - idle_seconds)), 0) AS s
     FROM time_entries WHERE task_id = ? AND status = 'ok'`, [t.id]);
  res.json({
    ...t, company: company?.legal_name, ...names, events, grants, seconds_logged: logged?.s ?? 0,
    can: {
      start: t.assignee_id === u.id && ['assigned', 'rework'].includes(t.status),
      submit: t.assignee_id === u.id && ['in_progress'].includes(t.status),
      requestAccess: t.assignee_id === u.id && !['approved', 'cancelled', 'requested'].includes(t.status),
      review: isTaskOwner(u, t) && t.status === 'submitted' && t.assignee_id !== u.id,
      decideAccess: isTaskOwner(u, t),
      assign: t.status === 'requested' && (u.role === 'director' || (u.role === 'manager' && inScope(u, t.company_id))),
      cancel: isTaskOwner(u, t) && !['approved', 'cancelled'].includes(t.status),
    },
  });
});

/* ---------- Creating ---------- */

const taskFields = z.object({
  company_id: zId,
  type: z.enum(TASK_TYPES),
  title: zText(200).min(3),
  period: zText(40).optional(),
  instructions: zText(4000).optional(),
  assignee_id: zId,
  reviewer_id: zId.optional(),
  due_date: zDate.optional(),
  statutory_due: zDate.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  estimate_hours: z.coerce.number().min(0).max(1000).optional(),
  grant_category_ids: z.array(z.number().int()).max(20).optional(),
});

tasksRouter.post('/tasks', requireRole('director', 'manager'), (req, res) => {
  const b = parse(taskFields, req.body);
  assertCompany(req.user!, b.company_id);
  const reviewerId = b.reviewer_id ?? req.user!.id;
  checkAssignee(b.assignee_id, reviewerId);
  const taskId = id();
  tx(() => {
    run(`INSERT INTO tasks (id, company_id, type, title, period, instructions, assignee_id, reviewer_id, created_by,
           due_date, statutory_due, priority, status, estimate_hours, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`,
    [taskId, b.company_id, b.type, b.title, b.period ?? null, b.instructions ?? null, b.assignee_id, reviewerId,
      req.user!.id, b.due_date ?? null, b.statutory_due ?? null, b.priority, b.estimate_hours ?? null, now(), now()]);
    run('INSERT INTO task_events (id, task_id, from_status, to_status, actor_id, created_at) VALUES (?, ?, NULL, ?, ?, ?)',
      [id(), taskId, 'assigned', req.user!.id, now()]);
    if (b.grant_category_ids?.length) grantAccess(req, taskId, b.assignee_id, b.company_id, b.grant_category_ids, 'Granted when the task was created');
  });
  auditReq(req, { action: 'task.created', objectType: 'task', objectId: taskId, companyId: b.company_id, details: { assignee: b.assignee_id } });
  res.status(201).json({ id: taskId });
});

/** Clients raise a request; it waits for a manager to assign it. */
tasksRouter.post('/tasks/request', requireRole('client'), (req, res) => {
  const b = parse(z.object({ company_id: zId, title: zText(200).min(3), details: zText(4000).optional() }), req.body);
  assertCompany(req.user!, b.company_id);
  const taskId = id();
  tx(() => {
    run(`INSERT INTO tasks (id, company_id, type, title, instructions, created_by, status, created_at, updated_at)
         VALUES (?, ?, 'Other', ?, ?, ?, 'requested', ?, ?)`,
    [taskId, b.company_id, b.title, b.details ?? null, req.user!.id, now(), now()]);
    run('INSERT INTO task_events (id, task_id, from_status, to_status, actor_id, created_at) VALUES (?, ?, NULL, ?, ?, ?)',
      [id(), taskId, 'requested', req.user!.id, now()]);
  });
  auditReq(req, { action: 'task.requested_by_client', objectType: 'task', objectId: taskId, companyId: b.company_id });
  res.status(201).json({ id: taskId });
});

tasksRouter.post('/tasks/:id/assign', requireRole('director', 'manager'), (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  requireStatus(t, 'requested');
  const b = parse(taskFields.omit({ company_id: true, grant_category_ids: true }), req.body);
  const reviewerId = b.reviewer_id ?? req.user!.id;
  checkAssignee(b.assignee_id, reviewerId);
  transition(req, t, 'assigned', undefined, {
    type: b.type, title: b.title, period: b.period ?? null, instructions: b.instructions ?? null,
    assignee_id: b.assignee_id, reviewer_id: reviewerId, due_date: b.due_date ?? null,
    statutory_due: b.statutory_due ?? null, priority: b.priority, estimate_hours: b.estimate_hours ?? null,
  });
  res.json({ ok: true });
});

/* ---------- Workflow ---------- */

tasksRouter.post('/tasks/:id/start', requireAuth, (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  if (t.assignee_id !== req.user!.id) throw new HttpError(403, 'Only the assignee can start this task.');
  requireStatus(t, 'assigned', 'rework');
  transition(req, t, 'in_progress');
  res.json({ ok: true });
});

tasksRouter.post('/tasks/:id/submit', requireAuth, (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  if (t.assignee_id !== req.user!.id) throw new HttpError(403, 'Only the assignee can submit this task.');
  requireStatus(t, 'in_progress');
  const b = parse(z.object({ note: zText(4000).min(5, 'Describe what was done') }), req.body);
  transition(req, t, 'submitted', b.note, { submission_note: b.note, submitted_at: now() });
  res.json({ ok: true });
});

tasksRouter.post('/tasks/:id/approve', requireRole('director', 'manager'), (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  if (!isTaskOwner(req.user!, t) || t.assignee_id === req.user!.id) throw new HttpError(403, 'Only the assigning manager can approve.');
  requireStatus(t, 'submitted');
  const b = parse(z.object({ comment: zText(2000).optional(), client_note: zText(1000).optional() }), req.body);
  tx(() => {
    transition(req, t, 'approved', b.comment, { approved_at: now(), client_note: b.client_note ?? null });
    // Access is tied to the task: it ends the moment the work is approved.
    run(`UPDATE access_grants SET status = 'revoked', decision_note = COALESCE(decision_note, 'Task approved') WHERE task_id = ? AND status IN ('requested','granted')`, [t.id]);
    run('UPDATE time_entries SET ended_at = COALESCE(last_heartbeat, ?) WHERE task_id = ? AND ended_at IS NULL', [now(), t.id]);
  });
  res.json({ ok: true });
});

tasksRouter.post('/tasks/:id/reject', requireRole('director', 'manager'), (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  if (!isTaskOwner(req.user!, t)) throw new HttpError(403, 'Only the assigning manager can reject.');
  requireStatus(t, 'submitted');
  const b = parse(z.object({ comment: zText(2000).min(5, 'Explain what needs fixing') }), req.body);
  transition(req, t, 'rework', b.comment, { rework_count: Number(t.rework_count ?? 0) + 1 });
  res.json({ ok: true });
});

tasksRouter.post('/tasks/:id/cancel', requireRole('director', 'manager'), (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  if (!isTaskOwner(req.user!, t) && !(t.status === 'requested' && inScope(req.user!, t.company_id))) {
    throw new HttpError(403, 'You cannot cancel this task.');
  }
  requireStatus(t, 'requested', 'assigned', 'in_progress', 'rework', 'submitted');
  const b = parse(z.object({ comment: zText(2000).min(3) }), req.body);
  tx(() => {
    transition(req, t, 'cancelled', b.comment);
    run(`UPDATE access_grants SET status = 'revoked' WHERE task_id = ? AND status IN ('requested','granted')`, [t.id]);
  });
  res.json({ ok: true });
});

/* ---------- Document access ---------- */

function grantAccess(req: Request, taskId: string, employeeId: string, companyId: string, categoryIds: number[], reason: string) {
  const grantId = id();
  run(`INSERT INTO access_grants (id, task_id, employee_id, company_id, category_ids, reason, status, decided_by, decided_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?, ?)`,
  [grantId, taskId, employeeId, companyId, JSON.stringify(categoryIds), reason, req.user!.id, now(),
    new Date(Date.now() + config.accessGrantDays * 86400e3).toISOString(), now()]);
  auditReq(req, { action: 'access.granted', objectType: 'access_grant', objectId: grantId, companyId, details: { taskId, employeeId, categoryIds } });
}

const zCategoryIds = z.array(z.number().int()).min(1).max(20).refine(
  (ids) => ids.every((c) => one('SELECT 1 FROM document_categories WHERE id = ?', [c])), 'Unknown category');

tasksRouter.post('/tasks/:id/access-requests', requireAuth, (req, res) => {
  const t = loadTask(req.user!, String(req.params.id));
  if (t.assignee_id !== req.user!.id) throw new HttpError(403, 'Only the assignee can request access.');
  requireStatus(t, 'assigned', 'in_progress', 'rework');
  const b = parse(z.object({ category_ids: zCategoryIds, reason: zText(1000).min(5, 'Say why you need these documents') }), req.body);
  const reqId = id();
  run(`INSERT INTO access_grants (id, task_id, employee_id, company_id, category_ids, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`,
  [reqId, t.id, req.user!.id, t.company_id, JSON.stringify(b.category_ids), b.reason, now()]);
  auditReq(req, { action: 'access.requested', objectType: 'access_grant', objectId: reqId, companyId: t.company_id, details: b });
  res.status(201).json({ id: reqId });
});

tasksRouter.get('/access-requests', requireRole('director', 'manager'), (req, res) => {
  const u = req.user!;
  const rows = all<Record<string, unknown> & { category_ids: string; reviewer_id: string; created_by: string }>(
    `SELECT g.id, g.task_id, g.category_ids, g.reason, g.created_at, t.title AS task_title, c.legal_name AS company,
            e.name AS employee, t.reviewer_id, t.created_by
     FROM access_grants g JOIN tasks t ON t.id = g.task_id JOIN companies c ON c.id = g.company_id JOIN users e ON e.id = g.employee_id
     WHERE g.status = 'requested' ORDER BY g.created_at`);
  res.json(rows
    .filter((r) => u.role === 'director' || r.reviewer_id === u.id || r.created_by === u.id)
    .map(({ reviewer_id, created_by, ...r }) => ({ ...r, category_ids: JSON.parse(r.category_ids) })));
});

tasksRouter.post('/access-requests/:id/decide', requireRole('director', 'manager'), (req, res) => {
  const g = one<{ id: string; task_id: string; status: string; category_ids: string; company_id: string }>(
    'SELECT id, task_id, status, category_ids, company_id FROM access_grants WHERE id = ?', [String(req.params.id)]);
  if (!g) throw new HttpError(404, 'Not found.');
  const t = loadTask(req.user!, g.task_id);
  if (!isTaskOwner(req.user!, t)) throw new HttpError(403, 'Only the assigning manager can decide.');
  if (g.status !== 'requested') throw new HttpError(409, 'This request was already decided.');
  const b = parse(z.object({
    decision: z.enum(['grant', 'reject']),
    category_ids: z.array(z.number().int()).optional(),
    note: zText(1000).optional(),
  }), req.body);
  const asked = JSON.parse(g.category_ids) as number[];
  // A manager may grant fewer categories than asked for, never more.
  const granted = b.category_ids ? b.category_ids.filter((c) => asked.includes(c)) : asked;
  if (b.decision === 'grant' && !granted.length) throw new HttpError(400, 'Pick at least one category to grant.');
  run(`UPDATE access_grants SET status = ?, category_ids = ?, decided_by = ?, decided_at = ?, decision_note = ?, expires_at = ? WHERE id = ?`,
    [b.decision === 'grant' ? 'granted' : 'rejected', JSON.stringify(b.decision === 'grant' ? granted : asked), req.user!.id, now(),
      b.note ?? null, b.decision === 'grant' ? new Date(Date.now() + config.accessGrantDays * 86400e3).toISOString() : null, g.id]);
  auditReq(req, { action: b.decision === 'grant' ? 'access.granted' : 'access.rejected', objectType: 'access_grant',
    objectId: g.id, companyId: g.company_id, details: { categories: granted } });
  res.json({ ok: true });
});

tasksRouter.post('/access-grants/:id/revoke', requireRole('director', 'manager'), (req, res) => {
  const g = one<{ id: string; task_id: string; company_id: string }>('SELECT id, task_id, company_id FROM access_grants WHERE id = ? AND status = ?', [String(req.params.id), 'granted']);
  if (!g) throw new HttpError(404, 'Not found.');
  const t = loadTask(req.user!, g.task_id);
  if (!isTaskOwner(req.user!, t)) throw new HttpError(403, 'Only the assigning manager can revoke.');
  run(`UPDATE access_grants SET status = 'revoked', decided_at = ? WHERE id = ?`, [now(), g.id]);
  auditReq(req, { action: 'access.revoked', objectType: 'access_grant', objectId: g.id, companyId: g.company_id });
  res.json({ ok: true });
});
