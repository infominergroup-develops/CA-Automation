/**
 * Proves the Firestore documents + blob storage slice (encryption at rest, integrity-verified download,
 * duplicates, review, soft delete) against the emulator + local blob store.
 * Run: npm run test:fs:docs   (emulator must be running on 8089)
 */
import './emulator-only.mts';
import { db } from '../server/firestore/client.ts';
import {
  ensureCategories, listCategories, cleanSubfolder, createDocument, docFolder, listDocuments, getDocumentMeta, readDocument,
  reviewDocument, softDeleteDocument, findDuplicate, IntegrityError, DEFAULT_CATEGORIES,
} from '../server/firestore/documents.ts';
import { blobs } from '../server/firestore/storage.ts';
import { detectType } from '../server/shared.ts';
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
const folder = docFolder('Mehta Traders Pvt Ltd', '2026-27', 'Bank statements');
const up = await createDocument({ companyId: COMPANY, categoryId: bank, fy: '2026-27', month: 9, name: 'HDFC Sep.pdf', mime: 'application/pdf', bytes: plain, uploadedBy: 'u-client', folder });
check('upload returns id + hash', !!up.id && up.sha256.length === 64 && up.duplicateOf === null);

// --- Encrypted at rest
const key = (await getDocumentMeta(up.id))!.blob_key;
check('stored in client / year / document-type folder', key.startsWith('Mehta Traders Pvt Ltd/2026-27/Bank statements/') && key.endsWith(`_HDFC Sep.pdf.${up.id}.enc`), key);
check('folder names cannot escape or add levels', docFolder('../evil/A', '2026-27', '..') === '__evil_A/2026-27/_');
check('month folders sort through the year', [4, 12, 1, 3].map((m) => docFolder('C', '2026-27', 'GST documents', m).split('/')[3]).join() === '2026-04 April,2026-12 December,2027-01 January,2027-03 March');
check('without a month, the file sits in its folder', docFolder('C', '2026-27', 'GST documents', null) === 'C/2026-27/GST documents');
check('inner folders are kept, safely', docFolder('C', '2026-27', 'Others', 4, cleanSubfolder('HDFC/../..//a\\b/Current')) === 'C/2026-27/Others/2026-04 April/HDFC/_/_/a_b/Current');
check('longest possible path fits the bucket limit', Buffer.byteLength(`${docFolder('क'.repeat(200), '2026-27', 'Payroll and PF/ESI', 9, cleanSubfolder('ख'.repeat(400) + '/' + 'ग'.repeat(400)))}/2026-11-25_${'घ'.repeat(100)}.${up.id}.enc`) <= 1024);
const stored = await blobs.get(key);
check('stored bytes are ciphertext (not the plaintext)', !stored.includes(Buffer.from('%PDF')) && !stored.equals(plain));

// --- File types (decided from the bytes; old Office files by name too, as they share a container)
const cfb = Buffer.concat([Buffer.from('D0CF11E0A1B11AE1', 'hex'), Buffer.alloc(512)]);
const types: [string, Buffer, string | null][] = [
  ['a.pdf', plain, 'application/pdf'], ['a.png', Buffer.from('89504E470D0A1A0A0000000D4948445200000001000000010806000000', 'hex'), 'image/png'],
  ['a.jpeg', Buffer.from('FFD8FFE000104A46494600010100', 'hex'), 'image/jpeg'], ['old.DOC', cfb, 'application/msword'], ['old.xls', cfb, 'application/vnd.ms-excel'],
  ['setup.msi', cfb, null], ['mail.msg', cfb, 'application/octet-stream'], ['fake.pdf', Buffer.from('MZ\x90\x00'), null],
  // Any other file is kept, except programs and scripts.
  ['gstr1.json', Buffer.from('{"gstin":"27ABCDE1234F1Z5"}'), 'text/plain'], ['itr.xml', Buffer.from('<ITR/>'), 'text/plain'],
  ['tally backup.tbk', Buffer.from([1, 0, 2, 0, 3]), 'application/octet-stream'], ['notes.dat', Buffer.from('plain words'), 'application/octet-stream'],
  ['data.rar', Buffer.from('526172211A0700CF907300000D', 'hex'), 'application/x-rar-compressed'],
  ['report.exe', Buffer.from('anything'), null], ['run.bat', Buffer.from('del *'), null], ['page.html', Buffer.from('<script>'), null],
  ['renamed.dat', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), null], ['invoice.pdf', Buffer.from('<html><script>x</script>'), null],
];
for (const [name, bytes, want] of types) check(`type of ${name}: ${want ?? 'refused'}`, await detectType(bytes, name) === want, await detectType(bytes, name));

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
const dup = await createDocument({ companyId: COMPANY, categoryId: bank, fy: '2026-27', month: 9, name: 'copy.pdf', mime: 'application/pdf', bytes: plain, uploadedBy: 'u-client', folder });
check('identical file flagged as duplicate', dup.duplicateOf?.id === up.id);
check('findDuplicate matches by company + hash', (await findDuplicate(COMPANY, up.sha256))?.id !== undefined);

// --- Category / FY filter
await createDocument({ companyId: COMPANY, categoryId: purchase, fy: '2025-26', month: null, name: 'bill.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF bill'), uploadedBy: 'u-client', folder: docFolder('Mehta Traders Pvt Ltd', '2025-26', 'Purchase bills') });
check('filter by category', (await listDocuments(COMPANY, { categoryId: purchase })).length === 1);
check('filter by financial year', (await listDocuments(COMPANY, { fy: '2026-27' })).length === 2);

// --- Review
await reviewDocument(up.id, 'accepted', null, 'u-manager');
check('review status updates', (await getDocumentMeta(up.id))!.review_status === 'accepted');

// --- Tamper detection
await blobs.put(key, Buffer.concat([stored, Buffer.from('X')])); // corrupt the ciphertext
let tampered = false;
try { await readDocument((await getDocumentMeta(up.id))!); } catch (e) { tampered = e instanceof IntegrityError; }
check('tampered file is refused on download', tampered);
await blobs.put(key, stored); // restore, then cut the stored tag down to 4 bytes (a much easier forgery)
const whole = (await getDocumentMeta(up.id))!;
check('the restored file reads back', (await readDocument(whole)).bytes.equals(plain));
let shortTag = false;
try { await readDocument({ ...whole, auth_tag: Buffer.from(whole.auth_tag, 'base64').subarray(0, 4).toString('base64') }); } catch (e) { shortTag = e instanceof IntegrityError; }
check('a shortened auth tag is refused', shortTag);

// --- Soft delete
await softDeleteDocument(dup.id, 'u-director');
check('soft-deleted document leaves the list', (await listDocuments(COMPANY)).every((d) => d.id !== dup.id));
check('soft-deleted document not returned by getDocumentMeta', (await getDocumentMeta(dup.id)) === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
await db.terminate();
process.exit(fail ? 1 : 0);
