/** Where a picked file goes: its financial year, and the folders it came in to keep below that. */
export interface Place { fy: string; sub: string }

function readFy(dir: string): string | undefined {
  const m = dir.match(/(?:^|\D)(20\d{2})\s*[-–_/ ]\s*(?:20)?(\d{2})(?:\D|$)/);
  return m && Number(m[2]) === (Number(m[1]) + 1) % 100 ? `${m[1]}-${m[2]}` : undefined;
}

/**
 * Files a picked file by the folders it came in. A folder named after a financial year (2025-26, FY 2025-2026) sets
 * the year, unless a year is already open (`openFy`); that folder and any above it (such as the client's own name)
 * are dropped. Every other folder is kept, in order, however deep.
 */
export function placeFile(path: string, openFy: string | undefined, fy: string): Place {
  const dirs = path.split('/').slice(0, -1);
  const at = dirs.findIndex((d) => (openFy ? readFy(d) === openFy : !!readFy(d)));
  if (at < 0) return { fy: openFy ?? fy, sub: dirs.join('/') };
  return { fy: openFy ?? readFy(dirs[at])!, sub: dirs.slice(at + 1).join('/') };
}
