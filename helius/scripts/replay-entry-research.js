'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), readline = require('node:readline');
const { EntryComparisons } = require('../src/shadow/entry-comparisons');
const { buyQuote, liquidationDetails } = require('../src/shadow/tracker');
const { entryAudit } = require('../src/reporting/entry-audit');
const { digest } = require('../src/reporting/archive');
const { checkInspectionBytes } = require('./inspect-export');
const { selection } = require('../src/shadow/selection');
function eligible(s) {
  return selection({}, {}, s.decisionFresh === true, null, s.features, s.age).arms.prebuyCombined.status === 'pass';
}
async function replay(directory, output, windowStart, windowEnd) {
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'))), file = path.join(directory, 'analysis.jsonl.gz');
  if (fs.statSync(file).size !== summary.bytes || await digest(file) !== summary.sha256) throw new Error('Archive checksum/size mismatch');
  const start = windowStart ?? Date.parse(summary.window.start), end = windowEnd ?? Date.parse(summary.window.endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < Date.parse(summary.window.start) || end > Date.parse(summary.window.endExclusive)) throw new Error('Invalid replay window');
  const engines = new Map(), lastSwap = new Map(), results = new Map(), samples = new Set(), seen = new Map(), sampleMints = new Map();
  let bytes = 0, observations = 0, buyerIdentityObservations = 0;
  const stream = fs.createReadStream(file), unzip = zlib.createGunzip(); stream.on('error', e => unzip.destroy(e)); stream.pipe(unzip);
  unzip.on('data', b => { bytes += b.length; try { checkInspectionBytes(bytes); } catch (e) { unzip.destroy(e); } });
  try {
    for await (const line of readline.createInterface({ input: unzip, crlfDelay: Infinity })) {
      const row = JSON.parse(line), r = row.record;
      if (row.dataset !== 'shadow' || !r?.runId || !Number.isFinite(r.at) || r.at >= end) continue;
      const run = r.runId, pk = `${run}:${r.pool}`;
      if (r.type === 'sample' && r.at >= start && !samples.has(r.id)) {
        samples.add(r.id); if (samples.size > 100000) throw new Error('Replay sample limit');
        if (!engines.has(run)) {
          const c = { ...r.policy, maxActive: 1000, maxActivePerPool: 100 };
          if (![c.entryDelayMs, c.entryDeadlineMs, c.maxGapMs, c.maxHoldMs, c.sizeSol, c.feeBps, c.slippageBps, c.networkFeeSol].every(Number.isFinite)) throw new Error('Missing replay policy');
          const engine = new EntryComparisons(c, event => results.set(`${event.id}:${event.variant}`,
            { ...event, runId: run, policyId: r.policyId, source: 'archived_stream_entry_replay', mint: sampleMints.get(event.id) }), { buyQuote, liquidationDetails });
          engines.set(run, { engine, at: r.at, nextTick: r.at + 1000, policyId: r.policyId });
        }
        const e = engines.get(run); if (e.policyId !== r.policyId) throw new Error('Policy changed within run');
        sampleMints.set(r.id, r.source.mint);
        const trigger = lastSwap.get(`${run}:${r.source.pool}`);
        e.engine.add(r, trigger?.key === r.key ? trigger : { price: NaN }, eligible(r), r.at);
      }
      const e = engines.get(run);
      if (r.type === 'pool_observation') {
        const unique = `${run}:${r.key}`; if (seen.has(unique)) continue;
        seen.set(unique, true); if (seen.size > 100000) seen.delete(seen.keys().next().value);
        lastSwap.set(pk, r); if (lastSwap.size > 20000) lastSwap.delete(lastSwap.keys().next().value);
        if (!e || r.at < start) continue;
        if (r.at < e.at) { e.engine.gap('replay_out_of_order', e.at); continue; }
        // Timer cadence is approximated from first candidate, and explicitly not a claim of live-fill replay.
        while (e.nextTick < r.at && e.engine.active.size) { e.engine.tick(e.nextTick); e.nextTick += 1000; }
        e.nextTick = Math.max(e.nextTick, Math.floor(r.at / 1000) * 1000 + 1000);
        e.at = r.at; observations++; if (r.side === 'buy' && r.user) buyerIdentityObservations++;
        e.engine.observe(r, r.at);
      }
      if (e && r.type === 'coverage_gap' && r.at >= start) e.engine.gap(r.reason || 'archived_gap', r.at);
    }
  } finally { stream.destroy(); unzip.destroy(); }
  for (const e of engines.values()) e.engine.gap('replay_window_end', end);
  const report = { version: 1, window: { start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString() },
    samples: samples.size, observations, buyerIdentityObservations,
    limitations: ['Archived stream is selectively recorded, not the full market stream; missing observations can censor or change results.',
      'Timer cadence is approximate. No RPC recovery or portfolio constraints. Not a real-fill backtest.',
      'Missing buyer identities remain censored; two buy swaps do not establish two buyers.',
      'Observed PnL excludes censored positions; do not rank using known outcomes alone.'],
    audit: entryAudit(results), results: [...results.values()] };
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return { ...report, results: undefined };
}
if (require.main === module) replay(path.resolve(process.argv[2] || '.'), path.resolve(process.argv[3] || 'entry-replay.json'),
  process.argv[4] ? Date.parse(process.argv[4]) : undefined, process.argv[5] ? Date.parse(process.argv[5]) : undefined)
  .then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { replay, eligible };
