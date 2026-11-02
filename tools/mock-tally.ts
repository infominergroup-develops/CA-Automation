/**
 * Tally simulator for development and demos. Speaks the same XML-over-HTTP protocol as TallyPrime on port 9000
 * for the requests the sync agent makes. Debits are exported as negative numbers, as Tally does.
 *
 *   npx tsx tools/mock-tally.ts            (port 9000)
 *   MOCK_TALLY_PORT=9100 MOCK_UTF16=1 npx tsx tools/mock-tally.ts
 */
import http from 'node:http';
import { COMPANY, GROUPS, LEDGERS, buildVouchers, ledgerClosing, stockValue } from './mock-tally-data.ts';

const port = Number(process.env.MOCK_TALLY_PORT ?? 9000);
const utf16 = process.env.MOCK_UTF16 === '1';
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const vouchers = buildVouchers(today);

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tAmt = (drPositive: number) => (-drPositive).toFixed(2); // Tally: Dr negative
const tDate = (iso: string) => iso.replaceAll('-', '');
const fromT = (t: string) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
const addDays = (d: string, n: number) => { const z = new Date(`${d}T00:00:00Z`); z.setUTCDate(z.getUTCDate() + n); return z.toISOString().slice(0, 10); };
const tag = (req: string, name: string) => req.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

function respond(req: string): string {
  const type = tag(req, 'TYPE') === 'Collection' ? req.match(/<COLLECTION[^>]*>\s*<TYPE>([^<]+)<\/TYPE>/)?.[1] : undefined;
  const company = tag(req, 'SVCURRENTCOMPANY')?.replace(/&amp;/g, '&');
  const from = tag(req, 'SVFROMDATE') ? fromT(tag(req, 'SVFROMDATE')!) : COMPANY.booksFrom;
  const to = tag(req, 'SVTODATE') ? fromT(tag(req, 'SVTODATE')!) : today;
  let body = '';
  if (type === 'Company') {
    body = `<COMPANY NAME="${x(COMPANY.name)}"><GUID>${COMPANY.guid}</GUID><BOOKSFROM>${tDate(COMPANY.booksFrom)}</BOOKSFROM><STARTINGFROM>${tDate(COMPANY.booksFrom)}</STARTINGFROM></COMPANY>`;
  } else if (company !== COMPANY.name) {
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not set 'SVCurrentCompany' to '${x(company ?? '')}'</LINEERROR></DATA></BODY></ENVELOPE>`;
  } else if (type === 'Group') {
    body = GROUPS.map(([n, p, r, gp, d]) => `<GROUP NAME="${x(n)}"><PARENT TYPE="String">${p === 'Primary' ? '&#4; Primary' : x(p)}</PARENT>`
      + `<ISREVENUE TYPE="Logical">${r ? 'Yes' : 'No'}</ISREVENUE><AFFECTSGROSSPROFIT TYPE="Logical">${gp ? 'Yes' : 'No'}</AFFECTSGROSSPROFIT><ISDEEMEDPOSITIVE TYPE="Logical">${d ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE></GROUP>`).join('');
  } else if (type === 'Ledger') {
    body = LEDGERS.map((l) => `<LEDGER NAME="${x(l[0])}"><PARENT TYPE="String">${l[1] === 'Primary' ? '&#4; Primary' : x(l[1])}</PARENT>`
      + `<OPENINGBALANCE TYPE="Amount">${tAmt(l[2])}</OPENINGBALANCE><CLOSINGBALANCE TYPE="Amount">${tAmt(ledgerClosing(vouchers, l, to))}</CLOSINGBALANCE>`
      + (l[3] ? `<PARTYGSTIN>${l[3]}</PARTYGSTIN>` : '') + `</LEDGER>`).join('');
  } else if (type === 'StockItem') {
    const open = stockValue(addDays(from, -1)), close = stockValue(to);
    // Two items sharing the value; Tally exports stock (an asset) as a debit, i.e. negative.
    body = [['Steel Fasteners', 0.6], ['Brass Fittings', 0.4]].map(([n, share]) =>
      `<STOCKITEM NAME="${n}"><OPENINGVALUE>${(-open * (share as number)).toFixed(2)}</OPENINGVALUE><CLOSINGVALUE>${(-close * (share as number)).toFixed(2)}</CLOSINGVALUE></STOCKITEM>`).join('');
  } else if (type === 'Voucher') {
    body = vouchers.filter((v) => v.date >= from && v.date <= to).map((v) => `<VOUCHER REMOTEID="${v.guid}" VCHTYPE="${v.type}" ACTION="Create">`
      + `<DATE TYPE="Date">${tDate(v.date)}</DATE><GUID>${v.guid}</GUID><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER>`
      + (v.party ? `<PARTYLEDGERNAME>${x(v.party)}</PARTYLEDGERNAME>` : '') + `<NARRATION>${x(v.narration)}</NARRATION>`
      + `<ISCANCELLED>${v.cancelled ? 'Yes' : 'No'}</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>`
      + v.entries.map((e) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.amount > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${tAmt(e.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('')
      + (v.items ?? []).map((i) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${x(i.item)}</STOCKITEMNAME><AMOUNT>${tAmt(i.amount)}</AMOUNT>`
        + `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${x(i.ledger)}</LEDGERNAME><AMOUNT>${tAmt(i.amount)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`).join('')
      + `</VOUCHER>`).join('');
  }
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${body}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const xml = respond(data);
    const buf = utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]) : Buffer.from(xml, 'utf8');
    res.writeHead(200, { 'Content-Type': `text/xml; charset=${utf16 ? 'utf-16' : 'utf-8'}` });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log(`Mock Tally on http://localhost:${port} · ${COMPANY.name} · ${vouchers.length} vouchers to ${today}`));
