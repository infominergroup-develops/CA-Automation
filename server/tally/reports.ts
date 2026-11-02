import { all, one } from '../db.ts';
import { HttpError } from '../security/session.ts';
import { addDays, fmtDateLong, fyStart } from './fy.ts';

/**
 * Report engine. Every report returns one ReportDoc; the web view, PDF and Excel are all rendered from it,
 * so the three can never disagree. Internally Dr is positive and Cr negative.
 */

export type Align = 'left' | 'right';
export interface Row { cells: (string | number | null)[]; style?: 'heading' | 'subtotal' | 'total' | 'muted'; indent?: number }
export interface ReportDoc {
  type: ReportType;
  title: string;
  company: string;
  period: string;
  columns: { label: string; align: Align; width: number }[];
  rows: Row[];
  summary?: { label: string; value: number; tone?: 'good' | 'bad' }[];
  notes?: string[];
  dataAsOf: string;
  provisional: boolean;
}
export type ReportType = 'balance-sheet' | 'profit-loss' | 'trial-balance' | 'ledger' | 'debtors' | 'creditors';

const r2 = (n: number) => Math.round(n * 100) / 100;
const nz = (n: number) => Math.abs(n) >= 0.005;

interface Ctx {
  companyId: string;
  fy: string;
  company: string;
  groups: Map<string, { parent: string; primary: string; is_revenue: number; affects_gp: number; is_debit: number }>;
  ledgers: Map<string, { parent: string; primary: string; opening: number; gstin: string | null }>;
  monthEnds: string[];
  dataAsOf: string;
  provisional: boolean;
}

export function loadCtx(companyId: string, fy: string): Ctx {
  const snap = one<{ synced_at: string }>('SELECT synced_at FROM tally_snapshots WHERE company_id = ? AND fy = ? ORDER BY synced_at DESC LIMIT 1', [companyId, fy]);
  if (!snap) throw new HttpError(404, `No Tally data has been synced for FY ${fy} yet.`);
  const company = one<{ legal_name: string }>('SELECT legal_name FROM companies WHERE id = ?', [companyId])!.legal_name;
  const groups = new Map(all<{ name: string; parent: string; primary_group: string; is_revenue: number; affects_gp: number; is_debit: number }>(
    'SELECT name, parent, primary_group, is_revenue, affects_gp, is_debit FROM tally_groups WHERE company_id = ? AND fy = ?', [companyId, fy])
    .map((g) => [g.name, { parent: g.parent, primary: g.primary_group, is_revenue: g.is_revenue, affects_gp: g.affects_gp, is_debit: g.is_debit }]));
  const ledgers = new Map(all<{ name: string; parent: string; primary_group: string; opening: number; gstin: string | null }>(
    'SELECT name, parent, primary_group, opening, gstin FROM tally_ledgers WHERE company_id = ? AND fy = ?', [companyId, fy])
    .map((l) => [l.name, { parent: l.parent, primary: l.primary_group, opening: l.opening, gstin: l.gstin }]));
  const monthEnds = all<{ month_end: string }>('SELECT DISTINCT month_end FROM tally_balances WHERE company_id = ? AND fy = ? ORDER BY month_end', [companyId, fy]).map((m) => m.month_end);
  const setting = one<{ final: number }>('SELECT final FROM report_settings WHERE company_id = ? AND fy = ?', [companyId, fy]);
  return { companyId, fy, company, groups, ledgers, monthEnds, dataAsOf: snap.synced_at, provisional: !setting?.final };
}

function balancesAt(c: Ctx, monthEnd: string): Map<string, number> {
  if (!c.monthEnds.includes(monthEnd)) throw new HttpError(400, 'Choose one of the available month ends.');
  return new Map(all<{ ledger: string; closing: number }>('SELECT ledger, closing FROM tally_balances WHERE company_id = ? AND fy = ? AND month_end = ?', [c.companyId, c.fy, monthEnd])
    .map((b) => [b.ledger, b.closing]));
}

/** The chain of groups from a ledger's parent up to its primary group. */
function chain(c: Ctx, parent: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = parent;
  while (cur && c.groups.has(cur) && out.length < 50) {
    out.push(cur);
    const g: { parent: string; primary: string } = c.groups.get(cur)!;
    if (g.primary === cur) break;
    cur = g.parent;
  }
  return out;
}
/** First-level heading under the primary group (a sub-group, or the ledger itself if it sits directly under the primary). */
function headingOf(c: Ctx, ledger: string): string {
  const ch = chain(c, c.ledgers.get(ledger)?.parent ?? '');
  return ch.length >= 2 ? ch[ch.length - 2] : ledger;
}

function isPnL(c: Ctx, ledger: string) {
  const l = c.ledgers.get(ledger);
  return !!l && !!c.groups.get(l.primary)?.is_revenue;
}

/** Stock value: from Stock-in-Hand ledgers if the company keeps it there, otherwise from inventory valuation. */
function stockUsesLedgers(c: Ctx) {
  return [...c.ledgers.values()].some((l) => l.primary === 'Stock-in-Hand' || chain(c, l.parent).includes('Stock-in-Hand'));
}
function stockAt(c: Ctx, date: string, bal?: Map<string, number>): number {
  if (stockUsesLedgers(c)) {
    if (date === addDays(fyStart(c.fy), -1)) return [...c.ledgers.entries()].filter(([, l]) => chain(c, l.parent).includes('Stock-in-Hand')).reduce((a, [, l]) => a + l.opening, 0);
    const b = bal ?? balancesAt(c, date);
    return [...c.ledgers.keys()].filter((n) => chain(c, c.ledgers.get(n)!.parent).includes('Stock-in-Hand')).reduce((a, n) => a + (b.get(n) ?? 0), 0);
  }
  if (date === addDays(fyStart(c.fy), -1)) {
    return one<{ v: number }>('SELECT opening AS v FROM tally_stock WHERE company_id = ? AND fy = ? ORDER BY month_end LIMIT 1', [c.companyId, c.fy])?.v ?? 0;
  }
  return one<{ v: number }>('SELECT closing AS v FROM tally_stock WHERE company_id = ? AND fy = ? AND month_end = ?', [c.companyId, c.fy, date])?.v ?? 0;
}

function base(c: Ctx, type: ReportType, title: string, period: string, columns: ReportDoc['columns']): ReportDoc {
  return { type, title, company: c.company, period, columns, rows: [], dataAsOf: c.dataAsOf, provisional: c.provisional };
}

/* ------------------------------------------------------------------ Profit & Loss */

function pnlFigures(c: Ctx, from: string, to: string) {
  const end = balancesAt(c, to);
  const startDate = addDays(from, -1);
  const fromFyStart = from === fyStart(c.fy);
  const start = fromFyStart ? new Map<string, number>() : balancesAt(c, startDate);
  const moved = new Map<string, number>();
  for (const [name] of c.ledgers) if (isPnL(c, name)) {
    const v = r2((end.get(name) ?? 0) - (start.get(name) ?? 0));
    if (nz(v)) moved.set(name, v);
  }
  const openingStock = stockAt(c, startDate, fromFyStart ? undefined : start);
  const closingStock = stockAt(c, to, end);
  // Sections by primary group. Expenses (debit nature) shown positive; incomes shown positive as credits.
  const section = (gp: boolean, debit: boolean) => {
    const byHeading = new Map<string, { total: number; items: Map<string, number> }>();
    for (const [name, v] of moved) {
      const g = c.groups.get(c.ledgers.get(name)!.primary)!;
      if (!!g.affects_gp !== gp || !!g.is_debit !== debit) continue;
      const head = c.ledgers.get(name)!.primary;
      const h = byHeading.get(head) ?? { total: 0, items: new Map() };
      const shown = debit ? v : -v;
      h.total += shown;
      const sub = headingOf(c, name);
      h.items.set(sub, (h.items.get(sub) ?? 0) + shown);
      byHeading.set(head, h);
    }
    return byHeading;
  };
  const tradingIncome = section(true, false);
  const tradingExpense = section(true, true);
  const indirectIncome = section(false, false);
  const indirectExpense = section(false, true);
  const sum = (m: Map<string, { total: number }>) => r2([...m.values()].reduce((a, h) => a + h.total, 0));
  const revenue = sum(tradingIncome);
  const cogs = r2(openingStock + sum(tradingExpense) - closingStock);
  const gross = r2(revenue - cogs);
  const net = r2(gross + sum(indirectIncome) - sum(indirectExpense));
  return { tradingIncome, tradingExpense, indirectIncome, indirectExpense, openingStock, closingStock, revenue, cogs, gross, net };
}

export function profitLoss(c: Ctx, from: string, to: string): ReportDoc {
  if (from < fyStart(c.fy) || from > to) throw new HttpError(400, 'Invalid period.');
  if (from !== fyStart(c.fy) && !c.monthEnds.includes(addDays(from, -1))) throw new HttpError(400, 'The period must start on the first day of a month.');
  const f = pnlFigures(c, from, to);
  const d = base(c, 'profit-loss', 'Profit & Loss Account', `${fmtDateLong(from)} to ${fmtDateLong(to)}`,
    [{ label: 'Particulars', align: 'left', width: 0.62 }, { label: 'Amount (INR)', align: 'right', width: 0.19 }, { label: 'Total (INR)', align: 'right', width: 0.19 }]);
  const block = (title: string, m: Map<string, { total: number; items: Map<string, number> }>) => {
    for (const [head, h] of m) {
      d.rows.push({ cells: [head, null, r2(h.total)], indent: 1 });
      for (const [item, v] of h.items) if (item !== head && nz(v)) d.rows.push({ cells: [item, r2(v), null], indent: 2, style: 'muted' });
    }
    if (!m.size) d.rows.push({ cells: [`No ${title.toLowerCase()} in this period`, null, null], indent: 1, style: 'muted' });
  };
  d.rows.push({ cells: ['Revenue from operations', null, null], style: 'heading' });
  block('Revenue', f.tradingIncome);
  d.rows.push({ cells: ['Cost of goods sold', null, null], style: 'heading' });
  if (nz(f.openingStock)) d.rows.push({ cells: ['Opening stock', null, r2(f.openingStock)], indent: 1 });
  block('Direct costs', f.tradingExpense);
  if (nz(f.closingStock)) d.rows.push({ cells: ['Less: Closing stock', null, r2(-f.closingStock)], indent: 1 });
  d.rows.push({ cells: ['Gross profit', null, f.gross], style: 'subtotal' });
  d.rows.push({ cells: ['Other income', null, null], style: 'heading' });
  block('Other income', f.indirectIncome);
  d.rows.push({ cells: ['Indirect expenses', null, null], style: 'heading' });
  block('Indirect expenses', f.indirectExpense);
  d.rows.push({ cells: [f.net >= 0 ? 'Net profit' : 'Net loss', null, f.net], style: 'total' });
  d.summary = [
    { label: 'Revenue', value: f.revenue },
    { label: 'Gross profit', value: f.gross, tone: f.gross >= 0 ? 'good' : 'bad' },
    { label: f.net >= 0 ? 'Net profit' : 'Net loss', value: f.net, tone: f.net >= 0 ? 'good' : 'bad' },
  ];
  if (f.revenue) d.notes = [`Gross margin ${((f.gross / f.revenue) * 100).toFixed(1)}%, net margin ${((f.net / f.revenue) * 100).toFixed(1)}%.`];
  return d;
}

/* ------------------------------------------------------------------ Balance Sheet */

export function balanceSheet(c: Ctx, asOn: string): ReportDoc {
  const bal = balancesAt(c, asOn);
  const profit = pnlFigures(c, fyStart(c.fy), asOn).net;
  const sides = { liabilities: new Map<string, { total: number; items: Map<string, number> }>(), assets: new Map<string, { total: number; items: Map<string, number> }>() };
  let pnlLedger = 0;
  for (const [name, v] of bal) {
    const l = c.ledgers.get(name);
    if (!l || isPnL(c, name)) continue;
    const g = c.groups.get(l.primary);
    if (!g) { pnlLedger += v; continue; } // e.g. the "Profit & Loss A/c" ledger, which sits under Primary
    if (l.primary === 'Stock-in-Hand' && !stockUsesLedgers(c)) continue;
    const side = g.is_debit ? sides.assets : sides.liabilities;
    const shown = g.is_debit ? v : -v;
    const h = side.get(l.primary) ?? { total: 0, items: new Map() };
    h.total += shown;
    const sub = headingOf(c, name);
    h.items.set(sub, (h.items.get(sub) ?? 0) + shown);
    side.set(l.primary, h);
  }
  if (!stockUsesLedgers(c)) {
    const stock = stockAt(c, asOn, bal);
    if (nz(stock)) {
      const h = sides.assets.get('Current Assets') ?? { total: 0, items: new Map() };
      h.total += stock; h.items.set('Closing stock', stock);
      sides.assets.set('Current Assets', h);
    }
  }
  // Profit & Loss A/c = brought-forward balance + profit for the year to date.
  const pl = { total: r2(-pnlLedger + profit), items: new Map([['Opening balance', r2(-pnlLedger)], ['Current period', profit]]) };
  sides.liabilities.set('Profit & Loss A/c', pl);

  const total = (m: Map<string, { total: number }>) => r2([...m.values()].reduce((a, h) => a + h.total, 0));
  const tl = total(sides.liabilities), ta = total(sides.assets);
  const diff = r2(ta - tl);
  if (nz(diff)) sides.liabilities.set('Difference in opening balances', { total: diff, items: new Map() });

  const d = base(c, 'balance-sheet', 'Balance Sheet', `As on ${fmtDateLong(asOn)}`,
    [{ label: 'Particulars', align: 'left', width: 0.62 }, { label: 'Amount (INR)', align: 'right', width: 0.19 }, { label: 'Total (INR)', align: 'right', width: 0.19 }]);
  const ORDER = ['Capital Account', 'Reserves & Surplus', 'Profit & Loss A/c', 'Loans (Liability)', 'Current Liabilities', 'Branch / Divisions', 'Suspense A/c',
    'Fixed Assets', 'Investments', 'Current Assets', 'Misc. Expenses (ASSET)'];
  const sorted = (m: Map<string, { total: number; items: Map<string, number> }>) =>
    [...m.entries()].sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  for (const [title, m] of [['Liabilities', sides.liabilities], ['Assets', sides.assets]] as const) {
    d.rows.push({ cells: [title, null, null], style: 'heading' });
    for (const [head, h] of sorted(m)) {
      if (!nz(h.total) && head !== 'Profit & Loss A/c') continue;
      d.rows.push({ cells: [head, null, r2(h.total)], indent: 1 });
      for (const [item, v] of h.items) if (item !== head && nz(v)) d.rows.push({ cells: [item, r2(v), null], indent: 2, style: 'muted' });
    }
    d.rows.push({ cells: [`Total ${title.toLowerCase()}`, null, total(m)], style: 'total' });
  }
  d.summary = [
    { label: 'Total assets', value: ta },
    { label: 'Profit for the year to date', value: profit, tone: profit >= 0 ? 'good' : 'bad' },
  ];
  if (nz(diff)) d.notes = [`The books do not tally by INR ${Math.abs(diff).toLocaleString('en-IN', { minimumFractionDigits: 2 })}. This is shown as "Difference in opening balances", as Tally does.`];
  return d;
}

/* ------------------------------------------------------------------ Trial Balance */

export function trialBalance(c: Ctx, asOn: string): ReportDoc {
  const bal = balancesAt(c, asOn);
  const d = base(c, 'trial-balance', 'Trial Balance', `As on ${fmtDateLong(asOn)}`,
    [{ label: 'Particulars', align: 'left', width: 0.6 }, { label: 'Debit (INR)', align: 'right', width: 0.2 }, { label: 'Credit (INR)', align: 'right', width: 0.2 }]);
  const byPrimary = new Map<string, [string, number][]>();
  for (const [name, v] of bal) {
    if (!nz(v)) continue;
    const p = c.ledgers.get(name)?.primary || 'Primary';
    byPrimary.set(p, [...(byPrimary.get(p) ?? []), [name, v]]);
  }
  let dr = 0, cr = 0;
  for (const [p, items] of [...byPrimary.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const t = items.reduce((a, [, v]) => a + v, 0);
    d.rows.push({ cells: [p, t > 0 ? r2(t) : null, t < 0 ? r2(-t) : null], style: 'heading' });
    for (const [name, v] of items.sort(([a], [b]) => a.localeCompare(b))) {
      d.rows.push({ cells: [name, v > 0 ? r2(v) : null, v < 0 ? r2(-v) : null], indent: 1, style: 'muted' });
      if (v > 0) dr += v; else cr -= v;
    }
  }
  // Tally shows opening stock valued from inventory as its own debit line; without it the trial balance does not tally.
  const os = stockUsesLedgers(c) ? 0 : stockAt(c, addDays(fyStart(c.fy), -1));
  if (nz(os)) {
    d.rows.unshift({ cells: ['Opening Stock', r2(os), null], style: 'heading' });
    dr += os;
  }
  d.rows.push({ cells: ['Grand total', r2(dr), r2(cr)], style: 'total' });
  d.summary = [{ label: 'Total debit', value: r2(dr) }, { label: 'Total credit', value: r2(cr) }];
  d.notes = nz(dr - cr) ? [`Debits and credits differ by INR ${Math.abs(r2(dr - cr)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.`] : [];
  return d;
}

/* ------------------------------------------------------------------ Ledger statement */

export function ledgerStatement(c: Ctx, ledger: string, from: string, to: string): ReportDoc {
  const l = c.ledgers.get(ledger);
  if (!l) throw new HttpError(404, 'Ledger not found.');
  if (from < fyStart(c.fy) || to < from) throw new HttpError(400, 'Invalid period.');
  const before = one<{ s: number }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS s FROM tally_entries e JOIN tally_vouchers v ON v.company_id = e.company_id AND v.fy = e.fy AND v.guid = e.voucher_guid
     WHERE e.company_id = ? AND e.fy = ? AND e.ledger = ? AND v.date < ?`, [c.companyId, c.fy, ledger, from])!.s;
  let bal = r2(l.opening + before);
  const rows = all<{ guid: string; date: string; vtype: string; number: string | null; narration: string | null; amount: number; others: string | null }>(
    `SELECT v.guid, v.date, v.vtype, v.number, v.narration, SUM(e.amount) AS amount,
            (SELECT GROUP_CONCAT(o.ledger, ', ') FROM tally_entries o WHERE o.company_id = v.company_id AND o.fy = v.fy AND o.voucher_guid = v.guid AND o.ledger <> ?) AS others
     FROM tally_vouchers v JOIN tally_entries e ON e.company_id = v.company_id AND e.fy = v.fy AND e.voucher_guid = v.guid
     WHERE v.company_id = ? AND v.fy = ? AND e.ledger = ? AND v.date BETWEEN ? AND ?
     GROUP BY v.guid ORDER BY v.date, v.number LIMIT 5000`, [ledger, c.companyId, c.fy, ledger, from, to]);
  const d = base(c, 'ledger', `Ledger: ${ledger}`, `${fmtDateLong(from)} to ${fmtDateLong(to)}`, [
    { label: 'Date', align: 'left', width: 0.11 }, { label: 'Particulars', align: 'left', width: 0.33 }, { label: 'Voucher', align: 'left', width: 0.14 },
    { label: 'Debit', align: 'right', width: 0.13 }, { label: 'Credit', align: 'right', width: 0.13 }, { label: 'Balance', align: 'right', width: 0.16 },
  ]);
  const drcr = (n: number) => `${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${n >= 0 ? 'Dr' : 'Cr'}`;
  d.rows.push({ cells: [null, 'Opening balance', null, null, null, drcr(bal)], style: 'subtotal' });
  let dr = 0, cr = 0;
  for (const r of rows) {
    bal = r2(bal + r.amount);
    if (r.amount > 0) dr += r.amount; else cr -= r.amount;
    const date = new Date(`${r.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
    d.rows.push({ cells: [date, (r.others ?? '') + (r.narration ? ` — ${r.narration}` : ''), `${r.vtype}${r.number ? ` ${r.number}` : ''}`,
      r.amount > 0 ? r2(r.amount) : null, r.amount < 0 ? r2(-r.amount) : null, drcr(bal)] });
  }
  d.rows.push({ cells: [null, 'Totals for the period', null, r2(dr), r2(cr), null], style: 'subtotal' });
  d.rows.push({ cells: [null, 'Closing balance', null, null, null, drcr(bal)], style: 'total' });
  d.summary = [{ label: 'Closing balance', value: bal }];
  const group = chain(c, l.parent);
  d.notes = [`Group: ${group.reverse().join(' › ') || l.parent}${l.gstin ? ` · GSTIN ${l.gstin}` : ''}`];
  if (rows.length === 5000) d.notes.push('Showing the first 5,000 entries. Choose a shorter period to see the rest.');
  return d;
}

/* ------------------------------------------------------------------ Debtors / creditors */

export function outstanding(c: Ctx, kind: 'debtors' | 'creditors', asOn: string): ReportDoc {
  const bal = balancesAt(c, asOn);
  const group = kind === 'debtors' ? 'Sundry Debtors' : 'Sundry Creditors';
  const parties = [...c.ledgers.entries()]
    .filter(([, l]) => chain(c, l.parent).includes(group))
    .map(([name, l]) => ({ name, gstin: l.gstin, v: bal.get(name) ?? 0 }))
    .filter((p) => nz(p.v))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const lastTxn = new Map(all<{ ledger: string; d: string }>(
    `SELECT e.ledger, MAX(v.date) AS d FROM tally_entries e JOIN tally_vouchers v ON v.company_id = e.company_id AND v.fy = e.fy AND v.guid = e.voucher_guid
     WHERE e.company_id = ? AND e.fy = ? AND v.date <= ? GROUP BY e.ledger`, [c.companyId, c.fy, asOn]).map((r) => [r.ledger, r.d]));
  const d = base(c, kind, kind === 'debtors' ? 'Debtors (receivables)' : 'Creditors (payables)', `As on ${fmtDateLong(asOn)}`, [
    { label: 'Party', align: 'left', width: 0.42 }, { label: 'GSTIN', align: 'left', width: 0.2 }, { label: 'Last transaction', align: 'left', width: 0.16 },
    { label: kind === 'debtors' ? 'Receivable (INR)' : 'Payable (INR)', align: 'right', width: 0.22 },
  ]);
  const sign = kind === 'debtors' ? 1 : -1;
  let total = 0;
  for (const p of parties) {
    const shown = r2(p.v * sign);
    total += shown;
    const last = lastTxn.get(p.name);
    d.rows.push({ cells: [p.name, p.gstin ?? '', last ? new Date(`${last}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Before FY', shown], style: shown < 0 ? 'muted' : undefined });
  }
  d.rows.push({ cells: [`Total (${parties.length} parties)`, null, null, r2(total)], style: 'total' });
  d.summary = [{ label: kind === 'debtors' ? 'Total receivable' : 'Total payable', value: r2(total) }];
  const advances = parties.filter((p) => p.v * sign < 0).length;
  if (advances) d.notes = [`${advances} part${advances > 1 ? 'ies have' : 'y has'} an opposite balance (${kind === 'debtors' ? 'advance received' : 'advance paid'}), shown as negative.`];
  return d;
}
