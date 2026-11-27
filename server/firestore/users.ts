import { config } from '../config.ts';
import { db } from './client.ts';
import { createAccount, deleteAccount, setAccountDisabled, setAccountPassword } from './firebase-auth.ts';
import { checkUnique, claimUnique, getById, newId, now, query, queryOne, UniquenessError } from './store.ts';
import { C, type Role, type UserDoc } from './types.ts';

/** Normalises an Indian mobile to its 10 digits (drops +91 / leading 0). */
export const normalizeMobile = (m: string) => m.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');

export const getUserById = (id: string) => getById<UserDoc>(C.users, id);

/** Several logins share this email or mobile, so the person must sign in with their username. */
export class SharedContactError extends Error {}

/**
 * Finds the user signing in: by username first, else by email or mobile when exactly one login has it (several clients
 * may share an owner's email or mobile; then only the username tells them apart).
 */
export async function findUserByIdentifier(identifier: string): Promise<UserDoc | undefined> {
  const v = identifier.trim().toLowerCase();
  const byName = await queryOne<UserDoc>(C.users, { where: [['username', '==', v]] });
  if (byName) return byName;
  for (const [field, value] of [['email', v], ['mobile', normalizeMobile(v)]] as const) {
    const hits = await query<UserDoc>(C.users, { where: [[field, '==', value]], limit: 2 });
    if (hits.length > 1) throw new SharedContactError();
    if (hits.length) return hits[0];
  }
  return undefined;
}

// Firebase accounts are email-based; new ones get an internal address so contact emails can repeat. No mail is sent to it.
const authEmailFor = (id: string) => `${id}@accounts.portal.invalid`;

/** A free username made from a name or email, such as ravi.mehta or ravi.mehta2 (the transaction still checks). */
export async function freeUsername(base: string): Promise<string> {
  const root = base.toLowerCase().split('@')[0].replace(/[^a-z0-9._-]+/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 32);
  const stem = root.length >= 3 ? root : `${root || 'user'}.login`.replace(/^\./, '');
  for (let i = 1; i < 500; i++) {
    const name = i === 1 ? stem : `${stem}${i}`;
    if (!(await queryOne(C.users, { where: [['username', '==', name]] }))) return name;
  }
  return `${stem}.${newId().slice(0, 6)}`;
}

export interface NewStaff { role: Exclude<Role, 'client'>; name: string; email: string; mobile: string; password: string; username?: string; createdBy?: string }

/**
 * Creates the Firebase account and the user document under the same id, reserving the username atomically so it is
 * never given twice. Email and mobile may repeat. If the document cannot be written, the account is removed again.
 */
async function createUser(u: Pick<UserDoc, 'role' | 'name' | 'client_group_id'> & { email: string; mobile: string; password?: string; username?: string; createdBy?: string }): Promise<{ id: string; username: string }> {
  const email = u.email.trim().toLowerCase();
  const mobile = normalizeMobile(u.mobile);
  const username = u.username?.trim().toLowerCase() || await freeUsername(email || u.name);
  const id = newId();
  const authEmail = authEmailFor(id);
  await createAccount(id, authEmail, u.name, u.password);
  try {
    await db.runTransaction(async (t) => {
      await checkUnique(t, C.uniqueUsername, username, id); // read first, then write
      claimUnique(t, C.uniqueUsername, username, id);
      const doc: UserDoc = {
        id, role: u.role, name: u.name, email, mobile, username, auth_email: authEmail, status: 'active',
        client_group_id: u.client_group_id, failed_logins: 0, locked_until: null, monitoring_notice_ack_at: null,
        created_at: now(), created_by: u.createdBy ?? null, updated_at: now(),
      };
      t.set(db.collection(C.users).doc(id), doc);
    });
  } catch (e) {
    await deleteAccount(id).catch((err) => console.error(`Orphan Firebase account ${id}`, err));
    throw e;
  }
  return { id, username };
}

/** Gives every user made before usernames one (from their email), once, at start. Returns how many were given. */
export async function ensureUsernames(): Promise<number> {
  const missing = (await query<UserDoc>(C.users)).filter((u) => !u.username);
  for (const u of missing) {
    const username = await freeUsername(u.email ?? u.name);
    await db.runTransaction(async (t) => {
      await checkUnique(t, C.uniqueUsername, username, u.id);
      claimUnique(t, C.uniqueUsername, username, u.id);
      t.update(db.collection(C.users).doc(u.id), { username, updated_at: now() });
    });
  }
  return missing.length;
}

export const createStaffUser = async (s: NewStaff) => (await createUser({ ...s, client_group_id: null })).id;
export const createStaffLogin = (s: NewStaff) => createUser({ ...s, client_group_id: null });

/** Creates a client login under a client group. Clients sign in with OTP, or with `password` while OTP is off. */
type NewClientLogin = { name: string; email: string; mobile: string; clientGroupId: string; createdBy?: string; password?: string; username?: string };
export const createClientLogin = ({ clientGroupId, ...c }: NewClientLogin) => createUser({ ...c, role: 'client', client_group_id: clientGroupId });
export const createClientUser = async (c: NewClientLogin) => (await createClientLogin(c)).id;

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

/** The password itself lives only in Firebase Authentication; the user record notes when it changed. */
export async function updatePassword(userId: string, password: string): Promise<void> {
  await setAccountPassword(userId, password);
  await db.collection(C.users).doc(userId).update({ password_changed_at: now(), updated_at: now() });
}

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
