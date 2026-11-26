/** The CSV reader used by the file viewer. Run: npx tsx tests/csv.mts */
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.ts';
assert.deepEqual(parseCsv('a,b\r\n1,2\n'), [['a', 'b'], ['1', '2']]);
assert.deepEqual(parseCsv('"Mehta, Ravi","said ""hi""",3'), [['Mehta, Ravi', 'said "hi"', '3']]);
assert.deepEqual(parseCsv('"two\nlines",x\n,'), [['two\nlines', 'x'], ['', '']]);
assert.deepEqual(parseCsv('1\n2\n3\n4', 2), [['1'], ['2']]);
assert.deepEqual(parseCsv(''), []);
console.log('5 passed, 0 failed');
