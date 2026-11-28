import { GSTIN_RE } from './gst';

/** One party from a client list in Excel, ready to add as a client without a login. */
export interface ImportRow { line: number; name: string; gstins: string[]; pan: string; problem: string | null }

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Reads a sheet given as rows of cells (first sheet of the workbook). The header row is the first one with a name
 * column ("Name", "Name of Party", "Client"...); GSTIN and PAN columns are found by their headers, in any order.
 * A GSTIN cell may hold several, one per state, separated by commas, spaces or new lines.
 */
export function readClientSheet(rows: unknown[][]): ImportRow[] {
  const head = rows.findIndex((r) => r.some((c) => /name|party|client/i.test(clean(c))));
  if (head < 0) throw new Error('No column for the client name was found. Name the column "Name of Party" or "Client name".');
  const col = (re: RegExp) => rows[head].findIndex((c) => re.test(clean(c)));
  const nameAt = col(/name|party|client/i), gstAt = col(/gst/i), panAt = col(/^pan\b|pan no|pan number|\bpan$/i);
  return rows.slice(head + 1).flatMap((r, i) => {
    const name = clean(r[nameAt]);
    if (!name) return []; // blank lines and totals rows without a name
    const gstins = gstAt < 0 ? [] : [...new Set(clean(r[gstAt]).toUpperCase().split(/[\s,;/]+/).filter(Boolean))];
    const pan = panAt < 0 ? '' : clean(r[panAt]).toUpperCase();
    const badGst = gstins.find((g) => !GSTIN_RE.test(g));
    const problem = name.length < 2 ? 'Name is too short' : badGst ? `Not a valid GSTIN: ${badGst}` : pan && !PAN_RE.test(pan) ? `Not a valid PAN: ${pan}` : null;
    return [{ line: head + i + 2, name, gstins, pan, problem }];
  });
}
