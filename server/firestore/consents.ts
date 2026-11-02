import { db } from './client.ts';
import { create, now, query } from './store.ts';
import { getSetting } from './settings.ts';
import { C, type ConsentDoc } from './types.ts';

/**
 * DPDP consent records. A client must hold consent for the current notice version before their data is
 * processed in the portal. Each give/withdraw is recorded with its time, version and IP — never deleted.
 */
export async function hasCurrentConsent(userId: string): Promise<boolean> {
  const version = await getSetting('privacy_notice_version');
  const active = await query<ConsentDoc>(C.consents, {
    where: [['user_id', '==', userId], ['notice_version', '==', version], ['withdrawn_at', '==', null]],
    limit: 1,
  });
  return active.length > 0;
}

export async function activeConsent(userId: string): Promise<ConsentDoc | undefined> {
  const rows = await query<ConsentDoc>(C.consents, {
    where: [['user_id', '==', userId], ['withdrawn_at', '==', null]],
    orderBy: [['given_at', 'desc']], limit: 1,
  });
  return rows[0];
}

/** Records consent, superseding any earlier active consent for this user. */
export async function giveConsent(userId: string, purposes: string[], version: string, ip: string | null): Promise<void> {
  // Withdraw any existing active consent first (purpose set is replaced, not merged).
  const existing = await query<ConsentDoc>(C.consents, { where: [['user_id', '==', userId], ['withdrawn_at', '==', null]] });
  await Promise.all(existing.map((c) => db.collection(C.consents).doc(c.id).update({ withdrawn_at: now() })));
  await create(C.consents, { user_id: userId, notice_version: version, purposes, given_at: now(), withdrawn_at: null, ip });
}

export function listConsents(userId: string): Promise<ConsentDoc[]> {
  return query<ConsentDoc>(C.consents, { where: [['user_id', '==', userId]], orderBy: [['given_at', 'desc']] });
}

/**
 * Withdraws specific purposes. Withdrawing is as easy as giving it (DPDP s.6(4)). If 'service' is withdrawn
 * the client loses portal access; the caller then ends their sessions and opens a request for the firm.
 */
export async function withdrawConsent(userId: string, withdraw: string[]): Promise<{ lostService: boolean }> {
  const current = await activeConsent(userId);
  if (!current) return { lostService: false };
  const remaining = current.purposes.filter((p) => !withdraw.includes(p));
  await db.collection(C.consents).doc(current.id).update({ withdrawn_at: now() });
  if (remaining.length) await create(C.consents, { user_id: userId, notice_version: current.notice_version, purposes: remaining, given_at: now(), withdrawn_at: null, ip: current.ip });
  return { lostService: !remaining.includes('service') };
}
