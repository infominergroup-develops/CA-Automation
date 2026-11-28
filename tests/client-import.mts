/** Reading a client list from Excel. Run: npm run test:import */
import assert from 'node:assert/strict';
import { readClientSheet } from '../src/clientImport.ts';

const rows = readClientSheet([
  ['LIST OF PARTIES'],
  [],
  ['S. No.', 'Name of Party', 'GSTIN ', 'PAN '],
  [1, 'CUBETIX SOLUTIONS PRIVATE LIMITED     ', '09AAJCC5253D1ZQ', 'AAJCC5253D'],
  [2, 'CHAMBER  OF PROFESSIONALS (COP)', '', 'aadac9538k'],
  [3, 'Two States Pvt Ltd', '09AAJCC5253D1ZQ, 27AAJCC5253D1ZM', ''],
  [4, '', '', ''],
  [5, 'Bad Gst Co', '09XYZ', ''],
  [6, 'Bad Pan Co', '', 'ABC'],
]);
assert.equal(rows.length, 5, 'blank rows are dropped');
assert.deepEqual(rows[0], { line: 4, name: 'CUBETIX SOLUTIONS PRIVATE LIMITED', gstins: ['09AAJCC5253D1ZQ'], pan: 'AAJCC5253D', problem: null });
assert.equal(rows[1].name, 'CHAMBER OF PROFESSIONALS (COP)', 'spaces tidied');
assert.deepEqual(rows[1].gstins, []);
assert.equal(rows[1].pan, 'AADAC9538K', 'PAN upper-cased');
assert.deepEqual(rows[2].gstins, ['09AAJCC5253D1ZQ', '27AAJCC5253D1ZM'], 'several GSTINs in one cell');
assert.match(rows[3].problem ?? '', /Not a valid GSTIN: 09XYZ/);
assert.match(rows[4].problem ?? '', /Not a valid PAN: ABC/);
assert.throws(() => readClientSheet([['a', 'b'], [1, 2]]), /No column for the client name/);
// Columns in another order, found by their headers.
assert.deepEqual(readClientSheet([['PAN', 'GST No', 'Client'], ['AAJCC5253D', '09AAJCC5253D1ZQ', 'X Co']])[0].gstins, ['09AAJCC5253D1ZQ']);
console.log('client import: 10 checks passed');
