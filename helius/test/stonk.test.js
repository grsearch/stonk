'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LAUNCHLAB, CPMM, PLATFORMS, WINDOW_MS, tag, normalize, migrations, active, swaps } = require('../src/stonk/protocol');
const { Monitor, config } = require('../src/stonk/monitor');
const epoch = 1800000000000;
const pool = { pool: 'pool', mint: 'base', quoteMint: 'stock', baseVault: 'bv', quoteVault: 'qv', platform: PLATFORMS[0], graduatedAt: epoch };
function migration(platform = PLATFORMS[0]) {
  return { programId: LAUNCHLAB, accounts: ['payer', 'base', 'stock', platform, CPMM, 'pool', 'authority', 'lp', 'bv', 'qv', 'fee', 'createFee', 'observation'], data: tag('migrate_to_cpswap') };
}
function raw(instructions = [migration()], blockTime = epoch / 1000) {
  return { blockTime, slot: 1, transaction: { message: { accountKeys: ['bv', 'qv'], instructions } }, meta: { err: null,
    logMessages: [`Program ${LAUNCHLAB} success`], preTokenBalances: [], postTokenBalances: [
      { accountIndex: 0, mint: 'base', uiTokenAmount: { amount: '1000000000', decimals: 6 } },
      { accountIndex: 1, mint: 'stock', uiTokenAmount: { amount: '100000000', decimals: 8 } },
    ] } };
}
function trade({ sell = true, exactOut = false } = {}) {
  const t = raw([{ programId: CPMM, accounts: ['user', 'authority', 'fee', 'pool', 'userIn', 'userOut', sell ? 'bv' : 'qv', sell ? 'qv' : 'bv', 'token', 'token2022', sell ? 'base' : 'stock', sell ? 'stock' : 'base'], data: tag(exactOut ? 'swap_base_output' : 'swap_base_input') }], epoch / 1000 + 1);
  const b = (accountIndex, mint, amount, decimals) => ({ accountIndex, mint, uiTokenAmount: { amount, decimals } });
  t.meta.preTokenBalances = [b(0, 'base', '1000000000', 6), b(1, 'stock', '100000000', 8)];
  t.meta.postTokenBalances = [b(0, 'base', sell ? '1100000000' : '900000000', 6), b(1, 'stock', sell ? '90000000' : '110000000', 8)];
  return t;
}
function monitor(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stonk-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const m = new Monitor({ ...config({ HELIUS_API_KEY: 'test' }), dataDir }, { now: () => epoch + 1000, ...options });
  m.logs = []; m.log = (type, data) => m.logs.push({ type, ...data }); return m;
}
test('migration requires Stonk config in exact position and LaunchLab program', () => {
  assert.equal(migrations(normalize(raw())).length, 1);
  assert.equal(migrations(normalize(raw([migration(PLATFORMS[1])]))).length, 1);
  const other = migration('other'); other.accounts.push(PLATFORMS[0]);
  assert.equal(migrations(normalize(raw([other]))).length, 0);
  other.programId = CPMM; assert.equal(migrations(normalize(raw([other]))).length, 0);
  const failed = raw(); failed.meta.err = {}; assert.equal(normalize(failed), null);
  const caught = raw(); caught.meta.logMessages.push(`Program ${LAUNCHLAB} failed: custom error`);
  assert.equal(migrations(normalize(caught)).length, 0);
  const unseeded = raw(); unseeded.meta.postTokenBalances = []; assert.equal(migrations(normalize(unseeded)).length, 0);
});
test('strict graduation window includes zero, excludes 30 minutes, unknown and future', () => {
  assert.equal(active(pool, epoch), true); assert.equal(active(pool, epoch + WINDOW_MS - 1), true);
  assert.equal(active(pool, epoch + WINDOW_MS), false); assert.equal(active(pool, epoch - 1), false);
  assert.equal(active({ ...pool, graduatedAt: undefined }, epoch), false);
});
test('CPMM non-SOL quotes and differing decimals: sell, buy, exact output', () => {
  for (const sell of [true, false]) for (const exactOut of [true, false]) {
    const [s] = swaps(normalize(trade({ sell, exactOut })), new Map([['pool', pool]]), epoch + 1000);
    assert.equal(s.side, sell ? 'sell' : 'buy'); assert.equal(s.quoteMint, 'stock');
    assert.equal(s.vaultRatioBefore, 0.001); assert.equal(s.executableQuote, false);
    assert.equal(s.quoteSol, undefined); assert.equal(s.quoteVaultDeltaRaw, sell ? '-10000000' : '10000000');
  }
});
test('rejects expired/delayed, pregraduation, unrelated pools and repeated pool operations', () => {
  const pools = new Map([['pool', pool]]);
  assert.deepEqual(swaps(normalize(trade()), pools, epoch + WINDOW_MS), []);
  const t = trade(); t.blockTime = epoch / 1000 - 1; assert.deepEqual(swaps(normalize(t), pools, epoch + 1000), []);
  t.blockTime = epoch / 1000 + 1; t.transaction.message.instructions.push(t.transaction.message.instructions[0]);
  assert.deepEqual(swaps(normalize(t), pools, epoch + 1000), []);
  assert.deepEqual(swaps(normalize(trade()), new Map(), epoch + 1000), []);
});
test('rejects mismatched vaults, mint and missing balances', () => {
  for (const change of [t => t.transaction.message.instructions[0].accounts[6] = 'bad', t => t.meta.postTokenBalances[1].mint = 'bad', t => t.meta.preTokenBalances = []]) {
    const t = trade(); change(t); assert.deepEqual(swaps(normalize(t), new Map([['pool', pool]]), epoch + 1000), []);
  }
});
test('JSON address lookup tables and inner CPI instructions are normalized', () => {
  const t = raw([]); t.meta.loadedAddresses = { writable: ['pool'], readonly: [LAUNCHLAB] };
  t.meta.innerInstructions = [{ instructions: [{ programIdIndex: 3, accounts: [2], data: '1' }] }];
  const n = normalize(t); assert.equal(n.instructions[0].program, LAUNCHLAB); assert.deepEqual(n.instructions[0].accounts, ['pool']); assert.deepEqual(n.instructions[0].data, Buffer.from([0]));
});
test('monitor discovers, deduplicates migration/trade and expires from original time', async t => {
  let now = epoch + 1000; const m = monitor(t, { now: () => now });
  await m.process(raw(), 'migration'); await m.process(raw([], epoch / 1000 + 10), 'migration');
  assert.equal(m.pools.get('pool').graduatedAt, epoch);
  await m.process(trade(), 'swap'); await m.process(trade(), 'swap');
  assert.equal(m.stats.trades, 1); assert.equal(m.stats.dumps, 1);
  now = epoch + WINDOW_MS; m.expire(); assert.equal(m.pools.size, 0);
});
test('missing chain timestamp fails closed; subsequent retry succeeds', async t => {
  let timestamp = null; const m = monitor(t, { rpc: async () => timestamp });
  await assert.rejects(m.process(raw([migration()], null), 'migration'), /Missing chain/);
  assert.equal(m.pools.size, 0); timestamp = epoch / 1000;
  await m.process(raw([migration()], null), 'migration'); assert.equal(m.pools.size, 1);
});
test('subscriptions contain Stonk configs and active pools only; expiry unsubscribes', t => {
  const m = monitor(t); const sent = []; m.ws = { readyState: 1, send: s => sent.push(JSON.parse(s)) };
  m.pools.set('pool', pool); m.syncSubscriptions();
  assert.deepEqual(sent[0].params[0].accountInclude, PLATFORMS); assert.deepEqual(sent[1].params[0].accountInclude, ['pool']);
  m.pending.clear(); m.subscriptions.set('discovery', 10); m.subscriptions.set('pool', 11);
  m.pools.clear(); m.syncSubscriptions(); assert.equal(sent.at(-1).method, 'transactionUnsubscribe'); assert.deepEqual(sent.at(-1).params, [11]);
});
test('startup discovery recovers recent graduation and never resets its age', async t => {
  const m = monitor(t, { rpc: async method => method === 'getSignaturesForAddress' ? [{ signature: 'oldMigration', blockTime: epoch / 1000, err: null }] : raw() });
  await m.discover(); assert.equal(m.pools.get('pool').graduatedAt, epoch);
  assert.equal(m.cursors[PLATFORMS[0]], 'oldMigration');
});
test('discovery failure does not advance recovery cursor', async t => {
  const m = monitor(t, { rpc: async method => method === 'getSignaturesForAddress' ? [{ signature: 'missing', blockTime: epoch / 1000, err: null }] : null });
  await assert.rejects(m.discover()); assert.deepEqual(m.cursors, {});
});
test('restoring state keeps original graduation and excludes expired pools', async t => {
  const m = monitor(t); m.pools.set('pool', pool); m.pools.set('old', { ...pool, pool: 'old', graduatedAt: epoch - WINDOW_MS }); m.save();
  m.connect = () => {}; m.start(); assert.equal(m.pools.size, 1); assert.equal(m.pools.get('pool').graduatedAt, epoch); await m.stop();
});
test('legacy SOL and live settings cannot enable trading or change 30-minute window', () => {
  const c = config({ HELIUS_API_KEY: 'test', DRY_RUN: 'false', MIN_SELL_SOL: '8', MAX_AGE_MS: '99999999' });
  assert.equal(c.dryRun, undefined); assert.equal(c.minSellSol, undefined); assert.equal(WINDOW_MS, 1800000);
  assert.throws(() => config({ HELIUS_API_KEY: 'test', STONK_DUMP_PCT: 'NaN' }));
});
test('RPC budget is enforced and resets on next UTC day', async t => {
  let now = epoch; const m = monitor(t, { now: () => now, rpc: async () => 'ok' }); m.config.maxRpc = 1;
  assert.equal(await m.rpc('getBlockTime', [1]), 'ok'); await assert.rejects(m.rpc('getBlockTime', [2]), /budget/);
  now += 86400000; assert.equal(await m.rpc('getBlockTime', [3]), 'ok');
});
test('a second process cannot overwrite an active state lock', async t => {
  const m = monitor(t); m.connect = () => {}; m.start();
  const other = new Monitor(m.config); assert.throws(() => other.start(), /already running/);
  await m.stop(); assert.equal(fs.existsSync(path.join(m.config.dataDir, 'monitor.lock')), false);
});
test('page-limited discovery signals incomplete coverage without advancing cursor', async t => {
  const m = monitor(t, { rpc: async method => method === 'getSignaturesForAddress' ? Array.from({ length: 100 }, (_, i) => ({ signature: String(i), blockTime: epoch / 1000, err: {} })) : null });
  m.config.historyPages = 1; await m.discover();
  assert.equal(m.health.discoveryComplete, false); assert.deepEqual(m.cursors, {});
  assert.equal(m.logs.filter(l => l.type === 'discovery_incomplete').length, 2);
});
test('WebSocket envelope subscribes, receives JSON-parsed graduation, and handles late expiry ack', async t => {
  let now = epoch + 1000; const handlers = {}; const sent = [];
  const ws = { readyState: 0, send: s => sent.push(JSON.parse(s)), addEventListener: (name, cb) => { handlers[name] = cb; }, close: () => { ws.readyState = 3; handlers.close?.(); } };
  const m = monitor(t, { now: () => now, rpc: async () => [], socketFactory: () => ws }); m.running = true; m.connect();
  ws.readyState = 1; handlers.open(); await m.recoveryWork;
  const disc = sent.find(r => r.method === 'transactionSubscribe');
  assert.equal(disc.params[1].encoding, 'jsonParsed');
  const message = value => handlers.message({ data: JSON.stringify(value) });
  message({ id: disc.id, result: 123 });
  const r = raw(); r.transaction.message.accountKeys = r.transaction.message.accountKeys.map(pubkey => ({ pubkey, source: 'transaction' }));
  message({ method: 'transactionNotification', params: { result: { transaction: r, signature: 'wireMigration', slot: 1, blockTime: epoch / 1000 } } });
  await m.queue; assert.equal(m.pools.size, 1);
  const poolSub = sent.find(s => s.params?.[0]?.accountInclude?.[0] === 'pool');
  now = epoch + WINDOW_MS; m.expire(); message({ id: poolSub.id, result: 456 });
  assert.equal(sent.at(-1).method, 'transactionUnsubscribe'); assert.deepEqual(sent.at(-1).params, [456]);
  await m.stop();
});

test('failed transaction processing marks a Shadow coverage gap and the queue continues', async t => {
  const gaps = [], m = monitor(t, { onGap: reason => gaps.push(reason) });
  m.enqueue(async () => { throw Error('RPC unavailable'); });
  let continued = false; m.enqueue(async () => { continued = true; });
  await m.queue;
  assert.deepEqual(gaps, ['transaction_processing_failed']); assert.equal(continued, true); assert.equal(m.queued, 0);
});

test('cancelled Shadow RPC is rejected before spending the daily request budget', async t => {
  let called = false;
  const m = monitor(t, { rpc: async () => { called = true; } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(m.rpc('getMultipleAccounts', [], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(called, false); assert.equal(m.totalRpc, 0);
  const active = new AbortController();
  m.rpcOverride = async (_method, _params, options) => assert.equal(options.signal, active.signal);
  await m.rpc('getMultipleAccounts', [], { signal: active.signal });
});

test('Stonk subscriptions obey the reserve gate while retaining a protected position until graduation expires', t => {
  let allowed = true; const m = monitor(t, { shouldSubscribe: () => allowed });
  const sent = []; m.ws = { readyState: 1, send: text => sent.push(JSON.parse(text)) };
  m.pools.set(pool.pool, pool); m.subscriptions.set('discovery', 1); m.subscriptions.set(pool.pool, 2);
  m.syncSubscriptions(); assert.equal(sent.length, 0);
  allowed = false; m.syncSubscriptions();
  assert.equal(sent[0].method, 'transactionUnsubscribe'); assert.deepEqual(sent[0].params, [2]);
  allowed = true; m.syncSubscriptions(); assert.equal(sent.at(-1).method, 'transactionSubscribe');
  m.now = () => epoch + WINDOW_MS; m.expire();
  assert.equal(m.pools.size, 0);
});
