import { db } from './client.ts';
import { now } from './store.ts';
import { C, type AuditDoc } from './types.ts';
import { sha256 } from '../security/crypto.ts';

/**
 * Tamper-evident audit trail on Firestore.
 *
 * SQLite enforced append-only with triggers and gave us an auto-increment seq. Firestore has neither, so:
 *  - `counters/audit` holds { seq, lastHash } and is advanced inside a transaction, which both assigns the
 *    next seq and chains each entry's hash to the previous one — the chain is what makes tampering detectable.
 *  - The doc id is the zero-padded seq, so entries sort in order.
 *  - firestore.rules denies all client access and locks audit_log to create-only (defence in depth); the
 *    server Admin SDK must therefore only ever append — never update or delete — audit entries.
 */

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  objectType?: string;
  objectId?: string;
  companyId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

const GENESIS = '0'.repeat(64);
const pad = (n: number) => String(n).padStart(12, '0');

/** Fixed field order, so the same row always hashes the same way (must match verify + the SQLite version). */
function rowHash(r: Omit<AuditDoc, 'hash' | 'seq'>): string {
  return sha256(JSON.stringify([
    r.prev_hash, r.ts, r.actor_id, r.actor_role, r.action, r.object_type,
    r.object_id, r.company_id, r.ip, r.details,
  ]));
}

export async function audit(e: AuditEntry): Promise<void> {
  const counter = db.collection(C.counters).doc('audit');
  await db.runTransaction(async (t) => {
    const snap = await t.get(counter);
    const prev = snap.exists ? (snap.data() as { seq: number; lastHash: string }) : { seq: 0, lastHash: GENESIS };
    const seq = prev.seq + 1;
    const row: Omit<AuditDoc, 'hash'> = {
      seq,
      prev_hash: prev.lastHash,
      ts: now(),
      actor_id: e.actorId ?? null,
      actor_role: e.actorRole ?? null,
      action: e.action,
      object_type: e.objectType ?? null,
      object_id: e.objectId ?? null,
      company_id: e.companyId ?? null,
      ip: e.ip ?? null,
      details: e.details ? JSON.stringify(e.details) : null,
    };
    const hash = rowHash(row);
    t.set(db.collection(C.audit).doc(pad(seq)), { ...row, hash });
    t.set(counter, { seq, lastHash: hash });
  });
}

/** Re-computes the whole chain. Returns the first broken entry, if any. */
export async function verifyAuditChain(): Promise<{ ok: boolean; checked: number; brokenAt?: number; headHash: string }> {
  let prev = GENESIS;
  let checked = 0;
  const snap = await db.collection(C.audit).orderBy('seq').get();
  for (const doc of snap.docs) {
    const r = doc.data() as AuditDoc;
    const { hash, ...rest } = r;
    if (r.prev_hash !== prev || rowHash(rest) !== hash) {
      return { ok: false, checked, brokenAt: r.seq, headHash: prev };
    }
    prev = hash;
    checked++;
  }
  return { ok: true, checked, headHash: prev };
}
