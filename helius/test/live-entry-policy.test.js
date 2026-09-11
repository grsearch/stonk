'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reason, recordLoss } = require('../src/live-entry-policy');
const { readConfig } = require('../src/config');
const { Engine } = require('../src/engine');
const { fixture } = require('./fixtures');
const { parseSwaps } = require('../src/parser');
function setup() {
  const c = readConfig({ HELIUS_API_KEY: 'test', DRY_RUN: 'false', LIVE_CALIBRATION: 'true', WALLET_PRIVATE_KEY_BS58: 'unused' });
  const store = { data: { wallet: 'w', positions: {}, cleanup: {}, pending: {}, seen: {}, cooldown: {} }, logs: [], save() {}, log(type, r) { this.logs.push({ type, ...r }); } };
  let builds = 0;
  const executor = { async buildSwap(_, s) { builds++; return { signature: 'buy', quoteStatePrice: s.price }; }, async submit() {} };
  const engine = new Engine(c, store, executor, { connected: true, budgetExceeded: () => false });
  const swap = { ...parseSwaps(fixture())[0], liquidity: 200, impact: 20, sellSol: 10 };
  return { c, store, executor, engine, swap, builds: () => builds, filter: () => Promise.resolve({ arm: { status: 'pass' } }) };
}
test('live reserve floor is inclusive at 100, rejects missing, and preserves paper research', async () => {
  for (const liquidity of [99, 100, undefined, NaN]) {
    const h = setup(); await h.engine.buy({ ...h.swap, liquidity }, h.filter());
    assert.equal(h.builds(), 0); assert.equal(h.engine.calibration.s.attempts, 0);
    assert.match(h.store.logs[0].reason, /live_reserve/);
  }
  const h = setup(); await h.engine.buy({ ...h.swap, liquidity: 100.000000001 }, h.filter()); assert.equal(h.builds(), 1);
  assert.equal(reason({ ...h.c, dryRun: true }, {}, { liquidity: 1 }), null);
});
test('only confirmed net losses arm a per-mint cooldown, with exact expiry and no extension on replay', () => {
  const { c } = setup(), data = {};
  for (const r of [{ status: 'failed', netPnlSol: -.01 }, { status: 'confirmed', netPnlSol: 0 }, { status: 'confirmed', netPnlSol: null }])
    recordLoss(c, data, { side: 'sell', mint: 'm', receiptObservedAt: 1000, ...r });
  assert.equal(data.lossCooldowns, undefined);
  const loss = { side: 'sell', status: 'confirmed', mint: 'm', receiptObservedAt: 1000, netPnlSol: -.00001 };
  recordLoss(c, data, loss); recordLoss(c, data, loss);
  assert.equal(reason(c, data, { mint: 'm', liquidity: 200 }, 600999), 'live_loss_cooldown');
  assert.equal(reason(c, data, { mint: 'm', liquidity: 200 }, 601000), null);
  assert.equal(reason(c, data, { mint: 'other', liquidity: 200 }, 1001), null);
});
test('restart restores unexpired cooldown from prior calibration receipts', () => {
  const h = setup(), observed = Date.now() - 1000;
  h.store.data.calibration.transactions.s = { mint: 'm', side: 'sell', status: 'confirmed', receiptObservedAt: observed, netPnlSol: -.01 };
  const restored = JSON.parse(JSON.stringify(h.store.data));
  const e = new Engine(h.c, { ...h.store, data: restored }, h.executor, h.engine.stream);
  assert.equal(e.data.lossCooldowns.m, observed + 600000);
});
test('short contention wait can resume, rechecks cooldown, and never duplicates pending signatures', async () => {
  const h = setup(); h.engine.busy = true;
  setTimeout(() => { h.engine.busy = false; }, 30);
  await h.engine.buy(h.swap, h.filter()); assert.equal(h.builds(), 1);
  await h.engine.buy({ ...h.swap, signature: 'another' }, h.filter()); assert.equal(h.builds(), 1);
  const k = setup(); k.engine.busy = true;
  setTimeout(() => { k.store.data.lossCooldowns = { [k.swap.mint]: Date.now() + 600000 }; k.engine.busy = false; }, 30);
  await k.engine.buy(k.swap, k.filter()); assert.equal(k.builds(), 0);
});
test('waiting candidate cancels after reserve deterioration or signal expiry and leaves no waiter', async () => {
  for (const mode of ['reserve', 'expired']) {
    const h = setup(); h.engine.busy = true;
    setTimeout(() => {
      if (mode === 'reserve') for (const g of h.engine.entryGuards.values()) g.observe({ ...h.swap, liquidity: 100 });
      else h.swap.receivedAt -= 10000;
      h.engine.busy = false;
    }, 30);
    await h.engine.buy(h.swap, h.filter()); assert.equal(h.builds(), 0); assert.equal(h.engine.entryWaiters.size, 0);
  }
});
test('due exits take priority over fresh buys', async () => {
  const h = setup(); h.store.data.positions.other = { entryPrice: 100, lastPrice: 70, high: 100, openedAt: Date.now() };
  await h.engine.buy(h.swap, h.filter()); assert.equal(h.builds(), 0);
});
test('executor rechecks the real reserve without applying the buy floor to sells', async () => {
  const { executor, state, accountInfo } = require('./executor-fixtures'), BN = require('bn.js');
  const e = executor(), s = state(e); e.state = async () => s;
  s.poolQuoteAmount = new BN('100000000000');
  await assert.rejects(e.buildSwap('buy', { mint: s.baseMint.toBase58() }), /exceed 100/);
  s.userBaseAccountInfo = accountInfo(s.baseMint, e.wallet.publicKey, 1000000n);
  assert.ok((await e.buildSwap('sell', { mint: s.baseMint.toBase58() }, '1000000')).signature);
});

test('confirmed losing sell persists cooldown before a later candidate can enter', async () => {
  const h = setup(); h.engine.c.calibration = { enabled: false }; h.engine.calibration.s = null;
  const f = fixture(), swap = parseSwaps(f)[0];
  h.store.data.positions[f.mint] = { ...swap, rawAmount: '250000000', entrySol: 30, openedAt: Date.now(), buySignature: 'original' };
  h.engine.applyReceipt({ side: 'sell', signature: f.signature, mint: f.mint, ata: f.ata, swap, submittedAt: Date.now() },
    { ...f.transaction, slot: f.slot });
  assert.ok(h.store.data.lossCooldowns[f.mint] > Date.now() + 599000);
  await h.engine.buy({ ...swap, liquidity: 200 }); assert.equal(h.builds(), 0);
  assert.equal(h.store.logs.at(-1).reason, 'live_loss_cooldown');
});
