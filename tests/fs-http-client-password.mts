/**
 * With OTP off (the live setting): clients sign in with a firm-set password, and uploads land in
 * client / year / document-type folders.
 * Run: npm run test:fs:clientpw   (emulator on 8089; OTP_PROVIDER=off)
 */
import './emulator-only.mts';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/firestore/app.ts';
import { db } from '../server/firestore/client.ts';
import { createStaffUser } from '../server/firestore/users.ts';
import { ensureSettingDefaults } from '../server/firestore/settings.ts';
import { ensureCategories, getDocumentMeta } from '../server/firestore/documents.ts';

if (process.env.OTP_PROVIDER !== 'off') throw new Error('Run with OTP_PROVIDER=off');
let pass = 0, fail = 0;
const check = (name: string, cond: unknown, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };

for (const c of await db.listCollections()) await db.recursiveDelete(c);
await ensureSettingDefaults();
await ensureCategories();
const PW = 'correct horse 99';
await createStaffUser({ role: 'director', name: 'Krishna', email: 'k@firm.test', mobile: '9000000001', password: PW });
await createStaffUser({ role: 'manager', name: 'Ambrish', email: 'a@firm.test', mobile: '9000000002', password: PW });

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function browser() {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const isForm = body instanceof FormData;
    const r = await fetch(base + p, {
      method, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      headers: { ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'fetch', origin: 'http://localhost:5173', cookie },
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: (r.headers.get('content-type') ?? '').includes('json') ? await r.json() as any : null };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
    login: (mode: string, identifier: string, password: string) => call('POST', '/api/auth/login', { mode, identifier, password }),
  };
}

try {
  const dir = browser(), mgr = browser(), cli = browser(), cli2 = browser();
  check('signed-out /me says clients use a password', (await dir.get('/api/auth/me')).data.clientPassword === true);
  check('director signs in with password alone', (await dir.login('staff', 'k@firm.test', PW)).data.signedIn === true);

  const company = { legal_name: 'Mehta Traders Pvt Ltd' };
  check('client without password refused', (await dir.post('/api/clients', { group_name: 'Mehta Group', company, contact: { name: 'Ravi Mehta', mobile: '9876543210', email: 'ravi@mehta.test' } })).status === 400);
  check('weak client password refused', (await dir.post('/api/clients', { group_name: 'Mehta Group', company, contact: { name: 'Ravi Mehta', mobile: '9876543210', email: 'ravi@mehta.test', password: 'short' } })).status === 400);
  const created = await dir.post('/api/clients', { group_name: 'Mehta Group', company, contact: { name: 'Ravi Mehta', mobile: '9876543210', email: 'ravi@mehta.test', password: 'clientpass123' } });
  check('client created with password', created.status === 201, created.data);
  const { companyId, userId } = created.data;

  check('client signs in with mobile + password', (await cli.login('client', '98765 43210', 'clientpass123')).data.signedIn === true);
  check('client signs in with email + password', (await cli2.login('client', 'ravi@mehta.test', 'clientpass123')).data.signedIn === true);
  check('wrong password refused', (await browser().login('client', '9876543210', 'wrongpass123')).status === 401);
  check('client cannot use the staff tab', (await browser().login('staff', '9876543210', 'clientpass123')).status === 401);
  check('staff cannot use the client tab', (await browser().login('client', 'k@firm.test', PW)).status === 401);
  check('client is the right user', (await cli.get('/api/auth/me')).data.user?.name === 'Ravi Mehta');

  // Folder layout
  const fd = new FormData();
  fd.append('category_id', 'bank-statements'); fd.append('fy', '2025-26');
  fd.append('files', new Blob([Buffer.from('%PDF-1.4\nApril\n%%EOF\n')], { type: 'application/pdf' }), 'HDFC April.pdf');
  const up = await dir.post(`/api/companies/${companyId}/documents`, fd);
  check('upload', up.status === 201, up.data);
  const key = (await getDocumentMeta(up.data[0].id))!.blob_key;
  check('stored as client / year / document type / date_name.id.enc',
    new RegExp(`^Mehta Traders Pvt Ltd/2025-26/Bank statements/\\d{4}-\\d{2}-\\d{2}_HDFC April\\.pdf\\.${up.data[0].id}\\.enc$`).test(key), key);
  check('download still works', (await dir.get(`/api/documents/${up.data[0].id}/download`)).status === 200);

  // Firm resets the client's password
  check('manager outside the client: 404', (await mgr.login('staff', 'a@firm.test', PW), (await mgr.post(`/api/users/${userId}/password`, { password: 'newclient123' })).status === 404));
  check('weak reset refused', (await dir.post(`/api/users/${userId}/password`, { password: 'short' })).status === 400);
  check('cannot set a staff password this way', (await dir.post(`/api/users/${(await dir.get('/api/auth/me')).data.user.id}/password`, { password: 'newclient123' })).status === 404);
  check('director resets the client password', (await dir.post(`/api/users/${userId}/password`, { password: 'newclient123' })).status === 200);
  check('reset signs the client out', (await cli.get('/api/auth/me')).data.user === null);
  check('old password no longer works', (await browser().login('client', '9876543210', 'clientpass123')).status === 401);
  check('new password works', (await browser().login('client', '9876543210', 'newclient123')).data.signedIn === true);
  check('reset is audited', (await dir.get('/api/audit?action=user.password_set')).data.length === 1);
} catch (e) {
  fail++; console.error(e);
} finally {
  server.close();
  await db.terminate();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
