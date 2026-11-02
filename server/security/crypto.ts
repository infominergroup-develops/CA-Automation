import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const scrypt = promisify(crypto.scrypt) as (
  pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Always do the work, so response time does not reveal whether the account exists.
  const parts = (stored ?? '').split('$');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const [, N, r, p, saltB64, hashB64] = valid ? parts : ['', '32768', '8', '1', 'AAAAAAAAAAAAAAAAAAAAAA==', 'A'.repeat(44)];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length || 32, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return valid && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Password policy: 12+ characters with letters and digits. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const hmac = (data: string) => crypto.createHmac('sha256', config.otpSecret).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Envelope encryption for documents.
 * Each file gets its own random key (DEK); the DEK is encrypted with MASTER_KEY.
 * The document id is bound as associated data, so a ciphertext cannot be swapped onto another record.
 */
export function encryptFile(plain: Buffer, docId: string) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(docId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    body,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    wrappedKey: wrapKey(dek, docId),
  };
}

export function decryptFile(body: Buffer, docId: string, meta: { iv: string; auth_tag: string; wrapped_key: string }) {
  const dek = unwrapKey(meta.wrapped_key, docId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(meta.iv, 'base64'));
  decipher.setAAD(Buffer.from(docId));
  decipher.setAuthTag(Buffer.from(meta.auth_tag, 'base64'));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function wrapKey(dek: Buffer, docId: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  c.setAAD(Buffer.from(`dek:${docId}`));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

function unwrapKey(wrapped: string, docId: string): Buffer {
  const [iv, tag, ct] = wrapped.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', config.masterKey, iv);
  d.setAAD(Buffer.from(`dek:${docId}`));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
