/**
 * Proves the Firestore documents + blob storage slice (encryption at rest, integrity-verified download,
 * duplicates, review, soft delete) against the emulator + local blob store.
 * Run: npm run test:fs:docs   (emulator must be running on 8089)
 */
import './emulator-only.mts';
import { db } from '../server/firestore/client.ts';
import {
  ensureCategories, listCategories, createDocument, listDocuments, getDocumentMeta, readDocument,
  reviewDocument, softDeleteDocument, findDuplicate, IntegrityError, DEFAULT_CATEGORIES,
} from '../server/firestore/documents.ts';
import { blobs, blobKey } from '../server/firestore/storage.ts';
import { C } from '../server/firestore/types.ts';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra: unknown = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };

async function wipe(col: string) { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
for (const c of [C.documents, C.documentCategories]) await wipe(c);

// --- Categories
await ensureCategories();
const cats = await listCategories();
check('categories seeded', cats.length === DEFAULT_CATEGORIES.length);
const bank = cats.find((c) => c.name === 'Bank statements')!.id;
const purchase = cats.find((c) => c.name === 'Purchase bills')!.id;
check('category has a stable slug id', bank === 'bank-statements');

// --- Upload
const COMPANY = 'co-demo-1';
const plain = Buffer.from('%PDF-1.4\nHDFC Bank statement September 2026\n%%EOF\n');
const up = await createDocument({ companyId: COMPANY, categoryId: bank, fy: '2026-27', month: 9, name: 'HDFC Sep.pdf', mime: 'application/pdf', bytes: plain, uploadedBy: 'u-client' });
check('upload returns id + hash', !!up.id && up.sha256.length === 64 && up.duplicateOf === null);

// --- Encrypted at rest
const stored = await blobs.get(blobKey(COMPANY, up.id));
check('stored bytes are ciphertext (not the plaintext)', !stored.includes(Buffer.from('%PDF')) && !stored.equals(plain));

// --- List hides crypto fields
const list = await listDocuments(COMPANY);
check('document appears in list', list.length === 1 && list[0].id === up.id);
check('list never exposes wrapped_key/iv/auth_tag', !('wrapped_key' in list[0]) && !('iv' in list[0]) && !('auth_tag' in list[0]));
check('list shows the fingerprint', list[0].sha256 === up.sha256);

// --- Download: decrypt + integrity verify
const doc = (await getDocumentMeta(up.id))!;
const got = await readDocument(doc);
check('download decrypts to the original bytes', got.bytes.equals(plain));
check('download verifies the fingerprint', got.sha256 === up.sha256);

// --- Duplicate detection
const dup = await createDocument({ companyId: COMPANY, categoryId: bank, fy: '2026-27', month: 9, name: 'copy.pdf', mime: 'application/pdf', bytes: plain, uploadedBy: 'u-client' });
check('identical file flagged as duplicate', dup.duplicateOf?.id === up.id);
check('findDuplicate matches by company + hash', (await findDuplicate(COMPANY, up.sha256))?.id !== undefined);

// --- Category / FY filter
await createDocument({ companyId: COMPANY, categoryId: purchase, fy: '2025-26', month: null, name: 'bill.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF bill'), uploadedBy: 'u-client' });
check('filter by category', (await listDocuments(COMPANY, { categoryId: purchase })).length === 1);
check('filter by financial year', (await listDocuments(COMPANY, { fy: '2026-27' })).length === 2);

// --- Review
await reviewDocument(up.id, 'accepted', null, 'u-manager');
check('review status updates', (await getDocumentMeta(up.id))!.review_status === 'accepted');

// --- Tamper detection
await blobs.put(blobKey(COMPANY, up.id), Buffer.concat([stored, Buffer.from('X')])); // corrupt the ciphertext
let tampered = false;
try { await readDocument((await getDocumentMeta(up.id))!); } catch (e) { tampered = e instanceof IntegrityError; }
check('tampered file is refused on download', tampered);

// --- Soft delete
await softDeleteDocument(dup.id, 'u-director');
check('soft-deleted document leaves the list', (await listDocuments(COMPANY)).every((d) => d.id !== dup.id));
check('soft-deleted document not returned by getDocumentMeta', (await getDocumentMeta(dup.id)) === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
await db.terminate();
process.exit(fail ? 1 : 0);
