'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline');

async function report(file) {
  const input = fs.createReadStream(file);
  const decoded = file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  if (decoded !== input) input.on('error', err => decoded.destroy(err));
  const out = { version: 2, intervals: 0, start: null, end: null, byteCount: 0, categories: {}, reasons: {}, reasonCoveredByteCount: 0,
    otherPoolByteCount: 0, overflowPoolByteCount: 0, unattributedByteCount: 0 };
  const pools = new Map();
  for await (const line of readline.createInterface({ input: decoded, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const envelope = JSON.parse(line), r = envelope.record || envelope;
    if (envelope.context || r.type !== 'stream_traffic' || ![1, 2].includes(r.version)) continue;
    out.intervals++; out.start = Math.min(out.start ?? r.start, r.start); out.end = Math.max(out.end ?? r.end, r.end);
    out.byteCount += r.byteCount;
    if (r.reasons) {
      out.reasonCoveredByteCount += r.byteCount;
      for (const [key, value] of Object.entries(r.reasons)) {
        const row = out.reasons[key] ||= { messages: 0, byteCount: 0 };
        row.messages += value.messages; row.byteCount += value.byteCount;
      }
    }
    for (const [key, value] of Object.entries(r.categories)) {
      const c = out.categories[key] ||= { messages: 0, byteCount: 0 };
      c.messages += value.messages; c.byteCount += value.byteCount;
    }
    for (const key of ['otherPoolByteCount', 'overflowPoolByteCount', 'unattributedByteCount']) out[key] += r[key];
    for (const p of r.topPools) {
      const row = pools.get(p.pool) || { pool: p.pool, byteCount: 0, messages: 0 };
      row.byteCount += p.byteCount; row.messages += p.messages; pools.set(p.pool, row);
    }
  }
  out.categoryTotalMatches = Object.values(out.categories).reduce((s, c) => s + c.byteCount, 0) === out.byteCount;
  for (const c of Object.values(out.categories)) c.percent = out.byteCount ? c.byteCount / out.byteCount * 100 : 0;
  for (const r of Object.values(out.reasons)) r.percentOfCoveredBytes = out.reasonCoveredByteCount ? r.byteCount / out.reasonCoveredByteCount * 100 : 0;
  out.topPools = [...pools.values()].sort((a, b) => b.byteCount - a.byteCount).slice(0, 30);
  out.note = 'Pool ranking sums interval top-20 entries only: lower bounds, not exact full-window ranking. Multi-pool transactions split equally. Intervals may straddle export boundaries. Missing telemetry cannot be reconstructed from old archives. Received application bytes are not an account billing statement.';
  return out;
}
if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: node helius/scripts/stream-traffic-report.js analysis.jsonl.gz'); process.exitCode = 1; }
  else report(process.argv[2]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { report };
