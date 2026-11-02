import { config } from '../config.ts';
import { db } from './client.ts';
import { getById, newId, now, query } from './store.ts';
import { C, type TimeEntryDoc } from './types.ts';

/** The day after a YYYY-MM-DD date, as YYYY-MM-DD (an exclusive upper bound for ISO timestamps). */
export const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);

/** Worked seconds = wall-clock from start to (end | last heartbeat | start), minus idle seconds. */
export function workedSeconds(e: TimeEntryDoc): number {
  const end = Date.parse(e.ended_at ?? e.last_heartbeat ?? e.started_at);
  return Math.max(0, Math.round((end - Date.parse(e.started_at)) / 1000) - e.idle_seconds);
}

const entries = () => db.collection(C.timeEntries);

export const getRunning = (userId: string) =>
  query<TimeEntryDoc>(C.timeEntries, { where: [['user_id', '==', userId], ['ended_at', '==', null]], limit: 1 }).then((r) => r[0]);

/** Stops the user's running timer, if any, at its last activity. Returns the stopped entry id. */
export async function stopRunning(userId: string, endAt = now()): Promise<string | null> {
  const r = await getRunning(userId);
  if (!r) return null;
  await entries().doc(r.id).update({ ended_at: endAt });
  return r.id;
}

/** Starts a timer on a task or a non-task category. Only one timer runs per user (the previous is stopped). */
export async function startTimer(userId: string, target: { taskId?: string; category?: string }): Promise<string> {
  await stopRunning(userId);
  const id = newId();
  const e: TimeEntryDoc = {
    id, user_id: userId, task_id: target.taskId ?? null, category: target.category ?? null,
    started_at: now(), ended_at: null, last_heartbeat: now(), idle_seconds: 0,
    source: 'timer', note: null, status: 'ok', approved_by: null, created_at: now(),
  };
  await entries().doc(id).set(e);
  return id;
}

/**
 * A beat sent each minute while a timer runs. `idle` true means no input for 15 min, so that minute isn't
 * counted; a long gap (laptop asleep) is treated as away too.
 */
export async function heartbeat(userId: string, idle: boolean): Promise<boolean> {
  const r = await getRunning(userId);
  if (!r) return false;
  const t = Date.now();
  const since = Math.max(0, Math.round((t - Date.parse(r.last_heartbeat ?? r.started_at)) / 1000));
  const gap = since > 150 ? since - 60 : 0;
  const idleAdd = (idle ? Math.min(since, 60) : 0) + gap;
  await entries().doc(r.id).update({ last_heartbeat: new Date(t).toISOString(), idle_seconds: r.idle_seconds + idleAdd });
  return true;
}

/** Manual entry for work done off the portal. Over the configured limit it needs manager approval. */
export async function addManualEntry(i: { userId: string; taskId?: string; category?: string; date: string; minutes: number; note: string }): Promise<{ id: string; needsApproval: boolean }> {
  const start = new Date(`${i.date}T09:00:00+05:30`);
  const end = new Date(start.getTime() + i.minutes * 60e3);
  const needsApproval = i.minutes > config.manualEntryApprovalHours * 60;
  const id = newId();
  const e: TimeEntryDoc = {
    id, user_id: i.userId, task_id: i.taskId ?? null, category: i.category ?? null,
    started_at: start.toISOString(), ended_at: end.toISOString(), last_heartbeat: null, idle_seconds: 0,
    source: 'manual', note: i.note, status: needsApproval ? 'pending_approval' : 'ok', approved_by: null, created_at: now(),
  };
  await entries().doc(id).set(e);
  return { id, needsApproval };
}

export async function decideManualEntry(id: string, deciderId: string, decision: 'approve' | 'reject'): Promise<void> {
  const e = await getById<TimeEntryDoc>(C.timeEntries, id);
  if (!e || e.status !== 'pending_approval') throw new Error('Not found.');
  await entries().doc(id).update({ status: decision === 'approve' ? 'ok' : 'rejected', approved_by: deciderId });
}

/** Entries for a user in a date range (inclusive), newest first. */
export async function listEntries(userId: string, from: string, to: string): Promise<TimeEntryDoc[]> {
  const rows = await query<TimeEntryDoc>(C.timeEntries, { where: [['user_id', '==', userId]] });
  const before = nextDay(to);
  return rows.filter((e) => e.started_at >= from && e.started_at < before).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** Seconds logged on a task (approved/ok entries only). */
export async function taskSeconds(taskId: string): Promise<number> {
  const rows = await query<TimeEntryDoc>(C.timeEntries, { where: [['task_id', '==', taskId], ['status', '==', 'ok']] });
  return rows.reduce((s, e) => s + workedSeconds(e), 0);
}

/** Stops timers whose browser stopped sending heartbeats (closed laptop/tab), at their last activity. */
export async function sweepStaleTimers(): Promise<void> {
  const cutoff = new Date(Date.now() - config.timerStaleMinutes * 60e3).toISOString();
  const running = await query<TimeEntryDoc>(C.timeEntries, { where: [['ended_at', '==', null]] });
  const lateIst = new Date(Date.now() + 5.5 * 3600e3).getUTCHours() >= 21; // hard stop at 21:00 IST
  await Promise.all(running.filter((e) => lateIst || (e.last_heartbeat ?? e.started_at) < cutoff)
    .map((e) => entries().doc(e.id).update({ ended_at: e.last_heartbeat ?? e.started_at })));
}
