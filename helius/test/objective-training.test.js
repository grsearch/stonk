'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { train, loadDataset } = require('../src/shadow/training');
const { Model, score } = require('../src/shadow/model');
const { FEATURE_NAMES } = require('../src/shadow/features');
const { ExitComparisons } = require('../src/shadow/exit-comparisons');
function rows() { return Array.from({ length: 1000 }, (_, i) => ({ at: i * 120000, endAt: i * 120000 + 60000, y: i % 2,
  values: Object.fromEntries(FEATURE_NAMES.map(k => [k, k === 'sellSol' ? i % 2 : 0])) })); }
test('holdout range rejection matches runtime and cannot pass with too few scored samples', () => {
  const rs = rows(); for (let i = 850; i < 1000; i++) rs[i].values.sellSol = 10000;
  const r = train(rs, 'loss_25', 'p');
  assert.equal(r.model, null); assert.equal(r.report.status, 'insufficient_scored_data');
  assert.equal(r.report.coverage.testRejected, 150); assert.equal(r.report.coverage.testScored, 50);
});
test('return regression uses net return units, shared score and future-only observation', () => {
  const rs = rows().map(r => ({ ...r, y: r.y ? 0.1 : -0.4 })), r = train(rs, 'net_return', 'p');
  assert.ok(r.model.validation.passed); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'return-model-')), file = path.join(dir, 'model.json');
  fs.writeFileSync(file, JSON.stringify(r.model)); const model = new Model(file, 'p');
  const p = model.predict({ ready: true, values: rs[1].values }, r.model.evaluationAfter + 1);
  assert.equal(p.probability, null); assert.equal(p.expectedNetReturn, score(r.model, rs[1].values)); assert.ok(Math.abs(p.expectedNetReturn - 0.1) < 0.02);
  assert.equal(model.predict({ ready: true, values: rs[1].values }, r.model.evaluationAfter).status, 'before_forward_evaluation_window');
});
test('risk and return labels require known net costs; censored and legacy amounts are not fabricated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-data-')), records = [];
  for (let i = 0; i < 4; i++) {
    records.push({ type: 'sample', schema: 1, id: String(i), key: String(i), policyId: 'p', at: i * 1000, sequence: 2, decisionFresh: true,
      features: { ready: true, lastHistorySequence: 1, values: rows()[0].values } });
    records.push({ type: 'outcome', id: String(i), target: 'strategy_proxy', policyId: 'p', at: i * 1000 + 500,
      status: i === 2 ? 'censored' : 'observed_proxy', label: 0, ...(i === 3 ? {} : { netPnlSol: i === 0 ? -0.5 : -0.2, entryCostSol: 2 }) });
  }
  fs.writeFileSync(path.join(dir, 'samples-test.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual((await loadDataset(dir, 'loss_25', 'p')).rows.map(r => r.y), [1, 0]);
  assert.deepEqual((await loadDataset(dir, 'net_return', 'p')).rows.map(r => r.y), [-0.25, -0.1]);
});
test('exit arms await observed delayed ticks, retain unknown gaps and never mutate baseline entry', () => {
  const events = [], c = { exitDelayMs: 500, takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000 };
  const comparisons = new ExitComparisons(c, r => events.push(r)), sample = { id: 'a', key: 'a', entry: { cost: 1, amount: 1, at: 0, openedAt: 0, high: 1, entryPrice: 1 } };
  comparisons.observe(sample, { price: 1.3 }, 1.25, 1000);
  assert.equal(events.length, 0); assert.equal(sample.entry.high, 1);
  comparisons.observe(sample, { price: 1.1 }, 1.05, 1249); assert.equal(events.length, 0);
  comparisons.observe(sample, { price: 0.9 }, 0.85, 1250); assert.equal(events.length, 1);
  assert.equal(events[0].variant, 'exit_250ms'); assert.ok(Math.abs(events[0].netPnlSol + 0.15) < 1e-9);
  comparisons.censor(sample, 'pool_observation_gap', 1300);
  assert.equal(events.length, 9); assert.equal(events.filter(r => r.status === 'censored').length, 8);
  assert.ok(events.filter(r => r.status === 'censored').every(r => r.netPnlSol === null));
});

test('no fixed stop research survives the stop then takes profit with the same delayed quote', () => {
  const events = [], c = { exitDelayMs: 500, takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000 };
  const x = new ExitComparisons(c, r => events.push(r)), s = { id: 'a', entry: { cost: 1, at: 0, openedAt: 0, high: 1, entryPrice: 1 } };
  x.observe(s, { price: .7 }, .65, 1000);
  assert.equal(s.exitComparisons.find(a => a.name === 'no_fixed_stop').pending, null);
  x.observe(s, { price: .6 }, .55, 1500);
  x.observe(s, { price: 1.3 }, 1.25, 2000);
  assert.equal(events.some(r => r.variant === 'no_fixed_stop'), false);
  x.observe(s, { price: 1.2 }, 1.15, 2500);
  const r = events.find(r => r.variant === 'no_fixed_stop');
  assert.equal(r.reason, 'take_profit'); assert.equal(r.firstFixedStopAt, 1000);
  assert.ok(Math.abs(r.minNetPct + 45) < 1e-9); assert.ok(Math.abs(r.netPnlSol - .15) < 1e-9);
  assert.equal(r.entryCostSol, 1); assert.equal(r.assumptions.fixedStopEnabled, false);
  assert.equal(c.stopLoss, 25); assert.equal(s.entry.high, 1);
});

test('no fixed stop retains trailing, time limits, deep losses and unknown exits', () => {
  const c = { exitDelayMs: 500, takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000 };
  const make = () => { const events = [], x = new ExitComparisons(c, r => events.push(r)); return { events, x,
    s: { id: 'a', entry: { cost: 1, at: 0, openedAt: 0, high: 1, entryPrice: 1 } } }; };
  const a = make(); a.x.observe(a.s, { price: 1.15 }, 1.1, 1000); a.x.observe(a.s, { price: 1.1 }, 1.05, 1500);
  a.x.observe(a.s, { price: 1.08 }, 1.03, 2000);
  assert.equal(a.events.find(r => r.variant === 'no_fixed_stop').reason, 'trailing');
  const b = make(); b.x.observe(b.s, { price: .1 }, .05, 1000); b.x.tick(b.s, 30000);
  b.x.observe(b.s, { price: .1 }, .05, 30500);
  const r = b.events.find(r => r.variant === 'no_fixed_stop'); assert.equal(r.reason, 'max_hold'); assert.equal(r.netPnlSol, -.95);
  const u = make(); u.x.observe(u.s, { price: .1 }, .05, 1000); u.x.tick(u.s, 30000); u.x.censor(u.s, 'pool_observation_gap', 30500);
  const unknown = u.events.find(r => r.variant === 'no_fixed_stop'); assert.equal(unknown.status, 'censored'); assert.equal(unknown.netPnlSol, null);
});

test('drawdown60 training uses horizon minimum, not final strategy loss, and rejects missing minima', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawdown-data-')), records = [];
  for (let i = 0; i < 4; i++) {
    records.push({ type: 'sample', schema: 1, id: String(i), key: String(i), policyId: 'p', at: i * 100000, sequence: 2, decisionFresh: true,
      features: { ready: true, lastHistorySequence: 1, values: rows()[0].values } });
    records.push({ type: 'outcome', id: String(i), target: 'rebound_60s', policyId: 'p', at: i * 100000 + 60000,
      status: i === 2 ? 'censored' : 'observed_proxy', label: 1, ...(i === 3 ? {} : { minNetPct: i === 0 ? -25 : -24.9 }) });
  }
  fs.writeFileSync(path.join(dir, 'samples-test.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual((await loadDataset(dir, 'drawdown_60s_25', 'p')).rows.map(r => r.y), [1, 0]);
  const trained = train(rows(), 'drawdown_60s_25', 'p'), file = path.join(dir, 'model.json');
  fs.writeFileSync(file, JSON.stringify(trained.model));
  const model = new Model(file, 'p'); assert.equal(model.status, 'experimental_calibrated_model');
  assert.equal(model.predict({ ready: true, values: rows()[0].values }, trained.model.evaluationAfter).status, 'before_forward_evaluation_window');
});
