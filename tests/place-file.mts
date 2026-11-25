/** Where files from an uploaded folder are filed. Run: npm run test:place */
import assert from 'node:assert/strict';
import { placeFile } from '../src/placeFile.ts';
const cats = ['Bank statements', 'Registrations', 'Profit and loss', 'Sales invoices', 'GST documents', 'TDS / TCS', 'Payroll and PF/ESI', 'Income tax', 'ROC / MCA', 'Others'].map((name) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name }));
const chosen = { category: '', fy: '2026-27', month: '' };
const at = (path: string, fixed = {}) => { const p = placeFile(path, fixed, chosen, cats); return [p.fy, p.category, p.month, p.sub].join('|'); };
const cases: [string, string, object?][] = [
  ['a.pdf', '2026-27|||'],
  ['Mehta/FY 2025-26/Bank Statement/April/a.pdf', '2025-26|bank-statements|4|'],
  ['2024-2025/GST/Sept/a.pdf', '2024-25|gst-documents|9|'],
  ['Mehta/2025-26/P&L/a.pdf', '2025-26|profit-and-loss||'],
  ['X/Registration/GST certificate/a.pdf', '2026-27|registrations||GST certificate'],
  ['X/ITR/2025_26/a.pdf', '2025-26|income-tax||'],
  ['X/TDS/2026-04 April/a.pdf', '2026-27|tds-tcs|4|'],
  ['X/PF/Apr-26/a.pdf', '2026-27|payroll-and-pf-esi|4|'],
  ['X/roc/a.pdf', '2026-27|roc-mca||'],
  ['Marketing/a.pdf', '2026-27|||Marketing'],              // not March
  ['2025-27/a.pdf', '2026-27|||2025-27'],                  // not a financial year
  ['Scans/HDFC/a.pdf', '2026-27|||Scans/HDFC'],            // nothing recognised: keep all
  ['Mehta/Delhi branch/Bank/HDFC/a.pdf', '2026-27|bank-statements||Delhi branch/HDFC'],
  ['X/GST/Sales/a.pdf', '2026-27|gst-documents||Sales'],   // first type wins, the second is kept
  ['GST/May/a.pdf', '2026-27|bank-statements|5|GST', { fy: '2026-27', category: 'bank-statements' }], // the open folder wins
  ['April/a.pdf', '2026-27|bank-statements|4|', { fy: '2026-27', category: 'bank-statements', month: '4' }],
  ['Bank statements/HDFC/a.pdf', '2026-27|bank-statements|4|HDFC', { fy: '2026-27', category: 'bank-statements', month: '4' }],
];
for (const [path, want, fixed] of cases) assert.equal(at(path, fixed), want, path);
console.log(`${cases.length} passed, 0 failed`);
