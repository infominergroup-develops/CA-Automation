import { all, one, run, tx, now } from './db.ts';
import { sha256 } from './security/crypto.ts';

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

interface AuditRow {
  seq: number;
  ts: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  company_id: string | null;
  ip: string | null;
  details: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function rowHash(r: Omit<AuditRow, 'hash' | 'seq'>): string {
  // Fixed field order, so the same row always hashes the same way.
  return sha256(JSON.stringify([
    r.prev_hash, r.ts, r.actor_id, r.actor_role, r.action, r.object_type,
    r.object_id, r.company_id, r.ip, r.details,
  ]));
}

/** Appends one entry. Each entry's hash covers the previous entry's hash, so any edit breaks the chain. */
export function audit(e: AuditEntry) {
  tx(() => {
    const prev = one<{ hash: string }>('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')?.hash ?? GENESIS;
    const row = {
      prev_hash: prev,
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
    run(
      `INSERT INTO audit_log (ts, actor_id, actor_role, action, object_type, object_id, company_id, ip, details, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.ts, row.actor_id, row.actor_role, row.action, row.object_type, row.object_id,
        row.company_id, row.ip, row.details, row.prev_hash, rowHash(row)],
    );
  });
}

/** Re-computes the whole chain. Returns the first broken entry, if any. */
export function verifyAuditChain(): { ok: boolean; checked: number; brokenAt?: number; headHash: string } {
  let prev = GENESIS;
  let checked = 0;
  for (const r of all<AuditRow>('SELECT * FROM audit_log ORDER BY seq')) {
    if (r.prev_hash !== prev || rowHash(r) !== r.hash) {
      return { ok: false, checked, brokenAt: r.seq, headHash: prev };
    }
    prev = r.hash;
    checked++;
  }
  return { ok: true, checked, headHash: prev };
}
