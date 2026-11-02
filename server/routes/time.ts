import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { inScope, loadTask } from '../authz.ts';
import { all, one, run, tx, now, id } from '../db.ts';
import { auditReq, parse, zDate, zId, zText } from '../http.ts';
import { HttpError, requireRole } from '../security/session.ts';
import { NON_TASK } from '../shared.ts';

export const timeRouter = Router();
timeRouter.use('/time', requireRole('director', 'manager', 'employee'));

/** Staff must have acknowledged the monitoring notice before any time is recorded. */
function requireAck(req: Request, _res: Response, next: NextFunction) {
  if (!req.user!.monitoring_notice_ack_at) return next(new HttpError(403, 'Please read and acknowledge the time-tracking notice first.', 'monitoring_ack_required'));
  next();
}

/** Worked seconds = wall time minus idle time. */
const WORKED = `MAX(0, (julianday(COALESCE(e.ended_at, e.last_heartbeat, e.started_at)) - julianday(e.started_at)) * 86400 - e.idle_seconds)`;

interface Running { id: string; task_id: string | null; category: string | null; started_at: string; last_heartbeat: string | null; idle_seconds: number }

function running(userId: string) {
  return one<Running>('SELECT id, task_id, category, started_at, last_heartbeat, idle_seconds FROM time_entries WHERE user_id = ? AND ended_at IS NULL', [userId]);
}

function stopRunning(req: Request, endAt = now()) {
  const r = running(req.user!.id);
  if (!r) return null;
  run('UPDATE time_entries SET ended_at = ? WHERE id = ?', [endAt, r.id]);
  auditReq(req, { action: 'time.stopped', objectType: 'time_entry', objectId: r.id });
  return r.id;
}

timeRouter.get('/time/current', (req, res) => {
  const r = running(req.user!.id);
  const task = r?.task_id ? one<{ title: string; company: string }>(
    'SELECT t.title, c.legal_name AS company FROM tasks t JOIN companies c ON c.id = t.company_id WHERE t.id = ?', [r.task_id]) : undefined;
  res.json({ running: r ? { ...r, task } : null, categories: NON_TASK, serverTime: now() });
});

timeRouter.post('/time/start', requireAck, (req, res) => {
  const b = parse(z.object({ task_id: zId.optional(), category: z.enum(NON_TASK).optional() })
    .refine((v) => !!v.task_id !== !!v.category, 'Choose a task or a non-task category'), req.body);
  if (b.task_id) {
    const t = loadTask(req.user!, b.task_id);
    if (['approved', 'cancelled', 'requested'].includes(t.status)) throw new HttpError(409, 'Time cannot be logged on this task now.');
    if (req.user!.role === 'employee' && t.assignee_id !== req.user!.id) throw new HttpError(403, 'You are not assigned to this task.');
  }
  const entryId = id();
  tx(() => {
    stopRunning(req); // only one timer at a time
    run(`INSERT INTO time_entries (id, user_id, task_id, category, started_at, last_heartbeat, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'timer', ?)`,
    [entryId, req.user!.id, b.task_id ?? null, b.category ?? null, now(), now(), now()]);
  });
  auditReq(req, { action: 'time.started', objectType: 'time_entry', objectId: entryId, details: b });
  res.status(201).json({ id: entryId });
});

timeRouter.post('/time/stop', (req, res) => {
  res.json({ stopped: stopRunning(req) });
});

/**
 * Sent every minute while a timer runs. `idle` is true when the browser saw no keyboard or mouse
 * activity for 15 minutes; that minute is then not counted. Gaps (laptop closed) are not counted either.
 */
timeRouter.post('/time/heartbeat', (req, res) => {
  const b = parse(z.object({ idle: z.boolean() }), req.body);
  const r = running(req.user!.id);
  if (!r) return res.json({ running: false });
  const t = Date.now();
  const since = Math.max(0, Math.round((t - Date.parse(r.last_heartbeat ?? r.started_at)) / 1000));
  const gap = since > 150 ? since - 60 : 0; // more than ~2 missed beats: treat the gap as away
  const idleAdd = (b.idle ? Math.min(since, 60) : 0) + gap;
  run('UPDATE time_entries SET last_heartbeat = ?, idle_seconds = idle_seconds + ? WHERE id = ?', [new Date(t).toISOString(), idleAdd, r.id]);
  res.json({ running: true });
});

timeRouter.post('/time/manual', requireAck, (req, res) => {
  const b = parse(z.object({
    task_id: zId.optional(),
    category: z.enum(NON_TASK).optional(),
    date: zDate,
    minutes: z.number().int().min(5).max(12 * 60),
    note: zText(500).min(3, 'Add a short note'),
  }).refine((v) => !!v.task_id !== !!v.category, 'Choose a task or a non-task category'), req.body);
  if (b.task_id) {
    const t = loadTask(req.user!, b.task_id);
    if (req.user!.role === 'employee' && t.assignee_id !== req.user!.id) throw new HttpError(403, 'You are not assigned to this task.');
  }
  const start = new Date(`${b.date}T09:00:00+05:30`);
  if (start.getTime() > Date.now() || start.getTime() < Date.now() - 14 * 86400e3) {
    throw new HttpError(400, 'Manual entries must be for the last 14 days.');
  }
  const end = new Date(start.getTime() + b.minutes * 60e3);
  const needsApproval = b.minutes > config.manualEntryApprovalHours * 60;
  const entryId = id();
  run(`INSERT INTO time_entries (id, user_id, task_id, category, started_at, ended_at, source, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
  [entryId, req.user!.id, b.task_id ?? null, b.category ?? null, start.toISOString(), end.toISOString(), b.note,
    needsApproval ? 'pending_approval' : 'ok', now()]);
  auditReq(req, { action: 'time.manual_entry', objectType: 'time_entry', objectId: entryId, details: { minutes: b.minutes, needsApproval } });
  res.status(201).json({ id: entryId, needsApproval });
});

const range = z.object({ from: zDate, to: zDate, user_id: zId.optional() });

timeRouter.get('/time/entries', (req, res) => {
  const q = parse(range, req.query);
  const u = req.user!;
  const userId = q.user_id && u.role !== 'employee' ? q.user_id : u.id;
  const rows = all(
    `SELECT e.id, e.task_id, t.title AS task, c.legal_name AS company, e.category, e.started_at, e.ended_at,
            e.source, e.note, e.status, CAST(${WORKED} AS INTEGER) AS seconds
     FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN companies c ON c.id = t.company_id
     WHERE e.user_id = ? AND e.started_at >= ? AND e.started_at < date(?, '+1 day')
     ORDER BY e.started_at DESC`, [userId, q.from, q.to]);
  res.json(rows);
});

/** Team report: hours per person and per client. Managers see their clients' task time; Directors see everything. */
timeRouter.get('/time/report', requireRole('director', 'manager'), (req, res) => {
  const q = parse(range.omit({ user_id: true }), req.query);
  const u = req.user!;
  const entries = all<{ user_id: string; name: string; company_id: string | null; company: string | null; seconds: number; status: string }>(
    `SELECT e.user_id, u.name, t.company_id, c.legal_name AS company, e.status, ${WORKED} AS seconds
     FROM time_entries e JOIN users u ON u.id = e.user_id
     LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN companies c ON c.id = t.company_id
     WHERE e.started_at >= ? AND e.started_at < date(?, '+1 day') AND e.status <> 'rejected'`, [q.from, q.to])
    .filter((e) => u.role === 'director' || (e.company_id !== null && inScope(u, e.company_id)));

  const byUser = new Map<string, { name: string; task: number; nonTask: number; pending: number }>();
  const byCompany = new Map<string, { company: string; seconds: number }>();
  for (const e of entries) {
    const p = byUser.get(e.user_id) ?? { name: e.name, task: 0, nonTask: 0, pending: 0 };
    if (e.status === 'pending_approval') p.pending += e.seconds;
    else if (e.company_id) p.task += e.seconds;
    else p.nonTask += e.seconds;
    byUser.set(e.user_id, p);
    if (e.company_id && e.status === 'ok') {
      const c = byCompany.get(e.company_id) ?? { company: e.company!, seconds: 0 };
      c.seconds += e.seconds;
      byCompany.set(e.company_id, c);
    }
  }
  const pending = all(
    `SELECT e.id, u.name, e.started_at, e.note, CAST(${WORKED} AS INTEGER) AS seconds, t.title AS task, e.category
     FROM time_entries e JOIN users u ON u.id = e.user_id LEFT JOIN tasks t ON t.id = e.task_id
     WHERE e.status = 'pending_approval' AND e.user_id <> ? ORDER BY e.started_at`, [u.id]);
  const overEstimate = all<{ company_id: string }>(
    `SELECT t.id, t.title, t.company_id, c.legal_name AS company, t.estimate_hours,
            (SELECT SUM(${WORKED}) FROM time_entries e WHERE e.task_id = t.id AND e.status = 'ok') / 3600.0 AS actual_hours
     FROM tasks t JOIN companies c ON c.id = t.company_id
     WHERE t.estimate_hours > 0 AND actual_hours >= t.estimate_hours * 1.25 ORDER BY actual_hours DESC LIMIT 50`)
    .filter((t) => u.role === 'director' || inScope(u, t.company_id));
  res.json({
    byUser: [...byUser.entries()].map(([user_id, v]) => ({ user_id, ...v })).sort((a, b) => b.task - a.task),
    byCompany: [...byCompany.entries()].map(([company_id, v]) => ({ company_id, ...v })).sort((a, b) => b.seconds - a.seconds),
    pending,
    overEstimate,
  });
});

timeRouter.post('/time/:id/decide', requireRole('director', 'manager'), (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'reject']) }), req.body);
  const e = one<{ id: string; user_id: string; task_id: string | null }>(
    `SELECT id, user_id, task_id FROM time_entries WHERE id = ? AND status = 'pending_approval'`, [String(req.params.id)]);
  if (!e) throw new HttpError(404, 'Not found.');
  if (e.user_id === req.user!.id) throw new HttpError(403, 'You cannot approve your own time.');
  if (req.user!.role === 'manager' && e.task_id) {
    const t = one<{ company_id: string }>('SELECT company_id FROM tasks WHERE id = ?', [e.task_id]);
    if (!t || !inScope(req.user!, t.company_id)) throw new HttpError(404, 'Not found.');
  }
  run('UPDATE time_entries SET status = ?, approved_by = ? WHERE id = ?', [b.decision === 'approve' ? 'ok' : 'rejected', req.user!.id, e.id]);
  auditReq(req, { action: `time.${b.decision}d`, objectType: 'time_entry', objectId: e.id });
  res.json({ ok: true });
});

/** Stops timers whose browser stopped sending heartbeats (laptop closed, tab killed), at their last activity. */
export function sweepStaleTimers() {
  const cutoff = new Date(Date.now() - config.timerStaleMinutes * 60e3).toISOString();
  run(`UPDATE time_entries SET ended_at = last_heartbeat WHERE ended_at IS NULL AND last_heartbeat < ?`, [cutoff]);
  // Hard stop at 21:00 IST.
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  if (ist.getUTCHours() >= 21) run(`UPDATE time_entries SET ended_at = COALESCE(last_heartbeat, ?) WHERE ended_at IS NULL`, [now()]);
}
