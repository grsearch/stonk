'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Recovery } = require('../src/shadow/recovery');
const c = { maxActive: 1, maxActivePerPool: 1, maxHoldMs: 30000, exitDelayMs: 500, maxGapMs: 10000, takeProfit: 20, trailArm: 10, trailDrop: 3 };
const sample = id => ({ id, key: id, source: { pool: 'p' }, last: { slot: 1 }, entry: { at: 0, cost: 1, amount: 1 },
  exitComparisons: [{ name: 'no_fixed_stop', done: false, position: { entryPrice: 1, openedAt: 0, high: 1 }, pending: null }] });
function setup() { const events = []; return { events, r: new Recovery(c, x => events.push(x), s => s.net) }; }
test('recovery retains only discontinuous quotes and waits for actual delayed exit', () => {
  const { r, events } = setup(); r.add(sample('a'), 'pool_observation_gap', 11000);
  r.observe({ pool: 'p', slot: 2, price: 1.3, net: 1.2 }, 15000);
  assert.equal(events.at(-1).phase, 'first_quote'); assert.equal(r.active.size, 1);
  r.observe({ pool: 'p', slot: 3, price: .9, net: .85 }, 15500);
  assert.equal(events.at(-1).status, 'discontinuous_proxy'); assert.equal(events.at(-1).reason, 'take_profit');
  assert.ok(Math.abs(events.at(-1).netPnlSol + .15) < 1e-9); assert.equal(r.active.size, 0);
  assert.ok(events.every(e => e.type === 'no_stop_recovery' && e.coverage === 'discontinuous'));
});
test('recovery expires without fabricating a fill and rejects old slots/unquotable ticks', () => {
  const { r, events } = setup(); r.add(sample('a'), 'pool_observation_gap', 11000);
  r.observe({ pool: 'p', slot: 0, price: 2, net: 2 }, 12000);
  r.observe({ pool: 'p', slot: 2, price: 2, net: null }, 13000);
  r.tick(40501); assert.equal(events.at(-1).status, 'unknown'); assert.equal(events.at(-1).netPnlSol, null);
  assert.equal(events.at(-1).firstQuoteAt, null); assert.equal(r.active.size, 0);
});
test('recovery timer exit uses real late quote and bounded capacity/shutdown stays unknown', () => {
  const { r, events } = setup(); r.add(sample('a'), 'pool_observation_gap', 11000); r.add(sample('b'), 'pool_observation_gap', 12000);
  assert.equal(events.at(-1).reason, 'recovery_capacity'); assert.equal(r.active.size, 1);
  r.observe({ pool: 'p', slot: 2, price: .1, net: .05 }, 30500);
  assert.equal(events.at(-1).reason, 'max_hold'); assert.equal(events.at(-1).netPnlSol, -.95);
  r.add(sample('c'), 'pool_observation_gap', 12000); r.close('process_shutdown', 13000);
  assert.equal(events.at(-1).status, 'unknown'); assert.equal(r.byPool.size, 0);
});
