import { db } from './client.ts';
import { create, getById, newId, now, query } from './store.ts';
import { getSetting } from './settings.ts';
import { listConsents } from './consents.ts';
import { C, type BreachDoc, type ConsentDoc, type DpdpRequestDoc, type UserDoc } from './types.ts';

/**
 * DPDP Act tooling: data-principal requests (access / correction / erasure / grievance / nomination),
 * the personal-data breach register, and a machine-readable export of a person's own data.
 */

const dueDate = async () => new Date(Date.now() + Number(await getSetting('dpdp_response_days')) * 86400e3).toISOString();

export async function raiseRequest(userId: string, type: DpdpRequestDoc['type'], details: string): Promise<string> {
  const id = newId();
  const doc: DpdpRequestDoc = {
    id, user_id: userId, type, details, status: 'open', response: null, due_at: await dueDate(),
    handled_by: null, created_at: now(), closed_at: null,
  };
  await db.collection(C.dpdpRequests).doc(id).set(doc);
  return id;
}

export const requestsForUser = (userId: string) =>
  query<DpdpRequestDoc>(C.dpdpRequests, { where: [['user_id', '==', userId]] })
    .then((rows) => rows.sort((a, b) => b.created_at.localeCompare(a.created_at)));
export const allRequests = () =>
  query<DpdpRequestDoc>(C.dpdpRequests, { orderBy: [['created_at', 'desc']] });

export async function updateRequest(id: string, handledBy: string, status: 'in_progress' | 'closed' | 'rejected', response?: string): Promise<void> {
  const r = await getById<DpdpRequestDoc>(C.dpdpRequests, id);
  if (!r) throw new Error('Not found.');
  await db.collection(C.dpdpRequests).doc(id).update({
    status, response: response ?? r.response, handled_by: handledBy, closed_at: status === 'in_progress' ? null : now(),
  });
}

/* ---------------- Breach register (DPDP s.8(6)) ---------------- */

export async function recordBreach(b: { detected_at: string; description: string; data_affected: string; principals_affected?: number; created_by: string }): Promise<string> {
  const id = newId();
  const doc: BreachDoc = {
    id, detected_at: b.detected_at, description: b.description, data_affected: b.data_affected,
    principals_affected: b.principals_affected ?? null, board_intimated_at: null, principals_notified_at: null,
    status: 'open', created_by: b.created_by, created_at: now(),
  };
  await db.collection(C.breachRegister).doc(id).set(doc);
  return id;
}

export const listBreaches = () =>
  query<BreachDoc>(C.breachRegister, { orderBy: [['detected_at', 'desc']] });

export async function updateBreach(id: string, patch: { status?: BreachDoc['status']; boardIntimated?: boolean; principalsNotified?: boolean }): Promise<void> {
  const b = await getById<BreachDoc>(C.breachRegister, id);
  if (!b) throw new Error('Not found.');
  await db.collection(C.breachRegister).doc(id).update({
    status: patch.status ?? b.status,
    board_intimated_at: patch.boardIntimated ? b.board_intimated_at ?? now() : b.board_intimated_at,
    principals_notified_at: patch.principalsNotified ? b.principals_notified_at ?? now() : b.principals_notified_at,
  });
}

/* ---------------- Right to access: export my own data (DPDP s.11) ---------------- */

export async function exportMyData(userId: string): Promise<Record<string, unknown>> {
  const u = await getById<UserDoc>(C.users, userId);
  const { password_hash, ...profile } = u ?? ({} as UserDoc);
  const companies = u?.role === 'client' && u.client_group_id
    ? (await query<{ legal_name: string; pan: string | null; gstin: string | null }>(C.companies, { where: [['group_id', '==', u.client_group_id]] }))
      .map(({ legal_name, pan, gstin }) => ({ legal_name, pan, gstin }))
    : [];
  const uploads = (await query<{ original_name: string; fy: string; month: number | null; size: number; sha256: string; created_at: string }>(
    C.documents, { where: [['uploaded_by', '==', userId]] }))
    .map(({ original_name, fy, month, size, sha256, created_at }) => ({ original_name, fy, month, size, sha256, created_at }));
  const consents = (await listConsents(userId)).map(({ notice_version, purposes, given_at, withdrawn_at }: ConsentDoc) => ({ notice_version, purposes, given_at, withdrawn_at }));
  const time = u?.role !== 'client'
    ? (await query<{ started_at: string; ended_at: string | null; idle_seconds: number; source: string; note: string | null }>(C.timeEntries, { where: [['user_id', '==', userId]] }))
      .map(({ started_at, ended_at, idle_seconds, source, note }) => ({ started_at, ended_at, idle_seconds, source, note }))
    : [];
  // Activity: audit entries where the person is the actor or the object.
  const [asActor, asObject] = await Promise.all([
    query<{ ts: string; action: string; ip: string | null }>(C.audit, { where: [['actor_id', '==', userId]] }),
    query<{ ts: string; action: string; ip: string | null }>(C.audit, { where: [['object_id', '==', userId]] }),
  ]);
  const activity = [...asActor, ...asObject].map(({ ts, action, ip }) => ({ ts, action, ip })).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 1000);
  return { generatedAt: now(), profile, companies, uploads, consents, timeEntries: time, activity };
}
