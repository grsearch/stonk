'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selection } = require('../src/shadow/selection');
const { selectionValidation } = require('../src/reporting/selection-validation');
const { recoveryAudit } = require('../src/reporting/recovery-audit');
const snapshot = () => ({ ready: true, values: { buyFraction15: .2, buySol15: 2, sellSol15: 8, return60Pct: -20, trades60: 10, sellSol: 39.99, buyFraction5: 1 / 3, consecutiveSells: 2, buySol5: 1, sellSol5: 2 } });
const safeAge = { definition: 'since_pump_graduation_migration', source: 'pump_migrate_processed', status: 'observed_processed_not_finalized', migrationAgeMs: 1000 };
const select = s => selection({}, {}, true, null, s, safeAge);
test('prebuy filters use fixed boundaries and do not depend on models', () => {
  const s = snapshot(), before = JSON.stringify(s);
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
  assert.equal(JSON.stringify(s), before);
  s.values.buyFraction15 = .199; assert.equal(select(s).arms.avoidWeakBuy.status, 'reject');
  s.values.buyFraction15 = .2; s.values.return60Pct = -20.01;
  assert.equal(select(s).arms.avoidPriorFall.status, 'reject');
  s.values.return60Pct = -20; s.values.sellSol = 40;
  assert.equal(select(s).arms.avoidLargeDump.status, 'reject');
  assert.equal(select(s).arms.prebuyCombined.status, 'reject');
});
test('missing history and no prior trades remain unknown, not fabricated passes', () => {
  const s = snapshot(); s.ready = false;
  assert.equal(select(s).arms.avoidWeakBuy.status, 'unknown');
  assert.equal(select(s).arms.avoidPriorFall.status, 'unknown');
  s.ready = true; s.values.buySol15 = s.values.sellSol15 = 0; s.values.trades60 = 1;
  assert.equal(select(s).arms.prebuyCombined.status, 'unknown');
  assert.equal(select().arms.avoidLargeDump.status, 'unknown');
});
test('new selection groups reach export and independent recovery without inventing missing returns', () => {
  const se = select(snapshot()), sample = { id: 'a', key: 'a', at: 1000, policyId: 'p', runId: 'r', selection: se };
  const result = selectionValidation(new Map([['a', sample]]), new Map(), { start: new Date(0).toISOString(), endExclusive: new Date(2000).toISOString() });
  assert.equal(result.legacySamples, 0);
  assert.equal(result.groups[0].arms.prebuyCombined.selectedPending, 1);
  assert.equal(result.groups[0].arms.prebuyCombined.selectedNetSol, null);
  const audit = recoveryAudit(new Map([['a', { ...sample, type: 'state_exit_recovery', variant: 'no_fixed_stop', phase: 'finished', status: 'unknown', reason: 'no_exit_quote_by_deadline' }]]), new Map());
  assert.equal(audit.groups[0].prebuyCombined.unknown, 1);
  assert.equal(audit.groups[0].prebuyCombined.estimatedNetSol, undefined);
});

test('unknown history policy arms distinguish explicit history rejection from risk rejection', () => {
  const s = snapshot(); s.ready = false;
  const unknown = select(s);
  assert.equal(unknown.arms.prebuyAllowUnknown.status, 'pass');
  assert.equal(unknown.arms.prebuyRequireKnown.status, 'reject');
  assert.equal(unknown.arms.prebuyUnknownOnly.status, 'pass');
  assert.equal(unknown.arms.prebuyCombined.status, 'unknown');
  s.values.sellSol = 40;
  const risk = select(s);
  for (const name of ['prebuyAllowUnknown', 'prebuyRequireKnown', 'prebuyUnknownOnly']) assert.equal(risk.arms[name].status, 'reject');
  const good = select(snapshot());
  assert.equal(good.arms.prebuyRequireKnown.status, 'pass');
  assert.equal(good.arms.prebuyUnknownOnly.status, 'reject');
  assert.equal(selection({}, {}, false, null, s).arms.prebuyAllowUnknown.status, 'reject');
});

test('strict history comparison exports the missed outcome without turning missing labels into losses', () => {
  const s = snapshot(); s.ready = false;
  const sample = { id: 'a', key: 'a', at: 1000, runId: 'r', policyId: 'p', selection: select(s) };
  const outcomes = new Map([['a:strategy_proxy', { at: 2000, status: 'observed_proxy', policyId: 'p', netPnlSol: -.4, entryCostSol: 1 }]]);
  const report = selectionValidation(new Map([['a', sample]]), outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  const g = report.groups[0];
  assert.equal(g.arms.prebuyAllowUnknown.selectedNetSol, -.4);
  assert.equal(g.arms.prebuyRequireKnown.pairedDifferenceSol, .4);
  assert.equal(g.arms.prebuyRequireKnown.selectedNetSol, null);
  assert.equal(g.reboundBySelection.prebuyUnknownOnly.unknown, 1);
});

test('consecutive sell pressure rejects only the joint condition and preserves legacy observation', () => {
  const s = snapshot(); s.values.consecutiveSells = 3;
  let result = select(s);
  assert.equal(result.version, 7);
  assert.equal(result.arms.prebuyCombined.status, 'reject');
  assert.equal(result.arms.prebuyLegacy.status, 'pass');
  assert.equal(result.arms.prebuyCombined.rejected[0].check, 'consecutivePressure');
  s.values.sellSol5 = s.values.buySol5;
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
  s.values.sellSol5 = 2; s.values.consecutiveSells = 2;
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
});
test('missing or invalid pressure history stays unknown, never a dangerous zero', () => {
  for (const values of [{ consecutiveSells: undefined }, { consecutiveSells: -1 }, { consecutiveSells: 3.5 }, { buySol5: NaN }, { sellSol5: -1 }]) {
    const s = snapshot(); Object.assign(s.values, values);
    assert.equal(select(s).arms.prebuyCombined.status, 'unknown');
    assert.equal(select(s).arms.prebuyAllowUnknown.status, 'pass');
    s.values.sellSol = 40;
    assert.equal(select(s).arms.prebuyCombined.status, 'reject');
  }
});
test('blocked pressure samples retain counterfactual losses in export and replay uses current rules', () => {
  const { eligible } = require('../scripts/replay-entry-research');
  const s = snapshot(); s.values.consecutiveSells = 3;
  assert.equal(eligible({ decisionFresh: true, features: s, age: safeAge }), false);
  const sample = { id: 'pressure', at: 1000, runId: 'r', policyId: 'p', selection: select(s) };
  const outcomes = new Map([['pressure:strategy_proxy', { at: 2000, status: 'observed_proxy', policyId: 'p', netPnlSol: -.4, entryCostSol: 1 }]]);
  const g = selectionValidation(new Map([['pressure', sample]]), outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() }).groups[0];
  assert.equal(g.arms.prebuyLegacy.selectedNetSol, -.4);
  assert.equal(g.arms.prebuyCombined.pairedDifferenceSol, .4);
  s.values.consecutiveSells = 2;
  assert.equal(eligible({ decisionFresh: true, features: s, age: safeAge }), true);
});

test('buy burst rejects the exact 80 percent boundary and preserves previous combined selection', () => {
  const { eligible } = require('../scripts/replay-entry-research');
  const s = snapshot(); Object.assign(s.values, { buySol5: 8, sellSol5: 2, buyFraction5: .8 });
  const result = select(s);
  assert.equal(result.arms.prebuyCombined.status, 'reject');
  assert.equal(result.arms.prebuyBeforeBuy80.status, 'pass');
  assert.equal(result.arms.prebuyCombined.rejected[0].check, 'priorBuyBurst');
  assert.equal(eligible({ decisionFresh: true, features: s, age: safeAge }), false);
  Object.assign(s.values, { buySol5: 7.999, sellSol5: 2.001, buyFraction5: .7999 });
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
  Object.assign(s.values, { buySol5: 10, sellSol5: 0, buyFraction5: 1 });
  assert.equal(select(s).arms.prebuyCombined.status, 'reject');
});
test('buy burst requires valid nonempty observed history and does not fabricate danger', () => {
  for (const values of [{ buyFraction5: undefined }, { buyFraction5: NaN }, { buyFraction5: 1.01 }, { buyFraction5: -1 }, { buySol5: 0, sellSol5: 0, buyFraction5: 1 }, { buySol5: Infinity }]) {
    const s = snapshot(); Object.assign(s.values, values);
    assert.equal(select(s).arms.avoidBuyBurst.status, 'unknown');
    assert.equal(select(s).arms.prebuyAllowUnknown.status, 'pass');
  }
  const s = snapshot(); s.ready = false; s.values.buyFraction5 = 1;
  assert.equal(select(s).arms.avoidBuyBurst.status, 'unknown');
  s.values.sellSol = 40;
  assert.equal(select(s).arms.prebuyCombined.status, 'reject');
});
test('buy burst counterfactual return is retained in selection and state recovery exports', () => {
  const s = snapshot(); Object.assign(s.values, { buySol5: 8, sellSol5: 2, buyFraction5: .8 });
  const sample = { id: 'burst', at: 1000, runId: 'r', policyId: 'p', selection: select(s) };
  const outcomes = new Map([['burst:strategy_proxy', { at: 2000, status: 'observed_proxy', policyId: 'p', netPnlSol: -.3, entryCostSol: 1 }]]);
  const g = selectionValidation(new Map([['burst', sample]]), outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() }).groups[0];
  assert.equal(g.arms.prebuyBeforeBuy80.selectedNetSol, -.3);
  assert.equal(g.arms.prebuyCombined.pairedDifferenceSol, .3);
  const audit = recoveryAudit(new Map([['burst', { ...sample, type: 'state_exit_recovery', variant: 'baseline', phase: 'finished', status: 'unknown' }]]), new Map());
  assert.equal(audit.groups[0].prebuyBeforeBuy80.unknown, 1);
});

test('migration age uses authenticated graduation evidence with inclusive 30 and exclusive 120 minute boundaries', () => {
  for (const [ms, status] of [[1799999, 'pass'], [1800000, 'reject'], [7199999, 'reject'], [7200000, 'pass']]) {
    const age = { ...safeAge, migrationAgeMs: ms };
    const result = selection({}, {}, true, null, snapshot(), age);
    assert.equal(result.arms.prebuyCombined.status, status);
    assert.equal(result.arms.prebuyBeforeAge.status, 'pass');
  }
  for (const age of [undefined, { ...safeAge, migrationAgeMs: null }, { ...safeAge, migrationAgeMs: -1 }, { ...safeAge, status: 'unknown' }, { ...safeAge, source: 'token_creation' }, { ...safeAge, definition: 'since_token_creation' }]) {
    const result = selection({}, {}, true, null, snapshot(), age);
    assert.equal(result.arms.prebuyCombined.status, 'unknown');
    assert.equal(result.arms.prebuyAllowUnknown.status, 'pass');
  }
});
test('age rejection retains previous selection outcomes and offline replay agrees', () => {
  const age = { ...safeAge, migrationAgeMs: 3600000 }, features = snapshot();
  const selected = selection({}, {}, true, null, features, age);
  assert.equal(selected.arms.prebuyCombined.rejected[0].check, 'migrationAge');
  assert.equal(require('../scripts/replay-entry-research').eligible({ decisionFresh: true, features, age }), false);
  const sample = { id: 'age', at: 1000, runId: 'r', policyId: 'p', selection: selected };
  const outcomes = new Map([['age:strategy_proxy', { at: 2000, status: 'observed_proxy', policyId: 'p', netPnlSol: -.3, entryCostSol: 1 }]]);
  const report = selectionValidation(new Map([['age', sample]]), outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  assert.equal(report.groups[0].arms.prebuyBeforeAge.selectedNetSol, -.3);
  assert.equal(report.groups[0].arms.prebuyCombined.pairedDifferenceSol, .3);
});
