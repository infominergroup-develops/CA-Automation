import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * Blob store for the encrypted document files (Firestore holds only metadata; files are too big for it).
 * Two backends with the same interface: Cloud Storage in production (DOCS_BUCKET set), local disk otherwise
 * — so the full upload/download/integrity flow can be tested without a storage emulator. Only ciphertext is
 * ever stored here; the app encrypts before put and decrypts after get.
 */
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalBlob implements BlobStore {
  constructor(private root: string) {}
  private p(key: string) { return path.join(this.root, key); }
  async put(key: string, bytes: Buffer) {
    const f = this.p(key);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, bytes, { mode: 0o600 });
  }
  async get(key: string) { return fs.readFileSync(this.p(key)); }
  async delete(key: string) { fs.rmSync(this.p(key), { force: true }); }
}

class GcsBlob implements BlobStore {
  // Imported lazily so local/dev and tests never load the Storage SDK.
  private bucketP = import('@google-cloud/storage').then(({ Storage }) => new Storage().bucket(this.bucket));
  constructor(private bucket: string) {}
  async put(key: string, bytes: Buffer) {
    const b = await this.bucketP;
    await b.file(key).save(bytes, { resumable: false, contentType: 'application/octet-stream', metadata: { cacheControl: 'no-store' } });
  }
  async get(key: string) { const [buf] = await (await this.bucketP).file(key).download(); return buf; }
  async delete(key: string) { await (await this.bucketP).file(key).delete({ ignoreNotFound: true }); }
}

export const blobs: BlobStore = config.docsBucket
  ? new GcsBlob(config.docsBucket)
  : new LocalBlob(path.join(config.dataDir, 'files'));

/** Storage key for a document's encrypted bytes. */
export const blobKey = (companyId: string, docId: string) => `${companyId}/${docId}.bin`;
