import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { NON_TASK, zDate, zId, zText } from '../shared.ts';
import { companyMap, inScope, loadTask, userNames } from '../firestore/authz.ts';
import { HttpError, auditReq, h, parse, requireRole } from '../firestore/http.ts';
import { getById, query } from '../firestore/store.ts';
import { addManualEntry, decideManualEntry, getRunning, heartbeat, listEntries, nextDay, startTimer, stopRunning, workedSeconds } from '../firestore/time.ts';
import { C, type TaskDoc, type TimeEntryDoc } from '../firestore/types.ts';

export const timeRouter = Router();
timeRouter.use('/time', requireRole('director', 'manager', 'employee'));

/** Staff must have acknowledged the monitoring notice before any time is recorded. */
function requireAck(req: Request, _res: Response, next: NextFunction) {
  if (!req.user!.monitoring_notice_ack_at) return next(new HttpError(403, 'Please read and acknowledge the time-tracking notice first.', 'monitoring_ack_required'));
  next();
}

async function stop(req: Request) {
  const stopped = await stopRunning(req.user!.id);
  if (stopped) await auditReq(req, { action: 'time.stopped', objectType: 'time_entry', objectId: stopped });
  return stopped;
}

const target = z.object({ task_id: zId.optional(), category: z.enum(NON_TASK).optional() });
const oneTarget = (v: { task_id?: string; category?: string }) => !!v.task_id !== !!v.category;

timeRouter.get('/time/current', h(async (req, res) => {
  const r = await getRunning(req.user!.id);
  let task: { title: string; company: string | undefined } | undefined;
  if (r?.task_id) {
    const t = await getById<TaskDoc>(C.tasks, r.task_id);
    if (t) task = { title: t.title, company: (await companyMap()).get(t.company_id)?.legal_name };
  }
  res.json({
    running: r ? { id: r.id, task_id: r.task_id, category: r.category, started_at: r.started_at, last_heartbeat: r.last_heartbeat, idle_seconds: r.idle_seconds, task } : null,
    categories: NON_TASK, serverTime: new Date().toISOString(),
  });
}));

timeRouter.post('/time/start', requireAck, h(async (req, res) => {
  const b = parse(target.refine(oneTarget, 'Choose a task or a non-task category'), req.body);
  if (b.task_id) {
    const t = await loadTask(req.user!, b.task_id);
    if (['approved', 'cancelled', 'requested'].includes(t.status)) throw new HttpError(409, 'Time cannot be logged on this task now.');
    if (req.user!.role === 'employee' && t.assignee_id !== req.user!.id) throw new HttpError(403, 'You are not assigned to this task.');
  }
  await stop(req); // only one timer at a time
  const entryId = await startTimer(req.user!.id, { taskId: b.task_id, category: b.category });
  await auditReq(req, { action: 'time.started', objectType: 'time_entry', objectId: entryId, details: b });
  res.status(201).json({ id: entryId });
}));

timeRouter.post('/time/stop', h(async (req, res) => {
  res.json({ stopped: await stop(req) });
}));

/** Sent every minute while a timer runs; idle minutes and gaps (laptop closed) are not counted. */
timeRouter.post('/time/heartbeat', h(async (req, res) => {
  const b = parse(z.object({ idle: z.boolean() }), req.body);
  res.json({ running: await heartbeat(req.user!.id, b.idle) });
}));

timeRouter.post('/time/manual', requireAck, h(async (req, res) => {
  const b = parse(target.extend({
    date: zDate,
    minutes: z.number().int().min(5).max(12 * 60),
    note: zText(500).min(3, 'Add a short note'),
  }).refine(oneTarget, 'Choose a task or a non-task category'), req.body);
  if (b.task_id) {
    const t = await loadTask(req.user!, b.task_id);
    if (req.user!.role === 'employee' && t.assignee_id !== req.user!.id) throw new HttpError(403, 'You are not assigned to this task.');
  }
  const start = new Date(`${b.date}T09:00:00+05:30`).getTime();
  if (start > Date.now() || start < Date.now() - 14 * 86400e3) throw new HttpError(400, 'Manual entries must be for the last 14 days.');
  const r = await addManualEntry({ userId: req.user!.id, taskId: b.task_id, category: b.category, date: b.date, minutes: b.minutes, note: b.note });
  await auditReq(req, { action: 'time.manual_entry', objectType: 'time_entry', objectId: r.id, details: { minutes: b.minutes, needsApproval: r.needsApproval } });
  res.status(201).json(r);
}));

const range = z.object({ from: zDate, to: zDate, user_id: zId.optional() });

/** Task title and company name for each entry's task. */
async function taskInfo(entries: TimeEntryDoc[]) {
  const ids = [...new Set(entries.map((e) => e.task_id).filter((id): id is string => !!id))];
  const [tasks, companies] = await Promise.all([Promise.all(ids.map((id) => getById<TaskDoc>(C.tasks, id))), companyMap()]);
  const map = new Map<string, { title: string; company_id: string; company: string | null; estimate_hours: number | null }>();
  tasks.forEach((t) => t && map.set(t.id, { title: t.title, company_id: t.company_id, company: companies.get(t.company_id)?.legal_name ?? null, estimate_hours: t.estimate_hours }));
  return map;
}

timeRouter.get('/time/entries', h(async (req, res) => {
  const q = parse(range, req.query);
  const u = req.user!;
  const userId = q.user_id && u.role !== 'employee' ? q.user_id : u.id;
  const entries = await listEntries(userId, q.from, q.to);
  const tasks = await taskInfo(entries);
  res.json(entries.map((e) => ({
    id: e.id, task_id: e.task_id, task: e.task_id ? tasks.get(e.task_id)?.title ?? null : null,
    company: e.task_id ? tasks.get(e.task_id)?.company ?? null : null, category: e.category,
    started_at: e.started_at, ended_at: e.ended_at, source: e.source, note: e.note, status: e.status, seconds: workedSeconds(e),
  })));
}));

/** Team report: hours per person and per client. Managers see their clients' task time; Directors see everything. */
timeRouter.get('/time/report', requireRole('director', 'manager'), h(async (req, res) => {
  const q = parse(range.omit({ user_id: true }), req.query);
  const u = req.user!;
  const [inRange, pendingAll, okAll, users] = await Promise.all([
    query<TimeEntryDoc>(C.timeEntries, { where: [['started_at', '>=', q.from], ['started_at', '<', nextDay(q.to)]] }),
    query<TimeEntryDoc>(C.timeEntries, { where: [['status', '==', 'pending_approval']] }),
    // shortcut: every approved entry, to compare tasks with their estimates; keep per-task totals if this grows slow.
    query<TimeEntryDoc>(C.timeEntries, { where: [['status', '==', 'ok']] }),
    userNames(),
  ]);
  const entries = inRange.filter((e) => e.status !== 'rejected');
  const tasks = await taskInfo([...entries, ...pendingAll, ...okAll]);
  const visible: TimeEntryDoc[] = [];
  for (const e of entries) {
    const companyId = e.task_id ? tasks.get(e.task_id)?.company_id : undefined;
    if (u.role === 'director' || (companyId && (await inScope(u, companyId)))) visible.push(e);
  }

  const byUser = new Map<string, { name: string; task: number; nonTask: number; pending: number }>();
  const byCompany = new Map<string, { company: string; seconds: number }>();
  for (const e of visible) {
    const seconds = workedSeconds(e);
    const task = e.task_id ? tasks.get(e.task_id) : undefined;
    const p = byUser.get(e.user_id) ?? { name: users.get(e.user_id)?.name ?? '', task: 0, nonTask: 0, pending: 0 };
    if (e.status === 'pending_approval') p.pending += seconds;
    else if (task) p.task += seconds;
    else p.nonTask += seconds;
    byUser.set(e.user_id, p);
    if (task && e.status === 'ok') {
      const c = byCompany.get(task.company_id) ?? { company: task.company ?? '', seconds: 0 };
      c.seconds += seconds;
      byCompany.set(task.company_id, c);
    }
  }
  const pending = pendingAll.filter((e) => e.user_id !== u.id).sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((e) => ({ id: e.id, name: users.get(e.user_id)?.name ?? '', started_at: e.started_at, note: e.note,
      seconds: workedSeconds(e), task: e.task_id ? tasks.get(e.task_id)?.title ?? null : null, category: e.category }));

  const actual = new Map<string, number>();
  for (const e of okAll) if (e.task_id) actual.set(e.task_id, (actual.get(e.task_id) ?? 0) + workedSeconds(e) / 3600);
  const overEstimate = [];
  for (const [id, hours] of actual) {
    const t = tasks.get(id);
    if (!t?.estimate_hours || hours < t.estimate_hours * 1.25) continue;
    if (u.role !== 'director' && !(await inScope(u, t.company_id))) continue;
    overEstimate.push({ id, title: t.title, company_id: t.company_id, company: t.company, estimate_hours: t.estimate_hours, actual_hours: hours });
  }
  res.json({
    byUser: [...byUser.entries()].map(([user_id, v]) => ({ user_id, ...v })).sort((a, b) => b.task - a.task),
    byCompany: [...byCompany.entries()].map(([company_id, v]) => ({ company_id, ...v })).sort((a, b) => b.seconds - a.seconds),
    pending,
    overEstimate: overEstimate.sort((a, b) => b.actual_hours - a.actual_hours).slice(0, 50),
  });
}));

timeRouter.post('/time/:id/decide', requireRole('director', 'manager'), h(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'reject']) }), req.body);
  const e = await getById<TimeEntryDoc>(C.timeEntries, String(req.params.id));
  if (!e || e.status !== 'pending_approval') throw new HttpError(404, 'Not found.');
  if (e.user_id === req.user!.id) throw new HttpError(403, 'You cannot approve your own time.');
  if (req.user!.role === 'manager' && e.task_id) {
    const t = await getById<TaskDoc>(C.tasks, e.task_id);
    if (!t || !(await inScope(req.user!, t.company_id))) throw new HttpError(404, 'Not found.');
  }
  await decideManualEntry(e.id, req.user!.id, b.decision);
  await auditReq(req, { action: `time.${b.decision}d`, objectType: 'time_entry', objectId: e.id });
  res.json({ ok: true });
}));
