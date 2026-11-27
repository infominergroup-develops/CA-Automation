import { GoogleAuth } from 'google-auth-library';
import { projectId } from './client.ts';

/**
 * Passwords live in Firebase Authentication, never in our database. Every portal user has one Firebase
 * account whose uid is the user's document id. Roles, lockout and sessions stay in Firestore.
 */

const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const base = `${emulator ? `http://${emulator}/` : 'https://'}identitytoolkit.googleapis.com`;
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export class FirebaseAuthError extends Error {
  constructor(public code: string) { super(`Firebase Authentication: ${code}`); }
}

async function request(path: string, headers: HeadersInit, body?: object): Promise<Record<string, any>> {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const data = await r.json().catch(() => ({}));
  // Codes arrive as "TOO_MANY_ATTEMPTS_TRY_LATER : explanation".
  if (!r.ok) throw new FirebaseAuthError(String(data.error?.message ?? r.status).split(' : ')[0]);
  return data;
}

/** A call made as the server's own Google identity. */
async function admin(path: string, body?: object) {
  const headers = new Headers(emulator ? { authorization: 'Bearer owner' } : await auth.getRequestHeaders(base));
  headers.set('content-type', 'application/json');
  return request(path, headers, body);
}
export const accounts = (action: string, body: object) => admin(`/v1/projects/${projectId}/accounts${action}`, body);

// The project's web API key, which password sign-in needs; read once from the project so there is nothing to configure.
let key: Promise<string> | undefined;
const apiKey = () => (key ??= emulator ? Promise.resolve('emulator')
  : admin(`/admin/v2/projects/${projectId}/config`).then((c) => c.client.apiKey as string).catch((e) => { key = undefined; throw e; }));

// Same form of the password everywhere, as the earlier hashes used.
const norm = (password: string) => password.normalize('NFKC');

export const createAccount = (id: string, email: string, name: string, password?: string) =>
  accounts('', { localId: id, email, displayName: name, ...(password && { password: norm(password) }) });
export const setAccountPassword = (id: string, password: string) => accounts(':update', { localId: id, password: norm(password) });
export const setAccountDisabled = (id: string, disabled: boolean) => accounts(':update', { localId: id, disableUser: disabled });
export const deleteAccount = (id: string) => accounts(':delete', { localId: id });

// Only these mean "wrong password"; anything else (an outage, a setup fault) must not count towards a lockout.
const REJECTED = ['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'USER_DISABLED', 'INVALID_EMAIL', 'MISSING_PASSWORD'];

/** Checks a password. Unknown users are checked too, so response time does not reveal which accounts exist. */
export async function checkPassword(u: { id: string; email: string | null; auth_email?: string } | undefined, password: string): Promise<boolean> {
  try {
    const r = await request('/v1/accounts:signInWithPassword', { 'content-type': 'application/json', 'x-goog-api-key': await apiKey() },
      { email: u?.auth_email ?? u?.email ?? 'unknown@example.invalid', password: norm(password), returnSecureToken: false });
    // The uid must be this user's: an account someone registered themselves with the same email is not ours.
    return !!u && r.localId === u.id;
  } catch (e) {
    if (e instanceof FirebaseAuthError && REJECTED.includes(e.code)) return false;
    throw e;
  }
}
