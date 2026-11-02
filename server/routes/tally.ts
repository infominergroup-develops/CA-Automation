import fs from 'node:fs';
import zlib from 'node:zlib';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { assertCompany, employeeCategories, inScope } from '../authz.ts';
import { all, one, run, tx, now, id, setting } from '../db.ts';
import { auditReq, parse, zId, zText } from '../http.ts';
import { randomToken, safeEqualHex, sha256 } from '../security/crypto.ts';
import { HttpError, requireAuth, requireRole, type SessionUser } from '../security/session.ts';
import { FY_RE, fyOf, fyStart, prevFy, todayIso } from '../tally/fy.ts';
import { ingestSnapshot, snapshotSchema } from '../tally/ingest.ts';
import { balanceSheet, ledgerStatement, loadCtx, outstanding, profitLoss, trialBalance, type ReportType } from '../tally/reports.ts';
import { renderPdf, renderXlsx } from '../tally/render.ts';

const SYNC_EVERY_HOURS = 2;      // current FY
const PREV_FY_EVERY_HOURS = 24;  // last FY changes rarely
const ONLINE_MINUTES = 3;

/* ======================================================================= Agent API
 * The sync agent authenticates with "Authorization: Bearer <agentId>.<secret>". No cookies, so no CSRF surface.
 */

declare global { namespace Express { interface Request { agent?: { id: string; name: string } } } }

export const agentRouter = Router();
agentRouter.use(rateLimit({ windowMs: 60e3, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

function agentAuth(req: Request, _res: Response, next: NextFunction) {
  const m = String(req.headers.authorization ?? '').match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/);
  const a = m ? one<{ id: string; name: string; key_hash: string; status: string }>('SELECT id, name, key_hash, status FROM tally_agents WHERE id = ?', [m[1]]) : undefined;
  if (!a || a.status !== 'active' || !safeEqualHex(sha256(m![2]), a.key_hash)) {
    audit({ action: 'tally.agent_auth_failed', ip: req.ip ?? null, details: { agent: m?.[1] } });
    return next(new HttpError(401, 'Invalid agent key.'));
  }
  req.agent = { id: a.id, name: a.name };
  run('UPDATE tally_agents SET last_seen = ?, last_ip = ? WHERE id = ?', [now(), req.ip ?? null, a.id]);
  next();
}
agentRouter.use(agentAuth);

const hello = z.object({
  pcName: zText(100),
  agentVersion: zText(40),
  tallyReachable: z.boolean(),
  companies: z.array(z.object({ name: zText(200).min(1), guid: zText(100).min(1), booksFrom: z.string().max(10).optional() })).max(500),
});

/** Heartbeat: the agent reports what Tally has open; the server answers with what to sync now. */
agentRouter.post('/hello', express.json({ limit: '200kb' }), (req, res) => {
  const b = parse(hello, req.body);
  const agentId = req.agent!.id;
  tx(() => {
    run('UPDATE tally_agents SET pc_name = ?, agent_version = ?, tally_reachable = ? WHERE id = ?', [b.pcName, b.agentVersion, b.tallyReachable ? 1 : 0, agentId]);
    for (const c of b.companies) {
      run(`INSERT INTO tally_companies (id, agent_id, tally_name, tally_guid, books_from, last_reported) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, tally_guid) DO UPDATE SET tally_name = excluded.tally_name, books_from = excluded.books_from, last_reported = excluded.last_reported`,
      [id(), agentId, c.name, c.guid, c.booksFrom ?? null, now()]);
    }
  });

  const open = new Set(b.companies.map((c) => c.guid));
  const sources = all<{ id: string; company_id: string; tally_guid: string; tally_name: string }>(
    'SELECT id, company_id, tally_guid, tally_name FROM tally_companies WHERE agent_id = ? AND is_primary = 1 AND company_id IS NOT NULL', [agentId]);
  const due: { tallyGuid: string; tallyName: string; fy: string; jobId?: string }[] = [];
  const curFy = fyOf(todayIso());
  for (const s of sources) {
    if (!open.has(s.tally_guid)) continue; // company not loaded in Tally right now
    const last = (fy: string) => one<{ t: string }>('SELECT MAX(synced_at) AS t FROM tally_snapshots WHERE company_id = ? AND fy = ?', [s.company_id, fy])?.t;
    const stale = (fy: string, hours: number) => { const t = last(fy); return !t || Date.parse(t) < Date.now() - hours * 3600e3; };
    const job = one<{ id: string }>(`SELECT id FROM sync_requests WHERE company_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1`, [s.company_id]);
    if (job) run(`UPDATE sync_requests SET status = 'picked', agent_id = ?, picked_at = ? WHERE company_id = ? AND status = 'pending'`, [agentId, now(), s.company_id]);
    if (job || stale(curFy, SYNC_EVERY_HOURS)) due.push({ tallyGuid: s.tally_guid, tallyName: s.tally_name, fy: curFy, jobId: job?.id });
    if (stale(prevFy(curFy), PREV_FY_EVERY_HOURS)) due.push({ tallyGuid: s.tally_guid, tallyName: s.tally_name, fy: prevFy(curFy) });
  }
  res.json({ due, pollSeconds: 60, serverTime: now() });
});

/** Snapshot upload: gzip-compressed JSON, validated, then ingested in one transaction. */
agentRouter.post('/snapshot', express.raw({ type: 'application/gzip', limit: '60mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Send gzip-compressed JSON.');
  let raw: string;
  try { raw = zlib.gunzipSync(req.body, { maxOutputLength: 400 * 1024 * 1024 }).toString('utf8'); }
  catch { throw new HttpError(400, 'Payload is not valid gzip.'); }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new HttpError(400, 'Payload is not valid JSON.'); }
  const s = parse(snapshotSchema, json);
  const src = one<{ company_id: string | null; is_primary: number }>('SELECT company_id, is_primary FROM tally_companies WHERE agent_id = ? AND tally_guid = ?', [req.agent!.id, s.tally.guid]);
  if (!src?.company_id || !src.is_primary) throw new HttpError(409, 'This Tally company is not mapped to a portal company with this PC as its primary source.');
  const result = ingestSnapshot(src.company_id, req.agent!.id, raw, s);
  audit({ action: 'tally.snapshot_received', objectType: 'company', objectId: src.company_id, companyId: src.company_id, ip: req.ip ?? null,
    details: { agent: req.agent!.name, fy: s.fy, status: result.status, ...result.stats } });
  res.json(result);
});

agentRouter.post('/jobs/:id/done', express.json({ limit: '20kb' }), (req, res) => {
  const b = parse(z.object({ ok: z.boolean(), error: zText(1000).optional() }), req.body);
  run(`UPDATE sync_requests SET status = ?, error = ?, done_at = ? WHERE id = ? AND agent_id = ? AND status = 'picked'`,
    [b.ok ? 'done' : 'failed', b.error ?? null, now(), String(req.params.id), req.agent!.id]);
  res.json({ ok: true });
});

/* ======================================================================= Admin: agents and mapping */

export const tallyRouter = Router();

tallyRouter.get('/tally/agents', requireRole('director'), (_req, res) => {
  const rows = all<Record<string, unknown> & { last_seen: string | null }>(
    `SELECT a.id, a.name, a.status, a.pc_name, a.agent_version, a.tally_reachable, a.last_seen, a.created_at,
            (SELECT COUNT(*) FROM tally_companies t WHERE t.agent_id = a.id) AS companies
     FROM tally_agents a ORDER BY a.status, a.name`);
  res.json(rows.map((r) => ({ ...r, online: !!r.last_seen && Date.parse(r.last_seen) > Date.now() - ONLINE_MINUTES * 60e3 })));
});

tallyRouter.post('/tally/agents', requireRole('director'), (req, res) => {
  const b = parse(z.object({ name: zText(80).min(2) }), req.body);
  const agentId = id();
  const secret = randomToken(32);
  run('INSERT INTO tally_agents (id, name, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [agentId, b.name, sha256(secret), req.user!.id, now()]);
  auditReq(req, { action: 'tally.agent_created', objectType: 'tally_agent', objectId: agentId, details: { name: b.name } });
  // The key is shown exactly once; only its hash is stored.
  res.status(201).json({ id: agentId, key: `${agentId}.${secret}` });
});

/** The agent program (built by `npm run agent:build`) and its Windows installer. */
tallyRouter.get('/tally/agent/download', requireRole('director'), (req, res) => {
  const installer = req.query.file === 'installer';
  const file = new URL(installer ? '../../agent/install-agent.ps1' : '../../agent/dist/infominer-agent.mjs', import.meta.url);
  if (!fs.existsSync(file)) throw new HttpError(404, 'The agent has not been built. Run "npm run agent:build" on the server.');
  auditReq(req, { action: 'tally.agent_downloaded', details: { file: installer ? 'installer' : 'program' } });
  res.setHeader('Content-Type', installer ? 'text/plain' : 'text/javascript');
  res.setHeader('Content-Disposition', `attachment; filename="${installer ? 'install-agent.ps1' : 'infominer-agent.mjs'}"`);
  res.end(fs.readFileSync(file));
});

tallyRouter.post('/tally/agents/:id/revoke', requireRole('director'), (req, res) => {
  const agentId = String(req.params.id);
  const r = run(`UPDATE tally_agents SET status = 'revoked' WHERE id = ? AND status = 'active'`, [agentId]);
  if (!r.changes) throw new HttpError(404, 'Not found.');
  run('UPDATE tally_companies SET is_primary = 0 WHERE agent_id = ?', [agentId]);
  auditReq(req, { action: 'tally.agent_revoked', objectType: 'tally_agent', objectId: agentId });
  res.json({ ok: true });
});

tallyRouter.get('/tally/sources', requireRole('director', 'manager'), (req, res) => {
  const rows = all<Record<string, unknown> & { company_id: string | null; tally_guid: string; last_seen: string | null }>(
    `SELECT t.id, t.tally_name, t.tally_guid, t.books_from, t.company_id, c.legal_name AS company, t.is_primary, t.last_reported, t.last_synced,
            a.name AS agent, a.pc_name, a.last_seen, a.status AS agent_status,
            (SELECT status FROM tally_snapshots s WHERE s.company_id = t.company_id ORDER BY synced_at DESC LIMIT 1) AS snapshot_status
     FROM tally_companies t JOIN tally_agents a ON a.id = t.agent_id LEFT JOIN companies c ON c.id = t.company_id
     WHERE a.status = 'active' ORDER BY t.company_id IS NOT NULL, t.tally_name`);
  const copies = new Map<string, number>();
  for (const r of rows) copies.set(r.tally_guid, (copies.get(r.tally_guid) ?? 0) + 1);
  res.json(rows
    .filter((r) => req.user!.role === 'director' || !r.company_id || inScope(req.user!, r.company_id))
    .map((r) => ({ ...r, online: !!r.last_seen && Date.parse(r.last_seen) > Date.now() - ONLINE_MINUTES * 60e3, copies: copies.get(r.tally_guid) })));
});

tallyRouter.post('/tally/sources/:id/map', requireRole('director', 'manager'), (req, res) => {
  const b = parse(z.object({ company_id: zId.nullable() }), req.body);
  const src = one<{ id: string; tally_guid: string; company_id: string | null }>('SELECT id, tally_guid, company_id FROM tally_companies WHERE id = ?', [String(req.params.id)]);
  if (!src) throw new HttpError(404, 'Not found.');
  if (b.company_id) assertCompany(req.user!, b.company_id);
  if (src.company_id && !inScope(req.user!, src.company_id)) throw new HttpError(404, 'Not found.');
  tx(() => {
    run('UPDATE tally_companies SET company_id = ?, is_primary = 0 WHERE id = ?', [b.company_id, src.id]);
    // The first source mapped to a company becomes its primary automatically.
    if (b.company_id && !one('SELECT 1 FROM tally_companies WHERE company_id = ? AND is_primary = 1', [b.company_id])) {
      run('UPDATE tally_companies SET is_primary = 1 WHERE id = ?', [src.id]);
    }
  });
  auditReq(req, { action: b.company_id ? 'tally.source_mapped' : 'tally.source_unmapped', objectType: 'tally_source', objectId: src.id, companyId: b.company_id ?? src.company_id });
  res.json({ ok: true });
});

tallyRouter.post('/tally/sources/:id/primary', requireRole('director', 'manager'), (req, res) => {
  const src = one<{ id: string; company_id: string | null }>('SELECT id, company_id FROM tally_companies WHERE id = ?', [String(req.params.id)]);
  if (!src?.company_id) throw new HttpError(404, 'Map this source to a company first.');
  assertCompany(req.user!, src.company_id);
  tx(() => {
    run('UPDATE tally_companies SET is_primary = 0 WHERE company_id = ?', [src.company_id]);
    run('UPDATE tally_companies SET is_primary = 1 WHERE id = ?', [src.id]);
  });
  auditReq(req, { action: 'tally.primary_changed', objectType: 'tally_source', objectId: src.id, companyId: src.company_id });
  res.json({ ok: true });
});

/* ======================================================================= Reports */

/** Who may see a company's reports. Employees need an open, granted task on the company. */
function assertReports(u: SessionUser, companyId: string, fy?: string) {
  assertCompany(u, companyId);
  if (u.role === 'employee' && employeeCategories(u.id, companyId).size === 0) {
    throw new HttpError(403, 'You need granted document access on an open task for this client to see its reports.');
  }
  if (u.role === 'client' && fy) {
    const s = one<{ client_visible: number }>('SELECT client_visible FROM report_settings WHERE company_id = ? AND fy = ?', [companyId, fy]);
    if (s && !s.client_visible) throw new HttpError(403, `Reports for FY ${fy} are being reviewed by your CA team and will be available soon.`);
  }
}

tallyRouter.get('/companies/:id/reports/meta', requireAuth, (req, res) => {
  const companyId = String(req.params.id);
  assertReports(req.user!, companyId);
  const u = req.user!;
  const fys = all<{ fy: string }>('SELECT DISTINCT fy FROM tally_snapshots WHERE company_id = ? ORDER BY fy DESC', [companyId]).map((r) => r.fy);
  const out = fys.map((fy) => {
    const snap = one<{ synced_at: string; status: string; checks: string; stats: string; period_to: string }>(
      'SELECT synced_at, status, checks, stats, period_to FROM tally_snapshots WHERE company_id = ? AND fy = ? ORDER BY synced_at DESC LIMIT 1', [companyId, fy])!;
    const s = one<{ client_visible: number; final: number }>('SELECT client_visible, final FROM report_settings WHERE company_id = ? AND fy = ?', [companyId, fy]);
    return {
      fy,
      monthEnds: all<{ m: string }>('SELECT DISTINCT month_end AS m FROM tally_balances WHERE company_id = ? AND fy = ? ORDER BY m', [companyId, fy]).map((r) => r.m),
      syncedAt: snap.synced_at,
      periodTo: snap.period_to,
      clientVisible: s ? !!s.client_visible : true,
      final: !!s?.final,
      ...(u.role === 'client' ? {} : { status: snap.status, checks: JSON.parse(snap.checks), stats: JSON.parse(snap.stats) }),
    };
  }).filter((f) => u.role !== 'client' || f.clientVisible);
  const source = one<{ last_seen: string | null; pc_name: string | null; tally_name: string }>(
    `SELECT a.last_seen, a.pc_name, t.tally_name FROM tally_companies t JOIN tally_agents a ON a.id = t.agent_id
     WHERE t.company_id = ? AND t.is_primary = 1 AND a.status = 'active'`, [companyId]);
  const pending = one<{ status: string; created_at: string }>(`SELECT status, created_at FROM sync_requests WHERE company_id = ? AND status IN ('pending','picked') ORDER BY created_at DESC LIMIT 1`, [companyId]);
  res.json({
    fys: out,
    source: source ? { online: !!source.last_seen && Date.parse(source.last_seen) > Date.now() - ONLINE_MINUTES * 60e3, ...(u.role === 'client' ? {} : source) } : null,
    pending: pending ?? null,
  });
});

tallyRouter.get('/companies/:id/reports/ledgers', requireAuth, (req, res) => {
  const companyId = String(req.params.id);
  const q = parse(z.object({ fy: z.string().regex(FY_RE) }), req.query);
  assertReports(req.user!, companyId, q.fy);
  res.json(all('SELECT name, parent AS "group" FROM tally_ledgers WHERE company_id = ? AND fy = ? ORDER BY name', [companyId, q.fy]));
});

const REPORTS: ReportType[] = ['balance-sheet', 'profit-loss', 'trial-balance', 'ledger', 'debtors', 'creditors'];

tallyRouter.get('/companies/:id/reports/:type', requireAuth, async (req, res) => {
  const companyId = String(req.params.id);
  const type = String(req.params.type) as ReportType;
  if (!REPORTS.includes(type)) throw new HttpError(404, 'Unknown report.');
  const q = parse(z.object({
    fy: z.string().regex(FY_RE),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ledger: zText(200).optional(),
    format: z.enum(['json', 'pdf', 'xlsx']).default('json'),
  }), req.query);
  assertReports(req.user!, companyId, q.fy);
  const c = loadCtx(companyId, q.fy);
  const from = q.from ?? fyStart(q.fy);
  const doc =
    type === 'balance-sheet' ? balanceSheet(c, q.to)
      : type === 'profit-loss' ? profitLoss(c, from, q.to)
        : type === 'trial-balance' ? trialBalance(c, q.to)
          : type === 'ledger' ? ledgerStatement(c, q.ledger ?? '', from, q.to)
            : outstanding(c, type, q.to);

  auditReq(req, { action: q.format === 'json' ? 'report.viewed' : 'report.downloaded', objectType: 'report', objectId: type, companyId,
    details: { fy: q.fy, from, to: q.to, ledger: q.ledger, format: q.format } });

  if (q.format === 'json') return res.json(doc);
  const viewer = { name: req.user!.name, firm: setting('firm_name'), at: new Date() };
  const fname = `${doc.company} - ${doc.title} - ${q.to}`.replace(/[^\w .&()-]+/g, '_');
  if (q.format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}.pdf`);
    return res.end(await renderPdf(doc, viewer));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}.xlsx`);
  res.end(await renderXlsx(doc, viewer));
});

const syncLimiter = rateLimit({ windowMs: 10 * 60e3, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (req) => `${req.user?.id}:${req.params.id}` });

tallyRouter.post('/companies/:id/sync-request', requireAuth, syncLimiter, (req, res) => {
  const companyId = String(req.params.id);
  assertReports(req.user!, companyId);
  if (!one(`SELECT 1 FROM tally_companies t JOIN tally_agents a ON a.id = t.agent_id WHERE t.company_id = ? AND t.is_primary = 1 AND a.status = 'active'`, [companyId])) {
    throw new HttpError(409, 'This company is not connected to Tally yet.');
  }
  const existing = one<{ id: string }>(`SELECT id FROM sync_requests WHERE company_id = ? AND status IN ('pending','picked')`, [companyId]);
  if (existing) return res.json({ id: existing.id, alreadyQueued: true });
  const reqId = id();
  run('INSERT INTO sync_requests (id, company_id, requested_by, created_at) VALUES (?, ?, ?, ?)', [reqId, companyId, req.user!.id, now()]);
  auditReq(req, { action: 'tally.sync_requested', objectType: 'company', objectId: companyId, companyId });
  res.status(201).json({ id: reqId });
});

tallyRouter.patch('/companies/:id/report-settings', requireRole('director', 'manager'), (req, res) => {
  const companyId = String(req.params.id);
  assertCompany(req.user!, companyId);
  const b = parse(z.object({ fy: z.string().regex(FY_RE), client_visible: z.boolean().optional(), final: z.boolean().optional() }), req.body);
  run(`INSERT INTO report_settings (company_id, fy, client_visible, final, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, fy) DO UPDATE SET
         client_visible = COALESCE(?, client_visible), final = COALESCE(?, final), updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  [companyId, b.fy, b.client_visible === false ? 0 : 1, b.final ? 1 : 0, req.user!.id, now(),
    b.client_visible === undefined ? null : b.client_visible ? 1 : 0, b.final === undefined ? null : b.final ? 1 : 0]);
  auditReq(req, { action: 'report.settings_changed', objectType: 'company', objectId: companyId, companyId, details: b });
  res.json({ ok: true });
});
