import { decryptFile, encryptFile, sha256 } from '../security/crypto.ts';
import { db } from './client.ts';
import { getById, newId, now, query } from './store.ts';
import { blobKey, blobs } from './storage.ts';
import { C } from './types.ts';

/** Default document categories (same list as the SQLite build), keyed by a stable slug. */
export const DEFAULT_CATEGORIES = [
  'Bank statements', 'Sales invoices', 'Purchase bills', 'Expense bills', 'GST documents',
  'TDS / TCS', 'Payroll and PF/ESI', 'Fixed assets', 'Loans', 'Investments', 'Income tax',
  'ROC / MCA', 'KYC', 'Others',
];
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export interface Category { id: string; name: string; sort: number; active: boolean }
export interface DocumentDoc {
  id: string; company_id: string; category_id: string; fy: string; month: number | null;
  original_name: string; mime: string; size: number; sha256: string;
  wrapped_key: string; iv: string; auth_tag: string;
  uploaded_by: string; review_status: 'pending' | 'accepted' | 'reupload' | 'not_needed';
  review_note: string | null; reviewed_by: string | null;
  deleted_at: string | null; deleted_by: string | null; created_at: string;
}
/** Metadata safe to return to the app — never the key/iv/auth_tag. */
export type DocumentMeta = Omit<DocumentDoc, 'wrapped_key' | 'iv' | 'auth_tag'>;
const strip = ({ wrapped_key, iv, auth_tag, ...meta }: DocumentDoc): DocumentMeta => meta;

export async function ensureCategories(): Promise<void> {
  await Promise.all(DEFAULT_CATEGORIES.map(async (name, i) => {
    const id = slug(name);
    if (!(await getById(C.documentCategories, id))) await db.collection(C.documentCategories).doc(id).set({ id, name, sort: i, active: true });
  }));
}
export async function listCategories(): Promise<Category[]> {
  const cats = await query<Category>(C.documentCategories, { where: [['active', '==', true]] });
  return cats.sort((a, b) => a.sort - b.sort);
}

export async function findDuplicate(companyId: string, hash: string): Promise<DocumentMeta | undefined> {
  const [dup] = await query<DocumentDoc>(C.documents, { where: [['company_id', '==', companyId], ['sha256', '==', hash], ['deleted_at', '==', null]], limit: 1 });
  return dup && strip(dup);
}

export interface UploadInput { companyId: string; categoryId: string; fy: string; month: number | null; name: string; mime: string; bytes: Buffer; uploadedBy: string }

/** Encrypts the file, stores the ciphertext, and records metadata. Returns the id, hash and any duplicate. */
export async function createDocument(u: UploadInput): Promise<{ id: string; sha256: string; duplicateOf: { id: string; created_at: string } | null }> {
  const hash = sha256(u.bytes);
  const dup = await findDuplicate(u.companyId, hash);
  const id = newId();
  const enc = encryptFile(u.bytes, id);
  await blobs.put(blobKey(u.companyId, id), enc.body);
  try {
    const doc: DocumentDoc = {
      id, company_id: u.companyId, category_id: u.categoryId, fy: u.fy, month: u.month,
      original_name: u.name, mime: u.mime, size: u.bytes.length, sha256: hash,
      wrapped_key: enc.wrappedKey, iv: enc.iv, auth_tag: enc.authTag,
      uploaded_by: u.uploadedBy, review_status: 'pending', review_note: null, reviewed_by: null,
      deleted_at: null, deleted_by: null, created_at: now(),
    };
    await db.collection(C.documents).doc(id).set(doc);
  } catch (e) {
    await blobs.delete(blobKey(u.companyId, id)).catch(() => {}); // no orphan ciphertext on failure
    throw e;
  }
  return { id, sha256: hash, duplicateOf: dup ? { id: dup.id, created_at: dup.created_at } : null };
}

export async function listDocuments(companyId: string, filter: { categoryId?: string; fy?: string } = {}): Promise<DocumentMeta[]> {
  // Equality filters only (sorted here), so no composite index is needed.
  const rows = (await query<DocumentDoc>(C.documents, { where: [['company_id', '==', companyId], ['deleted_at', '==', null]] }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  // category/fy filtered in memory to avoid an index per combination (document counts per company are modest).
  return rows.filter((d) => (!filter.categoryId || d.category_id === filter.categoryId) && (!filter.fy || d.fy === filter.fy)).map(strip);
}

export const getDocumentMeta = async (id: string) => {
  const d = await getById<DocumentDoc>(C.documents, id);
  return d && !d.deleted_at ? d : undefined; // full doc (callers need company_id/category_id for authz)
};

export class IntegrityError extends Error { constructor() { super('Document failed its integrity check.'); } }

/** Decrypts, verifies the bytes match the hash recorded at upload, and returns the plaintext. */
export async function readDocument(doc: DocumentDoc): Promise<{ bytes: Buffer; mime: string; name: string; sha256: string }> {
  let plain: Buffer;
  try {
    plain = decryptFile(await blobs.get(blobKey(doc.company_id, doc.id)), doc.id, doc);
  } catch {
    throw new IntegrityError();
  }
  if (plain.length === 0 || sha256(plain) !== doc.sha256) throw new IntegrityError();
  return { bytes: plain, mime: doc.mime, name: doc.original_name, sha256: doc.sha256 };
}

export async function reviewDocument(id: string, status: DocumentDoc['review_status'], note: string | null, reviewedBy: string): Promise<void> {
  await db.collection(C.documents).doc(id).update({ review_status: status, review_note: note, reviewed_by: reviewedBy });
}

/** Soft delete — the encrypted bytes are kept for the legal retention period. */
export async function softDeleteDocument(id: string, deletedBy: string): Promise<void> {
  await db.collection(C.documents).doc(id).update({ deleted_at: now(), deleted_by: deletedBy });
}
