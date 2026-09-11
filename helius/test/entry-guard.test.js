'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EntryGuard, historyUnavailable } = require('../src/entry-guard');
const { Engine } = require('../src/engine');
const { readConfig } = require('../src/config');
const { parseSwaps } = require('../src/parser');
const { fixture } = require('./fixtures');
function setup() {
  const c = readConfig({ HELIUS_API_KEY: 'test', DRY_RUN: 'false', LIVE_CALIBRATION: 'true', WALLET_PRIVATE_KEY_BS58: 'unused' });
  const s = { data: { wallet: 'test', positions: {}, pending: {}, cleanup: {}, seen: {}, cooldown: {} }, logs: [], save() {}, log(type, r) { this.logs.push({ type, ...r }); } };
  let sent = 0, built = 0;
  const ex = { async buildSwap(_, swap) { built++; return { signature: 'buy', serialized: 'unused', quoteStatePrice: swap.price }; }, async submit() { sent++; } };
  const e = new Engine(c, s, ex, { connected: true, budgetExceeded: () => false });
  const swap = { ...parseSwaps(fixture())[0], sellSol: 10, impact: 20, liquidity: 200 };
  return { e, s, ex, swap, counts: () => ({ sent, built }) };
}
test('live requires known trade history but permits AGE-only unknown', () => {
  for (const check of ['priorBuy', 'priorReturn', 'consecutivePressure', 'priorBuyBurst']) assert.equal(historyUnavailable({ status: 'unknown', unknown: [{ check }] }), true);
  assert.equal(historyUnavailable({ status: 'unknown', unknown: [{ check: 'migrationAge' }] }), false);
  assert.equal(historyUnavailable({ status: 'unknown' }), true);
});
test('cold start history rejection happens before build, reserve and submit', async () => {
  const h = setup(); await h.e.buy(h.swap, Promise.resolve({ arm: { status: 'unknown', unknown: [{ check: 'priorReturn' }] } }));
  assert.deepEqual(h.counts(), { sent: 0, built: 0 }); assert.equal(h.e.calibration.s.attempts, 0);
  assert.equal(h.s.logs[0].reason, 'prebuy_history_required'); assert.equal(h.e.entryGuards.size, 0);
});
test('20 percent continuation boundary latches even after recovery and ignores other pools/older slots', () => {
  const s = { pool: 'p', mint: 'm', slot: 10, receivedAt: 100, price: 100 }, g = new EntryGuard(s);
  g.observe({ ...s, pool: 'other', price: 1 }); g.observe({ ...s, slot: 9, price: 1 }); assert.equal(g.rejected, null);
  assert.equal(g.check(80.01, 'rpc', 10), null); assert.equal(g.check(80, 'rpc', 10).reason, 'pre_send_further_drop_20pct');
  assert.ok(Math.abs(g.check(120, 'rpc', 11).dropPct - 20) < 1e-8);
});
test('fall received while awaiting construction cancels despite a recovered RPC quote', async () => {
  const h = setup(); let release; h.ex.buildSwap = async () => new Promise(r => { release = r; });
  const pending = h.e.buy(h.swap, Promise.resolve({ arm: { status: 'pass' } }));
  await new Promise(r => setImmediate(r));
  for (const g of h.e.entryGuards.values()) g.observe({ ...h.swap, slot: h.swap.slot + 1, price: h.swap.price * .37 });
  release({ signature: 'buy', serialized: 'unused', quoteStatePrice: h.swap.price }); await pending;
  assert.equal(h.counts().sent, 0); assert.equal(h.e.calibration.s.attempts, 0); assert.deepEqual(h.s.data.pending, {});
  assert.equal(h.s.logs.at(-1).reason, 'pre_send_further_drop_20pct'); assert.equal(h.e.entryGuards.size, 0);
});
test('RPC continuation loss or missing quote cancels without any extra request', async () => {
  for (const multiplier of [.8, null]) {
    const h = setup(); h.ex.buildSwap = async () => ({ signature: 'buy', quoteStatePrice: multiplier === null ? undefined : h.swap.price * multiplier });
    await h.e.buy(h.swap, Promise.resolve({ arm: { status: 'pass' } })); assert.equal(h.counts().sent, 0); assert.equal(h.e.calibration.s.attempts, 0);
  }
});
test('AGE-only unknown with stable price still submits and counts one attempt', async () => {
  const h = setup(); await h.e.buy(h.swap, Promise.resolve({ arm: { status: 'unknown', unknown: [{ check: 'migrationAge' }] } }));
  assert.equal(h.counts().sent, 1); assert.equal(h.e.calibration.s.attempts, 1);
});
test('paper mode retains unknown-history behavior', async () => {
  const h = setup(); h.e.c = { ...h.e.c, dryRun: true, calibration: { enabled: false }, paperPrebuyFilter: true };
  await h.e.buy(h.swap, Promise.resolve({ arm: { status: 'unknown', unknown: [{ check: 'priorReturn' }] } }));
  assert.ok(h.s.data.positions[h.swap.mint]); assert.equal(h.counts().sent, 0);
});
test('parsed stream events cancel an active buy before submission', async () => {
  const h = setup(); h.swap.price *= 3;
  let release; h.ex.buildSwap = async () => new Promise(r => { release = r; });
  const work = h.e.buy(h.swap, Promise.resolve({ arm: { status: 'pass' } }));
  await new Promise(r => setImmediate(r));
  h.e.onTransaction(fixture());
  release({ signature: 'buy', quoteStatePrice: h.swap.price }); await work;
  assert.equal(h.counts().sent, 0); assert.ok(h.s.logs.some(r => r.type === 'live_entry_cancelled' && r.source === 'stream'));
});
