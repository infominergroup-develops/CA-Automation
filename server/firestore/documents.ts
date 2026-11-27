import { decryptFile, encryptFile, sha256 } from '../security/crypto.ts';
import { db } from './client.ts';
import { FieldValue, getById, newId, now, query } from './store.ts';
import { blobs } from './storage.ts';
import { C } from './types.ts';

/** Default document categories (same list as the SQLite build), keyed by a stable slug. */
export const DEFAULT_CATEGORIES = [
  'Bank statements', 'Registrations', 'Profit and loss', 'Balance sheet', 'Sales invoices', 'Purchase bills',
  'Expense bills', 'GST documents', 'TDS / TCS', 'Payroll and PF/ESI', 'Fixed assets', 'Loans', 'Investments',
  'Income tax', 'ROC / MCA', 'KYC', 'Others',
];
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export interface Category { id: string; name: string; sort: number; active: boolean }
export interface DocumentDoc {
  /** category_id '' = straight in the year, with no document type. */
  id: string; company_id: string; category_id: string; fy: string; month: number | null;
  original_name: string; mime: string; size: number; sha256: string;
  wrapped_key: string; iv: string; auth_tag: string;
  /** Where the ciphertext lives in the bucket, e.g. `Mehta Traders/2026-27/Bank statements/2026-04 April/2026-05-02_HDFC.pdf.<id>.enc`. */
  blob_key: string;
  /** Folders inside an uploaded folder that are not a year, document type or month, e.g. `HDFC/Current account`. */
  subfolder?: string;
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
    const existing = await getById<Category>(C.documentCategories, id);
    if (existing?.sort !== i) await db.collection(C.documentCategories).doc(id).set({ id, name, sort: i, active: existing?.active ?? true });
  }));
}
export async function listCategories(): Promise<Category[]> {
  const cats = await query<Category>(C.documentCategories, { where: [['active', '==', true]] });
  return cats.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export class FolderExistsError extends Error {}

/** A folder the firm adds itself, such as Bookkeeping. It lists alphabetically among the firm's own, before Others. */
export async function addCategory(name: string): Promise<Category> {
  const id = slug(name);
  if (!id) throw new FolderExistsError('Use letters or numbers in the name.');
  const cat: Category = { id, name, sort: DEFAULT_CATEGORIES.length - 1.5, active: true };
  // create() fails if the id exists, so two people adding the same folder at once cannot both win.
  await db.collection(C.documentCategories).doc(id).create(cat).catch((e) => {
    throw e?.code === 6 ? new FolderExistsError(`There is already a folder called ${name}.`) : e; // 6 = ALREADY_EXISTS
  });
  return cat;
}

export async function findDuplicate(companyId: string, hash: string): Promise<DocumentMeta | undefined> {
  const [dup] = await query<DocumentDoc>(C.documents, { where: [['company_id', '==', companyId], ['sha256', '==', hash], ['deleted_at', '==', null]], limit: 1 });
  return dup && strip(dup);
}

export interface UploadInput {
  companyId: string; categoryId: string; fy: string; month: number | null; name: string; mime: string; bytes: Buffer; uploadedBy: string;
  /** Bucket folder from docFolder(). */
  folder: string;
  /** Staff uploads need no review; only what clients send waits for it. */
  accepted?: boolean;
  subfolder?: string;
}

/** One safe folder name: no slashes, control characters or leading dots (so no `..`). */
export const segment = (s: string) => s.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().replace(/^\.+/, '_').slice(0, 100) || '_';

/** Safe form of an uploaded folder's inner path; short, because a bucket path may be at most 1,024 bytes in all. */
/**
 * Safe form of a folder path people made: up to ten levels, and at most 270 bytes in all, because a bucket path may be
 * at most 1,024 bytes (the client and file names take the rest).
 */
export function cleanSubfolder(path: string): string {
  let out = path.split('/').filter(Boolean).slice(0, 10).map(segment).join('/');
  while (Buffer.byteLength(out) > 270) out = out.slice(0, -1);
  return out.replace(/\/+$/, '');
}

/**
 * The folder path a file shows in, below its year: its document type and month (files filed before folders were free
 * have them), then the folders people made. A "/" inside a type's name, as in TDS / TCS, is shown as a look-alike.
 */
export const folderPath = (d: { category_id: string; month: number | null; subfolder?: string }, typeName: (id: string) => string) =>
  [d.category_id ? typeName(d.category_id).replace(/\//g, '∕') : '', d.category_id && d.month ? MONTH_NAMES[d.month - 1] : '', ...(d.subfolder ?? '').split('/')]
    .filter(Boolean).join('/');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_NAMES = MONTHS;
/** `2026-04 April` … `2027-03 March`, so a financial year's months sort in order. */
const monthFolder = (fy: string, month: number) => `${Number(fy.slice(0, 4)) + (month < 4 ? 1 : 0)}-${String(month).padStart(2, '0')} ${MONTHS[month - 1]}`;

/** Client / financial year / document type / month, as readable folders in the bucket. Contents stay encrypted. */
/** A file may also sit straight in the year (no document type, so no month either), alone or in folders people made. */
export const docFolder = (client: string, fy: string, category: string, month?: number | null, subfolder = '') =>
  [client, fy, ...(category ? [category, ...(month ? [monthFolder(fy, month)] : [])] : []), ...subfolder.split('/').filter(Boolean)].map(segment).join('/');

/** Encrypts the file, stores the ciphertext, and records metadata. Returns the id, hash and any duplicate. */
export async function createDocument(u: UploadInput): Promise<{ id: string; sha256: string; duplicateOf: { id: string; created_at: string } | null }> {
  const hash = sha256(u.bytes);
  const dup = await findDuplicate(u.companyId, hash);
  const id = newId();
  const enc = encryptFile(u.bytes, id);
  // The id keeps names unique; the date and name make the folder readable.
  const key = `${u.folder}/${now().slice(0, 10)}_${segment(u.name)}.${id}.enc`;
  await blobs.put(key, enc.body);
  try {
    const doc: DocumentDoc = {
      id, company_id: u.companyId, category_id: u.categoryId, fy: u.fy, month: u.month,
      ...(u.subfolder && { subfolder: u.subfolder }), original_name: u.name, mime: u.mime, size: u.bytes.length, sha256: hash,
      wrapped_key: enc.wrappedKey, iv: enc.iv, auth_tag: enc.authTag, blob_key: key,
      uploaded_by: u.uploadedBy, review_status: u.accepted ? 'accepted' : 'pending', review_note: null, reviewed_by: null,
      deleted_at: null, deleted_by: null, created_at: now(),
    };
    await db.collection(C.documents).doc(id).set(doc);
  } catch (e) {
    await blobs.delete(key).catch(() => {}); // no orphan ciphertext on failure
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

/**
 * Moves a file to another year, folder or month. The ciphertext is copied to its new place first and the record
 * updated, and only then is the old copy removed, so a failure part-way never loses the file.
 */
export async function moveDocument(doc: DocumentDoc, to: { fy: string; categoryId: string; month: number | null; subfolder: string; folder: string }): Promise<void> {
  const key = `${to.folder}/${doc.blob_key.split('/').pop()}`;
  if (key !== doc.blob_key) await blobs.put(key, await blobs.get(doc.blob_key));
  try {
    await db.collection(C.documents).doc(doc.id).update({
      fy: to.fy, category_id: to.categoryId, month: to.month, subfolder: to.subfolder || FieldValue.delete(), blob_key: key,
    });
  } catch (e) {
    if (key !== doc.blob_key) await blobs.delete(key).catch(() => {});
    throw e;
  }
  if (key !== doc.blob_key) await blobs.delete(doc.blob_key).catch((e) => console.error(`Old copy left at ${doc.blob_key}`, e));
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
    plain = decryptFile(await blobs.get(doc.blob_key), doc.id, doc);
  } catch {
    throw new IntegrityError();
  }
  if (plain.length === 0 || sha256(plain) !== doc.sha256) throw new IntegrityError();
  return { bytes: plain, mime: doc.mime, name: doc.original_name, sha256: doc.sha256 };
}

export async function reviewDocument(id: string, status: DocumentDoc['review_status'], note: string | null, reviewedBy: string): Promise<void> {
  await db.collection(C.documents).doc(id).update({ review_status: status, review_note: note, reviewed_by: reviewedBy });
}

/** Staff uploads made before they stopped needing review: takes them out of the review queue. Returns how many. */
export async function acceptStaffUploads(): Promise<number> {
  const waiting = await query<DocumentDoc>(C.documents, { where: [['review_status', '==', 'pending'], ['deleted_at', '==', null]] });
  if (!waiting.length) return 0;
  const clients = new Set((await query<{ id: string }>(C.users, { where: [['role', '==', 'client']] })).map((u) => u.id));
  const staff = waiting.filter((d) => !clients.has(d.uploaded_by));
  await Promise.all(staff.map((d) => db.collection(C.documents).doc(d.id).update({ review_status: 'accepted' })));
  return staff.length;
}

/** Soft delete — the encrypted bytes are kept for the legal retention period. */
export async function softDeleteDocument(id: string, deletedBy: string): Promise<void> {
  await db.collection(C.documents).doc(id).update({ deleted_at: now(), deleted_by: deletedBy });
}
