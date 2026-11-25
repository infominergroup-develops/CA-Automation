import { config } from '../config.ts';
import { db } from './client.ts';
import { FirebaseAuthError, createAccount, deleteAccount, setAccountDisabled, setAccountPassword } from './firebase-auth.ts';
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

/**
 * Creates the Firebase account and the user document under the same id, reserving email+mobile atomically so
 * duplicates are rejected (SQLite's UNIQUE). If the document cannot be written, the account is removed again.
 */
async function createUser(u: Pick<UserDoc, 'role' | 'name' | 'client_group_id'> & { email: string; mobile: string; password?: string; createdBy?: string }): Promise<string> {
  const email = u.email.trim().toLowerCase();
  const mobile = normalizeMobile(u.mobile);
  const id = newId();
  await createAccount(id, email, u.name, u.password).catch((e) => {
    throw e instanceof FirebaseAuthError && e.code === 'EMAIL_EXISTS' ? new UniquenessError(`${C.uniqueEmail}:${email}`) : e;
  });
  try {
    await db.runTransaction(async (t) => {
      await checkUnique(t, C.uniqueEmail, email, id); // reads first
      await checkUnique(t, C.uniqueMobile, mobile, id);
      claimUnique(t, C.uniqueEmail, email, id); // then writes
      claimUnique(t, C.uniqueMobile, mobile, id);
      const doc: UserDoc = {
        id, role: u.role, name: u.name, email, mobile, status: 'active',
        client_group_id: u.client_group_id, failed_logins: 0, locked_until: null, monitoring_notice_ack_at: null,
        created_at: now(), created_by: u.createdBy ?? null, updated_at: now(),
      };
      t.set(db.collection(C.users).doc(id), doc);
    });
  } catch (e) {
    await deleteAccount(id).catch((err) => console.error(`Orphan Firebase account ${id}`, err));
    throw e;
  }
  return id;
}

export const createStaffUser = (s: NewStaff) => createUser({ ...s, client_group_id: null });

/** Creates a client login under a client group. Clients sign in with OTP, or with `password` while OTP is off. */
export const createClientUser = ({ clientGroupId, ...c }: { name: string; email: string; mobile: string; clientGroupId: string; createdBy?: string; password?: string }) =>
  createUser({ ...c, role: 'client', client_group_id: clientGroupId });

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

export const updatePassword = (userId: string, password: string) => setAccountPassword(userId, password);

/** Our own status ends access at once; Firebase's copy follows. */
export async function setUserStatus(userId: string, status: 'active' | 'disabled'): Promise<void> {
  await db.collection(C.users).doc(userId).update({ status, updated_at: now() });
  await setAccountDisabled(userId, status === 'disabled');
}

export async function ackMonitoringNotice(userId: string): Promise<void> {
  const u = await getUserById(userId);
  if (u && !u.monitoring_notice_ack_at) await db.collection(C.users).doc(userId).update({ monitoring_notice_ack_at: now() });
}

export { UniquenessError };
