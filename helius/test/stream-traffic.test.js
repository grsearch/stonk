'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Traffic = require('../src/stream-traffic');
const { parseSwaps } = require('../src/parser');
const { fixture } = require('./fixtures');

test('traffic totals reconcile with bounded pool overflow and split allocation', () => {
  let now = 10;
  const t = new Traffic(() => {}, () => now, 2);
  t.record(101, { category: 'parsed_mixed', pools: ['a', 'a', 'b'] });
  t.record(30, { category: 'unparsed_swap', pools: ['c'] });
  t.record(7, { category: 'control' }); now = 20;
  const r = t.flush();
  assert.equal(r.byteCount, 138); assert.equal(r.messages, 3);
  assert.equal(r.topPools[0].byteCount, 50.5); assert.equal(r.overflowPoolByteCount, 30);
  assert.equal(r.unattributedByteCount, 7); assert.equal(r.start, 10); assert.equal(r.end, 20);
  assert.equal(Object.values(r.categories).reduce((s, c) => s + c.byteCount, 0), r.byteCount);
  assert.equal(t.flush(), undefined);
});

test('traffic reports retain other pool bytes when top list is truncated', () => {
  const t = new Traffic(() => {});
  for (let i = 0; i < 30; i++) t.record(i + 1, { pools: [`pool${i}`] });
  const r = t.flush();
  assert.equal(r.topPools.length, 20); assert.equal(r.otherPoolByteCount, 55);
  assert.equal(r.topPools.reduce((s, p) => s + p.byteCount, 0) + r.otherPoolByteCount, r.byteCount);
});

test('parser attributes buys, sells and rejected swap decoding without reparsing', () => {
  for (const side of ['buy', 'sell']) {
    const f = fixture({ side }); let info;
    assert.equal(parseSwaps(f, null, null, r => { info = r; }).length, 1);
    assert.equal(info.category, `parsed_${side}`); assert.equal(info.pools.length, 1);
    f.transaction.meta.postTokenBalances = [];
    assert.equal(parseSwaps(f, null, null, r => { info = r; }).length, 0);
    assert.equal(info.category, 'unparsed_swap');
    assert.deepEqual(info.reasons, ['missing_vault_balances']);
  }
});

test('parser explains unsupported pair and transaction without AMM instructions', () => {
  const f = fixture(); let info;
  f.transaction.transaction.message.instructions[0].accounts[4] = f.mint;
  parseSwaps(f, null, null, r => { info = r; });
  assert.deepEqual(info.reasons, ['unsupported_pair']);
  f.transaction.transaction.message.instructions = [];
  f.transaction.meta.innerInstructions = [];
  parseSwaps(f, null, null, r => { info = r; });
  assert.deepEqual(info.reasons, ['no_amm_instruction']);
});

test('traffic reason byte shares reconcile without double counting multi-reason messages', () => {
  const t = new Traffic(() => {});
  t.record(100, { category: 'unparsed_swap', reasons: ['unsupported_pair', 'missing_vault_balances', 'unsupported_pair'] });
  t.record(20, { category: 'control' });
  const r = t.flush();
  assert.equal(r.version, 2); assert.equal(r.reasons.unsupported_pair.byteCount, 50);
  assert.equal(Object.values(r.reasons).reduce((s, v) => s + v.byteCount, 0), r.byteCount);
});

test('archive report includes telemetry and excludes linked context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-'));
  try {
    const t = new Traffic(() => {}); t.record(50, { category: 'parsed_buy', pools: ['p'] });
    const record = { type: 'stream_traffic', ...t.flush() };
    const file = path.join(dir, 'analysis.jsonl.gz');
    fs.writeFileSync(file, zlib.gzipSync([JSON.stringify({ record, context: false }), JSON.stringify({ record, context: true })].join('\n')));
    const r = await require('../scripts/stream-traffic-report').report(file);
    assert.equal(r.intervals, 1); assert.equal(r.byteCount, 50); assert.equal(r.categoryTotalMatches, true);
    assert.equal(r.categories.parsed_buy.percent, 100); assert.equal(r.topPools[0].pool, 'p');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('websocket telemetry accounts every message including stale and malformed messages', async () => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const logs = [], data = { streamDays: {} };
  const Stream = require('../src/stream');
  const stream = new Stream({ wsUrl: `ws://127.0.0.1:${server.address().port}`, maxBytesPerDay: 0 }, { data, log: (type, r) => logs.push({ type, ...r }) });
  const packets = [JSON.stringify({ id: 1, result: 1 }), '{bad',
    JSON.stringify({ method: 'transactionNotification', params: { result: { slot: 100 } } }),
    JSON.stringify({ method: 'transactionNotification', params: { result: { slot: 1 } } })];
  server.on('connection', ws => ws.once('message', () => packets.forEach(p => ws.send(p))));
  stream.on('transaction', tx => { tx.traffic = { category: 'parsed_sell', pools: ['p'] }; });
  try {
    stream.start();
    const deadline = Date.now() + 3000;
    while (stream.traffic.messages < packets.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    stream.stop();
    const r = logs.find(x => x.type === 'stream_traffic');
    assert.equal(r.messages, 4); assert.equal(r.byteCount, packets.reduce((s, p) => s + Buffer.byteLength(p), 0));
    assert.equal(r.byteCount, Object.values(data.streamDays).reduce((a, b) => a + b, 0));
    for (const key of ['control', 'parse_or_handler_error', 'parsed_sell', 'stale_slot']) assert.equal(r.categories[key].messages, 1);
  } finally { stream.stop(); for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); }
});
