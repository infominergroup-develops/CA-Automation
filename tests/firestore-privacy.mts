/**
 * Proves the DPDP tooling on Firestore: data-principal requests, breach register, consent withdrawal, and
 * the "download my data" export. Run: npm run test:fs:privacy   (emulator on 8089)
 */
import { db } from '../server/firestore/client.ts';
import { ensureSettingDefaults, getSetting } from '../server/firestore/settings.ts';
import { createClientUser } from '../server/firestore/users.ts';
import { giveConsent, withdrawConsent, hasCurrentConsent } from '../server/firestore/consents.ts';
import { createDocument } from '../server/firestore/documents.ts';
import { audit } from '../server/firestore/audit.ts';
import { raiseRequest, requestsForUser, allRequests, updateRequest, recordBreach, listBreaches, updateBreach, exportMyData } from '../server/firestore/privacy.ts';
import { C } from '../server/firestore/types.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };
async function wipe(col: string) { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
for (const c of [C.users, C.uniqueEmail, C.uniqueMobile, C.consents, C.dpdpRequests, C.breachRegister, C.documents, C.audit, C.counters, C.clientGroups]) await wipe(c);
await ensureSettingDefaults();

await db.collection(C.clientGroups).doc('g1').set({ name: 'Demo Group' });
const cli = await createClientUser({ name: 'Ravi Shah', mobile: '9000000004', email: 'ravi@demo.test', clientGroupId: 'g1' });
const MGR = 'mgr-1';

// --- Data-principal requests
const reqId = await raiseRequest(cli, 'correction', 'Please correct my email address.');
const req = (await requestsForUser(cli))[0];
check('request raised as open with a due date', req.status === 'open' && !!req.due_at);
check('due date respects dpdp_response_days', Math.round((Date.parse(req.due_at) - Date.now()) / 86400e3) === Number(await getSetting('dpdp_response_days')));
check('director sees it in the queue', (await allRequests()).some((r) => r.id === reqId));
await updateRequest(reqId, MGR, 'in_progress');
check('marked in progress (not closed yet)', (await requestsForUser(cli))[0].status === 'in_progress');
await updateRequest(reqId, MGR, 'closed', 'Email updated as requested.');
const closed = (await requestsForUser(cli))[0];
check('closed with a response + timestamp', closed.status === 'closed' && closed.response === 'Email updated as requested.' && !!closed.closed_at);

// --- Breach register
const bId = await recordBreach({ detected_at: new Date().toISOString(), description: 'Laptop with cached statements lost.', data_affected: 'bank statements of 2 clients', principals_affected: 2, created_by: MGR });
check('breach recorded as open', (await listBreaches())[0].status === 'open');
await updateBreach(bId, { boardIntimated: true });
await updateBreach(bId, { principalsNotified: true, status: 'contained' });
const b = (await listBreaches())[0];
check('breach steps recorded', !!b.board_intimated_at && !!b.principals_notified_at && b.status === 'contained');

// --- Consent withdrawal
const version = await getSetting('privacy_notice_version');
await giveConsent(cli, ['service', 'updates'], version, '1.2.3.4');
const w1 = await withdrawConsent(cli, ['updates']);
check('withdrawing a non-essential purpose keeps service', !w1.lostService && (await hasCurrentConsent(cli)));
const w2 = await withdrawConsent(cli, ['service']);
check('withdrawing service ends portal access', w2.lostService && !(await hasCurrentConsent(cli)));

// --- Export my data (right to access)
await createDocument({ companyId: 'co-1', categoryId: 'bank-statements', fy: '2026-27', month: 9, name: 'stmt.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF data'), uploadedBy: cli });
await audit({ actorId: cli, actorRole: 'client', action: 'document.uploaded', ip: '1.2.3.4' });
const data = await exportMyData(cli) as any;
check('export has profile without the password hash', data.profile?.mobile === '9000000004' && !('password_hash' in data.profile));
check('export lists uploads', data.uploads.length === 1 && data.uploads[0].original_name === 'stmt.pdf');
check('export lists consent history', data.consents.length >= 1);
check('export includes activity (audit) for the person', data.activity.length >= 1);

console.log(`\n${pass} passed, ${fail} failed`);
await db.terminate();
process.exit(fail ? 1 : 0);
