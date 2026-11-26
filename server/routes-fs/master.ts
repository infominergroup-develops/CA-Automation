import { Router } from 'express';
import { z } from 'zod';
import { zId, zText } from '../shared.ts';
import { db } from '../firestore/client.ts';
import { HttpError, auditReq, h, parse, requireRole } from '../firestore/http.ts';
import { FieldValue, newId, now, query } from '../firestore/store.ts';
import { C, type ClientSetDoc, type CompanyDoc, type UserDoc, type WorkTypeDoc } from '../firestore/types.ts';

/** The client master: work types per client, named client groups given to staff, and clients ticked per employee. */
export const masterRouter = Router();
const director = requireRole('director');

const DEFAULT_WORK = ['GST', 'Income tax', 'TDS', 'Bookkeeping', 'Audit', 'ROC / MCA', 'Payroll'];
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** A starting list, written once when there is none. */
export async function ensureWorkTypes(): Promise<void> {
  if (!(await db.collection(C.workTypes).limit(1).get()).empty) return;
  const batch = db.batch();
  DEFAULT_WORK.forEach((name, i) => batch.set(db.collection(C.workTypes).doc(slug(name)), { id: slug(name), name, sort: i }));
  await batch.commit();
}

const ids = z.array(zId).max(5000).transform((a) => [...new Set(a)]);

/** Throws 400 unless every id is an existing client. */
async function checkCompanies(companyIds: string[]) {
  const known = new Set((await query<CompanyDoc>(C.companies)).map((c) => c.id));
  if (!companyIds.every((id) => known.has(id))) throw new HttpError(400, 'Unknown client.');
}

/* ---------- Work types ---------- */

masterRouter.get('/work-types', requireRole('director', 'manager', 'employee'), h(async (_req, res) => {
  res.json((await query<WorkTypeDoc>(C.workTypes)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)));
}));

masterRouter.post('/work-types', director, h(async (req, res) => {
  const { name } = parse(z.object({ name: zText(60).min(2) }), req.body);
  const id = slug(name);
  if (!id) throw new HttpError(400, 'Use letters or numbers in the name.');
  const doc: WorkTypeDoc = { id, name, sort: 1000 };
  await db.collection(C.workTypes).doc(id).create(doc).catch((e) => { throw e?.code === 6 ? new HttpError(409, `There is already a work type called ${name}.`) : e; });
  await auditReq(req, { action: 'master.work_type_added', objectType: 'work_type', objectId: id, details: { name } });
  res.status(201).json(doc);
}));

masterRouter.delete('/work-types/:id', director, h(async (req, res) => {
  const id = String(req.params.id);
  const tagged = await query<CompanyDoc>(C.companies, { where: [['work_types', 'array-contains', id]] });
  const batch = db.batch();
  batch.delete(db.collection(C.workTypes).doc(id));
  tagged.forEach((c) => batch.update(db.collection(C.companies).doc(c.id), { work_types: FieldValue.arrayRemove(id) }));
  await batch.commit();
  await auditReq(req, { action: 'master.work_type_removed', objectType: 'work_type', objectId: id, details: { clients: tagged.length } });
  res.json({ ok: true });
}));

masterRouter.put('/companies/:id/work-types', director, h(async (req, res) => {
  const { work_types } = parse(z.object({ work_types: z.array(z.string().max(80)).max(50).transform((a) => [...new Set(a)]) }), req.body);
  const known = new Set((await query<WorkTypeDoc>(C.workTypes)).map((w) => w.id));
  if (!work_types.every((w) => known.has(w))) throw new HttpError(400, 'Unknown work type.');
  const ref = db.collection(C.companies).doc(String(req.params.id));
  if (!(await ref.get()).exists) throw new HttpError(404, 'Not found.');
  await ref.update({ work_types });
  await auditReq(req, { action: 'client.work_types_set', objectType: 'company', objectId: ref.id, companyId: ref.id, details: { work_types } });
  res.json({ ok: true });
}));

/* ---------- Client groups given to staff ---------- */

masterRouter.get('/client-sets', director, h(async (_req, res) => {
  res.json((await query<ClientSetDoc>(C.clientSets)).sort((a, b) => a.name.localeCompare(b.name)));
}));

masterRouter.post('/client-sets', director, h(async (req, res) => {
  const { name } = parse(z.object({ name: zText(80).min(2) }), req.body);
  const doc: ClientSetDoc = { id: newId(), name, company_ids: [], member_ids: [], created_at: now(), created_by: req.user!.id };
  await db.collection(C.clientSets).doc(doc.id).set(doc);
  await auditReq(req, { action: 'client_set.created', objectType: 'client_set', objectId: doc.id, details: { name } });
  res.status(201).json(doc);
}));

masterRouter.put('/client-sets/:id', director, h(async (req, res) => {
  const b = parse(z.object({ name: zText(80).min(2).optional(), company_ids: ids.optional(), member_ids: ids.optional() }), req.body);
  const ref = db.collection(C.clientSets).doc(String(req.params.id));
  if (!(await ref.get()).exists) throw new HttpError(404, 'Not found.');
  if (b.company_ids) await checkCompanies(b.company_ids);
  if (b.member_ids) {
    const staff = new Set((await query<UserDoc>(C.users)).filter((u) => u.role === 'employee' || u.role === 'manager').map((u) => u.id));
    if (!b.member_ids.every((id) => staff.has(id))) throw new HttpError(400, 'Only employees and managers can be given a group.');
  }
  await ref.update(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
  await auditReq(req, { action: 'client_set.updated', objectType: 'client_set', objectId: ref.id, details: b });
  res.json({ ok: true });
}));

masterRouter.delete('/client-sets/:id', director, h(async (req, res) => {
  const ref = db.collection(C.clientSets).doc(String(req.params.id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Not found.');
  await ref.delete();
  await auditReq(req, { action: 'client_set.deleted', objectType: 'client_set', objectId: ref.id, details: { name: snap.data()!.name } });
  res.json({ ok: true });
}));

/* ---------- Clients ticked per employee ---------- */

masterRouter.put('/users/:id/clients', director, h(async (req, res) => {
  const { company_ids } = parse(z.object({ company_ids: ids }), req.body);
  const ref = db.collection(C.users).doc(String(req.params.id));
  const u = (await ref.get()).data() as UserDoc | undefined;
  if (!u || u.role !== 'employee') throw new HttpError(404, 'Not found.');
  await checkCompanies(company_ids);
  await ref.update({ client_ids: company_ids, updated_at: now() });
  await auditReq(req, { action: 'user.clients_set', objectType: 'user', objectId: ref.id, details: { clients: company_ids.length } });
  res.json({ ok: true });
}));
