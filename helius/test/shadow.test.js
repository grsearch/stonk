'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Features, FEATURE_NAMES } = require('../src/shadow/features');
const { Tracker, buyQuote, liquidation } = require('../src/shadow/tracker');
const { Model } = require('../src/shadow/model');
const { train, chronologicalSplit, loadDataset } = require('../src/shadow/training');
const ShadowClient = require('../src/shadow/client');
const { readConfig } = require('../src/config');
const { Engine } = require('../src/engine');
const { fixture } = require('./fixtures');
const base = readConfig({ HELIUS_API_KEY: 'test' });
const options = { ...base.shadow, sizeSol: base.sizeSol, takeProfit: base.takeProfit, stopLoss: base.stopLoss,
  trailArm: base.trailArm, trailDrop: base.trailDrop, maxHoldMs: base.maxHoldMs,
  networkFeeSol: 0, feeBps: 0, slippageBps: 0, maxSourceLagMs: 3500 };
function swap(at, extra = {}) {
  const quote = extra.postQuote || '100000000000';
  return { signature: `signature-${at}`, pool: 'pool', mint: 'mint', user: 'seller', slot: Math.floor(at / 400),
    receivedAt: at, eventTime: at, side: 'buy', price: Number(quote) / 1e11 / 1e9,
    sellSol: 8, impact: 20, liquidity: Number(quote) / 1e9, quoteSol: 1,
    postBase: '100000000000', postQuote: quote, virtual: '0', ...extra };
}
function collector(extra = {}) {
  const records = [], tracker = new Tracker({ ...options, ...extra }, r => records.push(r), { runId: 'test-run', now: () => 0 });
  tracker.connection(true, 0);
  return { tracker, records };
}
function warm(t) { for (let at = 0; at < 60000; at += 5000) t.onSwap(swap(at), false, false); }

test('independent entry research preserves original labels and records buyer identity only in confirmation window', () => {
  const enabled = collector({ entryComparisons: true }), disabled = collector({ entryComparisons: false });
  for (const { tracker } of [enabled, disabled]) {
    tracker.ages.created({ source: 'pump_migrate_processed', pool: 'pool', mint: 'mint', createdAt: 1, migrationAt: 1, observedAt: 1 });
    warm(tracker); tracker.onSwap(swap(59000, { side: 'sell' }), false, false); tracker.onSwap(swap(60000), true, true);
    tracker.onSwap(swap(60500), false, true);
    tracker.onSwap(swap(61000, { postQuote: '104000000000', user: 'second-buyer' }), false, true);
    tracker.onSwap(swap(61500, { postQuote: '105000000000' }), false, true);
    tracker.onSwap(swap(62000, { postQuote: '135000000000' }), false, true);
    tracker.onSwap(swap(62500, { postQuote: '130000000000' }), false, true);
    tracker.gap('process_shutdown', 64000);
  }
  assert.deepEqual(enabled.records.filter(r => r.type === 'outcome'), disabled.records.filter(r => r.type === 'outcome'));
  assert.equal(enabled.records[0].entryResearchVersion, 1);
  assert.ok(enabled.records.some(r => r.type === 'entry_comparison' && r.phase === 'entered'));
  assert.equal(enabled.records.find(r => r.type === 'pool_observation' && r.at === 60500).user, 'seller');
  assert.equal(enabled.records.find(r => r.type === 'pool_observation' && r.at === 61500).user, undefined);
  assert.equal(enabled.tracker.entryComparisons.active.size, 0);
});

test('exit research preserves baseline labels and archives missing variant exits', () => {
  const enabled = collector({ exitComparisons: true }), disabled = collector({ exitComparisons: false });
  for (const { tracker } of [enabled, disabled]) {
    warm(tracker); tracker.onSwap(swap(60000), true, true);
    tracker.onSwap(swap(60500), false, true);
    tracker.onSwap(swap(61000, { postQuote: '140000000000' }), false, true);
    tracker.onSwap(swap(61500, { postQuote: '130000000000' }), false, true);
    tracker.gap('test_disconnect', 61600);
  }
  assert.deepEqual(enabled.records.filter(r => r.type === 'outcome'), disabled.records.filter(r => r.type === 'outcome'));
  const variants = enabled.records.filter(r => r.type === 'exit_comparison');
  assert.equal(variants.length, 9); assert.ok(variants.some(r => r.variant === 'exit_1000ms' && r.status === 'censored'));
  assert.equal(enabled.tracker.active.size, 0);
});

test('shadow features contain only prior events, not the triggering dump or future observations', () => {
  const f = new Features(options);
  for (let i = 0; i < 12; i++) f.add(swap(i * 5000), i * 5000, i + 1);
  const trigger = swap(60000, { side: 'sell', quoteSol: 999 });
  const before = f.snapshot(trigger, 60000);
  assert.equal(before.ready, true); assert.equal(before.values.sellSol60, 0); assert.equal(before.lastHistorySequence, 12);
  f.add(trigger, 60000, 13); f.add(swap(61000, { quoteSol: 1000 }), 61000, 14);
  assert.equal(before.values.buySol60, 12); assert.equal(before.values.sellSol60, 0);
});
test('history is cold after restart or gap and bounded under eviction', () => {
  const f = new Features({ ...options, maxPools: 1, maxHistoryEvents: 2 });
  f.add(swap(0), 0, 1); f.add(swap(1, { pool: 'other' }), 1, 2);
  assert.equal(f.pools.size, 1); assert.ok(f.total <= 2);
  assert.equal(f.snapshot(swap(60000), 60000).ready, false);
  f.reset(); assert.equal(f.total, 0);
});
test('sample is written before outcome, with no fabricated probability when no model exists', () => {
  const { tracker, records } = collector(); warm(tracker);
  tracker.onSwap(swap(60000, { side: 'sell' }), true, true);
  const sample = records.find(r => r.type === 'sample');
  assert.ok(sample.features.ready); assert.equal(sample.prediction.status, 'no_model'); assert.equal(sample.prediction.probability, null);
  assert.equal(sample.selection.arms.risk.status, 'unknown');
  assert.equal(sample.observationVersion, 'selection-v7');
  assert.equal(records.filter(r => r.type === 'outcome').length, 0);
  assert.ok(sample.features.lastHistorySequence < sample.sequence);
});
test('entry uses the first observation after assumed delay, never the trigger low', () => {
  const { tracker, records } = collector(); warm(tracker); tracker.onSwap(swap(60000), true, true);
  tracker.onSwap(swap(60300), false, false);
  assert.equal(records.filter(r => r.type === 'proxy_entry').length, 0);
  tracker.onSwap(swap(60600, { postQuote: '110000000000' }), false, false);
  assert.equal(records.find(r => r.type === 'proxy_entry').actualEntryDelayMs, 600);
});
test('future tick cannot leak into 30 second horizon; continuous observed flat path is negative', () => {
  const { tracker, records } = collector(); warm(tracker); tracker.onSwap(swap(60000), true, true);
  tracker.onSwap(swap(60500), false, false);
  for (let at = 65000; at <= 85000; at += 5000) tracker.onSwap(swap(at), false, false);
  tracker.onSwap(swap(90001, { postQuote: '140000000000' }), false, false);
  const result = records.find(r => r.target === 'rebound_30s');
  assert.equal(result.status, 'observed_proxy'); assert.equal(result.label, 0);
});
test('rebound and strategy profit are separate labels; a stop can precede rebound', () => {
  const { tracker, records } = collector(); warm(tracker); tracker.onSwap(swap(60000), true, true);
  tracker.onSwap(swap(60500), false, false);
  tracker.onSwap(swap(61000, { postQuote: '70000000000' }), false, false);
  tracker.onSwap(swap(62000, { postQuote: '65000000000' }), false, false);
  for (let at = 65000; at <= 120000; at += 5000) tracker.onSwap(swap(at, { postQuote: '140000000000' }), false, false);
  assert.equal(records.find(r => r.target === 'strategy_proxy').label, 0);
  assert.equal(records.find(r => r.target === 'strategy_proxy').reason, 'stop_loss');
  assert.equal(records.find(r => r.target === 'rebound_60s').label, 1);
  assert.equal(tracker.active.size, 1); // 50% no-stop arm is still observing the flat 40% path.
  tracker.gap('process_shutdown', 120001);
  assert.equal(tracker.active.size, 0);
});
test('account snapshots feed only independent recovery, preserve censored labels and reject late delivery', () => {
  const { tracker, records } = collector({ stateQuotes: true }); warm(tracker);
  tracker.onSwap(swap(60000, { baseVault: 'base', quoteVault: 'quote', tokenProgram: 'program' }), true, true);
  tracker.onSwap(swap(60500, { baseVault: 'base', quoteVault: 'quote', tokenProgram: 'program' }), false, true);
  tracker.tick(71000);
  const targets = tracker.stateTargets(); assert.equal(targets.length, 1); assert.equal(targets[0].baseVault, 'base');
  const labels = JSON.stringify(records.filter(r => r.type === 'outcome')), history = tracker.features.total;
  const result = (at, requestAt) => ({ type: 'state_quote', pool: 'pool', status: 'quoted', at, requestAt,
    quote: { ...swap(at, { postQuote: '160000000000' }), requestAt } });
  tracker.stateQuotes([result(72100, 72000)], 76000);
  assert.equal(records.at(-1).discardReason, 'stale_delivery');
  tracker.stateQuotes([result(76100, 76000)], 76100);
  tracker.stateQuotes([result(78100, 78000)], 78100);
  assert.ok(records.some(r => r.type === 'state_exit_recovery' && r.status === 'account_state_proxy'));
  assert.equal(JSON.stringify(records.filter(r => r.type === 'outcome')), labels);
  assert.equal(tracker.features.total, history);
  assert.ok(!records.some(r => r.type === 'no_stop_recovery' && r.phase === 'finished'));
  tracker.gap('process_shutdown', 79000); assert.equal(tracker.stateTargets().length, 0);
});

test('disconnect, no entry and capacity overflow are censored, never negative training labels', () => {
  for (const kind of ['disconnect', 'no_entry', 'capacity']) {
    const { tracker, records } = collector({ maxActive: kind === 'capacity' ? 0 : 10 }); warm(tracker);
    tracker.onSwap(swap(60000), true, true);
    if (kind === 'disconnect') tracker.connection(false, 60100);
    if (kind === 'no_entry') tracker.tick(62600);
    const outcomes = records.filter(r => r.type === 'outcome');
    assert.equal(outcomes.length, 3); assert.ok(outcomes.every(r => r.label === null && r.status === 'censored'));
  }
});
test('stale source cannot provide a favorable future observation', () => {
  const { tracker, records } = collector(); warm(tracker); tracker.onSwap(swap(60000), true, true);
  tracker.onSwap(swap(60500), false, false);
  tracker.onSwap(swap(65000, { eventTime: 1000, postQuote: '200000000000' }), false, false);
  assert.ok(records.filter(r => r.type === 'outcome').every(r => r.label === null));
});
test('per-pool tracking cap records censored samples instead of dropping or inventing outcomes', () => {
  const { tracker, records } = collector({ maxActivePerPool: 1 }); warm(tracker);
  tracker.onSwap(swap(60000), true, true); tracker.onSwap(swap(60100), true, true);
  assert.equal(records.filter(r => r.type === 'sample').length, 2); assert.equal(tracker.active.size, 1);
  assert.ok(records.filter(r => r.type === 'outcome').every(r => r.reason === 'pool_active_capacity' && r.label === null));
});
test('fees, slippage and constant product impact reduce proxy returns', () => {
  const s = swap(0), free = buyQuote(s, options);
  const costly = { ...options, feeBps: 100, slippageBps: 100, networkFeeSol: 0.000305 };
  const paid = buyQuote(s, costly);
  assert.ok(paid.amount < free.amount); assert.ok(paid.cost > free.cost);
  assert.ok(liquidation(s, paid.amount, costly) < liquidation(s, free.amount, options));
  assert.ok(liquidation(s, free.amount, options) < free.cost);
});
test('time split purges labels that overlap the next partition', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ at: i * 1000, endAt: i * 1000 + 5000 }));
  const s = chronologicalSplit(rows);
  assert.ok(s.train.every(r => r.endAt < s.calStart));
  assert.ok(s.calibration.every(r => r.endAt < s.testStart)); assert.ok(s.purged > 0);
});
test('training does not fabricate a model from insufficient samples', () => {
  const r = train([], 'rebound_60s', 'policy');
  assert.equal(r.model, null); assert.equal(r.report.status, 'insufficient_data');
});
test('offline logistic calibration and holdout evaluation produce a loadable experimental model', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => {
    const signal = i % 2, y = i % 13 === 0 ? 1 - signal : signal;
    return { at: i * 120000, endAt: i * 120000 + 60000, y, mint: `mint-${i % 20}`,
      values: Object.fromEntries(FEATURE_NAMES.map(k => [k, k === 'sellSol' ? signal : 0])) };
  });
  const result = train(rows, 'rebound_60s', 'policy');
  assert.ok(result.model); assert.equal(result.model.validation.passed, true);
  assert.ok(result.model.validation.test.brier < result.model.validation.baseline.brier);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-model-')), file = path.join(dir, 'model.json');
  fs.writeFileSync(file, JSON.stringify(result.model));
  const m = new Model(file, 'policy');
  assert.equal(m.predict({ ready: true, values: rows[1].values }, result.model.evaluationAfter).status, 'before_forward_evaluation_window');
  assert.ok(m.predict({ ready: true, values: rows[1].values }).probability > 0.5);
  assert.equal(m.predict({ ready: false }).probability, null);
  assert.equal(new Model(file, 'other_policy').predict({ ready: true }).probability, null);
  result.model.validation.passed = false; fs.writeFileSync(file, JSON.stringify(result.model));
  assert.equal(new Model(file, 'policy').predict({ ready: true }).probability, null);
});
test('dataset loader excludes censored, truncated and duplicate sample records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-data-'));
  const values = Object.fromEntries(FEATURE_NAMES.map(k => [k, 1]));
  const sample = id => ({ type: 'sample', schema: 1, id, key: 'same-chain-event', at: 0, sequence: 2, decisionFresh: true,
    policyId: 'policy', source: { mint: 'mint' }, features: { ready: true, lastHistorySequence: 1, values } });
  const outcome = id => ({ type: 'outcome', id, target: 'rebound_60s', policyId: 'policy', status: 'observed_proxy', label: 1, at: 60000 });
  fs.writeFileSync(path.join(dir, 'samples-one.jsonl'), [sample('a'), outcome('a'), sample('b'), outcome('b'), { ...sample('c'), key: 'not-mature' }].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'samples-truncated.jsonl'), JSON.stringify(sample('d')) + '\n{');
  const data = await loadDataset(dir, 'rebound_60s');
  assert.equal(data.rows.length, 1); assert.equal(data.stats.duplicates, 1); assert.equal(data.stats.invalidFiles, 1); assert.equal(data.stats.immatureOrCensored, 1);
});
test('engine records a candidate even when wallet is busy, and never calls model to gate orders', async () => {
  const calls = [], shadow = { observe: (...args) => calls.push(['observe', ...args]), decision: (...args) => calls.push(['decision', ...args]), predict() { throw new Error('must not be called'); } };
  const store = { data: { positions: {}, cleanup: {}, cooldown: {}, pending: {}, seen: {}, streamDays: {} }, save() {}, log() {} };
  const engine = new Engine({ ...base, paperPrebuyFilter: false }, store, {}, { connected: true, budgetExceeded: () => false }, shadow);
  engine.busy = true; engine.onTransaction(fixture({ virtual: 100000000000n }));
  assert.equal(calls[0][0], 'observe'); assert.equal(calls[0][2], true);
  assert.equal(calls[1][2], 'skipped'); assert.equal(calls[1][3].reason, 'wallet_busy');
  engine.busy = false; engine.seen.clear(); shadow.observe = () => { throw new Error('sidecar broke'); };
  engine.onTransaction(fixture({ virtual: 100000000000n }));
  assert.equal(Object.keys(store.data.positions).length, 1);
});
test('cooldown, position cap and candidate cap do not hide samples from the sidecar', () => {
  for (const reason of ['cooldown', 'position_limit', 'candidate_limit']) {
    const tx = fixture({ virtual: 100000000000n }), events = [];
    const store = { data: { positions: {}, cleanup: {}, cooldown: {}, pending: {}, seen: {}, streamDays: {} }, save() {}, log() {} };
    const e = new Engine({ ...base, paperPrebuyFilter: false }, store, {}, { connected: true, budgetExceeded: () => false }, {
      observe: (...args) => events.push(['sample', ...args]), decision: (_, status, extra) => events.push([status, extra]),
    });
    if (reason === 'cooldown') store.data.cooldown[tx.mint] = Date.now() + 30000;
    if (reason === 'position_limit') for (let i = 0; i < 20; i++) store.data.positions[`other-${i}`] = {};
    if (reason === 'candidate_limit') { e.minute = Math.floor(Date.now() / 60000); e.candidates = 6; }
    e.onTransaction(tx);
    assert.equal(events[0][0], 'sample'); assert.equal(events[0][2], true);
    assert.equal(events[1][0], 'skipped'); assert.equal(events[1][1].reason, reason);
  }
});
test('main-thread sidecar queue is bounded and secrets are not passed to worker', async () => {
  const fake = new EventEmitter(); fake.unref = () => {}; const sent = [];
  fake.postMessage = message => { sent.push(message); if (message.type === 'close') fake.emit('exit', 0); };
  fake.terminate = async () => fake.emit('exit', 0);
  let passed;
  const client = new ShadowClient({ ...base, apiKey: 'SECRET_API', privateKey: 'SECRET_WALLET' }, { workerFactory: (_, opts) => { passed = opts; return fake; } });
  for (let i = 0; i < 5000; i++) client.observe(swap(i), false, false);
  assert.ok(client.queue.length <= 4096); assert.ok(client.dropped > 0);
  assert.ok(!JSON.stringify(passed).includes('SECRET'));
  client.pump(); assert.equal(sent[0].events[0].type, 'gap');
  while (client.queue.length || client.inFlight) fake.emit('message', { type: 'ack' });
  await client.close();
});
test('real worker writes samples asynchronously and marks shutdown observations censored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-worker-'));
  const client = new ShadowClient({ ...base, shadow: { ...base.shadow, directory: dir } });
  client.connection(true);
  client.observe(swap(Date.now()), true, true);
  await client.close();
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'));
  assert.equal(files.length, 1, JSON.stringify(client.stats()));
  const rows = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r => r.type === 'sample'));
  assert.equal(rows.filter(r => r.type === 'outcome').length, 3);
});

test('paper filter client matches responses, times out and ignores late replies', async () => {
  const fake = new EventEmitter(); fake.unref = () => {}; const batches = [];
  fake.postMessage = msg => { if (msg.type === 'batch') batches.push(msg); else fake.emit('exit', 0); };
  fake.terminate = async () => fake.emit('exit', 0);
  const client = new ShadowClient({ ...base, dryRun: true, paperPrebuyFilter: true }, { workerFactory: () => fake });
  const first = client.observe(swap(Date.now()), true, true); client.pump();
  const id = batches[0].events[0].filterId;
  fake.emit('message', { type: 'paper_filter', filterId: id, queueMs: 5, computeMs: 3, selection: { arm: { status: 'reject' } } });
  assert.equal((await first).arm.status, 'reject'); assert.equal(client.filters.size, 0);
  const second = client.observe(swap(Date.now()), true, true);
  assert.equal(await second, null); assert.equal(client.filters.size, 0);
  fake.emit('message', { type: 'paper_filter', filterId: id + 1, selection: { arm: { status: 'pass' } } });
  assert.equal(client.stats().filterTiming.requests, 2);
  assert.equal(client.stats().filterTiming.responses, 1);
  assert.equal(client.stats().filterTiming.timeouts, 1);
  assert.equal(client.stats().filterTiming.lateResponses, 1);
  assert.equal(client.stats().filterTiming.maxQueueMs, 5);
  assert.equal(client.stats().filterTiming.maxComputeMs, 3);
  while (client.queue.length || client.inFlight) fake.emit('message', { type: 'ack' });
  await client.close();
});

test('candidate experiments use prior history and loss cooldown never silently passes after a gap', () => {
  const { Experiments } = require('../src/shadow/experiments');
  const e = new Experiments({}, 0), s = { mint: 'm', sellSol: 50 };
  const history = { ready: true, values: { consecutiveSells: 4, sellSol15: 20, buySol15: 1 } };
  const first = e.evaluate(s, history, 1000);
  assert.equal(first.belowMaxSell, false); assert.equal(first.avoidPriorSellPressure, false); assert.equal(first.lossCooldown, null);
  e.closed('m', 600000, -1);
  assert.equal(e.evaluate(s, history, 600001).lossCooldown, false);
  assert.equal(e.evaluate(s, history, 1200000).lossCooldown, true);
  assert.equal(first.lossCooldown, null); // Earlier decision never changes from later information.
  e.reset(1200000); assert.equal(e.evaluate(s, history, 1200001).lossCooldown, null);
});

test('pool age is not token age, rejects future and conflicting creation evidence', () => {
  const { Age } = require('../src/shadow/age'); const a = new Age();
  const s = { pool: 'p', mint: 'm' };
  assert.equal(a.snapshot(s, 10000).migrationAgeMs, null);
  a.created({ ...s, createdAt: 1000, observedAt: 2000, signature: 'sig', source: 'pump_migrate_processed', migrationAt: 1000 });
  assert.equal(a.snapshot(s, 10000).migrationAgeMs, 9000);
  assert.equal(a.snapshot(s, 10000).tokenAgeMs, null);
  assert.equal(a.snapshot(s, 10000).tokenAgeMs, null);
  assert.equal(a.snapshot(s, 1500).migrationAgeMs, null);
  a.created({ ...s, createdAt: 1100, migrationAt: 1100, source: 'pump_migrate_processed', observedAt: 2000 });
  assert.equal(a.snapshot(s, 10000).migrationAgeMs, null);
});

test('execution comparison preserves delayed cost model, filter versions and unknown results', () => {
  const { tracker, records } = collector({ networkFeeSol: 0.001, feeBps: 100, slippageBps: 100 });
  warm(tracker); tracker.onSwap(swap(60000, { side: 'sell', sellSol: 50 }), true, true);
  tracker.onSwap(swap(60600), false, false);
  tracker.onSwap(swap(61000, { postQuote: '50000000000' }), false, false);
  tracker.onSwap(swap(61600, { postQuote: '40000000000' }), false, false);
  const cmp = records.find(r => r.type === 'execution_comparison');
  assert.equal(cmp.status, 'observed_proxy'); assert.equal(cmp.experiments.belowMaxSell, false);
  assert.equal(cmp.netPnlSol, cmp.exitProceedsSol - cmp.entryCostSol);
  assert.equal(cmp.actualExitDelayMs, 600); assert.equal(cmp.comparisonVersion, 1);
  const other = collector(); other.tracker.onSwap(swap(60000), true, true); other.tracker.gap('disconnect', 61000);
  assert.equal(other.records.find(r => r.type === 'execution_comparison').label, null);
});

test('migration diagnostics distinguish restored evidence, received evidence and unknown candidate age', () => {
  const {Age}=require('../src/shadow/age');const a=new Age();
  const e={pool:'p',mint:'m',createdAt:1000,migrationAt:1000,observedAt:1000,source:'pump_migrate_processed'};
  a.created(e,true);a.created({...e,pool:'p2'});
  assert.equal(a.counters.restored,1);assert.equal(a.counters.accepted,1);
  assert.equal(a.snapshot({pool:'missing',mint:'m'},2000).unknownReason,'migration_not_cached');
  assert.equal(a.snapshot({pool:'p',mint:'m'},2000).migrationAgeMs,1000);
  assert.equal(a.counters.known,1);assert.equal(a.counters.unknown,1);
});

test('pool gap preserves recovery independently of censored baseline and training labels', () => {
  const { tracker, records } = collector({ exitComparisons: true });
  warm(tracker); tracker.onSwap(swap(60000), true, true); tracker.onSwap(swap(60500), false, true);
  // Other pools keep global stream live while this pool is quiet.
  tracker.onSwap(swap(65000, { pool: 'other' }), false, true);
  tracker.onSwap(swap(70000, { pool: 'other' }), false, true); tracker.tick(71000);
  assert.equal(tracker.active.size, 0); assert.equal(tracker.recovery.active.size, 1);
  const labels = records.filter(r => r.type === 'outcome'); assert.ok(labels.every(r => r.status === 'censored'));
  tracker.onSwap(swap(72000, { postQuote: '140000000000' }), false, true);
  tracker.onSwap(swap(72500, { postQuote: '130000000000' }), false, true);
  assert.equal(tracker.recovery.active.size, 0);
  assert.equal(records.filter(r => r.type === 'outcome').length, labels.length);
  assert.ok(records.some(r => r.type === 'no_stop_recovery' && r.status === 'discontinuous_proxy'));
  assert.ok(records.filter(r => r.type === 'exit_comparison').every(r => r.status === 'censored'));
});

test('buy burst excludes trigger amount and still records the rejected candidate baseline entry', () => {
  const { tracker, records } = collector({ entryComparisons: true }); warm(tracker);
  tracker.onSwap(swap(60000, { side: 'sell', quoteSol: 999 }), true, true);
  const sample = records.find(r => r.type === 'sample');
  assert.equal(sample.features.values.buyFraction5, 1);
  assert.equal(sample.selection.arms.prebuyCombined.status, 'reject');
  assert.equal(sample.selection.arms.prebuyBeforeBuy80.status, 'pass');
  tracker.onSwap(swap(60500), false, true);
  assert.ok(records.some(r => r.type === 'proxy_entry' && r.id === sample.id));
  assert.ok(records.some(r => r.type === 'entry_comparison' && r.status === 'skipped'));
});
