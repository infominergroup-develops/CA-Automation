import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.ts';
import { cleanName, detectType, zFy, zText } from '../shared.ts';
import { assertCompany, canViewDocument, inScope, userNames } from '../firestore/authz.ts';
import {
  IntegrityError, createDocument, getDocumentMeta, listCategories, listDocuments, readDocument, reviewDocument, softDeleteDocument,
} from '../firestore/documents.ts';
import { HttpError, auditReq, h, parse, requireAuth, requireRole } from '../firestore/http.ts';
import { employeeCategories } from '../firestore/tasks.ts';

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 20, fields: 10 },
});

const zCategory = z.string().trim().min(1).max(80);

documentsRouter.get('/companies/:companyId/documents', requireAuth, h(async (req, res) => {
  const companyId = String(req.params.companyId);
  await assertCompany(req.user!, companyId);
  const q = parse(z.object({ category_id: zCategory.optional(), fy: zFy.optional() }), req.query);
  const [docs, cats, users] = await Promise.all([listDocuments(companyId, { categoryId: q.category_id, fy: q.fy }), listCategories(), userNames()]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  let rows = docs.slice(0, 500).map((d) => ({
    id: d.id, category_id: d.category_id, category: catName.get(d.category_id) ?? d.category_id, fy: d.fy, month: d.month,
    original_name: d.original_name, mime: d.mime, size: d.size, sha256: d.sha256, review_status: d.review_status,
    review_note: d.review_note, created_at: d.created_at, uploaded_by: d.uploaded_by,
    uploaded_by_name: users.get(d.uploaded_by)?.name ?? '', uploaded_by_role: users.get(d.uploaded_by)?.role ?? '',
  }));
  if (req.user!.role === 'employee') {
    const allowed = await employeeCategories(req.user!.id, companyId);
    rows = rows.filter((r) => allowed.has(r.category_id));
  }
  if (req.user!.role === 'client') {
    // Staff names stay internal.
    return res.json(rows.map(({ uploaded_by_name, uploaded_by, uploaded_by_role, ...r }) => ({
      ...r, uploaded_by_name: uploaded_by_role === 'client' ? uploaded_by_name : 'Infominer team', mine: uploaded_by === req.user!.id,
    })));
  }
  res.json(rows);
}));

documentsRouter.post('/companies/:companyId/documents', requireAuth, upload.array('files', 20), h(async (req, res) => {
  const companyId = String(req.params.companyId);
  await assertCompany(req.user!, companyId);
  const b = parse(z.object({
    category_id: zCategory,
    fy: zFy,
    month: z.coerce.number().int().min(1).max(12).optional().or(z.literal('').transform(() => undefined)),
  }), req.body);
  if (!(await listCategories()).some((c) => c.id === b.category_id)) throw new HttpError(400, 'Unknown category.');
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, 'Choose at least one file.');

  // Check every file before storing any.
  const prepared = await Promise.all(files.map(async (f) => {
    const name = cleanName(f.originalname);
    const mime = await detectType(f.buffer, name);
    if (!mime) throw new HttpError(415, `"${name}" is not an allowed file type (PDF, image, Excel, Word, CSV, ZIP).`);
    return { f, name, mime };
  }));

  const saved = [];
  for (const p of prepared) {
    const d = await createDocument({ companyId, categoryId: b.category_id, fy: b.fy, month: b.month ?? null, name: p.name, mime: p.mime, bytes: p.f.buffer, uploadedBy: req.user!.id });
    await auditReq(req, { action: 'document.uploaded', objectType: 'document', objectId: d.id, companyId,
      details: { name: p.name, size: p.f.size, sha256: d.sha256, category_id: b.category_id, fy: b.fy, duplicateOf: d.duplicateOf?.id } });
    saved.push({ id: d.id, name: p.name, sha256: d.sha256, duplicateOf: d.duplicateOf ? { id: d.duplicateOf.id, uploadedAt: d.duplicateOf.created_at } : null });
  }
  res.status(201).json(saved);
}));

documentsRouter.get('/documents/:id/download', requireAuth, h(async (req, res) => {
  const doc = await getDocumentMeta(String(req.params.id));
  if (!doc || !(await canViewDocument(req.user!, doc))) throw new HttpError(404, 'Not found.');
  let file: Awaited<ReturnType<typeof readDocument>>;
  try {
    // Authenticity check inside: the decrypted bytes must match the hash recorded at upload.
    file = await readDocument(doc);
  } catch (e) {
    if (!(e instanceof IntegrityError)) throw e;
    await auditReq(req, { action: 'document.integrity_failure', objectType: 'document', objectId: doc.id, companyId: doc.company_id });
    throw new HttpError(409, 'This file failed its integrity check and was not served. The incident has been logged.');
  }
  await auditReq(req, { action: 'document.downloaded', objectType: 'document', objectId: doc.id, companyId: doc.company_id });
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', file.bytes.length);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Document-SHA256', file.sha256);
  res.end(file.bytes);
}));

documentsRouter.patch('/documents/:id/review', requireRole('director', 'manager'), h(async (req, res) => {
  const b = parse(z.object({
    status: z.enum(['pending', 'accepted', 'reupload', 'not_needed']),
    note: zText(500).optional(),
  }), req.body);
  const doc = await getDocumentMeta(String(req.params.id));
  if (!doc || !(await inScope(req.user!, doc.company_id))) throw new HttpError(404, 'Not found.');
  if (b.status === 'reupload' && !b.note) throw new HttpError(400, 'Tell the client why it needs re-uploading.');
  await reviewDocument(doc.id, b.status, b.note ?? null, req.user!.id);
  await auditReq(req, { action: 'document.reviewed', objectType: 'document', objectId: doc.id, companyId: doc.company_id, details: b });
  res.json({ ok: true });
}));

/** Soft delete. Directors any time; clients only their own uploads within 24 hours. The encrypted file is kept for retention. */
documentsRouter.delete('/documents/:id', requireAuth, h(async (req, res) => {
  const doc = await getDocumentMeta(String(req.params.id));
  if (!doc || !(await inScope(req.user!, doc.company_id))) throw new HttpError(404, 'Not found.');
  const u = req.user!;
  const clientOwn = u.role === 'client' && doc.uploaded_by === u.id && Date.parse(doc.created_at) > Date.now() - 24 * 3600e3;
  if (u.role !== 'director' && !clientOwn) throw new HttpError(403, 'You cannot delete this document.');
  await softDeleteDocument(doc.id, u.id);
  await auditReq(req, { action: 'document.deleted', objectType: 'document', objectId: doc.id, companyId: doc.company_id });
  res.json({ ok: true });
}));
