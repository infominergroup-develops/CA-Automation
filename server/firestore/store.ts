import { randomUUID } from 'node:crypto';
import { type Transaction, FieldValue } from '@google-cloud/firestore';
import { db } from './client.ts';

/**
 * Thin data-access helpers over Firestore, giving the migration the same ergonomics the SQLite layer had
 * (get one, query many, run a transaction, generate an id, timestamps) while keeping Firestore's document
 * shape. Dates stay ISO-8601 strings exactly as before, so all existing date logic keeps working and sorts
 * correctly ("2026-10-07T…" is lexicographically ordered).
 */

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export { FieldValue };
export type Txn = Transaction;

type Where = [field: string, op: FirebaseFirestore.WhereFilterOp, value: unknown];
interface QueryOpts {
  where?: Where[];
  orderBy?: [field: string, dir?: 'asc' | 'desc'][];
  limit?: number;
  startAfter?: unknown;
}

function build(collection: string, opts: QueryOpts = {}) {
  let q: FirebaseFirestore.Query = db.collection(collection);
  for (const [f, op, v] of opts.where ?? []) q = q.where(f, op, v);
  for (const [f, dir] of opts.orderBy ?? []) q = q.orderBy(f, dir ?? 'asc');
  if (opts.startAfter !== undefined) q = q.startAfter(opts.startAfter);
  if (opts.limit) q = q.limit(opts.limit);
  return q;
}

/** One document by id, or undefined. */
export async function getById<T>(collection: string, id: string): Promise<T | undefined> {
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as T) : undefined;
}

/** All documents matching the query. */
export async function query<T>(collection: string, opts: QueryOpts = {}): Promise<T[]> {
  const snap = await build(collection, opts).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
}

/** First document matching, or undefined. */
export async function queryOne<T>(collection: string, opts: QueryOpts = {}): Promise<T | undefined> {
  const snap = await build(collection, { ...opts, limit: 1 }).get();
  const d = snap.docs[0];
  return d ? ({ id: d.id, ...d.data() } as T) : undefined;
}

/** True if any document matches (a cheap existence check: fetches at most one id). */
export async function exists(collection: string, opts: QueryOpts): Promise<boolean> {
  const snap = await build(collection, { ...opts, limit: 1 }).select().get();
  return !snap.empty;
}

export async function setDoc(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  await db.collection(collection).doc(id).set(strip(data));
}
export async function updateDoc(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  await db.collection(collection).doc(id).update(strip(data));
}
export async function deleteDoc(collection: string, id: string): Promise<void> {
  await db.collection(collection).doc(id).delete();
}

/** Create a document, generating an id if none is given. Returns the id. */
export async function create(collection: string, data: Record<string, unknown>, id = newId()): Promise<string> {
  await db.collection(collection).doc(id).set({ ...strip(data), created_at: data.created_at ?? now() });
  return id;
}

/** Runs fn inside a Firestore transaction. Reads must precede writes, as Firestore requires. */
export function txn<T>(fn: (t: Txn) => Promise<T>): Promise<T> {
  return db.runTransaction(fn);
}

/* ---------------- Uniqueness (Firestore has no UNIQUE constraint) ----------------
 * We enforce uniqueness with lookup documents: e.g. `unique_user_email/{email} -> { ownerId }`.
 * Reserving and releasing happen inside the same transaction as the entity write, so a duplicate email
 * or mobile, or a second running timer, is rejected atomically — the guarantee SQLite gave us for free.
 */
export class UniquenessError extends Error {
  constructor(public key: string) { super(`Already taken: ${key}`); }
}

/**
 * Firestore transactions require ALL reads before ANY writes, so reserving uniqueness is two phases:
 * `checkUnique` (read: throws if taken) for every key first, then `claimUnique` (write) for every key.
 */
export async function checkUnique(t: Txn, index: string, key: string, ownerId: string): Promise<void> {
  const snap = await t.get(db.collection(index).doc(encodeKey(key)));
  if (snap.exists && snap.data()?.ownerId !== ownerId) throw new UniquenessError(`${index}:${key}`);
}
export function claimUnique(t: Txn, index: string, key: string, ownerId: string): void {
  t.set(db.collection(index).doc(encodeKey(key)), { ownerId, key });
}
export function releaseUnique(t: Txn, index: string, key: string): void {
  t.delete(db.collection(index).doc(encodeKey(key)));
}
const encodeKey = (k: string) => encodeURIComponent(k).replace(/\./g, '%2E').slice(0, 1000) || '_';

/** Firestore rejects `undefined` field values even with ignoreUndefinedProperties off in some paths; drop them. */
function strip(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out;
}
