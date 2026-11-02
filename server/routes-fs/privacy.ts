import { Router } from 'express';
import { z } from 'zod';
import { NOTICE_SETTING_KEYS, PURPOSES, privacyNotice, zText } from '../shared.ts';
import { verifyAuditChain } from '../firestore/audit.ts';
import { companyMap, userNames } from '../firestore/authz.ts';
import { db } from '../firestore/client.ts';
import { activeConsent, giveConsent, listConsents, withdrawConsent } from '../firestore/consents.ts';
import { HttpError, auditReq, clearSessionCookie, clientIp, h, parse, requireAuth, requireRole } from '../firestore/http.ts';
import { allRequests, exportMyData, listBreaches, raiseRequest, recordBreach, requestsForUser, updateBreach, updateRequest } from '../firestore/privacy.ts';
import { destroySession } from '../firestore/sessions.ts';
import { getSetting, getSettings } from '../firestore/settings.ts';
import { C, type AuditDoc } from '../firestore/types.ts';

export const privacyRouter = Router();

const notice = async () => privacyNotice(await getSettings([...NOTICE_SETTING_KEYS]) as Parameters<typeof privacyNotice>[0]);

/** The data layer signals a missing row with a plain 'Not found.' error. */
const notFound = (e: unknown) => { if (e instanceof Error && e.message === 'Not found.') throw new HttpError(404, 'Not found.'); throw e; };

privacyRouter.get('/privacy/notice', h(async (_req, res) => { res.json(await notice()); }));

privacyRouter.post('/privacy/consent', requireRole('client'), h(async (req, res) => {
  const b = parse(z.object({ purposes: z.array(z.enum(PURPOSES.map((p) => p.code) as [string, ...string[]])).min(1), version: z.string() }), req.body);
  if (b.version !== (await getSetting('privacy_notice_version'))) throw new HttpError(409, 'The privacy notice has changed. Please read it again.');
  if (!b.purposes.includes('service')) throw new HttpError(400, 'Consent for service delivery is needed to use the portal.');
  await giveConsent(req.user!.id, b.purposes, b.version, clientIp(req));
  await auditReq(req, { action: 'privacy.consent_given', objectType: 'consent', details: b });
  res.status(201).json({ ok: true });
}));

privacyRouter.post('/privacy/consent/withdraw', requireRole('client'), h(async (req, res) => {
  const b = parse(z.object({ purposes: z.array(z.string()).min(1) }), req.body);
  const current = await activeConsent(req.user!.id);
  if (!current) throw new HttpError(404, 'No active consent.');
  const { lostService } = await withdrawConsent(req.user!.id, b.purposes);
  await auditReq(req, { action: 'privacy.consent_withdrawn', objectType: 'consent', objectId: current.id, details: { withdrawn: b.purposes } });
  if (lostService) {
    // Record it for the firm to action, then sign the client out.
    await raiseRequest(req.user!.id, 'withdraw_consent', 'Client withdrew consent for service delivery through the portal.');
    if (req.sessionHash) await destroySession(req.sessionHash);
    clearSessionCookie(res);
  }
  res.json({ ok: true, signedOut: lostService });
}));

privacyRouter.get('/privacy/mine', requireAuth, h(async (req, res) => {
  const [consents, requests] = await Promise.all([listConsents(req.user!.id), requestsForUser(req.user!.id)]);
  res.json({
    // purposes as a JSON string, the shape the app reads from the SQLite build
    consents: consents.map((c) => ({ notice_version: c.notice_version, purposes: JSON.stringify(c.purposes), given_at: c.given_at, withdrawn_at: c.withdrawn_at })),
    requests: requests.map(({ id, type, details, status, response, due_at, created_at, closed_at }) => ({ id, type, details, status, response, due_at, created_at, closed_at })),
  });
}));

/** Right to access (DPDP Act s.11): a machine-readable summary of the person's own data. */
privacyRouter.get('/privacy/my-data', requireAuth, h(async (req, res) => {
  const data = await exportMyData(req.user!.id);
  await auditReq(req, { action: 'privacy.data_exported', objectType: 'user', objectId: req.user!.id });
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(data);
}));

privacyRouter.post('/privacy/requests', requireAuth, h(async (req, res) => {
  const b = parse(z.object({
    type: z.enum(['access', 'correction', 'erasure', 'grievance', 'nomination']),
    details: zText(4000).min(5),
  }), req.body);
  const reqId = await raiseRequest(req.user!.id, b.type, b.details);
  await auditReq(req, { action: 'privacy.request_raised', objectType: 'dpdp_request', objectId: reqId, details: { type: b.type } });
  res.status(201).json({ id: reqId });
}));

const STATUS_RANK: Record<string, number> = { open: 0, in_progress: 1 };

privacyRouter.get('/privacy/requests', requireRole('director'), h(async (_req, res) => {
  const [rows, users] = await Promise.all([allRequests(), userNames()]);
  res.json(rows
    .sort((a, b) => (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2) || a.due_at.localeCompare(b.due_at))
    .map((r) => ({ ...r, user_name: users.get(r.user_id)?.name, user_role: users.get(r.user_id)?.role, handled_by_name: r.handled_by ? users.get(r.handled_by)?.name ?? null : null })));
}));

privacyRouter.patch('/privacy/requests/:id', requireRole('director'), h(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['in_progress', 'closed', 'rejected']), response: zText(4000).optional() }), req.body);
  if (b.status !== 'in_progress' && !b.response) throw new HttpError(400, 'Write the response sent to the person.');
  await updateRequest(String(req.params.id), req.user!.id, b.status, b.response).catch(notFound);
  await auditReq(req, { action: `privacy.request_${b.status}`, objectType: 'dpdp_request', objectId: String(req.params.id) });
  res.json({ ok: true });
}));

/* ---------- Breach register (DPDP Act s.8(6)) ---------- */

privacyRouter.get('/privacy/breaches', requireRole('director'), h(async (_req, res) => {
  const [rows, users] = await Promise.all([listBreaches(), userNames()]);
  res.json(rows.map((b) => ({ ...b, created_by_name: users.get(b.created_by)?.name })));
}));

const breach = z.object({
  detected_at: z.iso.datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)),
  description: zText(4000).min(10),
  data_affected: zText(2000).min(3),
  principals_affected: z.number().int().min(0).optional(),
});

privacyRouter.post('/privacy/breaches', requireRole('director'), h(async (req, res) => {
  const b = parse(breach, req.body);
  const bId = await recordBreach({ ...b, detected_at: new Date(b.detected_at).toISOString(), created_by: req.user!.id });
  await auditReq(req, { action: 'privacy.breach_recorded', objectType: 'breach', objectId: bId });
  res.status(201).json({ id: bId });
}));

privacyRouter.patch('/privacy/breaches/:id', requireRole('director'), h(async (req, res) => {
  const b = parse(z.object({
    status: z.enum(['open', 'contained', 'closed']).optional(),
    board_intimated: z.boolean().optional(),
    principals_notified: z.boolean().optional(),
  }), req.body);
  await updateBreach(String(req.params.id), { status: b.status, boardIntimated: b.board_intimated, principalsNotified: b.principals_notified }).catch(notFound);
  await auditReq(req, { action: 'privacy.breach_updated', objectType: 'breach', objectId: String(req.params.id), details: b });
  res.json({ ok: true });
}));

/* ---------- Audit log ---------- */

privacyRouter.get('/audit', requireRole('director'), h(async (req, res) => {
  const q = parse(z.object({
    before: z.coerce.number().int().optional(),
    action: zText(60).optional(),
    company_id: z.uuid().optional(),
  }), req.query);
  // Newest first, filtered here so no composite index is needed.
  // shortcut: scans at most 5,000 entries for a filtered page; add indexed queries if filters come back short on a large log.
  const matches: AuditDoc[] = [];
  let cursor = q.before;
  for (let scanned = 0; matches.length < 200 && scanned < 5000;) {
    let page = db.collection(C.audit).orderBy('seq', 'desc').limit(500);
    if (cursor !== undefined) page = page.where('seq', '<', cursor);
    const snap = await page.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const a = d.data() as AuditDoc;
      if ((!q.action || a.action.startsWith(q.action)) && (!q.company_id || a.company_id === q.company_id)) matches.push(a);
    }
    scanned += snap.size;
    cursor = (snap.docs[snap.size - 1].data() as AuditDoc).seq;
  }
  const [users, companies] = await Promise.all([userNames(), companyMap()]);
  res.json(matches.slice(0, 200).map((a) => {
    // Sign-in events have no actor yet; show the person signing in.
    const who = users.get(a.actor_id ?? (a.action.startsWith('auth.') && a.object_type === 'user' ? a.object_id ?? '' : ''));
    return {
      seq: a.seq, ts: a.ts, action: a.action, object_type: a.object_type, object_id: a.object_id, ip: a.ip, details: a.details,
      hash: a.hash, actor_role: a.actor_role ?? who?.role ?? null, actor: who?.name ?? null,
      company: a.company_id ? companies.get(a.company_id)?.legal_name ?? null : null,
    };
  }));
}));

privacyRouter.get('/audit/verify', requireRole('director'), h(async (req, res) => {
  const result = await verifyAuditChain();
  await auditReq(req, { action: 'audit.verified', details: { ok: result.ok, checked: result.checked } });
  res.json(result);
}));

