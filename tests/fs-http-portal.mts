/**
 * End-to-end over real HTTP: every portal route on the Firestore app (all but Tally), as each role.
 * Run: npm run test:fs:portal   (emulator on 8089; uses OTP_PROVIDER=file to read codes)
 */
import './emulator-only.mts';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/firestore/app.ts';
import { db } from '../server/firestore/client.ts';
import { createStaffUser } from '../server/firestore/users.ts';
import { ensureSettingDefaults } from '../server/firestore/settings.ts';
import { ensureCategories } from '../server/firestore/documents.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: unknown, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };

for (const c of await db.listCollections()) await db.recursiveDelete(c);
await ensureSettingDefaults();
await ensureCategories();
const PW = 'correct horse 99';
const dirId = await createStaffUser({ role: 'director', name: 'Krishna', email: 'k@firm.test', mobile: '9000000001', password: PW });
const mgrId = await createStaffUser({ role: 'manager', name: 'Ambrish', email: 'a@firm.test', mobile: '9000000002', password: PW });
const empId = await createStaffUser({ role: 'employee', name: 'Sajal', email: 's@firm.test', mobile: '9000000003', password: PW });
await createStaffUser({ role: 'employee', name: 'Ishika', email: 'i@firm.test', mobile: '9000000005', password: PW });

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const otp = (key: string) => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR!, 'dev-otp.json'), 'utf8'))[key];

/** A signed-in browser: its own cookie jar. */
function browser() {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const isForm = body instanceof FormData;
    const r = await fetch(base + p, {
      method, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      headers: { ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'fetch', origin: 'http://localhost:5173', cookie },
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') ?? '';
    const data: any = type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
    async staff(email: string, mobile: string) {
      const r = await call('POST', '/api/auth/login', { mode: 'staff', identifier: email, password: PW });
      return call('POST', '/api/auth/verify', { challengeId: r.data.challengeId, code: otp(mobile) });
    },
    async client(mobile: string) {
      const r = await call('POST', '/api/auth/login', { mode: 'client', identifier: mobile });
      return call('POST', '/api/auth/verify', { challengeId: r.data.challengeId, code: otp(mobile) });
    },
  };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const upload = (categoryId: string, name: string, bytes = PDF) => {
  const fd = new FormData();
  fd.append('category_id', categoryId); fd.append('fy', '2025-26'); fd.append('month', '4');
  fd.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
  return fd;
};

try {
  const dir = browser(), mgr = browser(), emp = browser(), cli = browser();
  check('director signs in', (await dir.staff('k@firm.test', '9000000001')).status === 200);
  check('me says Tally is off', (await dir.get('/api/auth/me')).data.features?.tally === false);

  // --- Admin ---
  const users = await dir.get('/api/users');
  check('staff list has 4, no password hashes', users.data.length === 4 && !('password_hash' in users.data[0]), users.data);
  check('new staff: weak password refused', (await dir.post('/api/users', { name: 'Raashi', role: 'employee', email: 'r@firm.test', mobile: '9000000006', password: 'short' })).status === 400);
  check('new staff: duplicate email 409', (await dir.post('/api/users', { name: 'Xavier', role: 'employee', email: 's@firm.test', mobile: '9000000007', password: 'longenough123' })).status === 409);
  const raashi = await dir.post('/api/users', { name: 'Raashi', role: 'employee', email: 'r@firm.test', mobile: '9000000006', password: 'longenough123' });
  check('new staff created', raashi.status === 201);

  const client = await dir.post('/api/clients', {
    group_name: 'Mehta Group',
    company: { legal_name: 'Mehta Traders Pvt Ltd', pan: 'AAACM1234E', gstin: '09AAACM1234E1Z5', manager_id: mgrId },
    contact: { name: 'Ravi Mehta', mobile: '98765 43210' },
  });
  check('client group + company + login created', client.status === 201 && client.data.companyId, client.data);
  const companyId = client.data.companyId as string, groupId = client.data.groupId as string;
  check('duplicate client mobile 409', (await dir.post('/api/clients', { group_name: 'Dup', company: { legal_name: 'Dup Co' }, contact: { name: 'Dup', mobile: '9876543210' } })).status === 409);
  const second = await dir.post(`/api/clients/${groupId}/companies`, { legal_name: 'Mehta Exports LLP' });
  check('second company in group', second.status === 201);
  const other = await dir.post('/api/clients', { group_name: 'Other Group', company: { legal_name: 'Other Co' }, contact: { name: 'Olga', mobile: '9123456780' } });
  check('add login to group', (await dir.post(`/api/clients/${groupId}/users`, { name: 'Priya Mehta', mobile: '9988776655', email: 'priya@mehta.test' })).status === 201);

  const companies = await dir.get('/api/companies');
  check('director sees 3 companies with group names', companies.data.length === 3 && companies.data.every((c: any) => c.group_name), companies.data);
  const detail = await dir.get(`/api/companies/${companyId}`);
  check('company detail + 2 contacts', detail.data.company.manager_name === 'Ambrish' && detail.data.contacts.length === 2, detail.data);
  const cats = (await dir.get('/api/categories')).data as { id: string; name: string }[];
  check('14 categories', cats.length === 14);
  const bank = cats.find((c) => c.name === 'Bank statements')!.id, gst = cats.find((c) => c.name === 'GST documents')!.id;

  check('settings readable', (await dir.get('/api/settings')).data.firm_name === 'Infominer');
  check('settings update', (await dir.patch('/api/settings', { grievance_officer_name: 'Krishna Mittal' })).status === 200);

  // --- Manager scope ---
  check('manager signs in', (await mgr.staff('a@firm.test', '9000000002')).status === 200);
  check('manager sees only their company', (await mgr.get('/api/companies')).data.length === 1);
  check('manager: other company is 404', (await mgr.get(`/api/companies/${other.data.companyId}`)).status === 404);
  check('manager cannot add a director', (await mgr.post('/api/users', { name: 'Yash', role: 'director', email: 'y@firm.test', mobile: '9000000008', password: 'longenough123' })).status === 403);

  // --- Documents ---
  const up = await dir.post(`/api/companies/${companyId}/documents`, upload(bank, 'April bank.pdf'));
  check('upload PDF', up.status === 201 && up.data[0].sha256, up.data);
  const up2 = await dir.post(`/api/companies/${companyId}/documents`, upload(gst, 'GSTR-1.pdf'));
  check('second upload flags duplicate bytes', up2.data[0].duplicateOf?.id === up.data[0].id, up2.data);
  check('non-allowed type refused', (await dir.post(`/api/companies/${companyId}/documents`, upload(bank, 'x.exe', Buffer.from('MZ\x90\x00binary')))).status === 415);
  check('unknown category refused', (await dir.post(`/api/companies/${companyId}/documents`, upload('nope', 'a.pdf'))).status === 400);
  const docs = await dir.get(`/api/companies/${companyId}/documents`);
  check('director lists 2 documents with names', docs.data.length === 2 && docs.data[0].category && docs.data[0].uploaded_by_name === 'Krishna', docs.data);
  check('filter by category', (await dir.get(`/api/companies/${companyId}/documents?category_id=${gst}`)).data.length === 1);
  const dl = await dir.get(`/api/documents/${up.data[0].id}/download`);
  check('download decrypts to the same bytes', dl.status === 200 && Buffer.compare(dl.data, PDF) === 0);
  check('review: reupload needs a note', (await dir.patch(`/api/documents/${up2.data[0].id}/review`, { status: 'reupload' })).status === 400);
  check('review: accept', (await dir.patch(`/api/documents/${up.data[0].id}/review`, { status: 'accepted' })).status === 200);

  // --- Tasks + access ---
  check('task: reviewer = assignee refused', (await dir.post('/api/tasks', { company_id: companyId, type: 'GST return', title: 'GSTR-3B Oct', assignee_id: mgrId, reviewer_id: mgrId })).status === 400);
  const task = await dir.post('/api/tasks', {
    company_id: companyId, type: 'GST return', title: 'GSTR-3B October', period: 'Oct 2026', assignee_id: empId, reviewer_id: mgrId,
    due_date: '2026-11-20', estimate_hours: 0.001, grant_category_ids: [bank],
  });
  check('task created with an access grant', task.status === 201, task.data);
  const taskId = task.data.id as string;

  check('employee signs in', (await emp.staff('s@firm.test', '9000000003')).status === 200);
  check('time needs the monitoring notice first', (await emp.post('/api/time/start', { category: 'Admin' })).status === 403);
  check('monitoring ack', (await emp.post('/api/me/monitoring-ack')).status === 200);
  check('employee sees their task', (await emp.get('/api/tasks')).data.length === 1);
  check('employee sees the company', (await emp.get('/api/companies')).data.length === 1);
  const empDocs = await emp.get(`/api/companies/${companyId}/documents`);
  check('employee sees only the granted category', empDocs.data.length === 1 && empDocs.data[0].category_id === bank, empDocs.data);
  check('employee can download granted doc', (await emp.get(`/api/documents/${up.data[0].id}/download`)).status === 200);
  check('employee cannot download other category', (await emp.get(`/api/documents/${up2.data[0].id}/download`)).status === 404);
  check('employee cannot see the other company', (await emp.get(`/api/companies/${other.data.companyId}/documents`)).status === 404);

  const ar = await emp.post(`/api/tasks/${taskId}/access-requests`, { category_ids: [gst], reason: 'Need GST docs to reconcile' });
  check('access request', ar.status === 201);
  check('access request: unknown category 400', (await emp.post(`/api/tasks/${taskId}/access-requests`, { category_ids: ['nope'], reason: 'Need GST docs' })).status === 400);
  const queue = await mgr.get('/api/access-requests');
  check('manager sees the request', queue.data.length === 1 && queue.data[0].employee === 'Sajal' && queue.data[0].task_title, queue.data);
  check('employee cannot decide', (await emp.post(`/api/access-requests/${ar.data.id}/decide`, { decision: 'grant' })).status === 403);
  check('manager grants', (await mgr.post(`/api/access-requests/${ar.data.id}/decide`, { decision: 'grant' })).status === 200);
  check('decided twice 409', (await mgr.post(`/api/access-requests/${ar.data.id}/decide`, { decision: 'grant' })).status === 409);
  check('employee now sees both categories', (await emp.get(`/api/companies/${companyId}/documents`)).data.length === 2);

  check('start task', (await emp.post(`/api/tasks/${taskId}/start`)).status === 200);
  check('start again 409', (await emp.post(`/api/tasks/${taskId}/start`)).status === 409);
  check('timer start on task', (await emp.post('/api/time/start', { task_id: taskId })).status === 201);
  check('heartbeat', (await emp.post('/api/time/heartbeat', { idle: false })).data.running === true);
  const cur = await emp.get('/api/time/current');
  check('current timer shows task + company', cur.data.running?.task?.company === 'Mehta Traders Pvt Ltd', cur.data);
  check('switching timer stops the first', (await emp.post('/api/time/start', { category: 'Admin' })).status === 201);
  check('stop timer', !!(await emp.post('/api/time/stop')).data.stopped);
  const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const manual = await emp.post('/api/time/manual', { task_id: taskId, date: yesterday, minutes: 180, note: 'Reconciled ITC offline' });
  check('long manual entry needs approval', manual.status === 201 && manual.data.needsApproval, manual.data);
  const today = new Date().toISOString().slice(0, 10);
  const entries = await emp.get(`/api/time/entries?from=${yesterday}&to=${today}`);
  check('entries list with task names', entries.data.length === 3 && entries.data.some((e: any) => e.task === 'GSTR-3B October'), entries.data);
  check('nobody approves their own time', (await emp.post(`/api/time/${manual.data.id}/decide`, { decision: 'approve' })).status === 403);
  const report = await dir.get(`/api/time/report?from=${yesterday}&to=${today}`);
  check('report: pending entry and per-user rows', report.data.pending.length === 1 && report.data.byUser.length === 1, report.data);
  check('director approves manual time', (await dir.post(`/api/time/${manual.data.id}/decide`, { decision: 'approve' })).status === 200);
  const report2 = await dir.get(`/api/time/report?from=${yesterday}&to=${today}`);
  check('report: by company + over estimate', report2.data.byCompany[0]?.company === 'Mehta Traders Pvt Ltd' && report2.data.overEstimate.length === 1, report2.data);

  check('submit needs a note', (await emp.post(`/api/tasks/${taskId}/submit`, { note: 'x' })).status === 400);
  check('submit', (await emp.post(`/api/tasks/${taskId}/submit`, { note: 'Filed and reconciled' })).status === 200);
  check('review queue for manager', (await mgr.get('/api/tasks?view=review')).data.length === 1);
  const detailT = await mgr.get(`/api/tasks/${taskId}`);
  check('task detail: events, grants, can.review', detailT.data.events.length === 3 && detailT.data.grants.length === 2 && detailT.data.can.review && detailT.data.creator === 'Krishna', detailT.data);
  check('reject needs a reason', (await mgr.post(`/api/tasks/${taskId}/reject`, { comment: 'no' })).status === 400);
  check('reject → rework', (await mgr.post(`/api/tasks/${taskId}/reject`, { comment: 'Fix the ITC figure' })).status === 200);
  await emp.post(`/api/tasks/${taskId}/start`);
  await emp.post(`/api/tasks/${taskId}/submit`, { note: 'Fixed ITC' });
  check('approve', (await mgr.post(`/api/tasks/${taskId}/approve`, { client_note: 'GSTR-3B filed for October.' })).status === 200);
  check('access ends on approval', (await emp.get(`/api/documents/${up.data[0].id}/download`)).status === 404);
  check('rework count recorded', (await dir.get(`/api/tasks/${taskId}`)).data.rework_count === 1);

  // --- Client ---
  check('client signs in with code', (await cli.client('9876543210')).status === 200);
  check('client blocked until consent', (await cli.get('/api/companies')).status === 403);
  const notice = await cli.get('/api/privacy/notice');
  check('notice shows the grievance officer', notice.data.grievanceOfficer.name === 'Krishna Mittal', notice.data);
  check('consent without service refused', (await cli.post('/api/privacy/consent', { purposes: ['updates'], version: notice.data.version })).status === 400);
  check('consent given', (await cli.post('/api/privacy/consent', { purposes: ['service', 'updates'], version: notice.data.version })).status === 201);
  const cc = await cli.get('/api/companies');
  check('client sees both group companies, no internal fields', cc.data.length === 2 && !('manager_id' in cc.data[0]), cc.data);
  const ct = await cli.get('/api/tasks');
  check('client sees friendly status + note', ct.data[0]?.status === 'Completed' && ct.data[0].client_note, ct.data);
  check('client raises a request', (await cli.post('/api/tasks/request', { company_id: companyId, title: 'Need a turnover certificate' })).status === 201);
  check('client cannot see other company', (await cli.get(`/api/companies/${other.data.companyId}/documents`)).status === 404);
  const cd = await cli.get(`/api/companies/${companyId}/documents`);
  check('client sees docs with staff names hidden', cd.data.length === 2 && cd.data[0].uploaded_by_name === 'Infominer team', cd.data);
  const cup = await cli.post(`/api/companies/${companyId}/documents`, upload(bank, 'May bank.pdf', Buffer.from('%PDF-1.4\nmay\n%%EOF\n')));
  check('client uploads', cup.status === 201);
  check('client deletes own upload', (await cli.del(`/api/documents/${cup.data[0].id}`)).status === 200);
  check('client cannot delete staff upload', (await cli.del(`/api/documents/${up.data[0].id}`)).status === 403);
  const cdash = await cli.get('/api/dashboard');
  check('client dashboard', cdash.data.openTasks === 1 && cdash.data.recentlyCompleted.length === 1, cdash.data);
  const mine = await cli.get('/api/privacy/mine');
  check('privacy/mine: purposes as JSON string', JSON.parse(mine.data.consents[0].purposes).includes('service'), mine.data);
  check('raise a DPDP request', (await cli.post('/api/privacy/requests', { type: 'correction', details: 'Update my email address' })).status === 201);
  const myData = await cli.get('/api/privacy/my-data');
  check('my-data export', myData.data.profile?.name === 'Ravi Mehta' && !('password_hash' in myData.data.profile), myData.data.profile);

  // --- Requests + dashboards ---
  const reqs = await dir.get('/api/tasks?view=requests');
  check('director sees the client request', reqs.data.length === 1);
  check('assign the request', (await dir.post(`/api/tasks/${reqs.data[0].id}/assign`, { type: 'Certificate', title: 'Turnover certificate', assignee_id: empId, reviewer_id: mgrId, due_date: '2026-12-01' })).status === 200);
  const ddash = await dir.get('/api/dashboard');
  check('director dashboard counts', ddash.data.upcoming.length >= 1 && ddash.data.privacyOpen === 1 && typeof ddash.data.pendingDocs === 'number', ddash.data);
  const edash = await emp.get('/api/dashboard');
  check('employee dashboard', edash.data.myOpenTasks === 1 && edash.data.toReview === 0, edash.data);

  // --- Privacy admin + breaches ---
  const dpdp = await dir.get('/api/privacy/requests');
  check('director sees DPDP requests with names', dpdp.data[0]?.user_name === 'Ravi Mehta', dpdp.data);
  check('closing needs a response', (await dir.patch(`/api/privacy/requests/${dpdp.data[0].id}`, { status: 'closed' })).status === 400);
  check('close request', (await dir.patch(`/api/privacy/requests/${dpdp.data[0].id}`, { status: 'closed', response: 'Email updated.' })).status === 200);
  check('unknown request 404', (await dir.patch('/api/privacy/requests/nope', { status: 'in_progress' })).status === 404);
  const br = await dir.post('/api/privacy/breaches', { detected_at: '2026-11-01T10:00', description: 'Laptop lost with cached files', data_affected: 'Bank statements' });
  check('record breach', br.status === 201);
  check('update breach', (await dir.patch(`/api/privacy/breaches/${br.data.id}`, { status: 'contained', board_intimated: true })).status === 200);
  const breaches = await dir.get('/api/privacy/breaches');
  check('breach list', breaches.data[0]?.board_intimated_at && breaches.data[0].created_by_name === 'Krishna', breaches.data);

  // --- Withdraw consent signs the client out ---
  const wd = await cli.post('/api/privacy/consent/withdraw', { purposes: ['service'] });
  check('withdrawing service consent signs out', wd.data.signedOut === true, wd.data);
  check('client session gone', (await cli.get('/api/auth/me')).data.user === null);

  // --- Audit ---
  const audit = await dir.get('/api/audit');
  check('audit log has entries with actor names', audit.data.length > 30 && audit.data.some((a: any) => a.actor === 'Sajal'), audit.data.length);
  const auditDocs = await dir.get('/api/audit?action=document.');
  check('audit filter by action', auditDocs.data.length > 0 && auditDocs.data.every((a: any) => a.action.startsWith('document.')));
  check('audit paging with before', (await dir.get(`/api/audit?before=${audit.data[5].seq}`)).data[0].seq === audit.data[6].seq);
  check('audit chain verifies', (await dir.get('/api/audit/verify')).data.ok === true);
  check('employee cannot read audit', (await emp.get('/api/audit')).status === 403);

  // --- Password + disabling ---
  check('change password: wrong current', (await emp.post('/api/me/password', { current: 'nope', next: 'newpassword123' })).status === 400);
  check('change password', (await emp.post('/api/me/password', { current: PW, next: 'newpassword123' })).status === 200);
  check('cannot disable yourself', (await dir.patch(`/api/users/${dirId}/status`, { status: 'disabled' })).status === 400);
  check('disable employee', (await dir.patch(`/api/users/${empId}/status`, { status: 'disabled' })).status === 200);
  check('disabled employee is signed out', (await emp.get('/api/auth/me')).data.user === null);
  check('Tally routes are not on Firestore', (await dir.get('/api/tally/agents')).status === 404);
} catch (e) {
  fail++; console.error(e);
} finally {
  server.close();
  await db.terminate();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
