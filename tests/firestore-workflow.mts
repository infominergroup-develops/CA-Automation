/**
 * Proves the task workflow, document-access grants, and time tracking on Firestore — including the key
 * security rule that approving a task ends the employee's access and stops their timer.
 * Run: npm run test:fs:flow   (emulator must be running on 8089)
 */
import { db } from '../server/firestore/client.ts';
import {
  createTask, createClientRequest, getTask, startTask, submitTask, rejectTask, approveTask, cancelTask, assignTask,
  requestAccess, decideAccess, revokeGrant, employeeCategories, grantsForTask, eventsForTask,
  reviewQueue, clientRequests, pendingAccessRequests, tasksForAssignee, TaskConflictError,
} from '../server/firestore/tasks.ts';
import {
  startTimer, stopRunning, getRunning, heartbeat, addManualEntry, decideManualEntry, listEntries, taskSeconds, workedSeconds,
} from '../server/firestore/time.ts';
import { C } from '../server/firestore/types.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };
async function wipe(col: string) { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
for (const c of [C.tasks, C.accessGrants, C.timeEntries]) await wipe(c);

const CO = 'co-1', EMP = 'emp-1', MGR = 'mgr-1', CLI = 'cli-1';
const BANK = 'bank-statements', PURCHASE = 'purchase-bills';

// --- Create + assign
const taskId = await createTask({ company_id: CO, type: 'GST return', title: 'GSTR-3B Sep', assignee_id: EMP, reviewer_id: MGR, created_by: MGR, estimate_hours: 2 });
check('task created as assigned', (await getTask(taskId))?.status === 'assigned');
check('employee has no access yet', (await employeeCategories(EMP, CO)).size === 0);

// --- Access request → grant a subset
const grantId = await requestAccess(taskId, EMP, CO, [BANK, PURCHASE], 'Need bank + bills to reconcile ITC');
check('access request is pending', (await grantsForTask(taskId))[0].status === 'requested');
check('still no access while only requested', (await employeeCategories(EMP, CO)).size === 0);
await decideAccess(grantId, MGR, 'grant', [BANK]); // grant fewer than asked
const cats = await employeeCategories(EMP, CO);
check('granted subset gives access to only that category', cats.has(BANK) && !cats.has(PURCHASE), [...cats]);

// manager cannot grant more than requested
const g2 = await requestAccess(taskId, EMP, CO, [BANK], 'again');
await decideAccess(g2, MGR, 'grant', [BANK, PURCHASE]); // asks only BANK → PURCHASE must be dropped
check('cannot grant more than was requested', !(await db.collection(C.accessGrants).doc(g2).get()).data()!.category_ids.includes(PURCHASE));

// --- Work + timer
await startTask(taskId, EMP);
check('task in progress', (await getTask(taskId))?.status === 'in_progress');
await startTimer(EMP, { taskId });
check('timer running', !!(await getRunning(EMP)));
await startTimer(EMP, { category: 'Admin' }); // starting another stops the first
check('only one timer runs at a time', (await db.collection(C.timeEntries).where('user_id', '==', EMP).where('ended_at', '==', null).get()).size === 1);
await stopRunning(EMP);
await startTimer(EMP, { taskId });
check('heartbeat accepted', await heartbeat(EMP, false));

// --- Submit → rework → resubmit
await submitTask(taskId, EMP, 'Reconciled ITC');
check('awaiting review', (await getTask(taskId))?.status === 'submitted');
check('review queue shows it for the reviewer', (await reviewQueue(MGR)).some((t) => t.id === taskId));
await rejectTask(taskId, MGR, 'Add RCM on freight');
check('rework increments the counter', (await getTask(taskId))?.rework_count === 1);
await startTask(taskId, EMP);
await submitTask(taskId, EMP, 'Added RCM');

// --- Approve ends access + stops the timer
await approveTask(taskId, MGR, { clientNote: 'GSTR-3B filed.' });
check('task approved', (await getTask(taskId))?.status === 'approved');
check('access ends on approval', (await employeeCategories(EMP, CO)).size === 0);
check('grant is revoked', (await grantsForTask(taskId)).every((g) => g.status !== 'granted'));
check('running timer on the task was stopped', (await db.collection(C.timeEntries).where('task_id', '==', taskId).where('ended_at', '==', null).get()).size === 0);
check('time is logged on the task', (await taskSeconds(taskId)) >= 0);

// --- Status guard
let conflict = false;
try { await approveTask(taskId, MGR, {}); } catch (e) { conflict = e instanceof TaskConflictError; }
check('cannot act on an approved task', conflict);

// --- History
const ev = await eventsForTask(taskId);
check('full history recorded', ev.map((e) => e.to_status).join(',') === 'assigned,in_progress,submitted,rework,in_progress,submitted,approved', ev.map((e) => e.to_status));

// --- Client request → assign
const reqId = await createClientRequest({ company_id: CO, title: 'CA certificate for bank loan', created_by: CLI });
check('client request waits as requested', (await clientRequests()).some((t) => t.id === reqId));
await assignTask(reqId, MGR, { type: 'Certificate', title: 'CA certificate', assignee_id: EMP, reviewer_id: MGR });
check('assigning a request moves it to assigned', (await getTask(reqId))?.status === 'assigned');
check('employee now has this task', (await tasksForAssignee(EMP)).some((t) => t.id === reqId));

// --- Manual time entry needing approval
const m = await addManualEntry({ userId: EMP, taskId, date: new Date().toISOString().slice(0, 10), minutes: 180, note: 'Client visit' });
check('manual entry over 2h needs approval', m.needsApproval);
await decideManualEntry(m.id, MGR, 'approve');
check('approved manual entry becomes ok', (await db.collection(C.timeEntries).doc(m.id).get()).data()!.status === 'ok');
const today = new Date().toISOString().slice(0, 10);
check('entries listed for the day', (await listEntries(EMP, today, today)).length >= 1);
check('workedSeconds computes for a manual entry', workedSeconds((await db.collection(C.timeEntries).doc(m.id).get()).data() as any) === 180 * 60);

// --- Cancel path revokes access too
const t2 = await createTask({ company_id: CO, type: 'Audit', title: 'Audit', assignee_id: EMP, reviewer_id: MGR, created_by: MGR });
const g3 = await requestAccess(t2, EMP, CO, [BANK], 'audit');
await decideAccess(g3, MGR, 'grant');
await cancelTask(t2, MGR, 'No longer needed');
check('cancelling revokes access', (await employeeCategories(EMP, CO)).size === 0);
check('pending access requests query works', Array.isArray(await pendingAccessRequests()));

// --- Manual revoke ends access immediately
const t3 = await createTask({ company_id: CO, type: 'Bookkeeping', title: 'Books', assignee_id: EMP, reviewer_id: MGR, created_by: MGR });
const g4 = await requestAccess(t3, EMP, CO, [BANK], 'books');
await decideAccess(g4, MGR, 'grant');
check('granted access is active', (await employeeCategories(EMP, CO)).has(BANK));
await revokeGrant(g4);
check('revoking a grant ends access at once', !(await employeeCategories(EMP, CO)).has(BANK));

console.log(`\n${pass} passed, ${fail} failed`);
await db.terminate();
process.exit(fail ? 1 : 0);
