/**
 * With OTP off (the live setting): clients sign in with a firm-set password, and uploads land in
 * client / year / document-type folders.
 * Run: npm run test:fs:clientpw   (emulator on 8089; OTP_PROVIDER=off)
 */
import './emulator-only.mts';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/firestore/app.ts';
import { db } from '../server/firestore/client.ts';
import { C } from '../server/firestore/types.ts';
import { getById } from '../server/firestore/store.ts';
import { createStaffUser } from '../server/firestore/users.ts';
import { addMonths, runOn, todayIst } from '../server/firestore/schedules.ts';
import { ensureSettingDefaults } from '../server/firestore/settings.ts';
import { acceptStaffUploads, ensureCategories, getDocumentMeta } from '../server/firestore/documents.ts';

if (process.env.OTP_PROVIDER !== 'off') throw new Error('Run with OTP_PROVIDER=off');
let pass = 0, fail = 0;
const check = (name: string, cond: unknown, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };

for (const c of await db.listCollections()) await db.recursiveDelete(c);
await ensureSettingDefaults();
await ensureCategories();
await (await import('../server/routes-fs/master.ts')).ensureWorkTypes();
const PW = 'correct horse 99';
const dirId = await createStaffUser({ role: 'director', name: 'Krishna', email: 'k@firm.test', mobile: '9000000001', password: PW });
const mgrId = await createStaffUser({ role: 'manager', name: 'Ambrish', email: 'a@firm.test', mobile: '9000000002', password: PW });
const empId = await createStaffUser({ role: 'employee', name: 'Deepak', email: 'd@firm.test', mobile: '9000000003', password: PW });
const emp2Id = await createStaffUser({ role: 'employee', name: 'Vivek', email: 'v@firm.test', mobile: '9000000004', password: PW });

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
    return { status: r.status, headers: r.headers, data: (r.headers.get('content-type') ?? '').includes('json') ? await r.json() as any : Buffer.from(await r.arrayBuffer()) as any };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    put: (p: string, b: unknown) => call('PUT', p, b),
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
  await cli.post('/api/privacy/consent', { purposes: ['service'], version: (await cli.get('/api/privacy/notice')).data.version });
  const fromClient = await cli.post(`/api/companies/${companyId}/documents`, (() => { const f = new FormData(); f.append('category_id', 'others'); f.append('fy', '2025-26');
    f.append('files', new Blob([Buffer.from('%PDF-1.4\nclient\n%%EOF\n')], { type: 'application/pdf' }), 'From client.pdf'); return f; })());
  check('client uploads still wait for review', fromClient.status === 201 && (await getDocumentMeta(fromClient.data[0].id))?.review_status === 'pending');
  await db.collection('documents').doc(up.data[0].id).update({ review_status: 'pending' }); // as before this change
  check('waiting staff uploads are cleared, client ones stay', (await acceptStaffUploads()) === 1
    && (await getDocumentMeta(up.data[0].id))?.review_status === 'accepted' && (await getDocumentMeta(fromClient.data[0].id))?.review_status === 'pending');

  // Firm resets the client's password
  await mgr.login('staff', 'a@firm.test', PW);
  const emp0 = browser(); await emp0.login('staff', 'd@firm.test', PW);
  check('an employee cannot reset a client password', (await emp0.post(`/api/users/${userId}/password`, { password: 'newclient123' })).status === 403);
  check('a manager sees a client they do not manage', (await mgr.get('/api/companies')).data.some((c: any) => c.id === companyId));
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
  // An employee's new client waits for its manager or a director.
  check('an employee\'s new client waits for approval', made.data.pending === true && (await mgr.get('/api/companies')).data.find((c: any) => c.id === gupta)?.approval === 'pending');
  check('...its files stay closed to the employee meanwhile', (await emp.post(G, file('early.pdf', 'others', 'x'))).status === 403);
  const guptaLogin = async () => (await getById<any>(C.users, made.data.userId))?.status;
  check('...and its login stays off', (await guptaLogin()) === 'disabled');
  check('the manager is told', (await mgr.get('/api/dashboard')).data.clientApprovals === 1);
  check('an employee cannot approve it', (await emp.post(`/api/companies/${gupta}/approval`, { decision: 'approve' })).status === 403);
  check('its manager approves it', (await mgr.post(`/api/companies/${gupta}/approval`, { decision: 'approve' })).status === 200);
  check('...only once', (await mgr.post(`/api/companies/${gupta}/approval`, { decision: 'approve' })).status === 409);
  check('then its login is on', (await guptaLogin()) === 'active');
  // A client is added once: same name or same GST number is refused.
  check('the same name is refused', await (async () => { const r = await dir.post('/api/clients', { group_name: 'Other', company: { legal_name: ' gupta TEXTILES ' } }); return r.status === 409 && /already exists: Gupta Textiles/.test(r.data.error); })());
  await dir.post('/api/clients', { group_name: 'GST Co', company: { legal_name: 'GST Co One', gstin: '27AAPFU0939F1ZV' } });
  check('the same GST number is refused', await (async () => { const r = await dir.post('/api/clients', { group_name: 'GST Two', company: { legal_name: 'GST Co Two', gstin: '27aapfu0939f1zv' } }); return r.status === 409 && /GST number 27AAPFU0939F1ZV already exists: GST Co One/.test(r.data.error); })());
  const mine = await emp.post(G, file('P&L.pdf', 'profit-and-loss', 'mine'));
  check('employee uploads to it', mine.status === 201, mine.data);
  const theirs = await dir.post(G, file('Bank.pdf', 'bank-statements', 'director'));
  const status = async (id: string) => (await getDocumentMeta(id))?.review_status;
  check('staff uploads need no approval', (await status(mine.data[0].id)) === 'accepted' && (await status(theirs.data[0].id)) === 'accepted');
  const seen = await emp.get(G);
  check('employee sees every file of the client they added', seen.data.length === 2, seen.data);
  check('employee downloads their own upload', (await emp.get(`/api/documents/${mine.data[0].id}/download`)).status === 200);
  check('employee downloads the director’s too', (await emp.get(`/api/documents/${theirs.data[0].id}/download`)).status === 200);
  check('another employee still cannot', (await emp2.get(`/api/documents/${theirs.data[0].id}/download`)).status === 404);
  // Viewing in the portal: same access rules, recorded as a view rather than a download.
  const views = async () => (await db.collection(C.audit).where('action', '==', 'document.viewed').where('object_id', '==', theirs.data[0].id).get()).size;
  check('employee views a file in the portal', (await emp.get(`/api/documents/${theirs.data[0].id}/download?view=1`)).status === 200 && (await views()) === 1);
  check('no view for someone who cannot download it', (await emp2.get(`/api/documents/${theirs.data[0].id}/download?view=1`)).status === 404 && (await views()) === 1);
  for (const [who, id] of [['own', mine.data[0].id], ['another’s', theirs.data[0].id]]) {
    check(`employee cannot delete ${who} file`, (await emp.del(`/api/documents/${id}`)).status === 403);
    check(`employee cannot change ${who} file`, (await emp.patch(`/api/documents/${id}/review`, { status: 'reupload', note: 'redo it' })).status === 403);
  }
  check('both files still there, unchanged', (await dir.get(G)).data.filter((d: any) => d.review_status === 'accepted').length === 2);
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

  // Folders: any staff member adds a document type for every client; clients make folders only inside them.
  check('employee adds a document-type folder', (await emp.post('/api/categories', { name: 'Working papers' })).status === 201);
  const cl = browser(); await cl.login('client', '9876543210', 'newclient123');
  check('a client cannot add one for every client', (await cl.post('/api/categories', { name: 'Ravi private' })).status === 403);
  const inMade = await cl.post(`/api/companies/${companyId}/documents`, (() => { const f = new FormData(); f.append('category_id', 'bank-statements'); f.append('fy', '2026-27');
    f.append('subfolder', 'HDFC/Current account'); f.append('files', new Blob([Buffer.from('{"gstin":"x"}')]), 'gstr1.json'); return f; })());
  check('a client uploads any file into a folder they made', inMade.status === 201 && (await getDocumentMeta(inMade.data[0].id))?.subfolder === 'HDFC/Current account');
  check('...but never a program', (await cl.post(`/api/companies/${companyId}/documents`, (() => { const f = new FormData(); f.append('category_id', 'others'); f.append('fy', '2026-27');
    f.append('files', new Blob([Buffer.from('MZ\x90\x00')]), 'setup.exe'); return f; })())).status === 415);
  const nf = await mgr.post('/api/categories', { name: 'Bookkeeping' });
  check('manager adds a folder', nf.status === 201 && nf.data.id === 'bookkeeping', nf.data);
  check('same folder twice is refused', (await dir.post('/api/categories', { name: 'bookkeeping!' })).status === 409);
  const cats2 = (await emp.get('/api/categories')).data as { id: string; name: string }[];
  check('new folders sit before Others', cats2.at(-1)!.name === 'Others' && cats2.slice(-3, -1).map((c) => c.name).join() === 'Bookkeeping,Working papers', cats2.map((c) => c.name));
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

  // Client master: work types, client groups given to staff, clients ticked per employee (director only)
  const wt = (await dir.get('/api/work-types')).data as { id: string; name: string }[];
  check('starting work types are there', wt.some((w) => w.name === 'GST') && wt.some((w) => w.name === 'Audit'), wt);
  check('manager cannot change the master', (await mgr.post('/api/work-types', { name: 'Valuation' })).status === 403 && (await mgr.post('/api/client-sets', { name: 'X team' })).status === 403);
  check('director adds a work type', (await dir.post('/api/work-types', { name: 'Valuation' })).status === 201);
  check('duplicate work type refused', (await dir.post('/api/work-types', { name: 'valuation' })).status === 409);
  check('director tags a client', (await dir.put(`/api/companies/${gupta}/work-types`, { work_types: ['gst', 'valuation'] })).status === 200);
  check('unknown work type refused', (await dir.put(`/api/companies/${gupta}/work-types`, { work_types: ['nope'] })).status === 400);
  check('clients list carries work types', (await mgr.get('/api/companies')).data.find((c: any) => c.id === gupta)?.work_types.join() === 'gst,valuation');
  check('removing a work type untags clients', (await dir.del('/api/work-types/valuation')).status === 200 && (await mgr.get('/api/companies')).data.find((c: any) => c.id === gupta)?.work_types.join() === 'gst');
  // Vivek (emp2) cannot see Mehta Traders (companyId) until given it
  const mehtaDocs = `/api/companies/${companyId}/documents`;
  check('employee starts without the client', (await emp2.get(mehtaDocs)).status === 404);
  const set = await dir.post('/api/client-sets', { name: 'North team' });
  check('director makes a named group', set.status === 201 && set.data.name === 'North team');
  check('a client in a group cannot be unknown', (await dir.put(`/api/client-sets/${set.data.id}`, { company_ids: ['00000000-0000-4000-8000-000000000000'] })).status === 400);
  check('only staff can be given a group', (await dir.put(`/api/client-sets/${set.data.id}`, { member_ids: [userId] })).status === 400);
  const vivek = (await dir.get('/api/users')).data.find((u: any) => u.name === 'Vivek').id;
  check('group gives its clients', (await dir.put(`/api/client-sets/${set.data.id}`, { company_ids: [companyId], member_ids: [vivek] })).status === 200);
  const vd = await emp2.get(mehtaDocs);
  check('group member now sees the client and its files', vd.status === 200 && vd.data.length >= 1 && (await emp2.get('/api/companies')).data.some((c: any) => c.id === companyId), vd.data);
  check('group member still cannot delete', (await emp2.del(`/api/documents/${vd.data[0].id}`)).status === 403);
  check('removed from the group: access ends', (await dir.put(`/api/client-sets/${set.data.id}`, { member_ids: [] })).status === 200 && (await emp2.get(mehtaDocs)).status === 404);
  check('director ticks a client for an employee', (await dir.put(`/api/users/${vivek}/clients`, { company_ids: [companyId] })).status === 200 && (await emp2.get(mehtaDocs)).status === 200);
  check('director sees the ticks', (await dir.get('/api/users')).data.find((u: any) => u.id === vivek).client_ids.join() === companyId);
  check('ticks only for employees and managers', (await dir.put(`/api/users/${userId}/clients`, { company_ids: [] })).status === 404);
  check('unticked: access ends', (await dir.put(`/api/users/${vivek}/clients`, { company_ids: [] })).status === 200 && (await emp2.get(mehtaDocs)).status === 404);
  check('deleting a group', (await dir.del(`/api/client-sets/${set.data.id}`)).status === 200 && (await dir.get('/api/client-sets')).data.length === 0);

  // Designation master: the director makes titles and gives or changes each person's.
  const title = (id: string) => (dir.get('/api/users') as Promise<any>).then((r) => r.data.find((x: any) => x.id === id)?.designation);
  check('only the director manages designations', (await mgr.post('/api/designations', { name: 'Partner' })).status === 403 && (await emp.get('/api/designations')).status === 403);
  const senior = await dir.post('/api/designations', { name: 'Senior Accountant' });
  const article = await dir.post('/api/designations', { name: 'Article Assistant' });
  check('director adds designations', senior.status === 201 && article.status === 201);
  check('duplicate designation refused', (await dir.post('/api/designations', { name: 'senior accountant' })).status === 409);
  check('director gives a designation', (await dir.put(`/api/users/${empId}/designation`, { designation_id: article.data.id })).status === 200 && (await title(empId)) === 'Article Assistant');
  check('director reassigns it', (await dir.put(`/api/users/${empId}/designation`, { designation_id: senior.data.id })).status === 200 && (await title(empId)) === 'Senior Accountant');
  check('unknown designation refused', (await dir.put(`/api/users/${empId}/designation`, { designation_id: '00000000-0000-4000-8000-000000000000' })).status === 400);
  check('clients get no designation', (await dir.put(`/api/users/${userId}/designation`, { designation_id: senior.data.id })).status === 404);
  check('employee cannot set designations', (await emp.put(`/api/users/${empId}/designation`, { designation_id: null })).status === 403);
  check('renaming shows everywhere', (await dir.put(`/api/designations/${senior.data.id}`, { name: 'Senior Associate' })).status === 200 && (await title(empId)) === 'Senior Associate');
  check('rename cannot clash', (await dir.put(`/api/designations/${senior.data.id}`, { name: 'Article Assistant' })).status === 409);
  check('removing a designation clears it from staff', (await dir.del(`/api/designations/${senior.data.id}`)).status === 200 && (await title(empId)) === null);
  check('master changes are audited', (await dir.get('/api/audit?action=client_set.')).data.length >= 3);

  // Roles and file rights, set by the director per person.
  const R = (view: boolean, edit: boolean, download: boolean, del: boolean, folders = false, move = edit) => ({ view, edit, move, download, downloadFolder: download, delete: del, deleteFolder: folders });
  const tdoc = theirs.data[0].id, dl = `/api/documents/${tdoc}/download`;
  check('only the director sees and sets rights', (await mgr.get('/api/rights')).status === 403 && (await mgr.put(`/api/users/${empId}/rights`, { rights: R(true, true, true, true) })).status === 403);
  const people = (await dir.get('/api/rights')).data as any[];
  const directorId = people.find((p) => p.role === 'director').id;
  check('rights start at the role defaults', people.find((p) => p.id === empId).rights.edit === false && people.find((p) => p.id === mgrId).rights.delete === false
    && people.find((p) => p.id === userId).rights.delete === true && people.every((p) => !p.custom));
  check('employee by default cannot move or delete', (await emp.post(`/api/documents/${tdoc}/move`, { category_id: 'others', fy: '2026-27', month: null })).status === 403 && (await emp.del(`/api/documents/${tdoc}`)).status === 403);
  check('director lets the employee edit and delete', (await dir.put(`/api/users/${empId}/rights`, { rights: R(true, true, true, true) })).status === 200);
  check('...the employee now moves a file', (await emp.post(`/api/documents/${tdoc}/move`, { category_id: 'others', fy: '2026-27', month: null })).status === 200);
  check('...and asks for a re-upload', (await emp.patch(`/api/documents/${tdoc}/review`, { status: 'reupload', note: 'blurred copy' })).status === 200);
  check('the app is told the rights', (await emp.get('/api/auth/me')).data.user.rights.delete === true);
  // Moving is its own right: review without move, and move without review.
  await dir.put(`/api/users/${empId}/rights`, { rights: R(true, true, true, false, false, false) });
  check('review without move: cannot move', (await emp.post(`/api/documents/${tdoc}/move`, { category_id: 'bank-statements', fy: '2026-27', month: null })).status === 403
    && (await emp.patch(`/api/documents/${tdoc}/review`, { status: 'accepted' })).status === 200);
  await dir.put(`/api/users/${empId}/rights`, { rights: R(true, false, true, false, false, true) });
  check('move without review: moves but cannot review', (await emp.post(`/api/documents/${tdoc}/move`, { category_id: 'bank-statements', fy: '2026-27', month: null })).status === 200
    && (await emp.patch(`/api/documents/${tdoc}/review`, { status: 'accepted' })).status === 403);
  check('rights set before "move" existed keep moving with edit', await (async () => {
    await db.collection('users').doc(empId).update({ rights: { view: true, edit: true, download: true, delete: false } });
    return (await emp.get('/api/auth/me')).data.user.rights.move === true;
  })());
  check('download off: viewing works, downloading is refused', (await dir.put(`/api/users/${empId}/rights`, { rights: R(true, false, false, false) })).status === 200
    && (await emp.get(dl)).status === 403 && (await emp.get(`${dl}?view=1`)).status === 200);
  check('view off: the file list and viewer are refused', (await dir.put(`/api/users/${empId}/rights`, { rights: R(false, false, true, false) })).status === 200
    && (await emp.get(G)).status === 403 && (await emp.get(`${dl}?view=1`)).status === 403);
  check('...but uploading still works', (await emp.post(G, file('late.pdf', 'others', 'late'))).status === 201);
  check('back to the role default', (await dir.put(`/api/users/${empId}/rights`, { rights: null })).status === 200
    && !(await dir.get('/api/rights')).data.find((p: any) => p.id === empId).custom && (await emp.get(G)).status === 200);
  check('directors always keep every right', (await dir.put(`/api/users/${directorId}/rights`, { rights: R(false, false, false, false) })).status === 400);
  const cdoc = fromClient.data[0].id, cdl = `/api/documents/${cdoc}/download`;
  await cli.login('client', '9876543210', 'newclient123'); // signed out when the director reset the password above
  check('client download off: views but cannot download', (await dir.put(`/api/users/${userId}/rights`, { rights: R(true, false, false, true) })).status === 200
    && (await cli.get(cdl)).status === 403 && (await cli.get(`${cdl}?view=1`)).status === 200);
  check('client delete off: cannot remove even a fresh own upload', (await dir.put(`/api/users/${userId}/rights`, { rights: R(true, false, true, false) })).status === 200
    && (await cli.del(`/api/documents/${cdoc}`)).status === 403);
  check('clients never get edit', (await dir.put(`/api/users/${userId}/rights`, { rights: R(true, true, true, true) })).status === 200
    && (await cli.patch(`/api/documents/${cdoc}/review`, { status: 'accepted' })).status === 403);
  check('client with delete removes their own upload', (await cli.del(`/api/documents/${cdoc}`)).status === 200);
  check('manager cannot change roles', (await mgr.put(`/api/users/${empId}/role`, { role: 'manager' })).status === 403);
  check('director cannot change their own role', (await dir.put(`/api/users/${directorId}/role`, { role: 'employee' })).status === 400);
  check('a client login is not made staff here', (await dir.put(`/api/users/${userId}/role`, { role: 'manager' })).status === 404);
  await dir.put(`/api/users/${empId}/rights`, { rights: R(true, true, true, true) });
  check('employee made a manager sees every client', (await dir.put(`/api/users/${empId}/role`, { role: 'manager' })).status === 200
    && (await emp.get('/api/companies')).data.length === (await dir.get('/api/companies')).data.length);
  const promoted = (await emp.get('/api/auth/me')).data.user;
  check('...with the manager default rights', promoted.role === 'manager' && promoted.rights.delete === false && promoted.rights.edit === true);
  // Clients kept without a portal login, tagged with work types when added.
  const quiet = await dir.post('/api/clients', { group_name: 'Joshi Group', company: { legal_name: 'Joshi Steels' }, work_types: ['gst', 'audit'] });
  check('client added without a login', quiet.status === 201 && quiet.data.userId === null, quiet.data);
  check('...with its work types', (await dir.get('/api/companies')).data.find((c: any) => c.id === quiet.data.companyId)?.work_types.join() === 'gst,audit');
  check('...and nobody who can sign in for it', (await dir.get(`/api/companies/${quiet.data.companyId}`)).data.contacts.length === 0);
  check('...its files can still be kept', (await dir.post(`/api/companies/${quiet.data.companyId}/documents`, file('itr.pdf', 'income-tax', 'joshi'))).status === 201);
  check('unknown work type refused when adding', (await dir.post('/api/clients', { group_name: 'X Group', company: { legal_name: 'X Metals' }, work_types: ['nope'] })).status === 400);
  check('a login can be added later', (await dir.post(`/api/clients/${quiet.data.groupId}/users`, { name: 'Anil Joshi', mobile: '9876500077', email: 'anil@joshi.test', password: 'joshi pass 2026' })).status === 201
    && (await browser().login('client', 'anil@joshi.test', 'joshi pass 2026')).data.signedIn === true);

  // Everyone changes their own password; the user record notes when.
  check('wrong current password refused', (await emp.post('/api/me/password', { current: 'not it at all 1', next: 'deepak new pass 1' })).status === 400);
  check('staff change their own password', (await emp.post('/api/me/password', { current: PW, next: 'deepak new pass 1' })).status === 200
    && (await browser().login('staff', 'd@firm.test', 'deepak new pass 1')).data.signedIn === true && (await browser().login('staff', 'd@firm.test', PW)).status === 401);
  check('weak new password refused', (await cli.post('/api/me/password', { current: 'newclient123', next: 'short' })).status === 400);
  check('clients change their own password', (await cli.post('/api/me/password', { current: 'newclient123', next: 'ravi own pass 77' })).status === 200
    && (await browser().login('client', 'ravi@mehta.test', 'ravi own pass 77')).data.signedIn === true);
  check('the change is noted on the user record', !!(await db.collection('users').doc(empId).get()).data()?.password_changed_at);
  // Deleting folders: the "delete folders" right, directors only by default; never clients.
  const J = `/api/companies/${quiet.data.companyId}/documents`, JF = `/api/companies/${quiet.data.companyId}/folders/delete`;
  const put = (cat: string, name: string, extra: Record<string, string> = {}) => { const f = file(name, cat, name); for (const [k, v] of Object.entries(extra)) f.set(k, v); return dir.post(J, f); };
  await put('bank-statements', 'hdfc-1.pdf', { subfolder: 'HDFC' }); await put('bank-statements', 'hdfc-2.pdf', { subfolder: 'HDFC/Current' });
  await put('bank-statements', 'sbi.pdf', { subfolder: 'SBI' }); await put('bank-statements', 'apr.pdf', { month: '4' }); await put('bank-statements', 'may.pdf', { month: '5' });
  const left = async () => ((await dir.get(J)).data as any[]).map((d) => d.original_name).sort().join();
  check('folder delete is directors-only by default', (await mgr.post(JF, { fy: '2026-27', path: 'Bank statements/HDFC' })).status === 403);
  check('files from before free folders show their type and month as folders', ((await dir.get(J)).data as any[]).find((d) => d.original_name === 'apr.pdf')?.path === 'Bank statements/April');
  check('director deletes a made folder with its inner folders', (await dir.post(JF, { fy: '2026-27', path: 'Bank statements/HDFC' })).data.deleted === 2
    && (await left()) === 'apr.pdf,itr.pdf,may.pdf,sbi.pdf');
  await dir.put(`/api/users/${mgrId}/rights`, { rights: R(true, true, true, false, true) });
  check('a manager given the right deletes a month', (await mgr.post(JF, { fy: '2026-27', path: 'Bank statements/April' })).data.deleted === 1 && (await left()) === 'itr.pdf,may.pdf,sbi.pdf');
  check('...and a whole year', (await mgr.post(JF, { fy: '2026-27' })).data.deleted === 3 && (await left()) === '');
  await dir.put(`/api/users/${userId}/rights`, { rights: R(true, false, true, true, true) });
  check('clients never get folder delete', (await dir.get('/api/rights')).data.find((p: any) => p.id === userId).rights.deleteFolder === false
    && (await cli.post(`/api/companies/${companyId}/folders/delete`, { fy: '2026-27' })).status === 403);
  check('folder deletes are audited with each file', (await dir.get('/api/audit?action=folder.deleted')).data.length === 3);
  // Files straight in a year: no document type needed; folders made there; moving into a new folder.
  const plainUp = (name: string, extra: Record<string, string>) => { const f = new FormData(); f.append('fy', '2026-27'); for (const [k, v] of Object.entries(extra)) f.set(k, v);
    f.append('files', new Blob([Buffer.from(`%PDF-1.4\n${name}\n%%EOF\n`)]), name); return dir.post(J, f); };
  const loose = await plainUp('loose.pdf', {});
  const looseMeta = await getDocumentMeta(loose.data[0].id);
  check('a file can sit straight in the year', loose.status === 201 && looseMeta?.category_id === '' && /^Joshi Steels\/2026-27\/\d{4}-\d{2}-\d{2}_loose\.pdf\./.test(looseMeta!.blob_key), looseMeta?.blob_key);
  check('a month needs a document type', (await plainUp('m.pdf', { month: '4' })).status === 400);
  await plainUp('deed.pdf', { subfolder: 'Property' });
  check('...and in folders made in the year', (await getDocumentMeta((await dir.get(J)).data.find((d: any) => d.original_name === 'deed.pdf').id))?.subfolder === 'Property');
  const typed = await put('bank-statements', 'typed.pdf');
  check('move into a new folder straight in the year', (await dir.post(`/api/documents/${typed.data[0].id}/move`, { fy: '2026-27', category_id: null, month: null, subfolder: 'Property/Old' })).status === 200
    && await (async () => { const m = await getDocumentMeta(typed.data[0].id); return m?.category_id === '' && m.subfolder === 'Property/Old' && m.blob_key.startsWith('Joshi Steels/2026-27/Property/Old/'); })());
  check('deleting a year\'s own folder leaves typed files alone', await (async () => {
    await put('bank-statements', 'keep.pdf', { subfolder: 'Property' });
    const r = await dir.post(JF, { fy: '2026-27', path: 'Property' });
    return r.data.deleted === 2 && (await left()) === 'keep.pdf,loose.pdf';
  })());
  // Managers see every client until the director limits them in Client access.
  const seesJoshi = async () => ((await mgr.get('/api/companies')).data as any[]).some((c) => c.id === quiet.data.companyId);
  check('a manager sees every client by default', await seesJoshi() && (await dir.get('/api/users')).data.find((x: any) => x.id === mgrId).all_clients === true);
  check('limited, a manager loses clients that are not theirs', (await dir.put(`/api/users/${mgrId}/clients`, { company_ids: [], all_clients: false })).status === 200
    && !(await seesJoshi()) && (await mgr.get(J)).status === 404);
  check('...keeps the clients they manage', ((await mgr.get('/api/companies')).data as any[]).some((c) => c.id === gupta));
  check('...and gets the ones ticked for them', (await dir.put(`/api/users/${mgrId}/clients`, { company_ids: [quiet.data.companyId], all_clients: false })).status === 200 && await seesJoshi());
  check('a manager cannot change their own access', (await mgr.put(`/api/users/${mgrId}/clients`, { company_ids: [], all_clients: true })).status === 403);
  check('every client again', (await dir.put(`/api/users/${mgrId}/clients`, { company_ids: [], all_clients: true })).status === 200 && (await mgr.get(G)).status === 200 && await seesJoshi());
  // Free folders: any depth, and moving into a folder that files from before already show.
  const deep = await plainUp('deep.pdf', { subfolder: 'A/B/C/D/E/F/G/H' });
  check('folders nest deeper than five levels', (await getDocumentMeta(deep.data[0].id))?.subfolder === 'A/B/C/D/E/F/G/H');
  const typedApr = await put('bank-statements', 'typed-apr.pdf', { month: '4' });
  const loose2 = await plainUp('loose2.pdf', {});
  await dir.post(`/api/documents/${loose2.data[0].id}/move`, { fy: '2026-27', category_id: null, month: null, subfolder: 'Bank statements/April' });
  const paths = Object.fromEntries(((await dir.get(J)).data as any[]).map((d) => [d.original_name, d.path]));
  check('a moved file joins the same folder as an older typed one', paths['typed-apr.pdf'] === 'Bank statements/April' && paths['loose2.pdf'] === 'Bank statements/April', paths);
  check('deleting that folder takes both', (await dir.post(JF, { fy: '2026-27', path: 'Bank statements/April' })).data.deleted === 2 && !!typedApr);
  // Two clients may share an owner's email and mobile; each login has its own username.
  const shared = await dir.post('/api/clients', { group_name: 'Mehta Retail', company: { legal_name: 'Mehta Retail LLP' },
    contact: { name: 'Ravi Mehta', mobile: '9876543210', email: 'ravi@mehta.test', password: 'retail pass 2026', username: 'ravi.retail' } });
  check('a second client can use the same email and mobile', shared.status === 201 && shared.data.username === 'ravi.retail', shared.data);
  check('sign-in with the shared email asks for the username', (await browser().login('client', 'ravi@mehta.test', 'retail pass 2026')).status === 400);
  const retail = browser();
  check('each signs in with their username', (await retail.login('client', 'ravi.retail', 'retail pass 2026')).data.signedIn === true);
  await retail.post('/api/privacy/consent', { purposes: ['service'], version: (await retail.get('/api/privacy/notice')).data.version });
  check('...and sees only their own client', ((await retail.get('/api/companies')).data as any[]).map((c) => c.legal_name).join() === 'Mehta Retail LLP');
  check('a taken username is refused', (await dir.post(`/api/clients/${shared.data.groupId}/users`, { name: 'Ravi 2', mobile: '9876543210', email: 'ravi@mehta.test', password: 'retail pass 2026', username: 'ravi.retail' })).status === 409);
  // --- Task names: directors and managers keep the list
  check('an employee cannot add a task name', (await emp2.post('/api/task-names', { name: 'GSTR-1 filing' })).status === 403);
  const gstr1 = await mgr.post('/api/task-names', { name: 'GSTR-1 filing' });
  check('a manager adds a task name', gstr1.status === 201 && gstr1.data.id === 'gstr-1-filing', gstr1.data);
  check('...once', (await dir.post('/api/task-names', { name: 'gstr 1 filing' })).status === 409);
  check('the team sees the list', ((await emp2.get('/api/task-names')).data as any[]).map((t) => t.name).join() === 'GSTR-1 filing');
  const T = gstr1.data.id;

  // --- Scheduled tasks: directors and managers set them; the whole team sees them while on; anyone may take one
  const day = (n: number) => new Date(Date.parse(todayIst()) + n * 864e5).toISOString().slice(0, 10); // n days from today in India
  check('dates: the 31st becomes the end of a short month', addMonths('2026-01-31', 1) === '2026-02-28' && addMonths('2024-01-31', 1) === '2024-02-29');
  check('dates: the run covering a day, or the next one', JSON.stringify(runOn({ start: '2026-01-01', end: '2026-01-10', repeat: 'monthly' }, '2026-03-05')) === '{"start":"2026-03-01","end":"2026-03-10"}'
    && runOn({ start: '2026-01-01', end: '2026-01-10', repeat: 'monthly' }, '2026-03-15').start === '2026-04-01'
    && runOn({ start: '2025-07-01', end: '2025-07-31', repeat: 'yearly' }, '2026-08-01').start === '2027-07-01');
  check('employee cannot schedule', (await emp2.post('/api/schedules', { company_id: companyId, start: day(-1), end: day(2), task_name_id: T, repeat: 'monthly' })).status === 403);
  check('end before start refused', (await dir.post('/api/schedules', { company_id: companyId, start: day(2), end: day(1), task_name_id: T, repeat: 'monthly' })).status === 400);
  check('a monthly one must be shorter than a month', (await dir.post('/api/schedules', { company_id: companyId, start: day(0), end: day(40), task_name_id: T, repeat: 'monthly' })).status === 400);
  check('a schedule needs a task from the list', (await dir.post('/api/schedules', { company_id: companyId, start: day(-1), end: day(2), task_name_id: 'nope', repeat: 'monthly' })).status === 400);
  const onNow = await dir.post('/api/schedules', { company_id: companyId, start: day(-1), end: day(2), task_name_id: T, repeat: 'monthly' });
  const later = await mgr.post('/api/schedules', { company_id: companyId, start: day(20), end: day(25), task_name_id: T, repeat: 'yearly' });
  check('director and manager schedule tasks', onNow.status === 201 && later.status === 201, [onNow.data, later.data]);
  const listed = (await emp2.get("/api/schedules")).data as any[];
  check("the whole team sees them, on now first", listed.length === 2 && listed[0].id === onNow.data.id && listed[0].task === 'GSTR-1 filing' && listed[0].live && !listed[1].live && listed[0].company === "Mehta Traders Pvt Ltd", listed);
  check('the team is told about the one on now', (await emp2.get('/api/dashboard')).data.scheduledNow === 1);
  check('anyone takes it', (await emp.post(`/api/schedules/${onNow.data.id}/take`, {})).status === 200);
  check('...only once', (await mgr.post(`/api/schedules/${onNow.data.id}/take`, {})).status === 409);
  check('everyone sees who has it', ((await emp2.get('/api/schedules')).data as any[])[0].taken?.name === 'Deepak');
  check('once taken, nobody is told any more', (await emp2.get('/api/dashboard')).data.scheduledNow === 0);
  check('a coming one can be taken early', (await emp2.post(`/api/schedules/${later.data.id}/take`, {})).status === 200);
  check('employee cannot stop a schedule', (await emp2.del(`/api/schedules/${later.data.id}`)).status === 403);
  check('director stops one', (await dir.del(`/api/schedules/${later.data.id}`)).status === 200 && ((await emp.get('/api/schedules')).data as any[]).length === 1);
  check('a client cannot see schedules', (await cli.get('/api/schedules')).status === 403);
  // Taking one opens that client's files to the taker until the run ends, or the schedule is stopped.
  const kapoor = (await dir.post('/api/clients', { group_name: 'Kapoor Metals', company: { legal_name: 'Kapoor Metals' } })).data.companyId;
  const KD = `/api/companies/${kapoor}/documents`;
  check('before taking, the employee cannot open that client', (await emp2.get(KD)).status === 404);
  const kapoorRun = await dir.post('/api/schedules', { company_id: kapoor, start: day(0), end: day(3), task_name_id: T, repeat: 'monthly' });
  check('...not even while it is on', (await emp2.get(KD)).status === 404);
  await emp2.post(`/api/schedules/${kapoorRun.data.id}/take`, {});
  check('after taking it, the employee opens the client and its files', (await emp2.get(KD)).status === 200 && ((await emp2.get('/api/companies')).data as any[]).some((c) => c.id === kapoor));
  check('nobody else gains access by it', (await browser().get(KD)).status !== 200);
  await dir.del(`/api/schedules/${kapoorRun.data.id}`);
  check('once the schedule is stopped, access ends', (await emp2.get(KD)).status === 404);
  // --- An employee adds their own task; whoever gave it approves it
  const kapoorOwn = (await emp2.post('/api/clients', { group_name: 'Kapoor Own Co', company: { legal_name: 'Kapoor Own Co', manager_id: mgrId } })).data.companyId;
  await mgr.post(`/api/companies/${kapoorOwn}/approval`, { decision: 'approve' });
  check('own task: needs a task from the list', (await emp2.post('/api/tasks/own', { company_id: kapoorOwn, task_name_id: 'nope', reviewer_id: mgrId })).status === 400);
  check('own task: only for a client they work on', (await emp2.post('/api/tasks/own', { company_id: companyId, task_name_id: T, reviewer_id: mgrId })).status === 404);
  check('own task: approved by a manager or director, not themselves', (await emp2.post('/api/tasks/own', { company_id: kapoorOwn, task_name_id: T, reviewer_id: emp2Id })).status === 400);
  const own = await emp2.post('/api/tasks/own', { company_id: kapoorOwn, task_name_id: T, reviewer_id: mgrId });
  check('an employee adds their own task', own.status === 201, own.data);
  const ownRow = ((await emp2.get('/api/tasks?view=mine')).data as any[]).find((t) => t.id === own.data.id);
  check('...assigned to them, named from the list, approved by whoever gave it', ownRow?.title === 'GSTR-1 filing' && ownRow?.assignee_id === emp2Id && ownRow?.reviewer_id === mgrId, ownRow);
  check('managers cannot use it to make tasks for others', (await mgr.post('/api/tasks/own', { company_id: kapoorOwn, task_name_id: T, reviewer_id: dirId })).status === 403);
  await emp2.post(`/api/tasks/${own.data.id}/start`);
  check('they finish and submit it', (await emp2.post(`/api/tasks/${own.data.id}/submit`, { note: 'Filed' })).status === 200);
  check('they cannot approve it themselves', (await emp2.post(`/api/tasks/${own.data.id}/approve`, {})).status === 403);
  check('whoever gave it approves it', (await mgr.post(`/api/tasks/${own.data.id}/approve`, {})).status === 200);

  // --- Turning down and deleting clients
  const quick = await emp2.post('/api/clients', { group_name: 'Quick Co', company: { legal_name: 'Quick Co', manager_id: mgrId } });
  check('a director turns down a new client: it is removed', (await dir.post(`/api/companies/${quick.data.companyId}/approval`, { decision: 'reject' })).status === 200
    && (await dir.get(`/api/companies/${quick.data.companyId}`)).status === 404);
  check('only a director deletes a client', (await mgr.del(`/api/companies/${kapoorOwn}`)).status === 403);
  const leftover = await dir.post('/api/schedules', { company_id: kapoorOwn, start: day(0), end: day(3), task_name_id: T, repeat: 'monthly' });
  const openTask = await dir.post('/api/tasks', { company_id: kapoorOwn, type: 'Other', title: 'Open work', assignee_id: emp2Id, reviewer_id: mgrId });
  check('director deletes a client', (await dir.del(`/api/companies/${kapoorOwn}`)).status === 200);
  check('...it is gone from the lists and its page', !((await dir.get('/api/companies')).data as any[]).some((c) => c.id === kapoorOwn) && (await dir.get(`/api/companies/${kapoorOwn}`)).status === 404);
  check('...its files are out of reach', (await dir.get(`/api/companies/${kapoorOwn}/documents`)).status === 404);
  check('...its open tasks are cancelled and leave the lists', (await getById<any>(C.tasks, openTask.data.id))?.status === 'cancelled' && !((await dir.get('/api/tasks')).data as any[]).some((t) => t.id === openTask.data.id));
  check('...its schedules stop', !((await dir.get('/api/schedules')).data as any[]).some((r) => r.id === leftover.data.id));
  check('...and the record is kept aside', (await getById<any>(C.deletedCompanies, kapoorOwn))?.deleted_reason === 'deleted');
  check('a deleted client can be added again', (await dir.post('/api/clients', { group_name: 'Kapoor Again', company: { legal_name: 'Kapoor Own Co' } })).status === 201);
  check('clients: approving, turning down and deleting are audited', (await dir.get('/api/audit?action=client.')).data.filter((a: any) => ['client.approved', 'client.rejected', 'client.deleted'].includes(a.action)).map((a: any) => a.action).sort().join() === 'client.approved,client.approved,client.deleted,client.rejected');

  // --- GST registrations by state
  const multi = await dir.post('/api/clients', { group_name: 'Multi State', company: { legal_name: 'Multi State Co', gstin: '09AAJCC5253D1ZQ', gstins: ['27AAJCC5253D1ZM'] } });
  const MS = multi.data.companyId;
  check('a client keeps several GSTINs, one per state', ((await dir.get('/api/companies')).data as any[]).find((c) => c.id === MS)?.gstins?.join() === '09AAJCC5253D1ZQ,27AAJCC5253D1ZM');
  check('a GSTIN another client has is refused', await (async () => { const r = await dir.post('/api/clients', { group_name: 'Copy', company: { legal_name: 'Copy Co', gstin: '27AAJCC5253D1ZM' } }); return r.status === 409 && /27AAJCC5253D1ZM already exists: Multi State Co/.test(r.data.error); })());
  check('a state is added to a client', (await mgr.put(`/api/companies/${MS}/gstins`, { gstins: ['09AAJCC5253D1ZQ', '27AAJCC5253D1ZM', '07AAJCC5253D1ZK'] })).status === 200
    && ((await dir.get(`/api/companies/${MS}`)).data.company.gstins as string[]).length === 3);
  check('...but not one another client has', (await mgr.put(`/api/companies/${MS}/gstins`, { gstins: ['09AAJCC5253D1ZQ', '27AAPFU0939F1ZV'] })).status === 409);
  check('an employee cannot change GSTINs', (await emp2.put(`/api/companies/${MS}/gstins`, { gstins: [] })).status === 403);
  check('a task names one of the client\'s states, not another client\'s', (await dir.post('/api/tasks', { company_id: MS, gstin: '27AAPFU0939F1ZV', type: 'GST return', title: 'GSTR-1 Maharashtra', assignee_id: emp2Id, reviewer_id: mgrId })).status === 400);
  const stateTask = await dir.post('/api/tasks', { company_id: MS, gstin: '27AAJCC5253D1ZM', type: 'GST return', title: 'GSTR-1 Maharashtra', assignee_id: emp2Id, reviewer_id: mgrId });
  check('...and the task shows which state', stateTask.status === 201 && ((await dir.get('/api/tasks')).data as any[]).find((t) => t.id === stateTask.data.id)?.gstin === '27AAJCC5253D1ZM');
  const stateRun = await dir.post('/api/schedules', { company_id: MS, gstin: '07AAJCC5253D1ZK', start: day(5), end: day(8), task_name_id: T, repeat: 'monthly' });
  check('a scheduled task names a state too', stateRun.status === 201 && ((await dir.get('/api/schedules')).data as any[]).find((r) => r.id === stateRun.data.id)?.gstin === '07AAJCC5253D1ZK');

  // --- Downloading a whole folder as a .zip
  const inFolder = (name: string, sub: string) => { const f = file(name, '', name); f.append('subfolder', sub); return f; };
  await dir.post(`/api/companies/${MS}/documents`, inFolder('one.pdf', 'Zip'));
  await dir.post(`/api/companies/${MS}/documents`, inFolder('two.pdf', 'Zip/Inner'));
  await dir.post(`/api/companies/${MS}/documents`, inFolder('two.pdf', 'Zip/Inner'));
  await dir.post(`/api/companies/${MS}/documents`, inFolder('elsewhere.pdf', 'Other'));
  const ZD = `/api/companies/${MS}/folders/download?fy=2026-27&path=Zip`;
  check('an employee cannot download folders by default', (await emp2.get(ZD)).status === 403);
  const zipped = await dir.get(ZD);
  check('a director downloads the folder as a .zip', zipped.status === 200 && zipped.headers.get('content-type') === 'application/zip' && /Multi%20State%20Co%20FY%202026-27%20Zip\.zip/.test(zipped.headers.get('content-disposition') ?? ''));
  const names = execFileSync('python3', ['-I', '-c', 'import sys,io,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(",".join(sorted(z.namelist())))'], { input: zipped.data }).toString().trim();
  check('...with its inner folders kept, only that folder, repeats numbered', names === 'Inner/two (2).pdf,Inner/two.pdf,one.pdf', names);
  check('an empty folder is 404', (await dir.get(`/api/companies/${MS}/folders/download?fy=2026-27&path=Nothing`)).status === 404);
  check('folder downloads are audited', JSON.parse((await dir.get('/api/audit?action=folder.downloaded')).data[0]?.details ?? '{}').files === 3);

  check('scheduling and taking are audited', ((await dir.get('/api/audit?action=schedule.')).data as any[]).map((a) => a.action).sort().join() === 'schedule.created,schedule.created,schedule.created,schedule.created,schedule.created,schedule.ended,schedule.ended,schedule.taken,schedule.taken,schedule.taken', (await dir.get('/api/audit?action=schedule.')).data.map((a: any) => a.action));

  check('role and rights changes are audited', (await dir.get('/api/audit?action=user.role_changed')).data.length === 1 && (await dir.get('/api/audit?action=user.rights_set')).data.length >= 6);
} catch (e) {
  fail++; console.error(e);
} finally {
  server.close();
  await db.terminate();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
