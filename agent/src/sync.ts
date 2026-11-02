import { TallyClient, amount, bool, findAll, isoDate, nameOf, tallyDate, text, type Node } from './tally.ts';

/**
 * Builds one snapshot (company × financial year) from Tally.
 * Sign convention: Tally exports debits as negative numbers; the snapshot uses Dr positive, so every amount is negated.
 */

export interface Snapshot {
  agentVersion: string;
  tally: { name: string; guid: string };
  fy: string;
  periodTo: string;
  groups: { name: string; parent: string; isRevenue: boolean; affectsGrossProfit: boolean; isDeemedPositive: boolean }[];
  ledgers: { name: string; parent: string; opening: number; gstin?: string }[];
  balances: { monthEnd: string; closing: Record<string, number> }[];
  stock: { monthEnd: string; opening: number; closing: number }[];
  vouchers: { guid: string; date: string; type: string; number?: string; party?: string; narration?: string; entries: { ledger: string; amount: number }[] }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const dr = (v: unknown) => r2(-amount(v)); // Tally Dr-negative → Dr-positive
const ROOTS = new Set(['', 'Primary']);
const PL_LEDGER = 'Profit & Loss A/c';

const fyStart = (fy: string) => `${fy.slice(0, 4)}-04-01`;
const fyEnd = (fy: string) => `${Number(fy.slice(0, 4)) + 1}-03-31`;
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function monthEnds(fy: string, upto: string): string[] {
  const out: string[] = [];
  let y = Number(fy.slice(0, 4)), m = 4;
  for (let i = 0; i < 12; i++) {
    const me = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (me >= upto) { out.push(upto); break; }
    out.push(me);
    if (++m === 13) { m = 1; y++; }
  }
  return out;
}

function monthStarts(fy: string, upto: string): [string, string][] {
  return monthEnds(fy, upto).map((end) => [`${end.slice(0, 8)}01`, end]);
}

export async function buildSnapshot(tally: TallyClient, company: { name: string; guid: string; booksFrom?: string }, fy: string, agentVersion: string,
  log: (m: string) => void): Promise<Snapshot> {
  const start = fyStart(fy);
  const periodTo = todayIst() < fyEnd(fy) ? todayIst() : fyEnd(fy);
  const booksFrom = company.booksFrom ?? start;
  if (booksFrom > fyEnd(fy)) throw new Error(`Books of ${company.name} begin on ${booksFrom}, after FY ${fy}.`);
  const c = company.name;

  // Groups and their nature (inherited from the primary group).
  const groups = (await tally.collection({ company: c, type: 'Group', tag: 'GROUP', fetch: ['Name', 'Parent', 'IsRevenue', 'AffectsGrossProfit', 'IsDeemedPositive'] }))
    .map((g) => ({ name: nameOf(g), parent: text(g.PARENT).replace(/^\s+/, ''), isRevenue: bool(g.ISREVENUE), affectsGrossProfit: bool(g.AFFECTSGROSSPROFIT), isDeemedPositive: bool(g.ISDEEMEDPOSITIVE) }))
    .filter((g) => g.name);
  const byName = new Map(groups.map((g) => [g.name, g]));
  const primaryOf = (n: string) => { let cur = n; for (let i = 0; i < 50; i++) { const g = byName.get(cur); if (!g || ROOTS.has(g.parent)) return cur; cur = g.parent; } return cur; };
  const isRevenueGroup = (parent: string) => !!byName.get(primaryOf(parent))?.isRevenue;
  log(`  ${groups.length} groups`);

  // Ledger masters.
  const ledgerRows = await tally.collection({ company: c, type: 'Ledger', tag: 'LEDGER', fetch: ['Name', 'Parent', 'OpeningBalance', 'PartyGSTIN'] });
  const ledgers = ledgerRows.map((l) => ({ name: nameOf(l), parent: text(l.PARENT).replace(/^\s+/, '') || 'Primary', master: dr(l.OPENINGBALANCE), gstin: text(l.PARTYGSTIN) || undefined }))
    .filter((l) => l.name);
  log(`  ${ledgers.length} ledgers`);

  // Opening balance at the start of this FY. For later years it is the closing at the previous year end;
  // income and expense ledgers start every FY at zero (Tally carries the profit to the P&L A/c).
  const opening = new Map<string, number>();
  if (booksFrom < start) {
    const prevClose = await tally.collection({ company: c, type: 'Ledger', tag: 'LEDGER', fetch: ['Name', 'ClosingBalance'],
      vars: { SVFROMDATE: tallyDate(booksFrom), SVTODATE: tallyDate(addDays(start, -1)) } });
    for (const l of prevClose) opening.set(nameOf(l), dr(l.CLOSINGBALANCE));
    for (const l of ledgers) if (isRevenueGroup(l.parent)) opening.set(l.name, 0);
  } else {
    for (const l of ledgers) opening.set(l.name, l.master);
  }

  // Inventory valuation (only used when stock is not kept as Stock-in-Hand ledger balances).
  const ends = monthEnds(fy, periodTo);
  const stock: Snapshot['stock'] = [];
  const firstStock = await tally.collection({ company: c, type: 'StockItem', tag: 'STOCKITEM', fetch: ['Name', 'OpeningValue', 'ClosingValue'],
    vars: { SVFROMDATE: tallyDate(start), SVTODATE: tallyDate(ends[0]) } });
  if (firstStock.length) {
    const sum = (rows: Node[], f: string) => r2(rows.reduce((a, s) => a + Math.abs(amount(s[f])), 0));
    const open = sum(firstStock, 'OPENINGVALUE');
    stock.push({ monthEnd: ends[0], opening: open, closing: sum(firstStock, 'CLOSINGVALUE') });
    for (const me of ends.slice(1)) {
      const rows = await tally.collection({ company: c, type: 'StockItem', tag: 'STOCKITEM', fetch: ['Name', 'ClosingValue'], vars: { SVFROMDATE: tallyDate(start), SVTODATE: tallyDate(me) } });
      stock.push({ monthEnd: me, opening: open, closing: sum(rows, 'CLOSINGVALUE') });
    }
    log(`  ${firstStock.length} stock items`);
  }

  // Closing balances at every month end (FY-to-date for income and expense ledgers).
  const balances: Snapshot['balances'] = [];
  for (const me of ends) {
    const rows = await tally.collection({ company: c, type: 'Ledger', tag: 'LEDGER', fetch: ['Name', 'ClosingBalance'], vars: { SVFROMDATE: tallyDate(start), SVTODATE: tallyDate(me) } });
    const closing: Record<string, number> = {};
    for (const l of rows) { const v = dr(l.CLOSINGBALANCE); if (v) closing[nameOf(l)] = v; }
    balances.push({ monthEnd: me, closing });
  }

  // Tally does not post earlier years' profit into the P&L A/c ledger; it adds it when showing the Balance Sheet.
  // Recreate that: whatever keeps the opening trial balance from netting to zero is carried profit.
  if (booksFrom < start) {
    const stockInLedgers = ledgers.some((l) => primaryOf(l.parent) === 'Stock-in-Hand');
    const carried = -r2([...opening.values()].reduce((a, n) => a + n, 0) + (stockInLedgers ? 0 : stock[0]?.opening ?? 0));
    if (Math.abs(carried) >= 0.01) {
      if (!ledgers.some((l) => l.name === PL_LEDGER)) ledgers.push({ name: PL_LEDGER, parent: 'Primary', master: 0, gstin: undefined });
      opening.set(PL_LEDGER, r2((opening.get(PL_LEDGER) ?? 0) + carried));
      for (const b of balances) b.closing[PL_LEDGER] = r2((b.closing[PL_LEDGER] ?? 0) + carried);
    }
  }

  // Vouchers, month by month to keep each Tally response small.
  const vouchers: Snapshot['vouchers'] = [];
  for (const [from, to] of monthStarts(fy, periodTo)) {
    const rows = await tally.collection({
      company: c, type: 'Voucher', tag: 'VOUCHER', vars: { SVFROMDATE: tallyDate(from), SVTODATE: tallyDate(to) },
      fetch: ['Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Narration', 'GUID', 'IsCancelled', 'IsOptional', 'AllLedgerEntries', 'AllInventoryEntries'],
    });
    for (const v of rows) {
      if (bool(v.ISCANCELLED) || bool(v.ISOPTIONAL)) continue;
      const date = isoDate(text(v.DATE));
      if (!date || date < from || date > to) continue;
      const entries = new Map<string, number>();
      const add = (e: Node) => { const l = text(e.LEDGERNAME); if (l) entries.set(l, r2((entries.get(l) ?? 0) + dr(e.AMOUNT))); };
      findAll(v, 'ALLLEDGERENTRIES.LIST').forEach(add);
      findAll(v, 'LEDGERENTRIES.LIST').forEach(add);
      // Item invoices carry the sales/purchase ledger inside each inventory line.
      for (const inv of [...findAll(v, 'ALLINVENTORYENTRIES.LIST'), ...findAll(v, 'INVENTORYENTRIES.LIST')]) findAll(inv, 'ACCOUNTINGALLOCATIONS.LIST').forEach(add);
      vouchers.push({
        guid: text(v.GUID) || `${date}-${text(v.VOUCHERTYPENAME)}-${text(v.VOUCHERNUMBER)}`,
        date, type: text(v.VOUCHERTYPENAME), number: text(v.VOUCHERNUMBER) || undefined,
        party: text(v.PARTYLEDGERNAME) || undefined, narration: text(v.NARRATION).slice(0, 2000) || undefined,
        entries: [...entries].filter(([, a]) => a !== 0).map(([ledger, a]) => ({ ledger, amount: a })),
      });
    }
  }
  log(`  ${vouchers.length} vouchers, ${balances.length} month ends`);

  return {
    agentVersion, tally: { name: company.name, guid: company.guid }, fy, periodTo, groups,
    ledgers: ledgers.map((l) => ({ name: l.name, parent: l.parent, opening: opening.get(l.name) ?? 0, ...(l.gstin ? { gstin: l.gstin } : {}) })),
    balances, stock, vouchers,
  };
}
