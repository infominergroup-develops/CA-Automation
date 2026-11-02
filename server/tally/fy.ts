/** Indian financial year helpers. FY "2026-27" runs 2026-04-01 to 2027-03-31. Dates are ISO yyyy-mm-dd strings. */

export const FY_RE = /^20\d{2}-\d{2}$/;

export function fyOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const fyStart = (fy: string) => `${fy.slice(0, 4)}-04-01`;
export const fyEnd = (fy: string) => `${Number(fy.slice(0, 4)) + 1}-03-31`;
export const prevFy = (fy: string) => fyOf(`${Number(fy.slice(0, 4)) - 1}-06-01`);

export const todayIso = () => {
  // India time, so a sync at 00:30 IST belongs to the right day.
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
};

function lastDayOfMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Month-end dates of an FY up to `upto` (inclusive). The current, unfinished month ends at `upto`. */
export function monthEnds(fy: string, upto = todayIso()): string[] {
  const out: string[] = [];
  const end = upto < fyEnd(fy) ? upto : fyEnd(fy);
  let y = Number(fy.slice(0, 4));
  let m = 4;
  for (let i = 0; i < 12; i++) {
    const me = lastDayOfMonth(y, m);
    if (me >= end) { out.push(end); break; }
    out.push(me);
    m++; if (m === 13) { m = 1; y++; }
  }
  return out.filter((d) => d >= fyStart(fy));
}

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const fmtDateLong = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
