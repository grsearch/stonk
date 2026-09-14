'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { readConfig } = require('../src/config');
const { fixture } = require('./fixtures');
const { parseSwaps } = require('../src/parser');
function setup(extra = {}) {
  const c = { ...readConfig({ HELIUS_API_KEY: 'test' }), dryRun: false, ...extra };
  const logs = [], store = { data: { positions: {}, pending: {}, cleanup: {}, seen: {}, cooldown: {}, streamDays: {} }, save() {}, log(type, r) { logs.push({ type, ...r }); } };
  const e = new Engine(c, store, {}, { connected: false });
  const p = { mint: 'm', pool: 'p', entryPrice: 1, high: 1, lastPrice: 1, lastPriceAt: Date.now(), openedAt: Date.now(), lastStreamQuoteAt: 1000, rawAmount: '1' };
  store.data.positions.m = p;
  return { e, p, store, logs };
}
test('10 second boundary uses stream time, ignores fresh RPC price and persists through restart', () => {
  const { e, p, store, logs } = setup();
  e.latchQuoteTimeout(p, 10999); assert.equal(p.exitRetryReason, undefined);
  e.latchQuoteTimeout(p, 11000); assert.equal(p.exitRetryReason, 'quote_timeout');
  assert.equal(logs[0].gapMs, 10000);
  p.lastStreamQuoteAt = 12000;
  const restored = new Engine(e.c, store, {}, {});
  restored.latchQuoteTimeout(p, 12001); assert.equal(p.exitRetryReason, 'quote_timeout'); assert.equal(logs.length, 1);
});
test('legacy holdings do not reset timeout on restart; dry run does not sell on stale spot', () => {
  const { e, p } = setup(); delete p.lastStreamQuoteAt; p.openedAt = 1000;
  e.latchQuoteTimeout(p, 11000); assert.equal(p.exitRetryReason, 'quote_timeout');
  const paper = setup({ dryRun: true }); paper.e.latchQuoteTimeout(paper.p, 11000);
  assert.equal(paper.p.exitRetryReason, undefined);
});
test('returning stream quote cannot cancel an already elapsed gap', () => {
  const { e, p, store } = setup(); const tx = fixture(), s = parseSwaps(tx)[0];
  delete store.data.positions.m;
  Object.assign(p, { mint: s.mint, pool: s.pool, entryPrice: s.price, lastPrice: s.price, high: s.price });
  store.data.positions[p.mint] = p; let reason;
  e.sell = async (_, r) => { reason = r; }; e.buy = async () => {};
  e.onTransaction(tx); assert.equal(reason, 'quote_timeout'); assert.ok(p.lastStreamQuoteAt > 1000);
});
test('timeout intent survives wallet contention and submits with explicit reason after recovery', async () => {
  const { e, p, store, logs } = setup(); e.busy = true; e.latchQuoteTimeout(p, 11000);
  await e.sell(p, 'take_profit'); assert.equal(store.data.pending.sig, undefined);
  p.lastStreamQuoteAt = Date.now(); e.busy = false;
  e.executor = { buildSwap: async () => ({ signature: 'sig' }), submit: async () => {} };
  await e.sell(p, 'take_profit'); assert.equal(store.data.pending.sig.reason, 'quote_timeout');
  assert.equal(logs.find(r => r.type === 'sell_submitted').reason, 'quote_timeout');
});
test('timeout preparation errors retain intent and use normal exit retry scheduling', async () => {
  const { e, p } = setup(); e.latchQuoteTimeout(p, 11000);
  e.executor = { buildSwap: async () => { throw new Error('RPC unavailable'); } };
  await assert.rejects(e.sell(p, 'quote_timeout'));
  assert.equal(p.exitRetryReason, 'quote_timeout'); assert.ok(p.retryAfter > Date.now());
});
test('live fixed loss no longer overrides timeout; latched exits retain priority', () => {
  const { e, p } = setup(); p.lastPrice = .7; e.latchQuoteTimeout(p, Date.now());
  assert.equal(p.exitRetryReason, 'quote_timeout');
  p.exitRetryReason = 'trailing'; e.latchQuoteTimeout(p, Date.now()); assert.equal(p.exitRetryReason, 'trailing');
});
test('tick latches every timeout before pending transaction RPC blocks', async () => {
  const { e, p, store } = setup(); store.data.positions.other = { ...p, mint: 'other' };
  e.reconcile = async () => { assert.equal(p.exitRetryReason, 'quote_timeout'); assert.equal(store.data.positions.other.exitRetryReason, 'quote_timeout'); throw new Error('pending RPC failed'); };
  await e.tick(); assert.equal(e.ticking, false);
});
