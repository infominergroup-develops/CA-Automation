/** Where files from an uploaded folder are filed: a year from the folder names, everything else kept. Run: npm run test:place */
import assert from 'node:assert/strict';
import { placeFile } from '../src/placeFile.ts';
const at = (path: string, openFy?: string) => { const p = placeFile(path, openFy, '2026-27'); return `${p.fy}|${p.sub}`; };
const cases: [string, string, string?][] = [
  ['a.pdf', '2026-27|'],
  ['Mehta/FY 2025-26/Bank Statement/April/a.pdf', '2025-26|Bank Statement/April'], // the client's folder above the year is dropped
  ['2024-2025/GST/Sept/a.pdf', '2024-25|GST/Sept'],
  ['Scans/HDFC/a.pdf', '2026-27|Scans/HDFC'],                                       // no year: everything kept
  ['A/B/C/D/E/F/G/a.pdf', '2026-27|A/B/C/D/E/F/G'],                                 // any depth
  ['2025-27/a.pdf', '2026-27|2025-27'],                                             // not a financial year
  ['2026-27/Bank/a.pdf', '2026-27|Bank', '2026-27'],                                // names the open year: dropped
  ['2025-26/Bank/a.pdf', '2026-27|2025-26/Bank', '2026-27'],                        // another year inside an open one: kept as a folder
  ['Bank/April/a.pdf', '2026-27|Bank/April', '2026-27'],
];
for (const [path, want, openFy] of cases) assert.equal(at(path, openFy), want, path);
console.log(`${cases.length} passed, 0 failed`);
