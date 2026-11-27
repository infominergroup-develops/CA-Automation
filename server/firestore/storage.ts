import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { config } from '../config.ts';

const pipeline = pipe as unknown as (streams: (NodeJS.ReadableStream | NodeJS.WritableStream)[]) => Promise<void>; // the array form, which the types miss

/**
 * Blob store for the encrypted document files (Firestore holds only metadata; files are too big for it).
 * Two backends with the same interface: Cloud Storage in production (DOCS_BUCKET set), local disk otherwise
 * — so the full upload/download/integrity flow can be tested without a storage emulator. Only ciphertext is
 * ever stored here; the app encrypts before put and decrypts after get.
 */
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** For files of any size: writes what the streams produce, in order, without holding it in memory. */
  putStream(key: string, from: NodeJS.ReadableStream[]): Promise<void>;
  getStream(key: string): Readable;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
}

class LocalBlob implements BlobStore {
  constructor(private root: string) {}
  private p(key: string) { return path.join(this.root, key); }
  private dir(key: string) { fs.mkdirSync(path.dirname(this.p(key)), { recursive: true, mode: 0o700 }); }
  async put(key: string, bytes: Buffer) {
    this.dir(key);
    fs.writeFileSync(this.p(key), bytes, { mode: 0o600 });
  }
  async get(key: string) { return fs.readFileSync(this.p(key)); }
  async putStream(key: string, from: NodeJS.ReadableStream[]) {
    this.dir(key);
    await pipeline([...from, fs.createWriteStream(this.p(key), { mode: 0o600 })]);
  }
  getStream(key: string) { return fs.createReadStream(this.p(key)); }
  async copy(from: string, to: string) { this.dir(to); fs.copyFileSync(this.p(from), this.p(to)); }
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
  async putStream(key: string, from: NodeJS.ReadableStream[]) {
    const b = await this.bucketP; // resumable (the default), so a large file survives a dropped connection
    await pipeline([...from, b.file(key).createWriteStream({ contentType: 'application/octet-stream', metadata: { cacheControl: 'no-store' } })]);
  }
  getStream(key: string) {
    const out = new PassThrough(); // returned at once; the bucket handle is ready long before the first download
    this.bucketP.then((b) => pipeline([b.file(key).createReadStream(), out])).catch((e) => out.destroy(e));
    return out;
  }
  async copy(from: string, to: string) { const b = await this.bucketP; await b.file(from).copy(b.file(to)); } // inside the bucket, nothing downloaded
  async delete(key: string) { await (await this.bucketP).file(key).delete({ ignoreNotFound: true }); }
}

export const blobs: BlobStore = config.docsBucket
  ? new GcsBlob(config.docsBucket)
  : new LocalBlob(path.join(config.dataDir, 'files'));
