'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ExitComparisons } = require('../src/shadow/exit-comparisons');
const { Recovery } = require('../src/shadow/recovery');
const c = { takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000,
  exitDelayMs: 500, maxGapMs: 10000, maxActive: 100, maxActivePerPool: 100 };
function setup() {
  const events = [], x = new ExitComparisons(c, r => events.push(r));
  const s = { id: 'a', key: 'a', at: 9000, source: { pool: 'p' }, last: { slot: 1 }, strategyDone: true,
    entry: { at: 10000, openedAt: 10000, entryPrice: 1, high: 1, amount: 1, cost: 1 } };
  const arm = x.states(s).find(a => a.name === 'rebound_failure_3s');
  return { events, x, s, arm };
}
const swap = (side, quoteSol, price = .95) => ({ side, quoteSol, price });
function pressure(t) {
  t.x.observe(t.s, swap('buy', 2), .96, 10500);
  t.x.observe(t.s, swap('sell', 2), .95, 11500);
  t.x.observe(t.s, swap('sell', 1), .94, 12500);
}
test('3s failure uses net liquidation, fixed flow and exact thresholds then waits for a delayed exit', () => {
  const t = setup(); pressure(t);
  assert.equal(t.arm.pending, null);
  t.x.observe(t.s, swap('sell', 0), .92, 13000);
  assert.equal(t.arm.pending.reason, 'rebound_failure_3s');
  const assessment = t.events.find(r => r.type === 'early_exit_assessment');
  assert.equal(assessment.status, 'failed'); assert.equal(assessment.sellSol, 3);
  t.x.observe(t.s, swap('buy', 100, 1.1), 1.06, 13499); assert.equal(t.arm.done, false);
  t.x.observe(t.s, swap('sell', 1, .9), .85, 13500);
  const exit = t.events.find(r => r.type === 'exit_comparison' && r.variant === t.arm.name);
  assert.equal(exit.triggerAt, 13000); assert.equal(exit.exitAt, 13500);
  assert.ok(Math.abs(exit.netPnlSol + .15) < 1e-12);
  assert.equal(exit.earlyAssessment.buySol, 2); assert.equal(t.s.entry.high, 1);
});
test('returning buy support or small net loss does not trigger; evaluation occurs once', () => {
  for (const support of [true, false]) {
    const t = setup(); pressure(t);
    t.x.observe(t.s, swap('buy', support ? 2 : 0), support ? .90 : .93, 13000);
    assert.equal(t.arm.pending, null); assert.equal(t.arm.failureState.assessment.status, 'not_failed');
    t.x.observe(t.s, swap('sell', 100), .90, 13500);
    assert.equal(t.arm.pending, null);
    assert.equal(t.events.filter(r => r.type === 'early_exit_assessment').length, 1);
  }
});
test('missing flow and missed evaluation window are unavailable, never backfilled by later selling', () => {
  const t = setup(); t.x.observe(t.s, { price: .95 }, .92, 11000);
  t.x.observe(t.s, swap('sell', 3), .90, 13000);
  assert.equal(t.arm.failureState.assessment.status, 'unavailable'); assert.equal(t.arm.pending, null);
  const late = setup(); pressure(late); late.x.tick(late.s, 14001);
  late.x.observe(late.s, swap('sell', 10), .90, 14500);
  assert.equal(late.arm.failureState.assessment.reason, 'no_timely_evaluation_quote'); assert.equal(late.arm.pending, null);
  const edge = setup(); pressure(edge); edge.x.observe(edge.s, swap('buy', 100), .90, 14000);
  assert.equal(edge.arm.pending.reason, 'rebound_failure_3s');
  assert.equal(edge.arm.failureState.assessment.buySol, 2); // after-3s buys cannot rewrite fixed flow window
  const empty = setup(); empty.x.observe(empty.s, swap('sell', 10), .90, 13001);
  assert.equal(empty.arm.failureState.assessment.reason, 'no_post_entry_flow_observed');
});
test('ordinary stops still apply before assessment; a gap cannot manufacture a new early failure', () => {
  const early = setup(); early.x.observe(early.s, swap('sell', 3, .7), .65, 11000);
  assert.equal(early.arm.pending.reason, 'stop_loss');
  early.x.observe(early.s, swap('sell', 1, .7), .65, 11500);
  assert.equal(early.arm.failureState.assessment.status, 'not_reached');
  const t = setup(); pressure(t);
  const events = [], recovery = new Recovery(c, r => events.push(r), s => s.net, 'state_exit_recovery');
  recovery.add(t.s, 'stream_disconnected', 12600); t.x.censor(t.s, 'stream_disconnected', 12600);
  recovery.observe({ pool: 'p', slot: 2, price: .95, net: .90, requestAt: 13000 }, 13000);
  assert.equal(recovery.active.get('a:rebound_failure_3s').pending, null);
  assert.equal(events.some(r => r.reason === 'rebound_failure_3s'), false);
});
test('gap after a failed assessment preserves exit intent and labels recovery separately', () => {
  const t = setup(); pressure(t); t.x.observe(t.s, swap('sell', 1), .90, 13000);
  const events = [], recovery = new Recovery(c, r => events.push(r), s => s.net, 'state_exit_recovery');
  recovery.add(t.s, 'stream_disconnected', 13100); t.x.censor(t.s, 'stream_disconnected', 13100);
  recovery.observe({ pool: 'p', slot: 2, price: 1.1, net: 1.05, requestAt: 13500 }, 13600);
  const r = events.find(r => r.variant === t.arm.name && r.phase === 'finished');
  assert.equal(r.reason, 'rebound_failure_3s'); assert.equal(r.triggerAt, 13000);
  assert.equal(r.status, 'account_state_proxy'); assert.equal(r.earlyAssessment.status, 'failed');
});
