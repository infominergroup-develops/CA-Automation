import { db } from './client.ts';
import { newId, now, query } from './store.ts';
import { C } from './types.ts';

/**
 * Scheduled tasks: a director or manager names a client and a date range that comes back every month or year.
 * While a run's dates are on, the whole team sees it, and the first person to take it has it for that run.
 */
export type Repeat = 'monthly' | 'yearly';
export interface ScheduleDoc {
  id: string; company_id: string; repeat: Repeat;
  /** From the task names in Masters, kept as written then. Older schedules have none. */
  task?: string;
  /** Which of the client's GST registrations (state) it is for, if one. */
  gstin?: string | null;
  /** The first run, YYYY-MM-DD, both days included. Later runs keep the same days of the month. */
  start: string; end: string;
  active: boolean; created_by: string; created_at: string; ended_by?: string; ended_at?: string;
}
/** One per run that someone took; the id is `<schedule id>_<run start>`, so a run can be taken only once. */
export interface ScheduleTakeDoc { id: string; schedule_id: string; start: string; end: string; taken_by: string; taken_at: string }
export interface Run { start: string; end: string }

/** Today's date in India, where the firm works. */
export const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

/** The same day `n` months later; the 31st becomes the last day of a shorter month. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

const step = (r: Repeat) => (r === 'monthly' ? 1 : 12);

/** Why a range cannot repeat, or null: it must end on or after it starts and be shorter than one repeat. */
export function rangeProblem(start: string, end: string, repeat: Repeat): string | null {
  if (end < start) return 'The end date is before the start date.';
  if (end >= addMonths(start, step(repeat))) return repeat === 'monthly' ? 'A monthly task must last less than a month.' : 'A yearly task must last less than a year.';
  return null;
}

/** The run that covers `day`, or the next one if none does. */
export function runOn(s: Pick<ScheduleDoc, 'start' | 'end' | 'repeat'>, day: string): Run {
  let k = 0;
  while (addMonths(s.end, k * step(s.repeat)) < day) k++; // shortcut: one step per run; fine for decades of monthly runs
  return { start: addMonths(s.start, k * step(s.repeat)), end: addMonths(s.end, k * step(s.repeat)) };
}

export async function createSchedule(b: { companyId: string; task: string; gstin?: string; start: string; end: string; repeat: Repeat; createdBy: string }): Promise<string> {
  const id = newId();
  const doc: ScheduleDoc = { id, company_id: b.companyId, task: b.task, gstin: b.gstin ?? null, repeat: b.repeat, start: b.start, end: b.end, active: true, created_by: b.createdBy, created_at: now() };
  await db.collection(C.schedules).doc(id).set(doc);
  return id;
}

export const listSchedules = () => query<ScheduleDoc>(C.schedules, { where: [['active', '==', true]] });

export async function endSchedule(id: string, by: string): Promise<void> {
  await db.collection(C.schedules).doc(id).update({ active: false, ended_by: by, ended_at: now() });
}

export class TakenError extends Error {}

/** Takes one run. Created in one step, so two people pressing at once cannot both get it. */
export async function takeRun(scheduleId: string, run: Run, userId: string): Promise<void> {
  const id = `${scheduleId}_${run.start}`;
  const doc: ScheduleTakeDoc = { id, schedule_id: scheduleId, start: run.start, end: run.end, taken_by: userId, taken_at: now() };
  try {
    await db.collection(C.scheduleTakes).doc(id).create(doc);
  } catch (e) {
    if ((e as { code?: number }).code === 6) throw new TakenError(); // ALREADY_EXISTS
    throw e;
  }
}

/**
 * Clients this person may open because they took a run of a scheduled task: from taking it until the run's last day,
 * and only while the schedule still runs.
 */
export async function takenCompanyIds(userId: string): Promise<string[]> {
  const today = todayIst();
  const takes = (await query<ScheduleTakeDoc>(C.scheduleTakes, { where: [['taken_by', '==', userId]] })).filter((t) => t.end >= today);
  if (!takes.length) return [];
  const snaps = await db.getAll(...[...new Set(takes.map((t) => t.schedule_id))].map((id) => db.collection(C.schedules).doc(id)));
  return snaps.map((s) => s.data() as ScheduleDoc | undefined).filter((s) => s?.active).map((s) => s!.company_id);
}

/** Who took each of these runs, keyed `<schedule id>_<run start>`. */
export async function takesFor(keys: string[]): Promise<Map<string, ScheduleTakeDoc>> {
  if (!keys.length) return new Map();
  const snaps = await db.getAll(...keys.map((k) => db.collection(C.scheduleTakes).doc(k)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, { id: s.id, ...s.data() } as ScheduleTakeDoc]));
}
