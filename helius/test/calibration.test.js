'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { readConfig } = require('../src/config'), Calibration = require('../src/calibration');
const { Engine } = require('../src/engine'), { parseSwaps } = require('../src/parser');
const { fixture } = require('./fixtures');
const env = { HELIUS_API_KEY: 'test', DRY_RUN: 'false', LIVE_CALIBRATION: 'true', WALLET_PRIVATE_KEY_BS58: 'not-used-in-tests' };
const config = extra => readConfig({ ...env, ...extra });
test('calibration includes SDK slippage allowance inside the quote payment cap', () => {
  const { buyQuoteLamports } = require('../src/executor');
  const BN = require('bn.js');
  for (const bps of [1, 100, 1000, 3000]) {
    const c = config({ BUY_SLIPPAGE_BPS: String(bps) });
    const quote = buyQuoteLamports(c);
    const factor = new BN(Math.floor((1 + (bps / 100) / 100) * 1e9));
    assert.ok(quote.mul(factor).div(new BN(1e9)).lte(new BN(50000000)));
    assert.ok(quote.gt(new BN(0)));
  }
  assert.equal(buyQuoteLamports({ sizeSol: 1, buySlippageBps: 1000 }).toString(), '1000000000');
});
function store() { return { data: { wallet: 'wallet', positions: {}, pending: {}, cleanup: {}, seen: {}, cooldown: {}, streamDays: {} }, logs: [], save() { this.saved = JSON.stringify(this.data); }, log(type, r) { this.logs.push({ type, ...r }); } }; }
function receipt(cal, side, signature, cashLamports, rentLamports = 0, error = null) {
  cal.receipt({ side, signature, mint: 'mint', ata: 'ata', senderTipSol: side === 'close' ? 0 : .0002,
    swap: { signature: 'signal', pool: 'pool' }, submittedAt: 100 },
  { slot: 1, blockTime: 1, meta: { err: error, fee: 5000, preBalances: [1e9, 1e7], postBalances: [1e9 + cashLamports, 1e7 + rentLamports] } },
  { keys: ['wallet', 'ata'] });
}
test('calibration is explicit, bounded, isolated, and ignores legacy one SOL/20 position settings', () => {
  const normal = readConfig({ HELIUS_API_KEY: 'test' }); assert.equal(normal.dryRun, true); assert.equal(normal.calibration.enabled, false);
  const c = config({ POSITION_SIZE_SOL: '1', MAX_CONCURRENT_POSITIONS: '20' });
  assert.equal(c.sizeSol, .05); assert.equal(c.maxPositions, 20); assert.match(c.stateFile, /calibration.json$/);
  for (const extra of [{ DRY_RUN: 'true' }, { SHADOW_ENABLED: 'false' }, { CALIBRATION_SIZE_SOL: '.1' }]) assert.throws(() => config(extra));
  assert.equal(config({ CALIBRATION_MAX_BUYS: '20', CALIBRATION_LOSS_LIMIT_SOL: '.1' }).calibration.maxBuys, null);
});
test('calibration position cap is independent and changing it preserves the active batch budget', () => {
  for (const v of ['0', '21', '1.5', 'bad']) assert.throws(() => config({ CALIBRATION_MAX_POSITIONS: v }));
  const one = config({ CALIBRATION_MAX_POSITIONS: '1', MAX_CONCURRENT_POSITIONS: '20' });
  assert.equal(one.maxPositions, 1);
  const s = store(), a = new Calibration(one, s); a.reserve({});
  s.data.calibration.lossSol = .03;
  s.data.positions.mint = { rawAmount: '123' }; s.save();
  const restored = { ...s, data: JSON.parse(s.saved) };
  const b = new Calibration(config({ CALIBRATION_MAX_POSITIONS: '20' }), restored);
  assert.equal(b.s.batchId, a.s.batchId); assert.equal(b.s.attempts, 1); assert.equal(b.s.lossSol, .03);
  assert.equal(restored.data.positions.mint.rawAmount, '123');
  assert.equal(b.s.limits.maxBuys, null); assert.equal(b.s.limits.lossLimitSol, null);
});
test('buy reservations survive restart and continue beyond twenty attempts', () => {
  const s = store(), c = config({ CALIBRATION_MAX_BUYS: '2' }); const a = new Calibration(c, s);
  a.reserve({}); s.save(); a.reserve({}); s.save();
  const restored = { ...s, data: JSON.parse(s.saved) }, b = new Calibration(c, restored);
  for (let i = 0; i < 30; i++) b.reserve({});
  assert.equal(b.reason(), null); assert.equal(b.s.attempts, 32);
  assert.throws(() => new Calibration({ calibration: { enabled: false } }, restored));
});
test('receipt accounting separates ATA deposits/refunds, charges failed fees, and deduplicates', () => {
  const s = store(), a = new Calibration(config(), s);
  receipt(a, 'buy', 'buy', -52300000, 2000000); // economic -0.0503
  receipt(a, 'sell', 'sell', 40300000); // trade -0.01
  assert.ok(Math.abs(s.data.calibration.lossSol - .01) < 1e-12);
  receipt(a, 'sell', 'sell', 40300000); assert.equal(s.logs.length, 2);
  receipt(a, 'close', 'close', 1995000, -2000000);
  receipt(a, 'buy', 'failed', -5000, 0, { instructionError: 1 });
  assert.ok(Math.abs(s.data.calibration.lossSol - .01001) < 1e-12);
  assert.equal(s.data.calibration.rentDeltaSol, 0);
  assert.equal(s.logs.at(-1).senderTipSol, 0);
});
test('cumulative loss remains recorded but does not stop new entries', () => {
  const s = store(), c = config({ CALIBRATION_LOSS_LIMIT_SOL: '.01' }), a = new Calibration(c, s);
  receipt(a, 'buy', 'b', -500000000); receipt(a, 'sell', 's', 30000000); s.save();
  assert.equal(a.reason(), null);
  const b = new Calibration(c, { ...s, data: JSON.parse(s.saved) }); assert.equal(b.reason(), null); b.reserve({});
  receipt(a, 'buy', 'b2', -50000000); receipt(a, 'sell', 's2', 100000000);
  assert.equal(a.reason(), null); assert.ok(s.data.calibration.lossSol >= .47);
});
test('legacy ledger migration removes only retired stops and preserves existing evidence', () => {
  for (const reason of ['calibration_buy_limit', 'calibration_loss_limit', 'calibration_accounting_unavailable', 'calibration_buy_accounting_missing']) {
    const s = store(); new Calibration(config(), s);
    Object.assign(s.data.calibration, { version: 1, limits: { sizeSol: .05, maxBuys: 20, lossLimitSol: .1 }, attempts: 25, lossSol: .3, stoppedReason: reason });
    const id = s.data.calibration.batchId; s.data.positions.m = { rawAmount: '10' }; s.data.pending.tx = { signature: 'tx' };
    s.data.calibration.transactions.old = { signature: 'old' };
    const a = new Calibration(config(), s);
    assert.equal(a.s.version, 2); assert.equal(a.s.batchId, id); assert.equal(a.s.attempts, 25); assert.equal(a.s.lossSol, .3);
    assert.ok(a.s.transactions.old); assert.ok(s.data.positions.m); assert.ok(s.data.pending.tx);
    assert.equal(a.reason(), reason.includes('accounting') ? reason : null);
    const restored = new Calibration(config(), { ...s, data: JSON.parse(s.saved) }); assert.equal(restored.reason(), a.reason());
  }
});
test('missing balance evidence stops entries instead of manufacturing zero cost', () => {
  const s = store(), a = new Calibration(config(), s);
  a.receipt({ side: 'buy', mint: 'mint', signature: 'x', ata: 'missing' }, { meta: { fee: 5000, preBalances: [1e9], postBalances: [9e8] } }, { keys: ['wallet'] });
  assert.equal(a.reason(), 'calibration_accounting_unavailable');
  assert.equal(s.logs[0].economicDeltaSol, null);
});
test('live calibration requires filter response and rejects six risk checks before building', async () => {
  for (const check of ['priorBuy', 'priorReturn', 'dumpSize', 'consecutivePressure', 'priorBuyBurst', 'migrationAge', null]) {
    const s = store(), c = config(); let built = 0;
    const e = new Engine(c, s, { buildSwap() { built++; } }, { connected: true, budgetExceeded: () => false });
    const swap = { ...parseSwaps(fixture())[0], impact: 20, sellSol: 10 };
    await e.buy(swap, check ? Promise.resolve({ arm: { status: 'reject', rejected: [{ check }] } }) : undefined);
    assert.equal(built, 0); assert.equal(e.candidates, 0); assert.equal(e.calibration.s.attempts, 0);
  }
});
test('accounting entry stop still allows sells, and signed uncertain buys count once', async () => {
  const s = store(), c = config(), stream = { connected: true, budgetExceeded: () => false };
  const ex = { async buildSwap(side, swap) { return { signature: 'signed', serialized: 'bytes', ata: 'ata', quoteStatePrice: swap.price }; }, async submit() { throw new Error('uncertain'); } };
  const e = new Engine(c, s, ex, stream), swap = { ...parseSwaps(fixture())[0], impact: 20, sellSol: 10, liquidity: 200 };
  await assert.rejects(e.buy(swap, Promise.resolve({ arm: { status: 'pass' } })), /uncertain/);
  assert.equal(JSON.parse(s.saved).calibration.attempts, 1); assert.ok(JSON.parse(s.saved).pending.signed);
  await e.buy(swap, Promise.resolve({ arm: { status: 'pass' } })); assert.equal(e.calibration.s.attempts, 1);
  delete s.data.pending.signed; e.calibration.s.stoppedReason = 'calibration_accounting_unavailable';
  let sold = false; ex.submit = async () => { sold = true; };
  await e.sell({ ...swap, rawAmount: '1', lastPrice: 1 }, 'stop_loss'); assert.equal(sold, true);
});
test('calibration audit pairs exact source signal and role, leaving missing outcomes unknown', () => {
  const { calibrationAudit } = require('../src/reporting/calibration-audit');
  const r = { time: new Date(1000).toISOString(), side: 'sell', status: 'confirmed', sourceSignature: 'signal', pool: 'p', netPnlSol: -.01 };
  const c = { status: 'observed_proxy', netPnlSol: -.02, executionPolicy: { sizeSol: .05 } };
  const report = calibrationAudit(new Map([['x', r]]), new Map([['same_size:signal:p', c]]), 0, 2000);
  assert.equal(report.paired, 1); assert.equal(report.rows[0].reference1Sol, null); assert.equal(report.rows[0].differenceSol, .01);
  assert.equal(calibrationAudit(new Map([['x', r]]), new Map(), 0, 2000).unknown, 1);
});
test('calibration worker records same-size and one-SOL reference separately without reference RPC recovery', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Worker } = require('node:worker_threads');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-worker-'));
  const c = config();
  const worker = new Worker(path.join(__dirname, '../src/shadow/worker.js'), { workerData: { ...c.shadow, directory,
    calibration: c.calibration, sizeSol: .05, takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3,
    maxHoldMs: 1800000, minSellSol: 8, minImpact: 10, maxImpact: 30, minLiquidity: 30,
    maxSourceLagMs: 3500, networkFeeSol: .000305 } });
  t.after(async () => { await worker.terminate(); fs.rmSync(directory, { recursive: true, force: true }); });
  const waitFor = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
    const fn = msg => { if (msg.type === type) { clearTimeout(timer); worker.off('message', fn); resolve(msg); } };
    worker.on('message', fn); worker.once('error', reject);
  });
  await waitFor('status');
  const swap = { ...parseSwaps(fixture())[0], impact: 20 }, ack = waitFor('ack');
  worker.postMessage({ type: 'batch', events: [{ type: 'connection', connected: true, at: swap.receivedAt }, { type: 'swap', swap, candidate: true, fresh: true }] });
  await ack;
  const exit = new Promise(resolve => worker.once('exit', resolve));
  worker.postMessage({ type: 'close', at: Date.now() }); await exit;
  const file = fs.readdirSync(directory).find(f => f.startsWith('samples-'));
  const rows = fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').map(JSON.parse);
  const sessions = rows.filter(r => r.type === 'session'); assert.equal(sessions.length, 2);
  assert.equal(sessions.find(r => r.calibrationRole === 'same_size').policy.sizeSol, .05);
  const ref = sessions.find(r => r.calibrationRole === 'reference_1_sol'); assert.equal(ref.policy.sizeSol, 1); assert.equal(ref.stateQuoteVersion, null);
  const samples = rows.filter(r => r.type === 'sample'); assert.equal(samples.length, 2);
  assert.equal(samples[0].key, samples[1].key); assert.notEqual(samples[0].id, samples[1].id);
});
