'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig } = require('../src/stonk/config');
const { readConfig: originalConfig } = require('../src/config');
const { Runtime, PaperExecutor } = require('../src/stonk/runtime');
const { assumptions, policyId, Tracker, buyQuote, liquidationDetails } = require('../src/shadow/tracker');
const { Adapter } = require('../src/stonk/adapter');
const { Valuation } = require('../src/stonk/valuation');
const { afterTransfer } = require('../src/stonk/proxy-quotes');
const { Age } = require('../src/shadow/age');
const { StateQuotes } = require('../src/shadow/state-quotes');
const { selection } = require('../src/shadow/selection');
const { TOKEN, TOKEN2022, WSOL, CLMM, discriminator, mint, cpmm } = require('../src/stonk/accounts');
const { CPMM, encode58, decode58 } = require('../src/stonk/protocol');
const key = n => encode58(Buffer.alloc(32, n));
const p = { pool: key(1), mint: key(2), quoteMint: key(3), baseVault: key(4), quoteVault: key(5), slot: 100 };
function account(data, owner) { return { data: [data.toString('base64'), 'base64'], owner }; }
function accounts() {
  const pool = Buffer.alloc(637); discriminator('PoolState').copy(pool); decode58(p.baseVault).copy(pool, 72); decode58(p.quoteVault).copy(pool, 104);
  decode58(p.mint).copy(pool, 168); decode58(p.quoteMint).copy(pool, 200); decode58(TOKEN).copy(pool, 232); decode58(TOKEN).copy(pool, 264); pool[331] = 6; pool[332] = 8;
  const m = d => { const b = Buffer.alloc(82); b[44] = d; b[45] = 1; return account(b, TOKEN); };
  const v = (mint, n) => { const b = Buffer.alloc(165); decode58(mint).copy(b); b.writeBigUInt64LE(n, 64); b[108] = 1; return account(b, TOKEN); };
  return [account(pool, CPMM), m(6), m(8), v(p.mint, 100000000000n), v(p.quoteMint, 500000000000n)];
}
function options(c) { return { ...c.shadow, market: c.market, sizeSol: c.sizeSol, takeProfit: c.takeProfit, stopLoss: c.stopLoss,
  trailArm: c.trailArm, trailDrop: c.trailDrop, maxHoldMs: c.maxHoldMs, minSellSol: c.minSellSol, minImpact: c.minImpact,
  maxImpact: c.maxImpact, minLiquidity: c.minLiquidity, maxSourceLagMs: c.maxSignalAgeMs + 1000, networkFeeSol: (5000 + c.priorityLamports + c.tipLamports) / 1e9 }; }
const c = readConfig({ HELIUS_API_KEY: 'test' });
test('Stonk forces paper and Shadow while preserving every original strategy and research setting', async () => {
  const original = originalConfig({ HELIUS_API_KEY: 'test' });
  for (const k of ['minSellSol','minImpact','maxImpact','minLiquidity','sizeSol','maxPositions','cooldownMs','takeProfit','stopLoss','trailArm','trailDrop','maxHoldMs','maxSignalAgeMs','paperPrebuyFilter']) assert.equal(c[k], original[k], k);
  for (const k of ['entryDelayMs','exitDelayMs','entryDeadlineMs','feeBps','slippageBps','entryComparisons','exitComparisons','stateQuotes']) assert.equal(c.shadow[k], original.shadow[k], k);
  assert.equal(policyId(assumptions(options(c))), '4aa9d98cc8a3e538');
  const forced = readConfig({ HELIUS_API_KEY: 'test', DRY_RUN: 'false', LIVE_CALIBRATION: 'true', SHADOW_ENABLED: 'false', WALLET_PRIVATE_KEY_BS58: 'must-not-load' });
  assert.equal(forced.dryRun, true); assert.equal(forced.shadow.enabled, true); assert.equal(forced.calibration.enabled, false); assert.equal(forced.privateKey, '');
  assert.throws(() => { forced.dryRun = false; });
  const executor = new PaperExecutor(); await assert.rejects(executor.buildSwap()); await assert.rejects(executor.submit()); await assert.rejects(executor.closeAccount());
});
test('original frozen models are loaded as references with the original policy id', () => {
  const records = [], t = new Tracker(options(c), r => records.push(r));
  assert.equal(t.model.status, 'experimental_calibrated_model'); assert.equal(t.drawdownModel.status, 'experimental_calibrated_model');
  assert.equal(records[0].source, 'confirmed_stonk_cpmm_swaps'); assert.match(records[0].modelDomain, /not_stonk_validated/);
});
test('Stonk migration AGE is accepted by the original selection rules', () => {
  const now = Date.now(), ages = new Age();
  assert.equal(ages.created({ pool: p.pool, mint: p.mint, createdAt: now - 1000, migrationAt: now - 1000, observedAt: now, source: 'stonk_migrate_confirmed' }), true);
  const age = ages.snapshot(p, now); assert.equal(age.migrationAgeMs, 1000); assert.equal(age.definition, 'since_stonk_graduation_migration');
  const s = selection({}, {}, true, {}, {}, age); assert.ok(s);
});
test('CPMM account decoder and adapter use mint precision, effective reserves, and SOL valuation', async () => {
  const now = Date.now(), a = accounts();
  const data = Buffer.from(a[0].data[0], 'base64'); data.writeBigUInt64LE(1000n, 341); data.writeBigUInt64LE(2000n, 397); a[0] = account(data, CPMM);
  assert.equal(cpmm(a[0]).fees0, 3000n);
  const adapter = new Adapter(async () => ({ context: { slot: 101 }, value: a }), { rate: async () => ({ rate: 0.02, at: now, source: 'test' }) });
  const q = await adapter.prepare({ ...p, graduatedAt: now - 1000 });
  assert.equal(q.postBase, '99999997000'); assert.equal(q.liquidity, 100); assert.equal(q.postQuote, '100000000000');
  assert.equal(q.quoteMint, p.quoteMint); assert.deepEqual(q.transferFees, { base: [], quote: [] });
  await assert.rejects(adapter.prepare({ ...p, graduatedAt: now - 1800000 }));
  a[0].owner = TOKEN; await assert.rejects(adapter.prepare({ ...p, graduatedAt: now - 1000 }));
});
test('Token-2022 transfer fee schedules and caps are included in Shadow proxy round-trip', () => {
  const b = Buffer.alloc(278); b[44] = 6; b[45] = 1; b[165] = 1; b.writeUInt16LE(1,166); b.writeUInt16LE(108,168);
  for (const offset of [242,260]) { b.writeBigUInt64LE(1000000000n, offset + 8); b.writeUInt16LE(300, offset + 16); }
  const fee = mint(account(b, TOKEN2022)).fees; assert.equal(fee.length, 2); assert.equal(afterTransfer(10000, fee), 9700);
  assert.equal(afterTransfer(10000, [{ bps: 300, maximumFee: '10' }]), 9990);
  const s = { ...p, market: 'stonk', postBase: '100000000000', postQuoteRaw: '500000000000', postQuote: '100000000000',
    price: 1e-9, quoteDecimals: 8, fx: { rate: 0.02 }, transferFees: { base: [], quote: [] } };
  const baseline = buyQuote(s, options(c)), taxed = buyQuote({ ...s, transferFees: { base: fee, quote: fee } }, options(c));
  assert.ok(taxed.amount < baseline.amount); assert.ok(liquidationDetails({ ...s, transferFees: { base: fee, quote: fee } }, taxed.amount, options(c)).net < 1);
  assert.equal(buyQuote({ ...s, transferFees: null }, options(c)), null);
});
test('on-chain FX uses verified CLMM pair and refuses missing markets; WSOL stays exactly one', async () => {
  let reads = 0; const from = key(6); const sorted = [from, WSOL].sort((a,b) => Buffer.compare(decode58(a),decode58(b)));
  const b = Buffer.alloc(1544); discriminator('PoolState').copy(b); decode58(sorted[0]).copy(b,73); decode58(sorted[1]).copy(b,105);
  b[233] = 9; b[234] = 9; b.writeBigUInt64LE(1000000000000n,237); b.writeBigUInt64LE(1n,261); // sqrt price = 2^64
  const a = account(b, CLMM);
  const fx = new Valuation(async (method, params) => { reads++; return method === 'getProgramAccounts' ? { context: { slot: 1 }, value: params[0] === CLMM ? [{ pubkey: key(7), account: a }] : [] } : { context: { slot: 1 }, value: [a] }; });
  assert.equal((await fx.rate(WSOL)).rate,1); assert.equal(reads,0); assert.equal((await fx.rate(from)).rate,1);
  const missing = new Valuation(async () => ({ context: { slot: 1 }, value: [] })); await assert.rejects(missing.rate(from), /No fresh/);
});
test('original state-quote scheduler reads all five Stonk accounts and returns the CPMM quote', async () => {
  const now = Date.now(), a = accounts(), s = { ...p, market: 'stonk', graduatedAt: now - 1000 };
  const adapter = new Adapter(async () => {}, { rate: async () => ({ rate: 0.02, at: now }) });
  let requested;
  const q = new StateQuotes(c, { keys: s => adapter.keys(s), validate: () => {}, decode: (s, values, slot) => adapter.state(s, values, slot),
    request: async (_url, options) => { requested = JSON.parse(options.body); return { ok: true, json: async () => ({ result: { context: { slot: 101 }, value: a } }) }; } });
  const rows = await q.poll([s]); assert.deepEqual(requested.params[0], adapter.keys(s));
  assert.equal(rows[0].status, 'quoted'); assert.equal(rows[0].quote.market, 'stonk'); assert.equal(rows[0].quote.liquidity, 100); q.close();
});
test('Shadow 30-minute cutoff censors proxy entry and all recovery arms without a fictitious close', () => {
  const at = Date.now(), events = [], tracker = new Tracker(options(c), r => events.push(r), { now: () => at });
  const graduatedAt = at - 1799000;
  tracker.ages.created({ ...p, createdAt: graduatedAt, migrationAt: graduatedAt, observedAt: at, source: 'stonk_migrate_confirmed' });
  tracker.connection(true, at);
  const s = { ...p, market:'stonk', graduatedAt, signature:'candidate', receivedAt:at, eventTime:at, side:'sell', sellSol:8, quoteSol:8,
    impact:20, liquidity:100, price:1e-9, postBase:'100000000000', postQuote:'100000000000', postQuoteRaw:'500000000000',
    quoteDecimals:8, fx:{rate:0.02}, transferFees:{base:[],quote:[]}, virtual:'0', user:key(8) };
  tracker.onSwap(s,true,true);
  tracker.onSwap({...s,signature:'entry',receivedAt:at+500,eventTime:at+500,slot:101},false,true);
  const sample = [...tracker.active.values()][0]; assert.ok(sample.entry);
  tracker.stateRecovery.add(sample,'pool_observation_gap',at+500); assert.ok(tracker.stateRecovery.active.size);
  tracker.tick(at+1000); assert.equal(tracker.active.size,0); assert.equal(tracker.stateRecovery.active.size,0); assert.deepEqual(tracker.stateTargets(),[]);
  assert.ok(events.some(e=>e.type==='outcome' && e.status==='censored' && e.reason==='graduation_window_end'));
  assert.equal(events.filter(e=>e.target==='strategy_proxy' && e.status==='observed_proxy').length,0);
});
test('real Shadow worker runs, responds to original prebuy filter, paper buys/sells, and censors at graduation deadline', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'stonk-runtime-'));
  const config = readConfig({ HELIUS_API_KEY:'test', STATE_FILE:path.join(dir,'paper.json'), SHADOW_DIRECTORY:path.join(dir,'shadow'), STONK_DATA_DIR:dir });
  const handlers = {}; const socket = { readyState: 0, addEventListener: (n,f) => { handlers[n]=f; }, send() {}, close() { this.readyState=3; handlers.close?.(); } };
  const runtime = new Runtime(config,{monitorOptions:{rpc:async()=>[],socketFactory:()=>socket}});
  const logs=[]; runtime.store.log=(type,data)=>logs.push({type,...data}); runtime.monitor.log=()=>{};
  runtime.adapter.prepare=async()=>({}); runtime.adapter.swap=async s=>s;
  t.after(async()=>{ await runtime.stop(); fs.rmSync(dir,{recursive:true,force:true}); }); runtime.start();
  const deadline=Date.now()+5000; while(runtime.shadow.stats().status!=='running' && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.equal(runtime.shadow.stats().status,'running');
  runtime.stream.connected=true; runtime.shadow.connection(true);
  const s={...p,market:'stonk',graduatedAt:Date.now()-1000,signature:'dump1',side:'sell',sellSol:8,quoteSol:8,impact:20,liquidity:100,
    receivedAt:Date.now(),eventTime:Date.now(),price:1e-9,postBase:'100000000000',postQuote:'100000000000',postQuoteRaw:'500000000000',
    quoteDecimals:8,fx:{rate:0.02},transferFees:{base:[],quote:[]},virtual:'0',user:key(8)};
  runtime.pool(s); await runtime.swap(s,s.receivedAt);
  for(let i=0;i<100 && !runtime.store.data.positions[p.mint];i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(runtime.store.data.positions[p.mint]); assert.ok(logs.some(r=>r.type==='paper_prebuy_filter'));
  assert.equal(runtime.shadow.filterTiming.responses,1); assert.equal(runtime.executor.wallet,undefined);
  await runtime.swap({...s,signature:'bounce',side:'buy',sellSol:0,impact:0,price:1.3e-9,receivedAt:Date.now(),eventTime:Date.now()},Date.now());
  for(let i=0;i<100 && runtime.engine.busy;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(logs.some(r=>r.type==='paper_sell' && r.reason==='take_profit'));
  runtime.store.data.positions[p.mint]={...s,entrySol:1,openedAt:Date.now()}; runtime.engine.expirePool(p.pool);
  assert.ok(logs.some(r=>r.type==='paper_censored' && r.netPnlSol===null)); assert.equal(Object.keys(runtime.store.data.positions).length,0);
});
