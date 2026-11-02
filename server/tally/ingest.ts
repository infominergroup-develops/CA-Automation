import { z } from 'zod';
import { db, run, tx, now, id } from '../db.ts';
import { sha256 } from '../security/crypto.ts';
import { FY_RE, fyEnd, fyStart } from './fy.ts';

/**
 * Snapshot sent by the sync agent for one company and one FY.
 * The agent converts Tally's sign convention (Dr negative) so that here Dr is positive and Cr negative.
 */
const name = z.string().min(1).max(200);
const amount = z.number().finite().refine((n) => Math.abs(n) < 1e14, 'amount out of range');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const snapshotSchema = z.object({
  agentVersion: z.string().max(40),
  tally: z.object({ name, guid: z.string().min(1).max(100) }),
  fy: z.string().regex(FY_RE),
  periodTo: date,
  groups: z.array(z.object({
    name, parent: z.string().max(200), isRevenue: z.boolean(), affectsGrossProfit: z.boolean(), isDeemedPositive: z.boolean(),
  })).max(5000),
  ledgers: z.array(z.object({ name, parent: name, opening: amount, gstin: z.string().max(20).optional() })).max(100_000),
  balances: z.array(z.object({ monthEnd: date, closing: z.record(z.string(), amount) })).max(13),
  stock: z.array(z.object({ monthEnd: date, opening: amount, closing: amount })).max(13),
  vouchers: z.array(z.object({
    guid: z.string().min(1).max(100), date, type: z.string().max(100), number: z.string().max(100).optional(),
    party: z.string().max(200).optional(), narration: z.string().max(2000).optional(),
    entries: z.array(z.object({ ledger: name, amount })).max(2000),
  })).max(500_000),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export interface Check { code: string; ok: boolean; message: string; details?: unknown }

const round = (n: number) => Math.round(n * 100) / 100;
const PRIMARY_ROOTS = new Set(['', 'Primary', '\u0004 Primary']);

/** Walks each group up to its primary group, and inherits nature flags from it. */
function resolveGroups(groups: Snapshot['groups']) {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const primaryOf = (n: string): string => {
    const seen = new Set<string>();
    let cur = n;
    while (true) {
      const g = byName.get(cur);
      if (!g || PRIMARY_ROOTS.has(g.parent) || seen.has(cur)) return cur;
      seen.add(cur);
      cur = g.parent;
    }
  };
  return new Map(groups.map((g) => {
    const primary = primaryOf(g.name);
    const p = byName.get(primary) ?? g;
    return [g.name, { ...g, primary, isRevenue: p.isRevenue, affectsGrossProfit: p.affectsGrossProfit, isDebit: p.isDeemedPositive }];
  }));
}

export function ingestSnapshot(companyId: string, agentId: string, raw: string, s: Snapshot) {
  if (s.periodTo < fyStart(s.fy) || s.periodTo > fyEnd(s.fy)) throw new Error('periodTo is outside the financial year');
  const groups = resolveGroups(s.groups);
  const ledgerPrimary = (parent: string) => groups.get(parent)?.primary ?? parent;
  const checks: Check[] = [];

  // 1. Trial balance must net to zero at every month end. When stock is valued from inventory (not kept in
  //    ledgers), Tally balances the trial balance with a separate Opening Stock line, so add it back.
  const stockInLedgers = s.ledgers.some((l) => ledgerPrimary(l.parent) === 'Stock-in-Hand');
  const inventoryOpening = stockInLedgers ? 0 : (s.stock[0]?.opening ?? 0);
  const tbOff = s.balances
    .map((b) => ({ monthEnd: b.monthEnd, diff: round(Object.values(b.closing).reduce((a, n) => a + n, 0) + inventoryOpening) }))
    .filter((x) => Math.abs(x.diff) >= 1);
  checks.push({
    code: 'tb_balanced', ok: !tbOff.length,
    message: tbOff.length ? `Trial balance does not tally at ${tbOff.length} month end(s); likely a difference in opening balances.` : 'Trial balance tallies at every month end.',
    details: tbOff.slice(0, 12),
  });

  // 2. Every voucher must balance.
  const unbalanced = s.vouchers.filter((v) => Math.abs(v.entries.reduce((a, e) => a + e.amount, 0)) >= 0.01);
  checks.push({
    code: 'vouchers_balanced', ok: !unbalanced.length,
    message: unbalanced.length ? `${unbalanced.length} voucher(s) have debits not equal to credits.` : 'Every voucher balances.',
    details: unbalanced.slice(0, 20).map((v) => ({ date: v.date, type: v.type, number: v.number })),
  });

  // 3. Opening + vouchers must equal Tally's own closing balance, ledger by ledger (proves nothing was lost in transfer).
  const last = s.balances.at(-1);
  if (last) {
    const moved = new Map<string, number>();
    for (const v of s.vouchers) {
      if (v.date > last.monthEnd) continue;
      for (const e of v.entries) moved.set(e.ledger, (moved.get(e.ledger) ?? 0) + e.amount);
    }
    const mismatched = s.ledgers
      .map((l) => ({ ledger: l.name, expected: round(l.opening + (moved.get(l.name) ?? 0)), tally: round(last.closing[l.name] ?? 0) }))
      .filter((x) => Math.abs(x.expected - x.tally) >= 1);
    checks.push({
      code: 'ledgers_reconcile', ok: !mismatched.length,
      message: mismatched.length ? `${mismatched.length} ledger(s) do not reconcile: opening + vouchers differs from Tally's closing balance.` : `All ${s.ledgers.length} ledgers reconcile with Tally's closing balances.`,
      details: mismatched.slice(0, 20),
    });
  }

  const status = checks.every((c) => c.ok) ? 'ok' : 'warning';
  const stats = { groups: s.groups.length, ledgers: s.ledgers.length, vouchers: s.vouchers.length, months: s.balances.length, hasStock: s.stock.length > 0 };
  const snapshotId = id();
  const k = [companyId, s.fy] as const;

  tx(() => {
    for (const t of ['tally_groups', 'tally_ledgers', 'tally_balances', 'tally_stock', 'tally_vouchers', 'tally_entries']) {
      run(`DELETE FROM ${t} WHERE company_id = ? AND fy = ?`, [...k]);
    }
    const ig = db.prepare('INSERT INTO tally_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const g of groups.values()) ig.run(...k, g.name, g.parent, g.primary, g.isRevenue ? 1 : 0, g.affectsGrossProfit ? 1 : 0, g.isDebit ? 1 : 0);
    const il = db.prepare('INSERT INTO tally_ledgers VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const l of s.ledgers) il.run(...k, l.name, l.parent, ledgerPrimary(l.parent), l.gstin ?? null, round(l.opening));
    const ib = db.prepare('INSERT INTO tally_balances VALUES (?, ?, ?, ?, ?)');
    for (const b of s.balances) for (const [ledger, c] of Object.entries(b.closing)) if (c !== 0) ib.run(...k, b.monthEnd, ledger, round(c));
    const is = db.prepare('INSERT INTO tally_stock VALUES (?, ?, ?, ?, ?)');
    for (const st of s.stock) is.run(...k, st.monthEnd, round(st.opening), round(st.closing));
    const iv = db.prepare('INSERT OR REPLACE INTO tally_vouchers VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const ie = db.prepare('INSERT INTO tally_entries VALUES (?, ?, ?, ?, ?)');
    for (const v of s.vouchers) {
      iv.run(...k, v.guid, v.date, v.type, v.number ?? null, v.party ?? null, v.narration ?? null);
      for (const e of v.entries) ie.run(...k, v.guid, e.ledger, round(e.amount));
    }
    run(`INSERT INTO tally_snapshots (id, company_id, agent_id, fy, period_to, synced_at, payload_sha256, stats, checks, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [snapshotId, companyId, agentId, s.fy, s.periodTo, now(), sha256(raw), JSON.stringify(stats), JSON.stringify(checks), status]);
    run('UPDATE tally_companies SET last_synced = ? WHERE agent_id = ? AND tally_guid = ?', [now(), agentId, s.tally.guid]);
  });
  return { snapshotId, status, checks, stats };
}
