import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.ts';
import { assertCompany, canViewDocument, employeeCategories, inScope } from '../authz.ts';
import { all, one, run, now, id } from '../db.ts';
import { auditReq, parse, zFy, zText } from '../http.ts';
import { decryptFile, encryptFile, sha256 } from '../security/crypto.ts';
import { cleanName, detectType } from '../shared.ts';
import { HttpError, requireAuth, requireRole } from '../security/session.ts';

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 20, fields: 10 },
});

const filePath = (docId: string) => path.join(config.dataDir, 'files', `${docId}.bin`);

interface DocRow {
  id: string;
  company_id: string;
  category_id: number;
  uploaded_by: string;
  created_at: string;
  deleted_at: string | null;
  iv: string;
  auth_tag: string;
  wrapped_key: string;
  sha256: string;
  original_name: string;
  mime: string;
}

documentsRouter.get('/companies/:companyId/documents', requireAuth, (req, res) => {
  const companyId = String(req.params.companyId);
  assertCompany(req.user!, companyId);
  const q = parse(z.object({ category_id: z.coerce.number().int().optional(), fy: zFy.optional() }), req.query);
  let rows = all<Record<string, unknown> & { category_id: number }>(
    `SELECT d.id, d.category_id, c.name AS category, d.fy, d.month, d.original_name, d.mime, d.size, d.sha256,
            d.review_status, d.review_note, d.created_at, d.uploaded_by, u.name AS uploaded_by_name, u.role AS uploaded_by_role
     FROM documents d JOIN document_categories c ON c.id = d.category_id JOIN users u ON u.id = d.uploaded_by
     WHERE d.company_id = ? AND d.deleted_at IS NULL
       AND (? IS NULL OR d.category_id = ?) AND (? IS NULL OR d.fy = ?)
     ORDER BY d.created_at DESC LIMIT 500`,
    [companyId, q.category_id ?? null, q.category_id ?? null, q.fy ?? null, q.fy ?? null]);
  if (req.user!.role === 'employee') {
    const allowed = employeeCategories(req.user!.id, companyId);
    rows = rows.filter((r) => allowed.has(r.category_id));
  }
  if (req.user!.role === 'client') {
    // Staff names stay internal.
    rows = rows.map(({ uploaded_by_name, uploaded_by, uploaded_by_role, ...r }) => ({
      ...r, uploaded_by_name: uploaded_by_role === 'client' ? uploaded_by_name : 'Infominer team',
      mine: uploaded_by === req.user!.id,
    })) as typeof rows;
  }
  res.json(rows);
});

documentsRouter.post('/companies/:companyId/documents', requireAuth, upload.array('files', 20), async (req, res) => {
  const companyId = String(req.params.companyId);
  assertCompany(req.user!, companyId);
  const b = parse(z.object({
    category_id: z.coerce.number().int(),
    fy: zFy,
    month: z.coerce.number().int().min(1).max(12).optional().or(z.literal('').transform(() => undefined)),
  }), req.body);
  if (!one('SELECT 1 FROM document_categories WHERE id = ? AND active = 1', [b.category_id])) throw new HttpError(400, 'Unknown category.');
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, 'Choose at least one file.');

  // Check every file before storing any.
  const prepared = await Promise.all(files.map(async (f) => {
    const name = cleanName(f.originalname);
    const mime = await detectType(f.buffer, name);
    if (!mime) throw new HttpError(415, `"${name}" is not an allowed file type (PDF, image, Excel, Word, CSV, ZIP).`);
    return { f, name, mime, hash: sha256(f.buffer) };
  }));

  const saved = [];
  for (const p of prepared) {
    const docId = id();
    const dup = one<{ id: string; created_at: string }>(
      'SELECT id, created_at FROM documents WHERE company_id = ? AND sha256 = ? AND deleted_at IS NULL', [companyId, p.hash]);
    const enc = encryptFile(p.f.buffer, docId);
    fs.writeFileSync(filePath(docId), enc.body, { mode: 0o600, flag: 'wx' });
    try {
      run(`INSERT INTO documents (id, company_id, category_id, fy, month, original_name, mime, size, sha256,
             wrapped_key, iv, auth_tag, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [docId, companyId, b.category_id, b.fy, b.month ?? null, p.name, p.mime, p.f.size, p.hash,
        enc.wrappedKey, enc.iv, enc.authTag, req.user!.id, now()]);
    } catch (e) {
      fs.rmSync(filePath(docId), { force: true });
      throw e;
    }
    auditReq(req, { action: 'document.uploaded', objectType: 'document', objectId: docId, companyId,
      details: { name: p.name, size: p.f.size, sha256: p.hash, category_id: b.category_id, fy: b.fy, duplicateOf: dup?.id } });
    saved.push({ id: docId, name: p.name, sha256: p.hash, duplicateOf: dup ? { id: dup.id, uploadedAt: dup.created_at } : null });
  }
  res.status(201).json(saved);
});

documentsRouter.get('/documents/:id/download', requireAuth, (req, res) => {
  const doc = one<DocRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [String(req.params.id)]);
  if (!doc || !canViewDocument(req.user!, doc)) throw new HttpError(404, 'Not found.');
  let plain: Buffer;
  try {
    plain = decryptFile(fs.readFileSync(filePath(doc.id)), doc.id, doc);
  } catch {
    plain = Buffer.alloc(0);
  }
  // Authenticity check: the decrypted bytes must match the hash recorded at upload.
  if (!plain.length || sha256(plain) !== doc.sha256) {
    auditReq(req, { action: 'document.integrity_failure', objectType: 'document', objectId: doc.id, companyId: doc.company_id });
    throw new HttpError(409, 'This file failed its integrity check and was not served. The incident has been logged.');
  }
  auditReq(req, { action: 'document.downloaded', objectType: 'document', objectId: doc.id, companyId: doc.company_id });
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Length', plain.length);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Document-SHA256', doc.sha256);
  res.end(plain);
});

documentsRouter.patch('/documents/:id/review', requireRole('director', 'manager'), (req, res) => {
  const b = parse(z.object({
    status: z.enum(['pending', 'accepted', 'reupload', 'not_needed']),
    note: zText(500).optional(),
  }), req.body);
  const doc = one<DocRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [String(req.params.id)]);
  if (!doc || !inScope(req.user!, doc.company_id)) throw new HttpError(404, 'Not found.');
  if (b.status === 'reupload' && !b.note) throw new HttpError(400, 'Tell the client why it needs re-uploading.');
  run('UPDATE documents SET review_status = ?, review_note = ?, reviewed_by = ? WHERE id = ?',
    [b.status, b.note ?? null, req.user!.id, doc.id]);
  auditReq(req, { action: 'document.reviewed', objectType: 'document', objectId: doc.id, companyId: doc.company_id, details: b });
  res.json({ ok: true });
});

/** Soft delete. Directors any time; clients only their own uploads within 24 hours. The encrypted file is kept for retention. */
documentsRouter.delete('/documents/:id', requireAuth, (req, res) => {
  const doc = one<DocRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [String(req.params.id)]);
  if (!doc || !inScope(req.user!, doc.company_id)) throw new HttpError(404, 'Not found.');
  const u = req.user!;
  const clientOwn = u.role === 'client' && doc.uploaded_by === u.id && Date.parse(doc.created_at) > Date.now() - 24 * 3600e3;
  if (u.role !== 'director' && !clientOwn) throw new HttpError(403, 'You cannot delete this document.');
  run('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?', [now(), u.id, doc.id]);
  auditReq(req, { action: 'document.deleted', objectType: 'document', objectId: doc.id, companyId: doc.company_id });
  res.json({ ok: true });
});
