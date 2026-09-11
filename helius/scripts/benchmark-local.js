'use strict';
// Synthetic wallet and pool only. No RPC, subscription, simulation or submission.
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const { fixture } = require('../test/fixtures');
const { executor, state } = require('../test/executor-fixtures');
const { parseSwaps } = require('../src/parser');
function stats(name, values) {
  const a = [...values].sort((x, y) => x - y);
  return { stage: name, samples: a.length, p50Ms: +a[Math.floor(a.length * 0.5)].toFixed(3), p95Ms: +a[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)].toFixed(3) };
}
async function main() {
  const e = executor(), s = state(e, true);
  e.state = async () => s;
  e.rpc = new Proxy({}, { get() { throw new Error('Network is forbidden in local benchmark'); } });
  const swap = { mint: s.baseMint.toBase58(), pool: s.poolKey.toBase58() };
  const wire = JSON.stringify(fixture({ encoding: 'base64', alt: true }));
  const coldAt = performance.now(); await e.buildSwap('buy', swap); const coldMs = performance.now() - coldAt;
  const parseTimes = [], buildTimes = [], journalTimes = [];
  for (let i = 0; i < 220; i++) {
    const p = performance.now(); parseSwaps(JSON.parse(wire));
    if (i >= 20) parseTimes.push(performance.now() - p);
    const b = performance.now(); await e.buildSwap('buy', swap);
    if (i >= 20) buildTimes.push(performance.now() - b);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helius-latency-'));
  const store = new Store(path.join(dir, 'state.json'), 'paper', 'synthetic');
  try {
    for (let i = 0; i < 20; i++) store.data.positions[`synthetic-${i}`] = { ...swap, rawAmount: '100000000', entryPrice: 0.000001, openedAt: Date.now() };
    for (let i = 0; i < 1000; i++) store.data.seen[`synthetic-signature-${i}`] = Date.now();
    store.data.pending.test = await e.buildSwap('buy', swap);
    for (let i = 0; i < 50; i++) { const t = performance.now(); store.save(); store.save(); journalTimes.push(performance.now() - t); }
  } finally { store.close(); }
  console.log(JSON.stringify({ kind: 'synthetic_local_only', node: process.version, platform: process.platform,
    coldBuildSignMs: +coldMs.toFixed(3), results: [stats('decode_one_small_tx', parseTimes), stats('sdk_build_sign_no_rpc', buildTimes), stats('two_durable_saves_20_positions_1000_seen', journalTimes)] }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
