import { XMLParser } from 'fast-xml-parser';

/**
 * Minimal client for Tally's built-in XML server (TallyPrime / Tally.ERP 9: F1 Help > Settings > Connectivity,
 * "TallyPrime acts as: Server", port 9000). Read-only: only Export requests are ever sent.
 */

const LISTS = new Set([
  'COMPANY', 'GROUP', 'LEDGER', 'STOCKITEM', 'VOUCHER',
  'ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST', 'ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST', 'ACCOUNTINGALLOCATIONS.LIST',
]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => LISTS.has(name),
});

export type Node = Record<string, unknown>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const tallyDate = (iso: string) => iso.replaceAll('-', '');
export const isoDate = (t: string) => (/^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : '');

/** Text of a Tally field, which may be a plain string or an element with attributes. */
export function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text((v as Node)['#text']);
  return String(v).trim();
}
export const bool = (v: unknown) => text(v).toLowerCase() === 'yes';

/** Tally amounts: "-1234.50", "1,234.50", or foreign currency like "$100 @ ₹80/$ = 8000". */
export function amount(v: unknown): number {
  let s = text(v);
  if (s.includes('=')) s = s.slice(s.lastIndexOf('=') + 1);
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function nameOf(n: Node): string {
  return text(n['@_NAME']) || text(n.NAME) || text((n['NAME.LIST'] as Node | undefined)?.NAME);
}

/** Finds every element with the given tag anywhere in the parsed tree. */
export function findAll(obj: unknown, tag: string, out: Node[] = []): Node[] {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { for (const o of obj) findAll(o, tag, out); return out; }
  for (const [k, v] of Object.entries(obj as Node)) {
    if (k === tag) (Array.isArray(v) ? v : [v]).forEach((x) => typeof x === 'object' && x && out.push(x as Node));
    else if (typeof v === 'object') findAll(v, tag, out);
  }
  return out;
}

export class TallyClient {
  constructor(private url: string, private timeoutMs = 120_000) {}

  async post(xml: string): Promise<unknown> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, { method: 'POST', body: xml, headers: { 'Content-Type': 'text/xml; charset=utf-8' }, signal: ctl.signal });
      const buf = Buffer.from(await res.arrayBuffer());
      // Tally may answer in UTF-16LE (with a byte-order mark) or UTF-8.
      let body = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
      // Strip characters XML does not allow (Tally uses &#4; before "Primary", for example).
      body = body.replace(/&#(\d+);/g, (m, d) => { const c = Number(d); return c < 32 && c !== 9 && c !== 10 && c !== 13 ? '' : m; })
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
      if (/<LINEERROR>/i.test(body)) throw new Error(`Tally error: ${body.match(/<LINEERROR>([^<]*)/i)?.[1] ?? 'unknown'}`);
      return parser.parse(body);
    } finally {
      clearTimeout(t);
    }
  }

  /** Exports a TDL collection. `vars` become static variables (SVFROMDATE, SVTODATE, ...). */
  async collection(opts: { company?: string; type: string; fetch: string[]; vars?: Record<string, string>; tag: string; filter?: string }): Promise<Node[]> {
    const id = `IM${opts.type}`;
    const vars = Object.entries(opts.vars ?? {}).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>`
      + `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>`
      + (opts.company ? `<SVCURRENTCOMPANY>${esc(opts.company)}</SVCURRENTCOMPANY>` : '') + vars + `</STATICVARIABLES>`
      + `<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${opts.type}</TYPE><FETCH>${opts.fetch.join(', ')}</FETCH>`
      + (opts.filter ? `<FILTER>IMFilter</FILTER>` : '') + `</COLLECTION>`
      + (opts.filter ? `<SYSTEM TYPE="Formulae" NAME="IMFilter">${esc(opts.filter)}</SYSTEM>` : '')
      + `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    return findAll(await this.post(xml), opts.tag);
  }

  async companies() {
    const rows = await this.collection({ type: 'Company', tag: 'COMPANY', fetch: ['Name', 'GUID', 'BooksFrom', 'StartingFrom'] });
    return rows.map((c) => ({ name: nameOf(c), guid: text(c.GUID) || nameOf(c), booksFrom: isoDate(text(c.BOOKSFROM) || text(c.STARTINGFROM)) || undefined }))
      .filter((c) => c.name);
  }

  async ping(): Promise<boolean> {
    try { await this.companies(); return true; } catch { return false; }
  }
}
