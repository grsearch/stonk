'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planExitRetry } = require('../src/exit-retry');
const { Engine } = require('../src/engine');
function setup() {
  const logs = [], data = { positions: {}, pending: {}, cleanup: {} };
  const p = data.positions.m = { mint: 'm', pool: 'pool', rawAmount: '1', lastPrice: 70, entryPrice: 100,
    high: 100, openedAt: Date.now(), lastPriceAt: Date.now() };
  const store = { data, save() {}, log: (type, r) => logs.push({ type, ...r }) };
  const executor = { buildSwap: async () => ({ signature: 'sell1' }), submit: async () => {} };
  const e = new Engine({ dryRun: false, calibration: { enabled: false }, stopLoss: 25, takeProfit: 20,
    trailArm: 10, trailDrop: 3, maxHoldMs: 1800000, positionPollMs: 15000, cleanupIntervalMs: 60000 }, store, executor, {});
  return { e, p, data, executor, logs };
}
test('short exit retries are bounded per position and globally, and survive ledger serialization', () => {
  const d = {}, p = {};
  assert.deepEqual([0, 1, 2, 3].map(i => planExitRetry(p, d, 'account_slot', 1000 + i).delayMs), [250, 500, 1000, 10000]);
  const restored = JSON.parse(JSON.stringify({ d, p }));
  assert.equal(planExitRetry(restored.p, restored.d, 'confirmed_slippage', 1100).fast, false);
  for (let i = 0; i < 3; i++) assert.equal(planExitRetry({}, d, 'account_slot', 1200).fast, true);
  assert.equal(planExitRetry({}, d, 'account_slot', 1200).fast, false);
  assert.equal(planExitRetry(p, d, 'account_slot', 61004).delayMs, 250);
  assert.equal(planExitRetry(p, d, 'preparation_error', 61005).delayMs, 10000);
});
test('unbroadcast slot failure retries with fresh build after eligibility, not before', async t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const { e, p, executor, data } = setup(); let calls = 0;
  executor.buildSwap = async () => { if (++calls === 1) throw Object.assign(new Error('slot'), { code: -32016 }); return { signature: 'new' }; };
  await assert.rejects(e.sell(p, 'stop_loss'));
  assert.equal(p.retryAfter, 10250); assert.equal(p.exitRetryReason, 'stop_loss');
  await e.sell(p, 'stop_loss'); assert.equal(calls, 1);
  now = 10250; await e.sell(p, 'stop_loss');
  assert.equal(calls, 2); assert.ok(data.pending.new);
});
test('uncertain sender submission stays pending and never rebuilds', async () => {
  const { e, p, executor, data, logs } = setup(); let calls = 0;
  executor.buildSwap = async () => { calls++; return { signature: 'unknown' }; };
  executor.submit = async () => { throw new Error('network timeout'); };
  await assert.rejects(e.sell(p, 'stop_loss'));
  assert.ok(data.pending.unknown); assert.equal(logs.length, 0);
  await e.sell(p, 'stop_loss'); assert.equal(calls, 1);
});
test('confirmed slippage releases pending and schedules short retry; other failures back off', () => {
  const { e, p, data, logs } = setup();
  const pending = { signature: 'bad', side: 'sell', mint: 'm', reason: 'stop_loss' };
  data.pending.bad = pending;
  e.failPending(pending, 'chain_error', { InstructionError: [3, { Custom: 6004 }] });
  assert.equal(data.pending.bad, undefined); assert.equal(logs[0].delayMs, 250);
  assert.equal(p.exitRetryReason, 'stop_loss');
  e.failPending(pending, 'chain_error', { InstructionError: [3, { Custom: 6001 }] });
  assert.equal(logs.filter(r => r.type === 'exit_retry_scheduled').at(-1).delayMs, 10000);
});
test('timer resumes failed exit intent even after quotes become stale or rebound', async t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const { e, p, executor, data } = setup(); let calls = 0;
  e.scheduleExitRetry(p, 'stop_loss', 'account_slot');
  p.lastPrice = 100; now = 11000;
  executor.buildSwap = async () => { calls++; return { signature: 'retry' }; };
  e.lastPoll = now; e.lastCleanup = now;
  await e.tick(); assert.equal(calls, 1); assert.equal(data.pending.retry.reason, 'stop_loss');
});
