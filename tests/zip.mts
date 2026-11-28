/** The folder-download zip opens in a standard unzip tool, with folders, names and bytes intact. Run: npm run test:zip */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZipWriter } from '../server/zip.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
const file = path.join(dir, 'out.zip');
const files: [string, Buffer][] = [
  ['a.pdf', Buffer.from('%PDF hello')],
  ['Bank statements/April/statement (1).pdf', crypto.randomBytes(300_000)],
  ['GST/जीएसटी रिटर्न.xlsx', crypto.randomBytes(70_000)], // non-English name
  ['empty.txt', Buffer.alloc(0)],
];
for (const limit of [undefined, 1000]) { // 1000: every file and the directory past the "4 GB" mark, so ZIP64 throughout
const out = fs.createWriteStream(file);
const zip = new ZipWriter(out, limit);
for (const [name, bytes] of files) {
  // Sent in pieces, as a decrypting download would.
  await zip.add(name, bytes.length, new Date('2026-11-28T10:30:00'), async (sink) => { for (let i = 0; i < bytes.length; i += 65536) await sink.write(bytes.subarray(i, i + 65536)); });
}
await zip.finish();
await new Promise((r) => out.on('close', r));

// Python's zipfile checks every CRC and size.
const listed = execFileSync('python3', ['-I', '-c', `
import sys, zipfile, hashlib, json
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))`, file], { encoding: 'utf8' });
const got = JSON.parse(listed);
for (const [name, bytes] of files) assert.equal(got[name], crypto.createHash('sha256').update(bytes).digest('hex'), name);
assert.equal(Object.keys(got).length, files.length);
}
fs.rmSync(dir, { recursive: true });
console.log('zip: every file opens with the right name and bytes, in plain and ZIP64 form');
