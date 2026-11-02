import { Router, type Request } from 'express';
import { z } from 'zod';
import { CLIENT_STATUS, TASK_TYPES, zDate, zId, zText } from '../shared.ts';
import { assertCompany, companyMap, companyScope, inScope, isTaskOwner, loadTask, userNames } from '../firestore/authz.ts';
import { listCategories } from '../firestore/documents.ts';
import { HttpError, auditReq, h, parse, requireAuth, requireRole } from '../firestore/http.ts';
import { getById, query } from '../firestore/store.ts';
import {
  TaskConflictError, approveTask, assignTask, cancelTask, createClientRequest, createTask, decideAccess, eventsForTask,
  grantsForTask, rejectTask, requestAccess, revokeGrant, startTask, submitTask,
} from '../firestore/tasks.ts';
import { taskSeconds, workedSeconds } from '../firestore/time.ts';
import { getUserById } from '../firestore/users.ts';
import { C, type AccessGrantDoc, type TaskDoc, type TaskStatus, type TimeEntryDoc } from '../firestore/types.ts';

export const tasksRouter = Router();

/** Runs a status change; a task that moved on in the meantime answers 409, like the SQLite build. */
async function transition(req: Request, t: TaskDoc, to: TaskStatus, run: () => Promise<void>) {
  try { await run(); } catch (e) {
    if (e instanceof TaskConflictError) throw new HttpError(409, e.message);
    throw e;
  }
  await auditReq(req, { action: `task.${to}`, objectType: 'task', objectId: t.id, companyId: t.company_id, details: { from: t.status } });
}

function requireStatus(t: TaskDoc, ...allowed: TaskStatus[]) {
  if (!allowed.includes(t.status)) throw new HttpError(409, `This task is ${t.status.replace('_', ' ')}; that action is not allowed now.`);
}

async function checkAssignee(assigneeId: string, reviewerId: string) {
  const [a, r] = await Promise.all([getUserById(assigneeId), getUserById(reviewerId)]);
  if (!a || !['employee', 'manager'].includes(a.role) || a.status !== 'active') throw new HttpError(400, 'Assignee must be an active employee or manager.');
  if (!r || !['manager', 'director'].includes(r.role) || r.status !== 'active') throw new HttpError(400, 'Reviewer must be an active manager or director.');
  // Segregation of duties: nobody approves their own work.
  if (assigneeId === reviewerId) throw new HttpError(400, 'The reviewer cannot be the same person as the assignee.');
}

const clientView = (t: TaskDoc, company: string | undefined) => ({
  id: t.id, company, type: t.type, title: t.title, period: t.period,
  status: CLIENT_STATUS[t.status], updated_at: t.updated_at, client_note: t.client_note,
});

/* ---------- Listing ---------- */

const STATUS_RANK: Partial<Record<TaskStatus, number>> = { approved: 2, cancelled: 3 };

tasksRouter.get('/tasks', requireAuth, h(async (req, res) => {
  const u = req.user!;
  const q = parse(z.object({
    view: z.enum(['mine', 'review', 'all', 'requests']).default('all'),
    status: z.string().max(20).optional(),
    company_id: zId.optional(),
  }), req.query);
  const mine = u.role === 'employee' || q.view === 'mine';
  // Narrowest single-field query first; the rest is filtered here.
  let rows = await query<TaskDoc>(C.tasks, {
    where: mine ? [['assignee_id', '==', u.id]]
      : q.view === 'review' ? [['status', '==', 'submitted']]
        : q.view === 'requests' ? [['status', '==', 'requested']]
          : q.company_id ? [['company_id', '==', q.company_id]] : [],
  });
  if (q.view === 'review') rows = rows.filter((t) => t.status === 'submitted' && (t.reviewer_id === u.id || u.role === 'director'));
  if (q.view === 'requests') rows = rows.filter((t) => t.status === 'requested');
  const scope = u.role === 'employee' ? null : await companyScope(u);
  if (scope) rows = rows.filter((t) => scope.includes(t.company_id));
  if (q.status) rows = rows.filter((t) => t.status === q.status);
  if (q.company_id) rows = rows.filter((t) => t.company_id === q.company_id);
  rows = rows.sort((a, b) => (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1)
    || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || b.updated_at.localeCompare(a.updated_at)).slice(0, 500);

  const companies = await companyMap();
  if (u.role === 'client') return res.json(rows.map((t) => clientView(t, companies.get(t.company_id)?.legal_name)));

  const [users, entries] = await Promise.all([
    userNames(),
    // shortcut: sums every approved time entry; fine for one firm, keep a per-task total if this grows slow.
    query<TimeEntryDoc>(C.timeEntries, { where: [['status', '==', 'ok']] }),
  ]);
  const logged = new Map<string, number>();
  for (const e of entries) if (e.task_id) logged.set(e.task_id, (logged.get(e.task_id) ?? 0) + workedSeconds(e));
  res.json(rows.map((t) => ({
    id: t.id, company_id: t.company_id, company: companies.get(t.company_id)?.legal_name, type: t.type, title: t.title,
    period: t.period, status: t.status, priority: t.priority, due_date: t.due_date, statutory_due: t.statutory_due,
    rework_count: t.rework_count, estimate_hours: t.estimate_hours, updated_at: t.updated_at, client_note: t.client_note,
    created_at: t.created_at, assignee: t.assignee_id ? users.get(t.assignee_id)?.name ?? null : null,
    reviewer: t.reviewer_id ? users.get(t.reviewer_id)?.name ?? null : null, assignee_id: t.assignee_id, reviewer_id: t.reviewer_id,
    seconds_logged: logged.get(t.id) ?? 0,
  })));
}));

tasksRouter.get('/tasks/meta', requireAuth, (_req, res) => res.json({ types: TASK_TYPES }));

tasksRouter.get('/tasks/:id', requireAuth, h(async (req, res) => {
  const u = req.user!;
  const t = await loadTask(u, String(req.params.id));
  const company = (await companyMap()).get(t.company_id);
  if (u.role === 'client') return res.json(clientView(t, company?.legal_name));
  const [users, events, grants, seconds] = await Promise.all([userNames(), eventsForTask(t.id), grantsForTask(t.id), taskSeconds(t.id)]);
  const name = (id: string | null) => (id ? users.get(id)?.name ?? null : null);
  res.json({
    ...t, company: company?.legal_name,
    assignee: name(t.assignee_id), reviewer: name(t.reviewer_id), creator: name(t.created_by),
    events: events.map((e) => ({ from_status: e.from_status, to_status: e.to_status, comment: e.comment, created_at: e.created_at, actor: name(e.actor_id) })),
    grants: grants.map((g) => ({
      id: g.id, category_ids: g.category_ids, reason: g.reason, status: g.status, expires_at: g.expires_at,
      decision_note: g.decision_note, created_at: g.created_at, decided_by_name: name(g.decided_by),
    })),
    seconds_logged: seconds,
    can: {
      start: t.assignee_id === u.id && ['assigned', 'rework'].includes(t.status),
      submit: t.assignee_id === u.id && t.status === 'in_progress',
      requestAccess: t.assignee_id === u.id && !['approved', 'cancelled', 'requested'].includes(t.status),
      review: isTaskOwner(u, t) && t.status === 'submitted' && t.assignee_id !== u.id,
      decideAccess: isTaskOwner(u, t),
      assign: t.status === 'requested' && (u.role === 'director' || (u.role === 'manager' && (await inScope(u, t.company_id)))),
      cancel: isTaskOwner(u, t) && !['approved', 'cancelled'].includes(t.status),
    },
  });
}));

/* ---------- Creating ---------- */

const zCategoryIds = z.array(z.string().trim().min(1).max(80)).max(20);

async function checkCategories(ids: string[]) {
  const known = new Set((await listCategories()).map((c) => c.id));
  if (!ids.every((c) => known.has(c))) throw new HttpError(400, 'category_ids: Unknown category');
}

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
  grant_category_ids: zCategoryIds.optional(),
});

tasksRouter.post('/tasks', requireRole('director', 'manager'), h(async (req, res) => {
  const b = parse(taskFields, req.body);
  await assertCompany(req.user!, b.company_id);
  const reviewerId = b.reviewer_id ?? req.user!.id;
  await checkAssignee(b.assignee_id, reviewerId);
  if (b.grant_category_ids?.length) await checkCategories(b.grant_category_ids);
  const taskId = await createTask({ ...b, reviewer_id: reviewerId, created_by: req.user!.id });
  if (b.grant_category_ids?.length) {
    const grantId = await requestAccess(taskId, b.assignee_id, b.company_id, b.grant_category_ids, 'Granted when the task was created');
    await decideAccess(grantId, req.user!.id, 'grant');
    await auditReq(req, { action: 'access.granted', objectType: 'access_grant', objectId: grantId, companyId: b.company_id,
      details: { taskId, employeeId: b.assignee_id, categoryIds: b.grant_category_ids } });
  }
  await auditReq(req, { action: 'task.created', objectType: 'task', objectId: taskId, companyId: b.company_id, details: { assignee: b.assignee_id } });
  res.status(201).json({ id: taskId });
}));

/** Clients raise a request; it waits for a manager to assign it. */
tasksRouter.post('/tasks/request', requireRole('client'), h(async (req, res) => {
  const b = parse(z.object({ company_id: zId, title: zText(200).min(3), details: zText(4000).optional() }), req.body);
  await assertCompany(req.user!, b.company_id);
  const taskId = await createClientRequest({ ...b, created_by: req.user!.id });
  await auditReq(req, { action: 'task.requested_by_client', objectType: 'task', objectId: taskId, companyId: b.company_id });
  res.status(201).json({ id: taskId });
}));

tasksRouter.post('/tasks/:id/assign', requireRole('director', 'manager'), h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  requireStatus(t, 'requested');
  const b = parse(taskFields.omit({ company_id: true, grant_category_ids: true }), req.body);
  const reviewerId = b.reviewer_id ?? req.user!.id;
  await checkAssignee(b.assignee_id, reviewerId);
  await transition(req, t, 'assigned', () => assignTask(t.id, req.user!.id, {
    type: b.type, title: b.title, period: b.period ?? null, instructions: b.instructions ?? null,
    assignee_id: b.assignee_id, reviewer_id: reviewerId, due_date: b.due_date ?? null,
    statutory_due: b.statutory_due ?? null, priority: b.priority, estimate_hours: b.estimate_hours ?? null,
  }));
  res.json({ ok: true });
}));

/* ---------- Workflow ---------- */

tasksRouter.post('/tasks/:id/start', requireAuth, h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  if (t.assignee_id !== req.user!.id) throw new HttpError(403, 'Only the assignee can start this task.');
  requireStatus(t, 'assigned', 'rework');
  await transition(req, t, 'in_progress', () => startTask(t.id, req.user!.id));
  res.json({ ok: true });
}));

tasksRouter.post('/tasks/:id/submit', requireAuth, h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  if (t.assignee_id !== req.user!.id) throw new HttpError(403, 'Only the assignee can submit this task.');
  requireStatus(t, 'in_progress');
  const b = parse(z.object({ note: zText(4000).min(5, 'Describe what was done') }), req.body);
  await transition(req, t, 'submitted', () => submitTask(t.id, req.user!.id, b.note));
  res.json({ ok: true });
}));

tasksRouter.post('/tasks/:id/approve', requireRole('director', 'manager'), h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  if (!isTaskOwner(req.user!, t) || t.assignee_id === req.user!.id) throw new HttpError(403, 'Only the assigning manager can approve.');
  requireStatus(t, 'submitted');
  const b = parse(z.object({ comment: zText(2000).optional(), client_note: zText(1000).optional() }), req.body);
  // Access is tied to the task: approving ends it, and stops any running timers on the task.
  await transition(req, t, 'approved', () => approveTask(t.id, req.user!.id, { comment: b.comment, clientNote: b.client_note }));
  res.json({ ok: true });
}));

tasksRouter.post('/tasks/:id/reject', requireRole('director', 'manager'), h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  if (!isTaskOwner(req.user!, t)) throw new HttpError(403, 'Only the assigning manager can reject.');
  requireStatus(t, 'submitted');
  const b = parse(z.object({ comment: zText(2000).min(5, 'Explain what needs fixing') }), req.body);
  await transition(req, t, 'rework', () => rejectTask(t.id, req.user!.id, b.comment));
  res.json({ ok: true });
}));

tasksRouter.post('/tasks/:id/cancel', requireRole('director', 'manager'), h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  if (!isTaskOwner(req.user!, t) && !(t.status === 'requested' && (await inScope(req.user!, t.company_id)))) {
    throw new HttpError(403, 'You cannot cancel this task.');
  }
  requireStatus(t, 'requested', 'assigned', 'in_progress', 'rework', 'submitted');
  const b = parse(z.object({ comment: zText(2000).min(3) }), req.body);
  await transition(req, t, 'cancelled', () => cancelTask(t.id, req.user!.id, b.comment));
  res.json({ ok: true });
}));

/* ---------- Document access ---------- */

tasksRouter.post('/tasks/:id/access-requests', requireAuth, h(async (req, res) => {
  const t = await loadTask(req.user!, String(req.params.id));
  if (t.assignee_id !== req.user!.id) throw new HttpError(403, 'Only the assignee can request access.');
  requireStatus(t, 'assigned', 'in_progress', 'rework');
  const b = parse(z.object({ category_ids: zCategoryIds.min(1), reason: zText(1000).min(5, 'Say why you need these documents') }), req.body);
  await checkCategories(b.category_ids);
  const reqId = await requestAccess(t.id, req.user!.id, t.company_id, b.category_ids, b.reason);
  await auditReq(req, { action: 'access.requested', objectType: 'access_grant', objectId: reqId, companyId: t.company_id, details: b });
  res.status(201).json({ id: reqId });
}));

tasksRouter.get('/access-requests', requireRole('director', 'manager'), h(async (req, res) => {
  const u = req.user!;
  const grants = await query<AccessGrantDoc>(C.accessGrants, { where: [['status', '==', 'requested']] });
  const [users, companies, tasks] = await Promise.all([
    userNames(), companyMap(), Promise.all(grants.map((g) => getById<TaskDoc>(C.tasks, g.task_id))),
  ]);
  res.json(grants
    .map((g, i) => ({ g, t: tasks[i] }))
    .filter(({ t }) => t && (u.role === 'director' || t.reviewer_id === u.id || t.created_by === u.id))
    .sort((a, b) => a.g.created_at.localeCompare(b.g.created_at))
    .map(({ g, t }) => ({
      id: g.id, task_id: g.task_id, category_ids: g.category_ids, reason: g.reason, created_at: g.created_at,
      task_title: t!.title, company: companies.get(g.company_id)?.legal_name, employee: users.get(g.employee_id)?.name,
    })));
}));

tasksRouter.post('/access-requests/:id/decide', requireRole('director', 'manager'), h(async (req, res) => {
  const g = await getById<AccessGrantDoc>(C.accessGrants, String(req.params.id));
  if (!g) throw new HttpError(404, 'Not found.');
  const t = await loadTask(req.user!, g.task_id);
  if (!isTaskOwner(req.user!, t)) throw new HttpError(403, 'Only the assigning manager can decide.');
  if (g.status !== 'requested') throw new HttpError(409, 'This request was already decided.');
  const b = parse(z.object({
    decision: z.enum(['grant', 'reject']),
    category_ids: z.array(z.string()).optional(),
    note: zText(1000).optional(),
  }), req.body);
  // A manager may grant fewer categories than asked for, never more.
  const granted = b.category_ids ? b.category_ids.filter((c) => g.category_ids.includes(c)) : g.category_ids;
  if (b.decision === 'grant' && !granted.length) throw new HttpError(400, 'Pick at least one category to grant.');
  await decideAccess(g.id, req.user!.id, b.decision, b.category_ids, b.note);
  await auditReq(req, { action: b.decision === 'grant' ? 'access.granted' : 'access.rejected', objectType: 'access_grant',
    objectId: g.id, companyId: g.company_id, details: { categories: granted } });
  res.json({ ok: true });
}));

tasksRouter.post('/access-grants/:id/revoke', requireRole('director', 'manager'), h(async (req, res) => {
  const g = await getById<AccessGrantDoc>(C.accessGrants, String(req.params.id));
  if (!g || g.status !== 'granted') throw new HttpError(404, 'Not found.');
  const t = await loadTask(req.user!, g.task_id);
  if (!isTaskOwner(req.user!, t)) throw new HttpError(403, 'Only the assigning manager can revoke.');
  await revokeGrant(g.id);
  await auditReq(req, { action: 'access.revoked', objectType: 'access_grant', objectId: g.id, companyId: g.company_id });
  res.json({ ok: true });
}));
