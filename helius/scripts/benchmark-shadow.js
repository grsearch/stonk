'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const ShadowClient = require('../src/shadow/client');
const { readConfig } = require('../src/config');
async function main() {
  const config = readConfig({ HELIUS_API_KEY: 'synthetic-only', DRY_RUN: 'true' });
  config.shadow.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-benchmark-'));
  const client = new ShadowClient(config), times = [], deadline = Date.now() + 20000;
  client.connection(true);
  try {
    for (let batch = 0; batch < 100; batch++) {
      while (client.inFlight || client.queue.length) {
        if (!client.enabled || Date.now() > deadline) throw new Error('Shadow worker could not keep up in this benchmark');
        await new Promise(r => setTimeout(r, 1));
      }
      const at = Date.now(), start = performance.now();
      for (let i = 0; i < 64; i++) {
        const n = batch * 64 + i;
        client.observe({ signature: `synthetic-${n}`, pool: `pool-${n % 20}`, mint: `mint-${n % 20}`, user: `user-${n % 50}`,
          side: n % 2 ? 'sell' : 'buy', slot: Math.floor(at / 400), receivedAt: at, eventTime: at,
          price: 1e-9, postBase: '100000000000', postQuote: '100000000000', virtual: '0', quoteSol: 8,
          sellSol: 8, impact: 20, liquidity: 100 }, n % 50 === 1, true);
      }
      client.pump(); // Include structured cloning/postMessage, not just pushing to a local array.
      times.push((performance.now() - start) / 64);
    }
  } finally { await client.close(); }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ kind: 'synthetic_shadow_main_thread_only', platform: process.platform, node: process.version,
    events: 6400, batchSize: 64, p50MsPerEvent: +times[50].toFixed(4), p95MsPerEvent: +times[94].toFixed(4),
    dropped: client.dropped, workerStatus: client.status, includesWorkerProcessing: false, includesNetwork: false }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
