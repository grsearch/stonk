'use strict';
const { performance } = require('node:perf_hooks');
const { readConfig } = require('../src/config');
async function main() {
  const c = readConfig();
  const endpoints = [
    ['SLC', 'http://slc-sender.helius-rpc.com/ping'],
    ['EWR', 'http://ewr-sender.helius-rpc.com/ping'],
    ['Global HTTPS', 'https://sender.helius-rpc.com/ping'],
  ];
  console.log('Read-only latency benchmark; no wallet signing or transaction submission.');
  const rows = [];
  for (const [name, url] of endpoints) {
    const samples = []; let failed = 0;
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        await response.text();
        if (!response.ok) throw new Error('HTTP error');
        if (i > 0) samples.push(performance.now() - start);
      } catch (_) { failed++; }
    }
    samples.sort((a, b) => a - b);
    rows.push({ endpoint: name, samples: samples.length, failed,
      p50Ms: samples.length ? +samples[Math.floor((samples.length - 1) * 0.5)].toFixed(1) : null,
      p95Ms: samples.length ? +samples[Math.ceil((samples.length - 1) * 0.95)].toFixed(1) : null });
  }
  const start = performance.now();
  try {
    const response = await fetch(c.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error('RPC error');
    rows.push({ endpoint: 'Configured RPC (one request)', p50Ms: +(performance.now() - start).toFixed(1) });
  } catch (_) { rows.push({ endpoint: 'Configured RPC', failed: 1 }); }
  console.table(rows);
  console.log('Run this on the Tencent Silicon Valley server. Ping latency is not transaction landing latency.');
}
main().catch(() => { console.error('Benchmark configuration invalid; check helius/.env.'); process.exitCode = 1; });
