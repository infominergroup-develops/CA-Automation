import { db } from './client.ts';
import { endSchedule } from './schedules.ts';
import { endAllSessions } from './sessions.ts';
import { now, query } from './store.ts';
import { TaskConflictError, cancelTask } from './tasks.ts';
import { C, type CompanyDoc, type TaskDoc, type UserDoc } from './types.ts';
import { setUserStatus } from './users.ts';
import type { ScheduleDoc } from './schedules.ts';
import { HttpError } from './http.ts';

/** A client's GST registrations; older records have only the one in `gstin`. */
export const gstinsOf = (c: Pick<CompanyDoc, 'gstin' | 'gstins'>): string[] => (c.gstins?.length ? c.gstins : c.gstin ? [c.gstin] : []);

/** 400 unless the GSTIN is one of this client's registrations. */
export function checkGstin(c: CompanyDoc, gstin: string | undefined | null) {
  if (gstin && !gstinsOf(c).includes(gstin)) throw new HttpError(400, 'That GST number is not one of this client\'s registrations.');
}

/**
 * Takes a client out of the portal: deleted by a director, or not approved. The record moves to deleted_companies,
 * its open tasks are cancelled and its schedules stopped. Its files stay encrypted in the bucket for the retention
 * period; nobody can reach them, as every route looks the client up first. If its client group has no other company
 * left, the group's own logins stop as well.
 */
export async function archiveCompany(c: CompanyDoc, by: string, reason: 'deleted' | 'not_approved'): Promise<void> {
  const why = reason === 'deleted' ? 'Client deleted' : 'Client not approved';
  for (const t of await query<TaskDoc>(C.tasks, { where: [['company_id', '==', c.id]] })) {
    if (['approved', 'cancelled'].includes(t.status)) continue;
    await cancelTask(t.id, by, why).catch((e) => { if (!(e instanceof TaskConflictError)) throw e; }); // already moved on
  }
  for (const s of await query<ScheduleDoc>(C.schedules, { where: [['company_id', '==', c.id], ['active', '==', true]] })) await endSchedule(s.id, by);

  const batch = db.batch();
  batch.set(db.collection(C.deletedCompanies).doc(c.id), { ...c, deleted_at: now(), deleted_by: by, deleted_reason: reason });
  batch.delete(db.collection(C.companies).doc(c.id));
  await batch.commit();

  if ((await query<CompanyDoc>(C.companies, { where: [['group_id', '==', c.group_id]], limit: 1 })).length) return;
  const logins = await query<UserDoc>(C.users, { where: [['client_group_id', '==', c.group_id]] });
  for (const u of logins.filter((x) => x.status === 'active')) {
    await setUserStatus(u.id, 'disabled');
    await endAllSessions(u.id);
  }
}

/** Approves a client an employee added: it opens, and so do its group's logins that were waiting with it. */
export async function approveCompany(c: CompanyDoc, by: string): Promise<void> {
  await db.collection(C.companies).doc(c.id).update({ approval: null, approved_by: by, approved_at: now() });
  const logins = await query<UserDoc>(C.users, { where: [['client_group_id', '==', c.group_id]] });
  for (const u of logins.filter((x) => x.status === 'disabled' && x.awaiting_approval)) {
    await setUserStatus(u.id, 'active');
    await db.collection(C.users).doc(u.id).update({ awaiting_approval: null });
  }
}
