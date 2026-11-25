/**
 * Proves the Firestore identity core, audit chain and consent against the emulator.
 * Run: npm run test:fs   (starts nothing — the emulator must already be running on 8089)
 */
import './emulator-only.mts';
import { db } from '../server/firestore/client.ts';
import { checkPassword, createAccount } from '../server/firestore/firebase-auth.ts';
import { createStaffUser, createClientUser, findUserByIdentifier, getUserById, isLocked, recordLoginFailure, setUserStatus, updatePassword, UniquenessError } from '../server/firestore/users.ts';
import { createChallenge, verifyChallenge } from '../server/firestore/challenges.ts';
import { createSession, loadValidSession, destroySession, endAllSessions } from '../server/firestore/sessions.ts';
import { audit, verifyAuditChain } from '../server/firestore/audit.ts';
import { giveConsent, hasCurrentConsent } from '../server/firestore/consents.ts';
import { ensureSettingDefaults, getSetting, setSetting } from '../server/firestore/settings.ts';
import { C } from '../server/firestore/types.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };

// Fresh slate: delete the collections this test touches.
async function wipe(col: string) { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
for (const c of [C.users, C.uniqueEmail, C.uniqueMobile, C.sessions, C.challenges, C.audit, C.counters, C.consents, C.settings, C.clientGroups]) await wipe(c);

await ensureSettingDefaults();

// --- Users + uniqueness
const dir = await createStaffUser({ role: 'director', name: 'Asha Rao', email: 'Asha@Demo.test', mobile: '+91 90000 00001', password: 'correct horse 99' });
check('staff user created', !!(await getUserById(dir)));
check('email normalised + found by email', (await findUserByIdentifier('asha@demo.test'))?.id === dir);
check('found by mobile (any format)', (await findUserByIdentifier('09000000001'))?.id === dir);
const asha = (await getUserById(dir))!;
check('password verifies', await checkPassword(asha, 'correct horse 99'));
check('wrong password rejected', !(await checkPassword(asha, 'nope')));
check('empty password rejected', !(await checkPassword(asha, '')));
check('unknown user rejected', !(await checkPassword(undefined, 'correct horse 99')));
check('no password or hash is stored in Firestore', !/hash|password/i.test(Object.keys(asha).join()));
await createAccount('someone-else', 'self@demo.test', 'Self', 'correct horse 99');
check('an account someone else registered with the same email is refused', !(await checkPassword({ id: 'our-user', email: 'self@demo.test' }, 'correct horse 99')));

let dupEmail = false, dupMobile = false;
try { await createStaffUser({ role: 'manager', name: 'X', email: 'asha@demo.test', mobile: '9000000099', password: 'another one 123' }); } catch (e) { dupEmail = e instanceof UniquenessError; }
try { await createStaffUser({ role: 'manager', name: 'Y', email: 'new@demo.test', mobile: '9000000001', password: 'another one 123' }); } catch (e) { dupMobile = e instanceof UniquenessError; }
check('duplicate email rejected atomically', dupEmail);
check('duplicate mobile rejected atomically', dupMobile);
check('failed creates left no partial user', (await db.collection(C.users).get()).size === 1);
check('failed creates left no Firebase account', !!(await createAccount('reuse', 'new@demo.test', 'Reuse', 'another one 123')));
await updatePassword(dir, 'changed horse 99');
check('changed password: new works, old does not', await checkPassword(asha, 'changed horse 99') && !(await checkPassword(asha, 'correct horse 99')));
await setUserStatus(dir, 'disabled');
check('disabled account cannot sign in', !(await checkPassword(asha, 'changed horse 99')));
await setUserStatus(dir, 'active');
check('re-enabled account can', await checkPassword(asha, 'changed horse 99'));

await db.collection(C.clientGroups).doc('g1').set({ name: 'Demo Traders Group', created_at: new Date().toISOString() });
const cli = await createClientUser({ name: 'Ravi', email: 'ravi@demo.test', mobile: '9000000004', clientGroupId: 'g1' });
check('client user without a password cannot use one', !(await checkPassword((await getUserById(cli))!, 'anything at all 1')));

// --- One-time code flow
const ch = await createChallenge(dir, '1.2.3.4');
check('wrong code fails', (await verifyChallenge(ch.challengeId, '000000')).ok === false);
check('correct code returns the user', (await verifyChallenge(ch.challengeId, ch.code) as any).userId === dir);
check('code is single-use', (await verifyChallenge(ch.challengeId, ch.code)).ok === false);
// lockout after max attempts
const ch2 = await createChallenge(dir, null);
for (let i = 0; i < 5; i++) await verifyChallenge(ch2.challengeId, '111111');
check('code locked after 5 wrong tries', (await verifyChallenge(ch2.challengeId, ch2.code) as any).reason === 'locked');
// unknown identifier still issues a challenge (no enumeration), but never verifies
const anon = await createChallenge(null, null);
check('unknown-identifier challenge never verifies', (await verifyChallenge(anon.challengeId, anon.code)).ok === false);

// --- Sessions
const token = await createSession(dir, '1.2.3.4', 'jest');
const loaded = await loadValidSession(token);
check('session loads for its token', loaded?.userId === dir);
check('garbage token rejected', (await loadValidSession('x')) === null);
await destroySession(loaded!.hash);
check('destroyed session is gone', (await loadValidSession(token)) === null);
const t1 = await createSession(dir, null, null), t2 = await createSession(dir, null, null);
await endAllSessions(dir);
check('endAllSessions clears every device', (await loadValidSession(t1)) === null && (await loadValidSession(t2)) === null);

// --- Account lockout
const victim = await createStaffUser({ role: 'employee', name: 'Lock Me', email: 'lock@demo.test', mobile: '9000000005', password: 'lock test 1234' });
for (let i = 0; i < 5; i++) await recordLoginFailure((await getUserById(victim))!);
check('account locks after 5 failed logins', isLocked((await getUserById(victim))!));

// --- Consent (DPDP)
const version = await getSetting('privacy_notice_version');
check('no consent initially', !(await hasCurrentConsent(cli)));
await giveConsent(cli, ['service'], version, '1.2.3.4');
check('consent recorded for current version', await hasCurrentConsent(cli));
await setSetting('privacy_notice_version', '2027-04-01');
check('new notice version invalidates old consent', !(await hasCurrentConsent(cli)));

// --- Audit chain
for (const a of [1, 2, 3, 4, 5]) await audit({ actorId: dir, actorRole: 'director', action: `test.event_${a}`, ip: '1.2.3.4', details: { n: a } });
const v1 = await verifyAuditChain();
check('audit chain intact after appends', v1.ok && v1.checked === 5, v1);
const t0 = Date.now();
await Promise.all(Array.from({ length: 12 }, (_, n) => audit({ actorId: dir, action: 'test.together', details: { n } })));
const v12 = await verifyAuditChain();
check('12 entries at once: all kept, chain intact, no pile-up', v12.ok && v12.checked === 17 && Date.now() - t0 < 10_000, { ...v12, ms: Date.now() - t0 });
let bad = false;
await Promise.all([audit({ action: undefined as unknown as string, details: { big: 1n } as never }).catch(() => { bad = true; }), audit({ action: 'test.after_failure' })]);
check('a failed entry reports its error and does not block the next', bad && (await verifyAuditChain()).checked === 18);
// tamper with an entry → chain must break
const first = (await db.collection(C.audit).orderBy('seq').limit(1).get()).docs[0];
await first.ref.update({ action: 'test.TAMPERED' });
const v2 = await verifyAuditChain();
check('tampering is detected', !v2.ok && v2.brokenAt === 1, v2);

console.log(`\n${pass} passed, ${fail} failed`);
await db.terminate();
process.exit(fail ? 1 : 0);
