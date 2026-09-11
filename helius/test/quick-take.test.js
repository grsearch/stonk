'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ExitComparisons } = require('../src/shadow/exit-comparisons');
const { Recovery } = require('../src/shadow/recovery');
const c = { takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000,
  exitDelayMs: 500, maxGapMs: 10000, maxActive: 100, maxActivePerPool: 100 };
function setup() {
  const events = [], x = new ExitComparisons(c, e => events.push(e));
  const s = { id: 'a', key: 'a', at: 9000, source: { pool: 'p' }, last: { slot: 1 }, strategyDone: true,
    entry: { at: 10000, openedAt: 10000, entryPrice: 1, high: 1, amount: 1, cost: 1 } };
  x.states(s); return { s, x, events, arm: s.exitComparisons.find(a => a.name === 'take8_first3s') };
}
test('quick take includes the exact 3s and 8% boundaries from entry and waits for the delayed quote', () => {
  const { s, x, arm, events } = setup();
  x.observe(s, { price: 1.079999 }, 1.04, 12999); assert.equal(arm.pending, null);
  x.observe(s, { price: 1.08 }, 1.04, 13000); assert.equal(arm.pending.reason, 'quick_take_profit');
  assert.equal(events.some(e => e.variant === arm.name), false);
  x.observe(s, { price: 1.05 }, 1.01, 13499); assert.equal(arm.done, false);
  x.observe(s, { price: 1.02 }, .98, 13500);
  const r = events.find(e => e.variant === arm.name);
  assert.equal(r.triggerAt, 13000); assert.equal(r.exitAt, 13500);
  assert.ok(Math.abs(r.netPnlSol + .02) < 1e-12);
  assert.equal(r.assumptions.quickTakePct, 8); assert.equal(r.assumptions.quickWindowMs, 3000);
  assert.equal(s.entry.high, 1); assert.equal(c.takeProfit, 20);
});
test('after 3s quick take expires, while original profit, stop, trailing and time rules remain', () => {
  const late = setup(); late.x.observe(late.s, { price: 1.08 }, 1.04, 13001); assert.equal(late.arm.pending, null);
  for (const [price, at, reason] of [[1.25, 14000, 'take_profit'], [.7, 14000, 'stop_loss'], [1, 40000, 'max_hold']]) {
    const { x, s, arm } = setup(); x.observe(s, { price }, price, at); assert.equal(arm.pending.reason, reason);
  }
  const t = setup(); t.x.observe(t.s, { price: 1.15 }, 1.1, 14000);
  t.x.observe(t.s, { price: 1.1 }, 1.05, 14500); assert.equal(t.arm.pending.reason, 'trailing');
});
test('missing quick exit is censored; recovery preserves trigger but never backfills the 3s window', () => {
  const { x, s, arm, events } = setup(); x.observe(s, { price: 1.08 }, 1.04, 13000);
  const recoveryEvents = [], r = new Recovery(c, e => recoveryEvents.push(e), s => s.net, 'state_exit_recovery');
  r.add(s, 'stream_disconnected', 13100); x.censor(s, 'stream_disconnected', 13100);
  assert.equal(events.find(e => e.variant === arm.name).status, 'censored');
  r.observe({ pool: 'p', slot: 2, price: .9, net: .85, requestAt: 13500 }, 13600);
  const done = recoveryEvents.find(e => e.variant === arm.name && e.phase === 'finished');
  assert.equal(done.reason, 'quick_take_profit'); assert.equal(done.triggerAt, 13000);
  assert.equal(done.status, 'account_state_proxy');
  const fresh = setup(), lateEvents = [], late = new Recovery(c, e => lateEvents.push(e), s => s.net, 'state_exit_recovery');
  late.add(fresh.s, 'stream_disconnected', 12000);
  late.observe({ pool: 'p', slot: 2, price: 1.08, net: 1.04, requestAt: 12999 }, 13001);
  assert.equal(late.active.get('a:take8_first3s').pending, null);
  assert.equal(lateEvents.some(e => e.reason === 'quick_take_profit'), false);
});
