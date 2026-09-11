'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { costSummary } = require('../src/reporting/execution-audit');
test('cost summary keeps missing and mismatched breakdowns out of component totals', () => {
  const row = { status: 'matched', prebuyStatus: 'pass', prebuyWaitMs: 9, entryTimeDifferenceMs: 500,
    paper: { pnlSol: .2 }, proxy: { pnlSol: .1, policyId: 'p' }, decomposition: { status: 'reconciled', components: { timingAndExitRule: -.07, exitFee: -.03 } } };
  const result = costSummary([row, { ...row, prebuyStatus: 'unknown', decomposition: { status: 'mismatch', components: { exitFee: -99 } } },
    { status: 'proxy_unknown', prebuyStatus: 'unknown', prebuyWaitMs: 15 }]);
  assert.equal(result.all.closes, 3); assert.equal(result.all.matched, 2); assert.equal(result.all.unknown, 1);
  assert.equal(result.all.reconciled, 1); assert.equal(result.all.components.exitFee, -.03);
  assert.equal(result.byPrebuyStatus.unknown.components, null);
  assert.equal(result.byPolicy.unmatched.matchedProxySol, null);
  assert.equal(result.all.prebuyWaitMs.count, 3);
  assert.equal(costSummary([]).all.components, null);
});
