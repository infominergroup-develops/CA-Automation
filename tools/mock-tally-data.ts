/**
 * Deterministic sample books for the Tally simulator. Amounts here are Dr positive / Cr negative.
 * Company "Demo Traders", books from 1 Apr 2025, two financial years of trading up to today.
 */

export const COMPANY = { name: 'Demo Traders', guid: '6f1c0e1a-demo-4ad1-9b77-tally000001', booksFrom: '2025-04-01' };

type G = [name: string, parent: string, revenue: boolean, gp: boolean, debit: boolean];
const P = 'Primary';
export const GROUPS: G[] = [
  ['Capital Account', P, false, false, false], ['Reserves & Surplus', 'Capital Account', false, false, false],
  ['Loans (Liability)', P, false, false, false], ['Secured Loans', 'Loans (Liability)', false, false, false], ['Bank OD A/c', 'Loans (Liability)', false, false, false],
  ['Current Liabilities', P, false, false, false], ['Duties & Taxes', 'Current Liabilities', false, false, false], ['Provisions', 'Current Liabilities', false, false, false], ['Sundry Creditors', 'Current Liabilities', false, false, false],
  ['Fixed Assets', P, false, false, true], ['Investments', P, false, false, true],
  ['Current Assets', P, false, false, true], ['Bank Accounts', 'Current Assets', false, false, true], ['Cash-in-Hand', 'Current Assets', false, false, true],
  ['Stock-in-Hand', 'Current Assets', false, false, true], ['Sundry Debtors', 'Current Assets', false, false, true], ['Loans & Advances (Asset)', 'Current Assets', false, false, true],
  ['Branch / Divisions', P, false, false, false], ['Misc. Expenses (ASSET)', P, false, false, true], ['Suspense A/c', P, false, false, false],
  ['Sales Accounts', P, true, true, false], ['Purchase Accounts', P, true, true, true], ['Direct Incomes', P, true, true, false], ['Direct Expenses', P, true, true, true],
  ['Indirect Incomes', P, true, false, false], ['Indirect Expenses', P, true, false, true],
];

type L = [name: string, parent: string, opening: number, gstin?: string];
export const LEDGERS: L[] = [
  ['Capital A/c', 'Capital Account', -500000], ['Profit & Loss A/c', P, 0],
  ['Cash', 'Cash-in-Hand', 50000], ['HDFC Bank', 'Bank Accounts', 400000],
  ['Sharma Retail', 'Sundry Debtors', 0, '09ABCPS1234K1Z5'], ['Gupta Stores', 'Sundry Debtors', 0, '09AAGFG5678L1Z2'], ['Kumar Enterprises', 'Sundry Debtors', 0, '07AAKFK9012M1Z8'],
  ['Patel Wholesale', 'Sundry Creditors', 0, '24AAPFP3456N1Z1'], ['Singh Suppliers', 'Sundry Creditors', 0, '09AASFS7890P1Z4'],
  ['Sales @18%', 'Sales Accounts', 0], ['Purchase @18%', 'Purchase Accounts', 0], ['Freight Inward', 'Direct Expenses', 0],
  ['CGST Output', 'Duties & Taxes', 0], ['SGST Output', 'Duties & Taxes', 0], ['IGST Output', 'Duties & Taxes', 0],
  ['CGST Input', 'Duties & Taxes', 0], ['SGST Input', 'Duties & Taxes', 0], ['IGST Input', 'Duties & Taxes', 0],
  ['Rent', 'Indirect Expenses', 0], ['Salaries', 'Indirect Expenses', 0], ['Electricity', 'Indirect Expenses', 0],
  ['Interest Received', 'Indirect Incomes', 0], ['Furniture', 'Fixed Assets', 0],
];
export const INVENTORY_OPENING = 50000;

export interface Voucher {
  guid: string; date: string; type: string; number: string; party?: string; narration: string; cancelled?: boolean;
  entries: { ledger: string; amount: number }[];       // plain ledger lines
  items?: { item: string; ledger: string; amount: number }[]; // item-invoice lines (sales/purchase ledger inside inventory)
}

// Small deterministic PRNG so every run produces the same books.
let seed = 20250401;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const amt = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) / 10) * 10;

function iso(y: number, m: number, d: number) { return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); }

export function buildVouchers(upto: string): Voucher[] {
  const out: Voucher[] = [];
  let n = 0;
  const v = (date: string, type: string, narration: string, entries: Voucher['entries'], party?: string, items?: Voucher['items'], cancelled = false) => {
    if (date > upto) return;
    n++;
    out.push({ guid: `demo-vch-${String(n).padStart(5, '0')}`, date, type, number: String(n), narration, entries, party, items, cancelled });
  };
  let y = 2025, m = 4;
  while (iso(y, m, 1) <= upto) {
    const debtors = ['Sharma Retail', 'Gupta Stores', 'Kumar Enterprises'];
    for (let i = 0; i < 3; i++) {
      const party = debtors[i];
      const base = amt(40000, 120000);
      const inter = party === 'Kumar Enterprises';
      const tax = Math.round(base * 0.18);
      const entries = inter
        ? [{ ledger: party, amount: base + tax }, { ledger: 'IGST Output', amount: -tax }]
        : [{ ledger: party, amount: base + tax }, { ledger: 'CGST Output', amount: -tax / 2 }, { ledger: 'SGST Output', amount: -tax / 2 }];
      v(iso(y, m, 3 + i * 7), 'Sales', `Invoice to ${party}`, entries, party, [{ item: 'Steel Fasteners', ledger: 'Sales @18%', amount: -base }]);
    }
    for (const [i, party] of ['Patel Wholesale', 'Singh Suppliers'].entries()) {
      const base = amt(30000, 80000);
      const tax = Math.round(base * 0.18);
      const inter = party === 'Patel Wholesale';
      v(iso(y, m, 5 + i * 10), 'Purchase', `Bill from ${party}`, [
        { ledger: 'Purchase @18%', amount: base },
        ...(inter ? [{ ledger: 'IGST Input', amount: tax }] : [{ ledger: 'CGST Input', amount: tax / 2 }, { ledger: 'SGST Input', amount: tax / 2 }]),
        { ledger: party, amount: -(base + tax) },
      ], party);
    }
    v(iso(y, m, 6), 'Payment', 'Freight on purchases', [{ ledger: 'Freight Inward', amount: 2500 }, { ledger: 'Cash', amount: -2500 }]);
    for (const [i, party] of debtors.entries()) {
      const r = amt(50000, 110000);
      v(iso(y, m, 15 + i * 3), 'Receipt', `Received from ${party}`, [{ ledger: 'HDFC Bank', amount: r }, { ledger: party, amount: -r }], party);
    }
    for (const [i, party] of ['Patel Wholesale', 'Singh Suppliers'].entries()) {
      const p = amt(35000, 80000);
      v(iso(y, m, 20 + i), 'Payment', `Paid to ${party}`, [{ ledger: party, amount: p }, { ledger: 'HDFC Bank', amount: -p }], party);
    }
    v(iso(y, m, 1), 'Payment', 'Office rent', [{ ledger: 'Rent', amount: 25000 }, { ledger: 'HDFC Bank', amount: -25000 }]);
    v(iso(y, m, 28), 'Payment', 'Salaries for the month', [{ ledger: 'Salaries', amount: 60000 }, { ledger: 'HDFC Bank', amount: -60000 }]);
    const power = amt(3000, 6000);
    v(iso(y, m, 12), 'Payment', 'Electricity bill', [{ ledger: 'Electricity', amount: power }, { ledger: 'Cash', amount: -power }]);
    v(iso(y, m, 10), 'Contra', 'Cash withdrawn for expenses', [{ ledger: 'Cash', amount: 15000 }, { ledger: 'HDFC Bank', amount: -15000 }]);
    if (m % 2 === 0) {
      const gst = amt(20000, 40000);
      v(iso(y, m, 20), 'Payment', 'GST paid (net of input credit)', [{ ledger: 'CGST Output', amount: gst / 2 }, { ledger: 'SGST Output', amount: gst / 2 }, { ledger: 'HDFC Bank', amount: -gst }]);
    }
    if (m % 3 === 0) v(iso(y, m, 25), 'Receipt', 'FD interest', [{ ledger: 'HDFC Bank', amount: 4200 }, { ledger: 'Interest Received', amount: -4200 }]);
    if (y === 2025 && m === 6) v(iso(y, m, 18), 'Payment', 'Office furniture', [{ ledger: 'Furniture', amount: 85000 }, { ledger: 'HDFC Bank', amount: -85000 }]);
    if (y === 2025 && m === 7) v(iso(y, m, 9), 'Sales', 'Cancelled invoice', [{ ledger: 'Gupta Stores', amount: 999999 }], 'Gupta Stores', [{ item: 'Steel Fasteners', ledger: 'Sales @18%', amount: -999999 }], true);
    if (++m === 13) { m = 1; y++; }
  }
  return out;
}

/** Inventory value at a date (end of day). */
export function stockValue(date: string): number {
  if (date < COMPANY.booksFrom) return INVENTORY_OPENING;
  const months = (Number(date.slice(0, 4)) - 2025) * 12 + Number(date.slice(5, 7)) - 4;
  return INVENTORY_OPENING + 6000 * ((months % 5) + 1) + months * 1500;
}

export const isRevenueLedger = (parent: string) => {
  const g = new Map(GROUPS.map((x) => [x[0], x]));
  let cur = parent;
  for (let i = 0; i < 10; i++) { const x = g.get(cur); if (!x) return false; if (x[1] === P) return x[2]; cur = x[1]; }
  return false;
};

export const fyStartOf = (d: string) => (Number(d.slice(5, 7)) >= 4 ? `${d.slice(0, 4)}-04-01` : `${Number(d.slice(0, 4)) - 1}-04-01`);

/** Ledger balance at end of `date`, with Tally's semantics. */
export function ledgerClosing(vouchers: Voucher[], ledger: L, date: string): number {
  const revenue = isRevenueLedger(ledger[1]);
  const from = revenue ? fyStartOf(date) : COMPANY.booksFrom;
  let bal = revenue ? 0 : ledger[2];
  for (const vc of vouchers) {
    if (vc.cancelled || vc.date < from || vc.date > date) continue;
    for (const e of [...vc.entries, ...(vc.items ?? [])]) if (e.ledger === ledger[0]) bal += e.amount;
  }
  return Math.round(bal * 100) / 100;
}
