'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, isSignal, exitReason, canClose } = require('../src/engine');
const { readConfig } = require('../src/config');
const { fixture } = require('./fixtures');
const { parseSwaps } = require('../src/parser');
const c = readConfig({ HELIUS_API_KEY: 'test' });
function setup(extra = {}) {
  const store = { data: { positions: {}, cleanup: {}, cooldown: {}, pending: {}, seen: {}, streamDays: {} }, save() {}, log() {} };
  const stream = { connected: true, budgetExceeded: () => false };
  return { store, stream, engine: new Engine({ ...c, paperPrebuyFilter: false, ...extra }, store, {}, stream) };
}
test('configuration rejects unsafe booleans, numbers and non-Helius endpoints', () => {
  for (const env of [{ DRY_RUN: 'tru' }, { MIN_SELL_SOL: 'NaN' }, { HELIUS_SENDER_URL: 'https://other.com' }, { HELIUS_WS_URL: 'wss://helius-rpc.com.attacker.com' }, { SENDER_TIP_LAMPORTS: 0 }, { DRY_RUN: 'false' }]) {
    assert.throws(() => readConfig({ HELIUS_API_KEY: 'test', ...env }));
  }
});
test('expired / future signals and trades below threshold are rejected', () => {
  const s = { ...parseSwaps(fixture())[0], impact: 20 };
  assert.equal(isSignal(s, c), true);
  assert.equal(isSignal({ ...s, receivedAt: Date.now() - 10000 }, c), false);
  assert.equal(isSignal({ ...s, eventTime: Date.now() + 3000 }, c), false);
  assert.equal(isSignal({ ...s, sellSol: 1 }, c), false);
});
test('take profit, stop loss, trailing and hold timeout', () => {
  const p = { entryPrice: 100, high: 120, openedAt: Date.now() };
  assert.equal(exitReason(p, 121, c), 'take_profit');
  assert.equal(exitReason(p, 70, c), 'stop_loss');
  assert.equal(exitReason(p, 115, c), 'trailing');
  assert.equal(exitReason({ ...p, high: 100, openedAt: 0 }, 100, c), 'max_hold');
});
test('paper buy never calls executor and is deduplicated', async () => {
  const { engine, store } = setup(); const s = parseSwaps(fixture())[0];
  await engine.buy(s); await engine.buy(s);
  assert.equal(Object.keys(store.data.positions).length, 1);
  await engine.sell(store.data.positions[s.mint], 'test');
  assert.equal(Object.keys(store.data.positions).length, 0);
  assert.equal(Object.keys(store.data.cleanup).length, 0);
});

test('paper prebuy rejects each risk before spending capacity, cooldown or preparing', async () => {
  for (const check of ['priorBuy', 'priorReturn', 'dumpSize', 'consecutivePressure', 'priorBuyBurst', 'migrationAge']) {
    const { engine, store } = setup({ paperPrebuyFilter: true });
    const s = { ...parseSwaps(fixture())[0], impact: 20, sellSol: check === 'dumpSize' ? 40 : 10 };
    await engine.buy(s, Promise.resolve({ arm: { status: 'reject', rejected: [{ check }] } }));
    assert.equal(Object.keys(store.data.positions).length, 0);
    assert.equal(engine.candidates, 0); assert.equal(store.data.cooldown[s.mint], undefined);
  }
});

test('paper prebuy passes known-safe and explicit unknown history but skips unavailable worker', async () => {
  for (const status of ['pass', 'unknown', null]) {
    const { engine, store } = setup({ paperPrebuyFilter: true });
    const s = { ...parseSwaps(fixture())[0], impact: 20, sellSol: 10 };
    await engine.buy(s, Promise.resolve(status ? { arm: { status, unknown: status === 'unknown' ? [{ check: 'priorBuy' }] : [] } } : null));
    assert.equal(Object.keys(store.data.positions).length, status ? 1 : 0);
  }
});

test('paper prebuy rechecks freshness and portfolio limits after asynchronous result', async () => {
  const { engine, store } = setup({ paperPrebuyFilter: true });
  const s = { ...parseSwaps(fixture())[0], impact: 20, sellSol: 10 };
  let release;
  const pending = engine.buy(s, new Promise(r => { release = r; }));
  engine.busy = true; release({ arm: { status: 'pass' } }); await pending;
  assert.equal(Object.keys(store.data.positions).length, 0);
  engine.busy = false; s.receivedAt = Date.now() - 10000;
  await engine.buy(s, Promise.resolve({ arm: { status: 'pass' } }));
  assert.equal(Object.keys(store.data.positions).length, 0);
});

test('paper rejection still observes the candidate and live execution does not wait for paper filter', async () => {
  const { engine, store } = setup({ paperPrebuyFilter: true }); let observed = 0;
  engine.shadow = { observe: () => { observed++; return Promise.resolve({ arm: { status: 'reject', rejected: [{ check: 'priorBuy' }] } }); } };
  engine.onTransaction(fixture({ virtual: 100000000000n }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, 1); assert.equal(Object.keys(store.data.positions).length, 0);
  const live = setup({ dryRun: false, paperPrebuyFilter: true }).engine;
  let built = false; live.executor = { buildSwap: async () => { built = true; throw new Error('test build'); } };
  const buy = live.buy({ ...parseSwaps(fixture())[0], liquidity: 200 }, new Promise(() => {}));
  assert.equal(built, true); await assert.rejects(buy, /test build/);
});
test('budget limit, stream failure and pending tx prevent entries', async () => {
  for (const kind of ['budget', 'stream', 'pending']) {
    const { engine, stream, store } = setup();
    if (kind === 'budget') stream.budgetExceeded = () => true;
    if (kind === 'stream') stream.connected = false;
    if (kind === 'pending') store.data.pending.x = { mint: 'other' };
    await engine.buy(parseSwaps(fixture())[0]);
    assert.equal(Object.keys(store.data.positions).length, 0);
  }
});
test('only expired, managed, unheld and unpending accounts can close', () => {
  const item = { mint: 'm', createdByBot: true, dueAt: 2000 };
  const data = { positions: {}, pending: {} };
  assert.equal(canClose(item, data, 1999), false); assert.equal(canClose(item, data, 2000), true);
  assert.equal(canClose({ ...item, createdByBot: false }, data, 3000), false);
  assert.equal(canClose(item, { ...data, positions: { m: {} } }, 3000), false);
  assert.equal(canClose(item, { ...data, pending: { x: { mint: 'm' } } }, 3000), false);
});
test('unknown submit is journaled and cannot trigger a rebuilt buy', async () => {
  const { engine, store } = setup({ dryRun: false });
  const s = { ...parseSwaps(fixture())[0], impact: 20, liquidity: 200 };
  let builds = 0;
  engine.executor = {
    async buildSwap() { builds++; return { signature: 'signed', serialized: 'bytes', ata: s.ata }; },
    async submit() { assert.ok(store.data.pending.signed); throw new Error('timeout'); },
  };
  await assert.rejects(engine.buy(s), /timeout/); await engine.buy({ ...s, signature: 'new' });
  assert.equal(builds, 1); assert.ok(store.data.pending.signed);
});
test('confirmed receipt establishes acquired quantity and cleanup delay', () => {
  const { engine, store } = setup({ dryRun: false });
  const buy = fixture({ side: 'buy' }); const swap = parseSwaps(buy)[0];
  const p = { side: 'buy', signature: buy.signature, mint: buy.mint, ata: buy.ata, createdByBot: true, swap, submittedAt: Date.now() };
  store.data.pending[p.signature] = p;
  engine.applyReceipt(p, { ...buy.transaction, slot: buy.slot });
  assert.equal(store.data.positions[buy.mint].rawAmount, '250000000');
  assert.equal(store.data.pending[p.signature], undefined);
  const sell = fixture(); const sellPending = { ...p, side: 'sell' };
  engine.applyReceipt(sellPending, { ...sell.transaction, slot: sell.slot });
  assert.equal(store.data.positions[buy.mint], undefined);
  assert.ok(Math.abs(store.data.cleanup[buy.mint].dueAt - Date.now() - 7200000) < 100);
});
test('reentry cancels old cleanup only after confirmed buy', () => {
  const { engine, store } = setup({ dryRun: false });
  const buy = fixture({ side: 'buy' });
  store.data.cleanup[buy.mint] = { dueAt: 1 };
  engine.applyReceipt({ side: 'buy', signature: buy.signature, mint: buy.mint, ata: buy.ata, swap: parseSwaps(buy)[0], submittedAt: Date.now() }, { ...buy.transaction, slot: buy.slot });
  assert.equal(store.data.cleanup[buy.mint], undefined);
});
test('sell/close RPC acknowledgement alone does not remove a position or refund record', async () => {
  const { engine, store } = setup({ dryRun: false });
  const s = parseSwaps(fixture())[0]; const position = { ...s, rawAmount: '1' };
  store.data.positions[s.mint] = position;
  engine.executor = { async buildSwap() { return { signature: 's', serialized: 'bytes' }; }, async submit() {} };
  await engine.sell(position, 'test');
  assert.ok(store.data.positions[s.mint]); assert.ok(store.data.pending.s);
});
test('old unlanded tx is released only after finalized expiry and missing receipt', async () => {
  const { engine, store } = setup({ dryRun: false });
  store.data.pending.sig = { signature: 'sig', side: 'buy', mint: 'm', submittedAt: 0, lastValidBlockHeight: 100 };
  let receiptCalls = 0;
  engine.executor = { rpc: { async getSignatureStatuses() { return { value: [null] }; }, async getBlockHeight() { return 120; } },
    async receipt() { receiptCalls++; return null; } };
  await engine.reconcile(); assert.ok(store.data.pending.sig); assert.equal(receiptCalls, 0);
  engine.executor.rpc.getBlockHeight = async () => 200;
  await engine.reconcile(); assert.equal(store.data.pending.sig, undefined); assert.equal(receiptCalls, 1);
});
test('cleanup shares wallet lock with new buys', async () => {
  const { engine, store } = setup({ dryRun: false });
  const s = parseSwaps(fixture())[0];
  store.data.cleanup[s.mint] = { mint: s.mint, createdByBot: true, dueAt: 0 };
  let finish;
  engine.executor = { closeTransaction() { return new Promise(resolve => { finish = resolve; }); } };
  const cleanup = engine.cleanup();
  assert.equal(engine.busy, true);
  await engine.buy(s); assert.deepEqual(store.data.positions, {});
  finish(null); await cleanup;
  assert.equal(engine.busy, false);
});
test('processed failure stays pending until confirmed, avoiding rollback retries', async () => {
  const { engine, store } = setup({ dryRun: false });
  store.data.pending.sig = { signature: 'sig', side: 'buy', mint: 'm', submittedAt: Date.now() };
  let confirmationStatus = 'processed';
  engine.executor = { rpc: { async getSignatureStatuses() { return { value: [{ err: 'failed', confirmationStatus }] }; } } };
  await engine.reconcile(); assert.ok(store.data.pending.sig);
  confirmationStatus = 'confirmed'; await engine.reconcile(); assert.equal(store.data.pending.sig, undefined);
});

test('sell diagnostics preserve the first trigger across wallet contention and emit paper comparison key', async () => {
  const { engine, store } = setup(); const logs=[],events=[];
  store.log=(type,r)=>logs.push({type,...r}); engine.shadow={decision:(...args)=>events.push(args)};
  const s=parseSwaps(fixture())[0]; await engine.buy(s); const p=store.data.positions[s.mint];
  engine.busy=true; await engine.sell(p,'stop_loss'); const first=p.exitDiagnostic.firstTriggerAt;
  engine.busy=false; await engine.sell(p,'stop_loss');
  const sold=logs.find(r=>r.type==='paper_sell');
  assert.equal(sold.diagnostic.firstTriggerAt,first); assert.equal(sold.diagnostic.blockedAttempts,1);
  assert.equal(sold.accountingVersion,'paper_spot_v1'); assert.ok(events.some(x=>x[1]==='paper_sell'&&x[2].positionId===s.signature));
});
