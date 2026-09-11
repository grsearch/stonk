'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selection } = require('../src/shadow/selection');
const { selectionValidation } = require('../src/reporting/selection-validation');
const market = { experimentId: 'e', belowMaxSell: true, avoidPriorSellPressure: true };
const predictions = { loss25: { modelId: 'risk', target: 'loss_25', status: 'experimental_calibrated_model', probability: .2 },
  netReturn: { modelId: 'net', target: 'net_return', status: 'experimental_calibrated_model', expectedNetReturn: .02 } };
test('fixed selection distinguishes absent models, strict boundaries and explicit rejection', () => {
  assert.equal(selection(market, {}, true).arms.combined.status, 'unknown');
  assert.equal(selection(market, predictions, true).arms.combined.status, 'pass');
  const p = structuredClone(predictions); p.loss25.probability = .25;
  assert.equal(selection(market, p, true).arms.risk.status, 'reject');
  p.loss25.probability = .2; p.netReturn.expectedNetReturn = 0;
  assert.equal(selection(market, p, true).arms.net.status, 'reject');
  assert.equal(selection({ ...market, belowMaxSell: false }, {}, true).arms.combined.status, 'reject');
  assert.equal(selection(market, predictions, false).arms.baseline.status, 'reject');
});
test('validation isolates runs and model versions; missing outcomes never become profitable zeros', () => {
  const samples = new Map(), outcomes = new Map();
  for (let i = 0; i < 5; i++) {
    const se = selection(i === 1 ? { ...market, belowMaxSell: false } : market, predictions, true);
    if (i === 4) se.modelIds.net = 'other';
    const s = { id: String(i), key: String(i), runId: i === 3 ? 'new-run' : 'run', runStartedAt: 0, at: 1000, policyId: 'p', selection: se };
    samples.set(s.id, s);
    if (i !== 2) outcomes.set(`${s.id}:strategy_proxy`, { policyId: 'p', at: 2000, status: 'observed_proxy', netPnlSol: i === 1 ? -.5 : .1, entryCostSol: 1 });
  }
  const r = selectionValidation(samples, outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  assert.equal(r.groups.length, 3); const b = r.groups[0].arms.combined;
  assert.equal(b.selectedKnown, 1); assert.equal(b.selectedPending, 1); assert.equal(b.selectedMissingRate, .5);
  assert.equal(b.pairedCandidates, 2); assert.equal(b.filteredPairedSol, .1); assert.equal(b.baselinePairedSol, -.4); assert.equal(b.pairedDifferenceSol, .5);
  assert.equal(r.groups[0].arms.baseline.severeLossRate, .5);
});
test('validation excludes old-window candidates and conflicting duplicate chain keys', () => {
  const s = { id: 'a', key: 'chain', runId: 'r', at: 1000, policyId: 'p', selection: selection(market, predictions, true) };
  const samples = new Map([['a', s], ['b', { ...s, id: 'b', selection: selection(market, {}, true) }], ['old', { ...s, id: 'old', key: 'old', at: -1 }]]);
  const r = selectionValidation(samples, new Map(), { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  assert.equal(r.conflicts, 1); assert.equal(r.groups.length, 0);
});

test('joint rebound/drawdown observation uses distinct targets and exact boundaries', () => {
  const rebound = { status: 'experimental_calibrated_model', target: 'rebound_60s', modelId: 'b', probability: .6 };
  const p = { drawdown60: { ...rebound, target: 'drawdown_60s_25', modelId: 'd', probability: .249 } };
  assert.equal(selection(market, p, true, rebound).arms.joint.status, 'pass');
  assert.equal(selection(market, p, false, rebound).arms.joint.status, 'reject');
  assert.equal(selection(market, p, true, { ...rebound, probability: .599 }).arms.joint.status, 'reject');
  p.drawdown60.probability = .25;
  assert.equal(selection(market, p, true, rebound).arms.joint.status, 'reject');
  p.drawdown60.target = 'loss_25';
  assert.equal(selection(market, p, true, rebound).arms.joint.status, 'unknown');
  assert.equal(selection(market, {}, true, { ...rebound, probability: .8 }).arms.highRebound.status, 'pass');
  assert.equal(selection(market, {}, true, { ...rebound, target: 'rebound_30s' }).arms.highRebound.status, 'unknown');
});

test('joint export pairs identical candidates and keeps missing horizons/exits unknown', () => {
  const p = { status: 'experimental_calibrated_model', target: 'rebound_60s', modelId: 'b', probability: .8 };
  const se = selection(market, { drawdown60: { ...p, target: 'drawdown_60s_25', probability: .2 } }, true, p);
  const samples = new Map(['a', 'b'].map(id => [id, { id, key: id, runId: 'r', policyId: 'p', at: 1000, selection: se }]));
  const outcomes = new Map([['a:strategy_proxy', { at: 62000, policyId: 'p', status: 'observed_proxy', netPnlSol: -.3, entryCostSol: 1 }],
    ['a:rebound_60s', { at: 62000, policyId: 'p', status: 'observed_proxy', label: 1, minNetPct: -40 }]]);
  const exits = new Map([['e', { id: 'a', variant: 'no_fixed_stop', comparisonVersion: 1, at: 63000, policyId: 'p', status: 'observed_proxy', netPnlSol: .1, entryCostSol: 1 }]]);
  const r = selectionValidation(samples, outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(100000).toISOString() }, exits).groups[0];
  assert.equal(r.reboundBySelection.joint.known, 1); assert.equal(r.reboundBySelection.joint.both, 1); assert.equal(r.reboundBySelection.joint.unknown, 1);
  assert.equal(r.exitsBySelection.joint.no_fixed_stop.paired, 1); assert.equal(r.exitsBySelection.joint.no_fixed_stop.missingOrUnpaired, 1);
  assert.equal(r.exitsBySelection.joint.no_fixed_stop.differenceSol, .4);
  assert.equal(r.exitsBySelection.joint.net_take5.variantSol, null);
});
