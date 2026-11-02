import { config } from '../config.ts';
import { hashPassword } from '../security/crypto.ts';
import { db } from './client.ts';
import { checkUnique, claimUnique, getById, newId, now, queryOne, UniquenessError } from './store.ts';
import { C, type Role, type UserDoc } from './types.ts';

/** Normalises an Indian mobile to its 10 digits (drops +91 / leading 0). */
export const normalizeMobile = (m: string) => m.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');

export const getUserById = (id: string) => getById<UserDoc>(C.users, id);

/** Finds a user by email or mobile for sign-in. Returns at most one. */
export async function findUserByIdentifier(identifier: string): Promise<UserDoc | undefined> {
  const v = identifier.trim();
  const byEmail = await queryOne<UserDoc>(C.users, { where: [['email', '==', v.toLowerCase()]] });
  if (byEmail) return byEmail;
  return queryOne<UserDoc>(C.users, { where: [['mobile', '==', normalizeMobile(v)]] });
}

export interface NewStaff { role: Exclude<Role, 'client'>; name: string; email: string; mobile: string; password: string; createdBy?: string }

/** Creates a staff user, reserving email+mobile atomically so duplicates are rejected (SQLite's UNIQUE). */
export async function createStaffUser(s: NewStaff): Promise<string> {
  const email = s.email.trim().toLowerCase();
  const mobile = normalizeMobile(s.mobile);
  const passwordHash = await hashPassword(s.password);
  const id = newId();
  await db.runTransaction(async (t) => {
    await checkUnique(t, C.uniqueEmail, email, id); // reads first
    await checkUnique(t, C.uniqueMobile, mobile, id);
    claimUnique(t, C.uniqueEmail, email, id); // then writes
    claimUnique(t, C.uniqueMobile, mobile, id);
    const u: UserDoc = {
      id, role: s.role, name: s.name, email, mobile, password_hash: passwordHash, status: 'active',
      client_group_id: null, failed_logins: 0, locked_until: null, monitoring_notice_ack_at: null,
      created_at: now(), created_by: s.createdBy ?? null, updated_at: now(),
    };
    t.set(db.collection(C.users).doc(id), u);
  });
  return id;
}

/** Creates a client login under a client group (clients sign in with OTP only; no password). */
export async function createClientUser(c: { name: string; email?: string; mobile: string; clientGroupId: string; createdBy?: string }): Promise<string> {
  const email = c.email?.trim().toLowerCase() || null;
  const mobile = normalizeMobile(c.mobile);
  const id = newId();
  await db.runTransaction(async (t) => {
    if (email) await checkUnique(t, C.uniqueEmail, email, id); // reads first
    await checkUnique(t, C.uniqueMobile, mobile, id);
    if (email) claimUnique(t, C.uniqueEmail, email, id); // then writes
    claimUnique(t, C.uniqueMobile, mobile, id);
    const u: UserDoc = {
      id, role: 'client', name: c.name, email, mobile, password_hash: null, status: 'active',
      client_group_id: c.clientGroupId, failed_logins: 0, locked_until: null, monitoring_notice_ack_at: null,
      created_at: now(), created_by: c.createdBy ?? null, updated_at: now(),
    };
    t.set(db.collection(C.users).doc(id), u);
  });
  return id;
}

export const isLocked = (u: UserDoc) => !!u.locked_until && Date.parse(u.locked_until) > Date.now();

/** On a wrong password: count the failure and lock the account after the configured number of tries. */
export async function recordLoginFailure(u: UserDoc): Promise<void> {
  const failed = u.failed_logins + 1;
  const lock = failed >= config.maxFailedLogins;
  await db.collection(C.users).doc(u.id).update({
    failed_logins: lock ? 0 : failed,
    locked_until: lock ? new Date(Date.now() + config.lockMinutes * 60e3).toISOString() : u.locked_until ?? null,
    updated_at: now(),
  });
}

export async function clearLoginFailures(userId: string): Promise<void> {
  await db.collection(C.users).doc(userId).update({ failed_logins: 0, locked_until: null, updated_at: now() });
}

export async function updatePassword(userId: string, password: string): Promise<void> {
  await db.collection(C.users).doc(userId).update({ password_hash: await hashPassword(password), updated_at: now() });
}

export async function setUserStatus(userId: string, status: 'active' | 'disabled'): Promise<void> {
  await db.collection(C.users).doc(userId).update({ status, updated_at: now() });
}

export async function ackMonitoringNotice(userId: string): Promise<void> {
  const u = await getUserById(userId);
  if (u && !u.monitoring_notice_ack_at) await db.collection(C.users).doc(userId).update({ monitoring_notice_ack_at: now() });
}

export { UniquenessError };
