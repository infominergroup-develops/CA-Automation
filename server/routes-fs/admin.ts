import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.ts';
import { zEmail, zGstin, zId, zMobile, zPan, zText, zUsername } from '../shared.ts';
import { passwordProblem } from '../security/crypto.ts';
import { assertCompany, companyScope, userNames } from '../firestore/authz.ts';
import { db } from '../firestore/client.ts';
import { HttpError, auditReq, h, parse, requireAuth, requireRole, type SessionUser } from '../firestore/http.ts';
import { endAllSessions } from '../firestore/sessions.ts';
import { getSettings, setSetting } from '../firestore/settings.ts';
import { getById, newId, now, query } from '../firestore/store.ts';
import { FolderExistsError, addCategory, listCategories, segment, type DocumentDoc } from '../firestore/documents.ts';
import { checkPassword } from '../firestore/firebase-auth.ts';
import {
  UniquenessError, ackMonitoringNotice, createClientLogin, createStaffLogin, getUserById, setUserStatus, updatePassword,
} from '../firestore/users.ts';
import { C, type AccessGrantDoc, type ClientGroupDoc, type CompanyDoc, type DesignationDoc, type TaskDoc, type UserDoc } from '../firestore/types.ts';
import { OPEN_STATUSES } from '../firestore/tasks.ts';

export const adminRouter = Router();

const duplicate = (e: unknown, msg: string) => { if (e instanceof UniquenessError) throw new HttpError(409, msg); throw e; };

/* ---------- Staff users ---------- */

adminRouter.get('/users', requireRole('director', 'manager', 'employee'), h(async (req, res) => {
  const ROLE_ORDER = ['director', 'employee', 'manager']; // alphabetical, as the SQLite build sorts
  const titles = new Map((await query<DesignationDoc>(C.designations)).map((d) => [d.id, d.name]));
  const rows = (await query<UserDoc>(C.users))
    .filter((u) => u.role !== 'client' && (req.user!.role === 'director' || u.status === 'active'))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name))
    .map(({ id, role, name, email, mobile, status, created_at, client_ids, designation_id, all_clients, username }) => ({
      id, role, name, email, mobile, status, created_at, username: username ?? null,
      designation_id: designation_id ?? null, designation: (designation_id && titles.get(designation_id)) || null,
      ...(req.user!.role === 'director' && { client_ids: client_ids ?? [], ...(role === 'manager' && { all_clients: all_clients !== false }) }),
    }));
  // Employees only need to name a client's relationship manager.
  if (req.user!.role === 'employee') {
    return res.json(rows.filter((u) => u.role !== 'employee').map(({ id, role, name, status }) => ({ id, role, name, status })));
  }
  res.json(rows);
}));

const newStaff = z.object({
  name: zText(120).min(2),
  role: z.enum(['director', 'manager', 'employee']),
  email: zEmail,
  mobile: zMobile,
  password: z.string().min(12).max(200),
  username: zUsername.optional().or(z.literal('').transform(() => undefined)),
});

adminRouter.post('/users', requireRole('director', 'manager'), h(async (req, res) => {
  const b = parse(newStaff, req.body);
  if (req.user!.role === 'manager' && b.role !== 'employee') throw new HttpError(403, 'Managers can only add employees.');
  const problem = passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  const { id: userId, username } = await createStaffLogin({ ...b, createdBy: req.user!.id })
    .catch((e) => duplicate(e, 'This username is taken. Choose another.'));
  await auditReq(req, { action: 'user.created', objectType: 'user', objectId: userId, details: { role: b.role, username } });
  res.status(201).json({ id: userId, username });
}));

adminRouter.patch('/users/:id/status', requireRole('director'), h(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
  const target = await getUserById(String(req.params.id));
  if (!target) throw new HttpError(404, 'Not found.');
  if (target.id === req.user!.id) throw new HttpError(400, 'You cannot disable your own account.');
  await setUserStatus(target.id, status);
  if (status === 'disabled') {
    await endAllSessions(target.id);
    // Disabling someone removes any document access they still hold.
    const grants = await query<AccessGrantDoc>(C.accessGrants, { where: [['employee_id', '==', target.id]] });
    await Promise.all(grants.filter((g) => g.status === 'requested' || g.status === 'granted')
      .map((g) => db.collection(C.accessGrants).doc(g.id).update({ status: 'revoked', decided_at: now() })));
  }
  await auditReq(req, { action: `user.${status === 'active' ? 'enabled' : 'disabled'}`, objectType: 'user', objectId: target.id });
  res.json({ ok: true });
}));

// Each try checks the current password, so it is limited like sign-in.
const passwordLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

/** Anyone signed in changes their own password; clients too while they sign in with one (one-time codes off). */
adminRouter.post('/me/password', requireAuth, passwordLimiter, h(async (req, res) => {
  const b = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
  if (req.user!.role === 'client' && config.otpProvider !== 'off') throw new HttpError(400, 'Clients sign in with a one-time code.');
  if (!(await checkPassword(await getUserById(req.user!.id), b.current))) throw new HttpError(400, 'Current password is incorrect.');
  const problem = passwordProblem(b.next);
  if (problem) throw new HttpError(400, problem);
  await updatePassword(req.user!.id, b.next);
  await endAllSessions(req.user!.id, req.sessionHash); // sign out every other device
  await auditReq(req, { action: 'user.password_changed', objectType: 'user', objectId: req.user!.id });
  res.json({ ok: true });
}));

/** Staff acknowledge, once, what the portal records about their work (DPDP Act notice to employees). */
adminRouter.post('/me/monitoring-ack', requireRole('director', 'manager', 'employee'), h(async (req, res) => {
  await ackMonitoringNotice(req.user!.id);
  await auditReq(req, { action: 'privacy.monitoring_notice_ack', objectType: 'user', objectId: req.user!.id });
  res.json({ ok: true });
}));

/* ---------- Clients and companies ---------- */

const optional = <T extends z.ZodType>(s: T) => s.optional().or(z.literal('').transform(() => undefined));
const companyFields = z.object({
  legal_name: zText(200).min(2),
  pan: optional(zPan),
  gstin: optional(zGstin),
  tally_name: zText(200).optional(),
  manager_id: zId.optional(),
});
// Firebase accounts are email-based, so every login needs one.
const contactFields = z.object({
  name: zText(120).min(2), mobile: zMobile, email: zEmail, password: z.string().max(200).optional(),
  username: zUsername.optional().or(z.literal('').transform(() => undefined)), // made from the email when left out
});

/** Each client's files live in a bucket folder named after it, so two clients may not share a folder name. */
// shortcut: check-then-write, so two simultaneous creates could both pass; reserve the name in a transaction if that ever matters.
async function checkFolderName(legalName: string) {
  const folder = segment(legalName).toLowerCase();
  if ((await query<CompanyDoc>(C.companies)).some((c) => segment(c.legal_name).toLowerCase() === folder)) {
    throw new HttpError(409, 'Another client already has this name. Add something to tell them apart, such as the city.');
  }
}

/** While OTP is off a client signs in with the password the firm sets, so it is required and must be strong. */
function clientPassword(pw: string | undefined): string | undefined {
  if (config.otpProvider !== 'off') return undefined;
  const problem = pw ? passwordProblem(pw) : 'Set a password for the client to sign in with.';
  if (problem) throw new HttpError(400, problem);
  return pw;
}

/** 404 unless the user may see at least one company in the client group. */
async function assertGroupInScope(u: SessionUser, groupId: string) {
  const scope = await companyScope(u);
  if (!scope) return;
  const companies = await query<CompanyDoc>(C.companies, { where: [['group_id', '==', groupId]] });
  if (!companies.some((c) => scope.includes(c.id))) throw new HttpError(404, 'Not found.');
}

async function checkManager(managerId: string | undefined) {
  if (!managerId) return;
  const m = await getUserById(managerId);
  if (!m || !['manager', 'director'].includes(m.role) || m.status !== 'active') throw new HttpError(400, 'Assigned manager not found.');
}

const companyDoc = (id: string, groupId: string, b: z.infer<typeof companyFields>, managerId: string | undefined, by: string): CompanyDoc => ({
  id, group_id: groupId, legal_name: b.legal_name, pan: b.pan ?? null, gstin: b.gstin ?? null,
  tally_name: b.tally_name ?? null, manager_id: managerId ?? null, created_at: now(), created_by: by,
});

adminRouter.post('/clients', requireRole('director', 'manager', 'employee'), h(async (req, res) => {
  // No contact = a client whose files the firm keeps without giving them a portal login (one can be added later).
  const b = parse(z.object({
    group_name: zText(200).min(2), company: companyFields, contact: contactFields.optional(),
    work_types: z.array(z.string().max(80)).max(50).optional().transform((a) => [...new Set(a ?? [])]),
  }), req.body);
  const managerId = b.company.manager_id ?? (req.user!.role === 'manager' ? req.user!.id : undefined);
  // Without one, no manager could see a client an employee added.
  if (req.user!.role === 'employee' && !managerId) throw new HttpError(400, 'Choose a relationship manager.');
  await checkManager(managerId);
  await checkFolderName(b.company.legal_name);
  const contact = b.contact;
  const password = contact ? clientPassword(contact.password) : undefined;
  if (b.work_types.length) {
    const known = new Set((await query<{ id: string }>(C.workTypes)).map((w) => w.id));
    if (!b.work_types.every((w) => known.has(w))) throw new HttpError(400, 'Unknown work type.');
  }
  const groupId = newId(), companyId = newId();
  // The login first: it is the step that can fail (a username already taken), before anything else is written.
  const login = contact
    ? await createClientLogin({ name: contact.name, mobile: contact.mobile, email: contact.email, username: contact.username, clientGroupId: groupId, createdBy: req.user!.id, password })
      .catch((e) => duplicate(e, 'This username is taken. Choose another.'))
    : null;
  const userId = login?.id ?? null;
  const batch = db.batch();
  batch.set(db.collection(C.clientGroups).doc(groupId), { id: groupId, name: b.group_name, created_at: now(), created_by: req.user!.id } satisfies ClientGroupDoc);
  batch.set(db.collection(C.companies).doc(companyId), { ...companyDoc(companyId, groupId, b.company, managerId, req.user!.id), work_types: b.work_types });
  await batch.commit();
  await auditReq(req, { action: 'client.created', objectType: 'client_group', objectId: groupId, companyId, details: { login: !!contact, work_types: b.work_types } });
  res.status(201).json({ groupId, companyId, userId, username: login?.username ?? null });
}));

adminRouter.post('/clients/:groupId/companies', requireRole('director', 'manager'), h(async (req, res) => {
  const b = parse(companyFields, req.body);
  const group = await getById<ClientGroupDoc>(C.clientGroups, String(req.params.groupId));
  if (!group) throw new HttpError(404, 'Not found.');
  if (req.user!.role === 'manager') {
    const mine = await query<CompanyDoc>(C.companies, { where: [['group_id', '==', group.id], ['manager_id', '==', req.user!.id]], limit: 1 });
    if (!mine.length) throw new HttpError(404, 'Not found.');
  }
  const managerId = b.manager_id ?? (req.user!.role === 'manager' ? req.user!.id : undefined);
  await checkManager(managerId);
  await checkFolderName(b.legal_name);
  const companyId = newId();
  await db.collection(C.companies).doc(companyId).set(companyDoc(companyId, group.id, b, managerId, req.user!.id));
  await auditReq(req, { action: 'company.created', objectType: 'company', objectId: companyId, companyId });
  res.status(201).json({ id: companyId });
}));

adminRouter.post('/clients/:groupId/users', requireRole('director', 'manager'), h(async (req, res) => {
  const b = parse(contactFields, req.body);
  const group = await getById<ClientGroupDoc>(C.clientGroups, String(req.params.groupId));
  if (!group) throw new HttpError(404, 'Not found.');
  await assertGroupInScope(req.user!, group.id);
  const password = clientPassword(b.password);
  const { id: userId, username } = await createClientLogin({ name: b.name, mobile: b.mobile, email: b.email, username: b.username, clientGroupId: group.id, createdBy: req.user!.id, password })
    .catch((e) => duplicate(e, 'This username is taken. Choose another.'));
  await auditReq(req, { action: 'client.user_added', objectType: 'user', objectId: userId, details: { username } });
  res.status(201).json({ id: userId, username });
}));

/** Sets or resets a client's sign-in password (clients use one while OTP is off). Signs them out everywhere. */
adminRouter.post('/users/:id/password', requireRole('director', 'manager'), h(async (req, res) => {
  const { password } = parse(z.object({ password: z.string().max(200) }), req.body);
  const target = await getUserById(String(req.params.id));
  if (!target || target.role !== 'client' || !target.client_group_id) throw new HttpError(404, 'Not found.');
  await assertGroupInScope(req.user!, target.client_group_id);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  await updatePassword(target.id, password);
  await endAllSessions(target.id);
  await auditReq(req, { action: 'user.password_set', objectType: 'user', objectId: target.id });
  res.json({ ok: true });
}));

adminRouter.get('/companies', requireAuth, h(async (req, res) => {
  const u = req.user!;
  const scope = await companyScope(u);
  const [companies, groups] = await Promise.all([
    query<CompanyDoc>(C.companies),
    query<ClientGroupDoc>(C.clientGroups),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const visible = companies.filter((c) => !scope || scope.includes(c.id))
    .map((c) => ({ ...c, group_name: groupName.get(c.group_id) ?? '' }))
    .sort((a, b) => a.group_name.localeCompare(b.group_name) || a.legal_name.localeCompare(b.legal_name));
  // Clients and employees do not need internal fields.
  if (u.role === 'client' || u.role === 'employee') {
    return res.json(visible.map(({ id, legal_name, group_name, gstin, work_types }) => ({ id, legal_name, group_name, gstin, ...(u.role === 'employee' && { work_types: work_types ?? [] }) })));
  }
  const [users, pendingDocs, openTasks] = await Promise.all([
    userNames(),
    query<DocumentDoc>(C.documents, { where: [['review_status', '==', 'pending'], ['deleted_at', '==', null]] }),
    query<TaskDoc>(C.tasks, { where: [['status', 'in', OPEN_STATUSES]] }),
  ]);
  const count = (rows: { company_id: string }[], id: string) => rows.filter((r) => r.company_id === id).length;
  res.json(visible.map((c) => ({
    id: c.id, legal_name: c.legal_name, pan: c.pan, gstin: c.gstin, tally_name: c.tally_name, group_id: c.group_id,
    group_name: c.group_name, manager_id: c.manager_id, manager_name: c.manager_id ? users.get(c.manager_id)?.name ?? null : null,
    pending_docs: count(pendingDocs, c.id), open_tasks: count(openTasks, c.id), work_types: c.work_types ?? [],
  })));
}));

adminRouter.get('/companies/:id', requireRole('director', 'manager'), h(async (req, res) => {
  const c = await assertCompany(req.user!, String(req.params.id));
  const [group, manager, contacts] = await Promise.all([
    getById<ClientGroupDoc>(C.clientGroups, c.group_id),
    c.manager_id ? getUserById(c.manager_id) : undefined,
    query<UserDoc>(C.users, { where: [['client_group_id', '==', c.group_id]] }),
  ]);
  res.json({
    company: { ...c, group_name: group?.name ?? '', manager_name: manager?.name ?? null },
    contacts: contacts.sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name, mobile, email, status, username }) => ({ id, name, mobile, email, status, username: username ?? null })),
  });
}));

/** A new document-type folder for every client, such as Bookkeeping. Any staff member (clients make folders inside these). */
adminRouter.post('/categories', requireRole('director', 'manager', 'employee'), h(async (req, res) => {
  const { name } = parse(z.object({ name: zText(60).min(2) }), req.body);
  const cat = await addCategory(name).catch((e) => { throw e instanceof FolderExistsError ? new HttpError(409, e.message) : e; });
  await auditReq(req, { action: 'category.created', objectType: 'category', objectId: cat.id, details: { name } });
  res.status(201).json({ id: cat.id, name: cat.name });
}));

adminRouter.get('/categories', requireAuth, h(async (_req, res) => {
  res.json((await listCategories()).map(({ id, name }) => ({ id, name })));
}));

/* ---------- Settings ---------- */

const SETTING_KEYS = ['firm_name', 'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone',
  'privacy_notice_version', 'dpdp_response_days'] as const;

adminRouter.get('/settings', requireRole('director'), h(async (_req, res) => {
  res.json(await getSettings([...SETTING_KEYS]));
}));

adminRouter.patch('/settings', requireRole('director'), h(async (req, res) => {
  const b = parse(z.object(Object.fromEntries(SETTING_KEYS.map((k) => [k, zText(200).optional()]))), req.body) as Record<string, string | undefined>;
  const changed = SETTING_KEYS.filter((k) => b[k] !== undefined);
  await Promise.all(changed.map((k) => setSetting(k, b[k]!)));
  // A new notice version makes every client accept the notice again on next sign-in.
  await auditReq(req, { action: 'settings.updated', details: { changed } });
  res.json({ ok: true });
}));
