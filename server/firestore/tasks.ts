import { config } from '../config.ts';
import { db } from './client.ts';
import { getById, newId, now, query, txn } from './store.ts';
import { C, type AccessGrantDoc, type TaskDoc, type TaskEventDoc, type TaskStatus } from './types.ts';

/** Statuses where work is still live (an employee may hold document access). */
export const OPEN_STATUSES: TaskStatus[] = ['requested', 'assigned', 'in_progress', 'submitted', 'rework'];
const isOpen = (s: TaskStatus) => OPEN_STATUSES.includes(s);

export class TaskConflictError extends Error {
  constructor(public current: TaskStatus) { super(`Task is ${current.replace('_', ' ')}; that action is not allowed now.`); }
}

const tasks = () => db.collection(C.tasks);
const events = (taskId: string) => tasks().doc(taskId).collection('events');

export const getTask = (id: string) => getById<TaskDoc>(C.tasks, id);

export interface NewTask {
  company_id: string; type: string; title: string; period?: string; instructions?: string;
  assignee_id: string; reviewer_id: string; created_by: string;
  due_date?: string; statutory_due?: string; priority?: TaskDoc['priority']; estimate_hours?: number;
}

export async function createTask(t: NewTask): Promise<string> {
  const id = newId();
  const doc: TaskDoc = {
    id, company_id: t.company_id, type: t.type, title: t.title, period: t.period ?? null, instructions: t.instructions ?? null,
    assignee_id: t.assignee_id, reviewer_id: t.reviewer_id, created_by: t.created_by,
    due_date: t.due_date ?? null, statutory_due: t.statutory_due ?? null, priority: t.priority ?? 'normal',
    status: 'assigned', estimate_hours: t.estimate_hours ?? null, rework_count: 0,
    submission_note: null, client_note: null, created_at: now(), updated_at: now(), submitted_at: null, approved_at: null,
  };
  await tasks().doc(id).set(doc);
  await events(id).doc(newId()).set({ from_status: null, to_status: 'assigned', actor_id: t.created_by, comment: null, created_at: now() });
  return id;
}

/** A client raises a request; it waits in 'requested' for a manager to assign it. */
export async function createClientRequest(c: { company_id: string; title: string; details?: string; created_by: string }): Promise<string> {
  const id = newId();
  const doc: TaskDoc = {
    id, company_id: c.company_id, type: 'Other', title: c.title, period: null, instructions: c.details ?? null,
    assignee_id: null, reviewer_id: null, created_by: c.created_by, due_date: null, statutory_due: null,
    priority: 'normal', status: 'requested', estimate_hours: null, rework_count: 0,
    submission_note: null, client_note: null, created_at: now(), updated_at: now(), submitted_at: null, approved_at: null,
  };
  await tasks().doc(id).set(doc);
  await events(id).doc(newId()).set({ from_status: null, to_status: 'requested', actor_id: c.created_by, comment: null, created_at: now() });
  return id;
}

/** Moves a task to a new status, guarding the allowed from-states and recording an event — atomically. */
async function transition(taskId: string, from: TaskStatus[], to: TaskStatus, actorId: string, comment?: string, patch: Partial<TaskDoc> = {}): Promise<void> {
  await txn(async (t) => {
    const ref = tasks().doc(taskId);
    const snap = await t.get(ref);
    if (!snap.exists) throw new Error('Task not found.');
    const cur = snap.data() as TaskDoc;
    if (!from.includes(cur.status)) throw new TaskConflictError(cur.status);
    t.update(ref, { status: to, updated_at: now(), ...patch });
    t.set(events(taskId).doc(newId()), { from_status: cur.status, to_status: to, actor_id: actorId, comment: comment ?? null, created_at: now() });
  });
}

export const assignTask = (taskId: string, actorId: string, fields: Partial<TaskDoc>) =>
  transition(taskId, ['requested'], 'assigned', actorId, undefined, fields);
export const startTask = (taskId: string, actorId: string) =>
  transition(taskId, ['assigned', 'rework'], 'in_progress', actorId);
export const submitTask = (taskId: string, actorId: string, note: string) =>
  transition(taskId, ['in_progress'], 'submitted', actorId, note, { submission_note: note, submitted_at: now() });
export const rejectTask = async (taskId: string, actorId: string, comment: string) => {
  const task = await getTask(taskId);
  return transition(taskId, ['submitted'], 'rework', actorId, comment, { rework_count: (task?.rework_count ?? 0) + 1 });
};

/** Approving closes the task, ends the employee's document access, and stops any running timers on it. */
export async function approveTask(taskId: string, actorId: string, opts: { comment?: string; clientNote?: string } = {}): Promise<void> {
  await transition(taskId, ['submitted'], 'approved', actorId, opts.comment, { approved_at: now(), client_note: opts.clientNote ?? null });
  await revokeGrantsForTask(taskId, 'Task approved');
  await stopTimersForTask(taskId);
}

export async function cancelTask(taskId: string, actorId: string, comment: string): Promise<void> {
  await transition(taskId, ['requested', 'assigned', 'in_progress', 'rework', 'submitted'], 'cancelled', actorId, comment);
  await revokeGrantsForTask(taskId, 'Task cancelled');
  await stopTimersForTask(taskId);
}

/* ---------------- Document access grants ---------------- */

export async function requestAccess(taskId: string, employeeId: string, companyId: string, categoryIds: string[], reason: string): Promise<string> {
  const task = await getTask(taskId);
  if (!task || !['assigned', 'in_progress', 'rework'].includes(task.status)) throw new TaskConflictError(task?.status ?? 'cancelled');
  const id = newId();
  const g: AccessGrantDoc = {
    id, task_id: taskId, employee_id: employeeId, company_id: companyId, category_ids: categoryIds, reason,
    status: 'requested', decided_by: null, decided_at: null, decision_note: null, expires_at: null, created_at: now(),
  };
  await db.collection(C.accessGrants).doc(id).set(g);
  return id;
}

/** Grant (optionally a subset of what was asked) or reject. A manager can never grant more than requested. */
export async function decideAccess(grantId: string, deciderId: string, decision: 'grant' | 'reject', categoryIds?: string[], note?: string): Promise<void> {
  const g = await getById<AccessGrantDoc>(C.accessGrants, grantId);
  if (!g || g.status !== 'requested') throw new Error('This request was already decided.');
  const granted = decision === 'grant' ? (categoryIds ? categoryIds.filter((c) => g.category_ids.includes(c)) : g.category_ids) : g.category_ids;
  if (decision === 'grant' && granted.length === 0) throw new Error('Pick at least one category to grant.');
  await db.collection(C.accessGrants).doc(grantId).update({
    status: decision === 'grant' ? 'granted' : 'rejected',
    category_ids: granted,
    decided_by: deciderId,
    decided_at: now(),
    decision_note: note ?? null,
    expires_at: decision === 'grant' ? new Date(Date.now() + config.accessGrantDays * 86400e3).toISOString() : null,
  });
}

export async function revokeGrant(grantId: string): Promise<void> {
  await db.collection(C.accessGrants).doc(grantId).update({ status: 'revoked', decided_at: now() });
}

async function revokeGrantsForTask(taskId: string, note: string): Promise<void> {
  const grants = await query<AccessGrantDoc>(C.accessGrants, { where: [['task_id', '==', taskId]] });
  await Promise.all(grants.filter((g) => g.status === 'requested' || g.status === 'granted')
    .map((g) => db.collection(C.accessGrants).doc(g.id).update({ status: 'revoked', decided_at: now(), decision_note: g.decision_note ?? note })));
}

async function stopTimersForTask(taskId: string): Promise<void> {
  const running = await query<{ id: string; last_heartbeat: string | null }>(C.timeEntries, { where: [['task_id', '==', taskId], ['ended_at', '==', null]] });
  await Promise.all(running.map((e) => db.collection(C.timeEntries).doc(e.id).update({ ended_at: e.last_heartbeat ?? now() })));
}

/**
 * The document categories an employee may currently open for a company: granted, unexpired grants, on an
 * OPEN task assigned to them. This is the core access rule — approving a task drops the grant, so access ends.
 */
export async function employeeCategories(employeeId: string, companyId: string): Promise<Set<string>> {
  const grants = await query<AccessGrantDoc>(C.accessGrants, {
    where: [['employee_id', '==', employeeId], ['company_id', '==', companyId], ['status', '==', 'granted']],
  });
  const out = new Set<string>();
  const nowIso = now();
  for (const g of grants) {
    if (!g.expires_at || g.expires_at <= nowIso) continue;
    const task = await getTask(g.task_id);
    if (task && isOpen(task.status) && task.assignee_id === employeeId) g.category_ids.forEach((c) => out.add(c));
  }
  return out;
}

/* ---------------- Queries for the views ---------------- */

export const tasksForCompany = (companyId: string) =>
  query<TaskDoc>(C.tasks, { where: [['company_id', '==', companyId]] });
export const tasksForAssignee = (assigneeId: string) =>
  query<TaskDoc>(C.tasks, { where: [['assignee_id', '==', assigneeId]] });
export const reviewQueue = (reviewerId: string) =>
  query<TaskDoc>(C.tasks, { where: [['reviewer_id', '==', reviewerId], ['status', '==', 'submitted']] });
export const clientRequests = () =>
  query<TaskDoc>(C.tasks, { where: [['status', '==', 'requested']] });
export const pendingAccessRequests = () =>
  query<AccessGrantDoc>(C.accessGrants, { where: [['status', '==', 'requested']] });
export const grantsForTask = (taskId: string) =>
  query<AccessGrantDoc>(C.accessGrants, { where: [['task_id', '==', taskId]], orderBy: [['created_at', 'desc']] });
export const eventsForTask = async (taskId: string): Promise<TaskEventDoc[]> => {
  const snap = await events(taskId).orderBy('created_at').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as TaskEventDoc);
};
