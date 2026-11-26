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
const mgrId = await createStaffUser({ role: 'manager', name: 'Ambrish', email: 'a@firm.test', mobile: '9000000002', password: PW });
const empId = await createStaffUser({ role: 'employee', name: 'Deepak', email: 'd@firm.test', mobile: '9000000003', password: PW });
await createStaffUser({ role: 'employee', name: 'Vivek', email: 'v@firm.test', mobile: '9000000004', password: PW });

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
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
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

  // Employees add clients and documents, but never change or delete a file
  const emp = browser(), emp2 = browser();
  await emp.login('staff', 'd@firm.test', PW); await emp2.login('staff', 'v@firm.test', PW);
  const file = (name: string, cat: string, body: string) => {
    const f = new FormData(); f.append('category_id', cat); f.append('fy', '2026-27');
    f.append('files', new Blob([Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`)], { type: 'application/pdf' }), name); return f;
  };
  const list = await emp.get('/api/users');
  check('employee sees only managers and directors, without contact details', list.data.length === 2 && list.data.every((s: any) => s.role !== 'employee' && !('email' in s) && !('mobile' in s)), list.data);
  const newClient = (extra: object) => ({ group_name: 'Gupta Group', company: { legal_name: 'Gupta Textiles', ...extra }, contact: { name: 'Asha Gupta', mobile: '9812300000', email: 'asha@gupta.test', password: 'guptapass2026' } });
  check('employee must name a relationship manager', (await emp.post('/api/clients', newClient({}))).status === 400);
  check('an employee is not accepted as the manager', (await emp.post('/api/clients', newClient({ manager_id: empId }))).status === 400);
  const made = await emp.post('/api/clients', newClient({ manager_id: mgrId }));
  check('employee adds a client', made.status === 201, made.data);
  const gupta = made.data.companyId, G = `/api/companies/${gupta}/documents`;
  check('employee sees only the client they added', (await emp.get('/api/companies')).data.map((c: any) => c.legal_name).join() === 'Gupta Textiles');
  check('another employee does not see it', (await emp2.get('/api/companies')).data.length === 0 && (await emp2.post(G, file('x.pdf', 'others', 'x'))).status === 404);
  check('the chosen manager sees it', (await mgr.get('/api/companies')).data.some((c: any) => c.id === gupta));
  const mine = await emp.post(G, file('P&L.pdf', 'profit-and-loss', 'mine'));
  check('employee uploads to it', mine.status === 201, mine.data);
  const theirs = await dir.post(G, file('Bank.pdf', 'bank-statements', 'director'));
  const seen = await emp.get(G);
  check('employee sees their own upload, not the director’s', seen.data.length === 1 && seen.data[0].id === mine.data[0].id, seen.data);
  check('employee downloads their own upload', (await emp.get(`/api/documents/${mine.data[0].id}/download`)).status === 200);
  check('employee cannot download the director’s', (await emp.get(`/api/documents/${theirs.data[0].id}/download`)).status === 404);
  for (const [who, id] of [['own', mine.data[0].id], ['another’s', theirs.data[0].id]]) {
    check(`employee cannot delete ${who} file`, (await emp.del(`/api/documents/${id}`)).status === 403);
    check(`employee cannot change ${who} file`, (await emp.patch(`/api/documents/${id}/review`, { status: 'accepted' })).status === 403);
  }
  check('both files still there, unchanged', (await dir.get(G)).data.filter((d: any) => d.review_status === 'pending').length === 2);
  check('employee cannot upload to a client they neither added nor work on', (await emp.post(`/api/companies/${companyId}/documents`, file('x.pdf', 'others', 'x'))).status === 404);
  check('employee still cannot add logins, companies, staff or tasks, or set passwords', (await Promise.all([
    emp.post(`/api/clients/${made.data.groupId}/users`), emp.post(`/api/clients/${made.data.groupId}/companies`), emp.post('/api/users'),
    emp.post('/api/tasks'), emp.post(`/api/users/${made.data.userId}/password`), emp.get(`/api/companies/${gupta}`),
  ])).every((r) => r.status === 403));
  const task = await dir.post('/api/tasks', { company_id: companyId, type: 'Other', title: 'Collect bills', assignee_id: empId, reviewer_id: mgrId });
  const onTask = await emp.post(`/api/companies/${companyId}/documents`, file('bill.pdf', 'purchase-bills', 'task'));
  check('with an open task: uploads, and sees that upload', onTask.status === 201 && (await emp.get(`/api/documents/${onTask.data[0].id}/download`)).status === 200);
  await dir.post(`/api/tasks/${task.data.id}/cancel`, { comment: 'Not needed' });
  check('when the task ends, so does access to that upload', (await emp.get(`/api/documents/${onTask.data[0].id}/download`)).status === 404);

  // New folders and moving files: directors and managers only
  check('employee cannot add a folder', (await emp.post('/api/categories', { name: 'Bookkeeping' })).status === 403);
  const nf = await mgr.post('/api/categories', { name: 'Bookkeeping' });
  check('manager adds a folder', nf.status === 201 && nf.data.id === 'bookkeeping', nf.data);
  check('same folder twice is refused', (await dir.post('/api/categories', { name: 'bookkeeping!' })).status === 409);
  const cats2 = (await emp.get('/api/categories')).data as { id: string; name: string }[];
  check('new folder sits before Others', cats2.at(-1)!.name === 'Others' && cats2.at(-2)!.name === 'Bookkeeping', cats2.map((c) => c.name));
  const f1 = await emp.post(G, file('ledger.pdf', 'others', 'ledger body'));
  const before = (await getDocumentMeta(f1.data[0].id))!.blob_key;
  check('employee cannot move a file', (await emp.post(`/api/documents/${f1.data[0].id}/move`, { fy: '2026-27', category_id: 'bookkeeping', month: 4 })).status === 403);
  check('moving to an unknown folder is refused', (await mgr.post(`/api/documents/${f1.data[0].id}/move`, { fy: '2026-27', category_id: 'nope', month: null })).status === 400);
  const mv = await mgr.post(`/api/documents/${f1.data[0].id}/move`, { fy: '2025-26', category_id: 'bookkeeping', month: 4 });
  const after = (await getDocumentMeta(f1.data[0].id))!;
  check('manager moves it', mv.status === 200 && after.fy === '2025-26' && after.category_id === 'bookkeeping' && after.month === 4, after);
  check('the bucket file moved too', after.blob_key.startsWith('Gupta Textiles/2025-26/Bookkeeping/2025-04 April/') && after.blob_key !== before, after.blob_key);
  const { blobs } = await import('../server/firestore/storage.ts');
  check('old copy is gone', await blobs.get(before).then(() => false, () => true));
  check('it still downloads, unchanged', (await mgr.get(`/api/documents/${f1.data[0].id}/download`)).status === 200);
  check('the move is audited', (await dir.get('/api/audit?action=document.moved')).data.length === 1);
} catch (e) {
  fail++; console.error(e);
} finally {
  server.close();
  await db.terminate();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
