/**
 * End-to-end over real HTTP: the Firestore-backed Express app, sign-in flow, sessions, CSRF, lockout.
 * Run: npm run test:fs:http   (emulator on 8089; uses OTP_PROVIDER=file to read codes)
 */
import './emulator-only.mts';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/firestore/app.ts';
import { db } from '../server/firestore/client.ts';
import { createStaffUser, createClientUser } from '../server/firestore/users.ts';
import { ensureSettingDefaults, getSetting } from '../server/firestore/settings.ts';
import { giveConsent } from '../server/firestore/consents.ts';
import { C } from '../server/firestore/types.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };
async function wipe(col: string) { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
for (const c of [C.users, C.uniqueEmail, C.uniqueMobile, C.sessions, C.challenges, C.audit, C.counters, C.consents, C.settings, C.clientGroups]) await wipe(c);
await ensureSettingDefaults();

// Seed accounts
const DIR_MOBILE = '9000000001', CLI_MOBILE = '9000000004';
await createStaffUser({ role: 'director', name: 'Asha', email: 'asha@demo.test', mobile: DIR_MOBILE, password: 'correct horse 99' });
await db.collection(C.clientGroups).doc('g1').set({ name: 'Demo Group' });
const cliId = await createClientUser({ name: 'Ravi', mobile: CLI_MOBILE, clientGroupId: 'g1' });

// Start the real server on a random port
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const otpFile = path.join(process.env.DATA_DIR!, 'dev-otp.json');
const codeFor = (key: string) => JSON.parse(fs.readFileSync(otpFile, 'utf8'))[key];

let cookie = '';
async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'fetch', origin: 'http://localhost:5173', cookie, ...headers },
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let data: any = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function login(mode: string, identifier: string, password?: string, otpKey = identifier) {
  const r = await req('POST', '/api/auth/login', { mode, identifier, ...(password ? { password } : {}) });
  if (r.status !== 200) return r;
  const code = codeFor(otpKey);
  return req('POST', '/api/auth/verify', { challengeId: r.data.challengeId, code });
}

try {
  check('health check', (await req('GET', '/healthz')).data?.backend === 'firestore');
  check('me is null when signed out', (await req('GET', '/api/auth/me')).data.user === null);
  check('CSRF: POST without the custom header is blocked', (await req('POST', '/api/auth/login', { mode: 'client', identifier: 'x' }, { 'x-requested-with': '' })).status === 403);
  check('foreign origin blocked', (await req('POST', '/api/auth/login', { mode: 'client', identifier: 'x' }, { origin: 'https://evil.example' })).status === 403);
  check('wrong password → 401', (await req('POST', '/api/auth/login', { mode: 'staff', identifier: 'asha@demo.test', password: 'wrong-password-1' })).status === 401);

  // Staff sign-in end to end
  const v = await login('staff', 'asha@demo.test', 'correct horse 99', DIR_MOBILE);
  check('staff sign-in issues a session', v.status === 200);
  const me = await req('GET', '/api/auth/me');
  check('me returns the director after sign-in', me.data.user?.role === 'director');
  check('staff needs the monitoring-notice acknowledgement', me.data.needsMonitoringAck === true);
  check('me exposes the notice version', me.data.noticeVersion === (await getSetting('privacy_notice_version')));

  await req('POST', '/api/auth/logout', {});
  check('logout clears the session', (await req('GET', '/api/auth/me')).data.user === null);

  // Client sign-in + consent flag
  const cv = await login('client', CLI_MOBILE, undefined, CLI_MOBILE);
  check('client signs in with a one-time code', cv.status === 200);
  check('client is flagged as needing consent', (await req('GET', '/api/auth/me')).data.needsConsent === true);
  await giveConsent(cliId, ['service'], await getSetting('privacy_notice_version'), null);
  check('after consent the client no longer needs it', (await req('GET', '/api/auth/me')).data.needsConsent === false);
  await req('POST', '/api/auth/logout', {});

  // No account enumeration
  const unknown = await req('POST', '/api/auth/login', { mode: 'client', identifier: '9999999999' });
  check('unknown number still returns a challenge (no enumeration)', typeof unknown.data.challengeId === 'string' && unknown.data.challengeId.length === 36);

  // Lockout after 5 wrong staff passwords
  for (let i = 0; i < 5; i++) await req('POST', '/api/auth/login', { mode: 'staff', identifier: 'asha@demo.test', password: `wrong-pass-${i}1` });
  check('account locked → 429 even with the right password', (await req('POST', '/api/auth/login', { mode: 'staff', identifier: 'asha@demo.test', password: 'correct horse 99' })).status === 429);
} finally {
  server.close();
  await db.terminate();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
