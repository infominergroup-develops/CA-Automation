/** Where a file goes: folder (category id), financial year, month ('' = none) and any inner folders to keep. */
export interface Place { category: string; fy: string; month: string; sub: string }

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Common short names for folders that share no first word with ours.
const ALIASES: Record<string, string> = { pl: 'profitandloss', pnl: 'profitandloss', itr: 'incometax', pf: 'payrollandpfesi', esi: 'payrollandpfesi', salary: 'payrollandpfesi', mca: 'rocmca' };
const norm = (s: string) => s.toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]/g, '').replace(/s$/, '');

function readFy(dir: string): string | undefined {
  const m = dir.match(/(?:^|\D)(20\d{2})\s*[-–_/ ]\s*(?:20)?(\d{2})(?:\D|$)/);
  return m && Number(m[2]) === (Number(m[1]) + 1) % 100 ? `${m[1]}-${m[2]}` : undefined;
}

function readMonth(dir: string): string | undefined {
  // "April", "apr", "04 April", "2026-04 April", "Apr-26"; the whole name must be a month, so "Marketing" is not March.
  const m = dir.toLowerCase().match(/^(?:[\d\s._-]+)?([a-z]+)(?:[\s'._-]*\d{2,4})?$/);
  const i = m ? MONTH_NAMES.findIndex((n) => m[1] === n || m[1] === n.slice(0, 3) || (n === 'september' && m[1] === 'sept')) : -1;
  return i < 0 ? undefined : String(i + 1);
}

function readCategory(dir: string, cats: { id: string | number; name: string }[]): string | undefined {
  const d = norm(dir);
  const hit = cats.find((c) => norm(c.name) === d || norm(c.name.split(/[\s/]/)[0]) === d || norm(c.name) === norm(ALIASES[d] ?? ''));
  return hit && String(hit.id);
}

/**
 * Files a picked file by the names of the folders it came in. The folder the user has open (`fixed`) always wins;
 * otherwise a recognised year, document type or month is used, and whatever is left is kept as inner folders.
 */
export function placeFile(path: string, fixed: Partial<Place>, chosen: Omit<Place, 'sub'>, cats: { id: string | number; name: string }[]): Place {
  const found: Partial<Place> = {};
  const rest: string[] = [];
  const dirs = path.split('/').slice(0, -1);
  let wrapper = false; // the top folder has a name that means nothing to us, such as the client's
  dirs.forEach((dir, i) => {
    const guesses = { fy: readFy(dir), month: readMonth(dir), category: readCategory(dir, cats) };
    const key = (['fy', 'month', 'category'] as const).find((k) => guesses[k]);
    if (i === 0 && !key) wrapper = true;
    if (key && fixed[key] === guesses[key]) return; // it names the folder already open
    if (key && fixed[key] === undefined && found[key] === undefined) found[key] = guesses[key];
    else rest.push(dir);
  });
  if (wrapper && Object.keys(found).length) rest.shift();
  return { ...chosen, ...found, ...fixed, sub: rest.join('/') };
}
