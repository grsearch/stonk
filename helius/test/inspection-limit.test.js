'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MAX_INSPECTION_BYTES, checkInspectionBytes } = require('../scripts/inspect-export');
const { failureMessage } = require('../scripts/upload-daily');
test('inspection accepts daily archives above 1 GiB and retains the 4 GiB boundary', () => {
  assert.equal(MAX_INSPECTION_BYTES, 4294967296);
  for (const bytes of [1024 ** 3 + 1, Math.ceil(1.52 * 1024 ** 3), MAX_INSPECTION_BYTES]) assert.doesNotThrow(() => checkInspectionBytes(bytes));
  assert.throws(() => checkInspectionBytes(MAX_INSPECTION_BYTES + 1), e => e.code === 'INSPECTION_SIZE_LIMIT' && /4 GiB/.test(e.message));
});
test('upload failure identifies known capacity error without exposing raw exceptions', () => {
  const secret = 'https://host/?secret=PRIVATE';
  assert.match(failureMessage({ code: 'INSPECTION_SIZE_LIMIT', message: secret }), /before upload.*4 GiB/);
  assert.ok(!failureMessage({ code: 'INSPECTION_SIZE_LIMIT', message: secret }).includes('PRIVATE'));
  assert.ok(!failureMessage(new Error(secret)).includes('PRIVATE'));
  assert.match(failureMessage(new Error(secret)), /Pending window retained/);
});
