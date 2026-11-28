import { Router } from 'express';
import { z } from 'zod';
import { zDate, zId } from '../shared.ts';
import { assertCompany, companyMap, userNames } from '../firestore/authz.ts';
import { HttpError, auditReq, h, parse, requireRole } from '../firestore/http.ts';
import { getById } from '../firestore/store.ts';
import {
  TakenError, createSchedule, endSchedule, listSchedules, rangeProblem, runOn, takeRun, takesFor, todayIst, type ScheduleDoc,
} from '../firestore/schedules.ts';
import { C } from '../firestore/types.ts';
import { taskName } from './master.ts';

/** Scheduled tasks: directors and managers set them up; the whole team sees them while on, and anyone may take one. */
export const schedulesRouter = Router();
const team = requireRole('director', 'manager', 'employee');
const planners = requireRole('director', 'manager');

/** Every active schedule with its current (or next) run and who took that run. Every staff member sees all of them. */
export async function scheduleRows() {
  const today = todayIst();
  const [rows, companies, users] = await Promise.all([listSchedules(), companyMap(), userNames()]);
  const runs = rows.filter((s) => companies.has(s.company_id)).map((s) => ({ s, run: runOn(s, today) }));
  const taken = await takesFor(runs.map(({ s, run }) => `${s.id}_${run.start}`));
  return runs.map(({ s, run }) => {
    const t = taken.get(`${s.id}_${run.start}`);
    return {
      id: s.id, company_id: s.company_id, company: companies.get(s.company_id)?.legal_name ?? '', task: s.task ?? '', repeat: s.repeat,
      run, live: run.start <= today, created_by_name: users.get(s.created_by)?.name ?? '',
      taken: t ? { by: t.taken_by, name: users.get(t.taken_by)?.name ?? '', at: t.taken_at } : null,
    };
  }).sort((a, b) => a.run.start.localeCompare(b.run.start) || a.company.localeCompare(b.company));
}

schedulesRouter.get('/schedules', team, h(async (_req, res) => { res.json(await scheduleRows()); }));

schedulesRouter.post('/schedules', planners, h(async (req, res) => {
  const b = parse(z.object({ company_id: zId, task_name_id: z.string().max(100), start: zDate, end: zDate, repeat: z.enum(['monthly', 'yearly']) }), req.body);
  await assertCompany(req.user!, b.company_id); // a manager limited to some clients schedules only those
  const problem = rangeProblem(b.start, b.end, b.repeat);
  if (problem) throw new HttpError(400, problem);
  const task = await taskName(b.task_name_id);
  const id = await createSchedule({ companyId: b.company_id, task, start: b.start, end: b.end, repeat: b.repeat, createdBy: req.user!.id });
  await auditReq(req, { action: 'schedule.created', objectType: 'schedule', objectId: id, companyId: b.company_id, details: { task, start: b.start, end: b.end, repeat: b.repeat } });
  res.status(201).json({ id });
}));

async function loadSchedule(id: string): Promise<ScheduleDoc> {
  const s = await getById<ScheduleDoc>(C.schedules, id);
  if (!s || !s.active) throw new HttpError(404, 'Not found.');
  return s;
}

/** Takes the current run, or the next one if none is on yet. */
schedulesRouter.post('/schedules/:id/take', team, h(async (req, res) => {
  const s = await loadSchedule(String(req.params.id));
  const run = runOn(s, todayIst());
  try {
    await takeRun(s.id, run, req.user!.id);
  } catch (e) {
    if (e instanceof TakenError) throw new HttpError(409, 'Someone has already taken this one.');
    throw e;
  }
  await auditReq(req, { action: 'schedule.taken', objectType: 'schedule', objectId: s.id, companyId: s.company_id, details: { ...run } });
  res.json({ ok: true, run });
}));

/** Stops a schedule; runs already taken stay on record. */
schedulesRouter.delete('/schedules/:id', planners, h(async (req, res) => {
  const s = await loadSchedule(String(req.params.id));
  await assertCompany(req.user!, s.company_id);
  await endSchedule(s.id, req.user!.id);
  await auditReq(req, { action: 'schedule.ended', objectType: 'schedule', objectId: s.id, companyId: s.company_id });
  res.json({ ok: true });
}));
