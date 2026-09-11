'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const DAY = 86400000;
// 07:00 Asia/Shanghai = 23:00 UTC on the preceding date; no host timezone dependency.
function latestEnd(now = Date.now()) { return Math.floor((now + 3600000) / DAY) * DAY - 3600000; }
function dayName(end) { return new Date(end + 8 * 3600000).toISOString().slice(0, 10); }
const PRIVATE = /secret|private.?key|api.?key|authorization|security.?token|password|signed|serialized|rawtransaction|rawtx|^bytes$|^wire$/i;
function scrub(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]');
    return value.replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, '[endpoint]');
  }
  if (Array.isArray(value)) return value.map(v => scrub(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, PRIVATE.test(k) ? '[redacted]' : scrub(v, secrets)]));
  return value;
}
function publicConfig(c) {
  const keys = ['market', 'liveEntryPolicy', 'calibration', 'dryRun', 'paperPrebuyFilter', 'minSellSol', 'minImpact', 'maxImpact', 'minLiquidity', 'sizeSol', 'maxPositions', 'cooldownMs',
    'maxSignalAgeMs', 'takeProfit', 'stopLoss', 'trailArm', 'trailDrop', 'maxHoldMs', 'buySlippageBps', 'sellSlippageBps',
    'closeAfterMs', 'cleanupIntervalMs', 'blockhashMs', 'positionPollMs', 'computeUnits', 'priorityLamports', 'tipLamports',
    'maxBytesPerDay', 'maxCandidatesPerMinute'];
  return { exitRetryVersion: 1, streamTrafficVersion: 2, liveEntryGuardVersion: 1, liveEntryMaxFurtherDropPct: 20, executionExtensionsVersion: 1, ...Object.fromEntries(keys.map(k => [k, c[k]])), shadow: c.shadow && Object.fromEntries(Object.entries(c.shadow).filter(([k]) => !['directory', 'modelFile'].includes(k))) };
}
function publicState(data) {
  const pendingKeys = ['side', 'mint', 'signature', 'submittedAt', 'lastValidBlockHeight', 'ata', 'reason', 'createdByBot', 'warned'];
  return { calibration: data.calibration, version: data.version, mode: data.mode, wallet: data.wallet, positions: data.positions, cleanup: data.cleanup,
    pending: Object.fromEntries(Object.entries(data.pending || {}).map(([k, p]) => [k, Object.fromEntries(pendingKeys.filter(n => p[n] !== undefined).map(n => [n, p[n]]))])),
    cooldown: data.cooldown, lossCooldowns: data.lossCooldowns, streamDays: data.streamDays, exitRetryBudget: data.exitRetryBudget };
}
async function atomicJSON(file, data) {
  const fd = await fsp.open(`${file}.tmp`, 'w', 0o600);
  try { await fd.writeFile(JSON.stringify(data, null, 2)); await fd.sync(); } finally { await fd.close(); }
  await fsp.rename(`${file}.tmp`, file);
}
async function digest(file) { const hash = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) hash.update(b); return hash.digest('hex'); }

// Only newline-terminated records from a fixed byte boundary are included. An active writer
// may append after this boundary; partial records are reported, not guessed or repaired.
async function* records(source, stats) {
  if (!source.size) return;
  let tail = '', line = 0, endOffset = 0;
  for await (const chunk of fs.createReadStream(source.file, { start: 0, end: source.size - 1, encoding: 'utf8' })) {
    tail += chunk;
    let nl;
    while ((nl = tail.indexOf('\n')) >= 0) {
      const text = tail.slice(0, nl); tail = tail.slice(nl + 1); line++; endOffset += Buffer.byteLength(text + '\n');
      try { const r = JSON.parse(text); if (!r || typeof r !== 'object') throw new Error(); yield { r, line, endOffset }; }
      catch (_) { if (stats) stats.invalidLines++; }
    }
    if (tail.length > 32 * 1024 * 1024) throw new Error('Report source line exceeds 32 MB');
  }
  if (tail && stats) stats.partialLines++;
}
function timeOf(r) { return typeof r.at === 'number' ? r.at : Date.parse(r.time); }
async function buildArchive({ c, outputDir, end, start = end - DAY, manual = false, secrets = [], now = Date.now(), previousSources }) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || (!manual && start !== end - DAY)) throw new Error('Invalid archive window');
  const folder = path.join(outputDir, manual ? `manual-${new Date(end).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}` : dayName(end));
  await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  const sources = [];
  const files = [...new Set([`${c.stateFile}.jsonl`, path.join(path.dirname(c.stateFile), 'paper.json.jsonl'), path.join(path.dirname(c.stateFile), 'live.json.jsonl'), path.join(path.dirname(c.stateFile), 'calibration.json.jsonl')].map(f => path.resolve(f)))];
  const shadows = await fsp.readdir(c.shadow.directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  files.push(...shadows.filter(n => /^samples-.*\.jsonl$/.test(n)).map(n => path.join(c.shadow.directory, n)));
  for (const file of files) {
    const stat = await fsp.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isFile()) sources.push({ file, id: crypto.createHash('sha256').update(file).digest('hex').slice(0, 16), name: path.basename(file), size: stat.size, dataset: path.basename(file).startsWith('samples-') ? 'shadow' : 'trading' });
  }
  const stats = { windowRecords: 0, contextRecords: 0, invalidLines: 0, partialLines: 0, timestampMissing: 0, byType: {}, firstEventAt: null, lastEventAt: null };
  const ids = new Set(), tradeKeys = new Set();
  const inWindow = r => timeOf(r) >= start && timeOf(r) < end;
  const prior = new Map((previousSources || []).map(s => [s.id, s.size]));
  const sourceChanges = (previousSources || []).filter(old => !sources.some(s => s.id === old.id && s.size >= old.size)).map(s => ({ source: s.name, reason: 'missing_or_shorter_than_previous_export' }));
  const late = (source, r, offset) => previousSources && timeOf(r) < start && offset > (prior.get(source.id) || 0);
  for (const source of sources) for await (const { r, endOffset } of records(source, stats)) {
    if (!Number.isFinite(timeOf(r))) stats.timestampMissing++;
    if (inWindow(r) || late(source, r, endOffset)) {
      if (r.id) ids.add(r.id);
      for (const k of [r.buySignature, r.signal, r.sourceSignature, r.positionId, r.signature, r.key]) if (k) tradeKeys.add(k);
    }
  }
  const manifest = { schema: 1, kind: manual ? 'manual_analysis_archive' : 'daily_analysis_archive', timezone: 'Asia/Shanghai', window: { start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString(), beijingDate: dayName(end) },
    snapshotAt: new Date(now).toISOString(), sources: sources.map(({ id, name, size, dataset }) => ({ id, name, size, dataset })), sourceChanges,
    scope: 'All available local trading and shadow records in window plus linked earlier context; not all raw chain transactions',
    analysisChecklist: ['Separate paper results, confirmed live fills and shadow proxy labels.',
      'Reconstruct trades across days; assess entry delay, exit reasons, drawdown, cost and net expectancy.',
      'Measure candidate exclusions, missing coverage and training-eligible samples before quoting win rates.',
      'Evaluate rebound and strategy-profit targets separately; check calibration by date and unseen mint.',
      'Compare dump size, liquidity, price impact and prior buy/sell flow with outcomes.',
      'Report Helius traffic estimates and RPC counters separately from actual billed usage.',
      'Suggest parameter changes only with independent subsequent validation; do not infer unknown fees or fills.'],
    limitations: ['No proof of uninterrupted observation; inspect health and coverage_gap records.', 'State/config snapshots are export-time, not boundary-time.',
      'Outcomes not yet written appear in a later daily archive; deduplicate linked context across days.', 'Missing logs, process crashes and parser exclusions cannot be reconstructed.',
      'Shadow labels are counterfactual estimates, not actual fills. No live profitability guarantee.'], config: publicConfig(c) };
  async function* rows() {
    yield JSON.stringify({ dataset: 'manifest', record: manifest }) + '\n';
    for (const source of sources) for await (const { r, line, endOffset } of records(source)) {
      const inside = inWindow(r);
      const context = !Number.isFinite(timeOf(r)) || (timeOf(r) < end && (late(source, r, endOffset) || r.type === 'session' || r.type === 'starting' || (r.id && ids.has(r.id))
        || [r.signature, r.signal, r.sourceSignature, r.positionId, r.key].some(k => k && tradeKeys.has(k))));
      if (!inside && !context) continue;
      if (inside) {
        stats.windowRecords++; const key = `${source.dataset}:${r.type || 'unknown'}`; stats.byType[key] = (stats.byType[key] || 0) + 1;
        stats.firstEventAt = Math.min(stats.firstEventAt ?? Infinity, timeOf(r)); stats.lastEventAt = Math.max(stats.lastEventAt ?? -Infinity, timeOf(r));
      } else stats.contextRecords++;
      yield JSON.stringify({ dataset: source.dataset, source: source.name, sourceId: source.id, line, context: !inside, record: scrub(r, secrets) }) + '\n';
    }
    const stateFiles = [...new Set([c.stateFile, path.join(path.dirname(c.stateFile), 'paper.json'), path.join(path.dirname(c.stateFile), 'live.json'), path.join(path.dirname(c.stateFile), 'calibration.json')].map(f => path.resolve(f)))];
    for (const file of stateFiles) {
      try { const data = JSON.parse(await fsp.readFile(file, 'utf8')); yield JSON.stringify({ dataset: 'state_snapshot', source: path.basename(file), record: scrub(publicState(data), secrets) }) + '\n'; }
      catch (e) { if (e.code !== 'ENOENT') throw new Error('Could not read consistent state snapshot'); }
    }
    for (const modelFile of new Set([c.shadow.modelFile, c.shadow.drawdownModelFile, c.shadow.riskModelFile, c.shadow.returnModelFile].filter(Boolean))) {
      for (const file of [modelFile, `${modelFile}.report.json`]) {
        try {
          if ((await fsp.stat(file)).size > 1024 * 1024) throw new Error('Model report exceeds 1 MB');
          yield JSON.stringify({ dataset: 'model_snapshot', source: path.basename(file), record: scrub(JSON.parse(await fsp.readFile(file, 'utf8')), secrets) }) + '\n';
        } catch (e) { if (e.code !== 'ENOENT') throw new Error('Invalid model snapshot'); }
      }
    }
    yield JSON.stringify({ dataset: 'summary', record: stats }) + '\n';
  }
  const file = path.join(folder, 'analysis.jsonl.gz');
  await pipeline(Readable.from(rows()), zlib.createGzip({ level: 1 }), fs.createWriteStream(`${file}.tmp`, { mode: 0o600 }));
  const durable = await fsp.open(`${file}.tmp`, 'r+');
  try { await durable.sync(); } finally { await durable.close(); }
  await fsp.rename(`${file}.tmp`, file);
  const summary = { ...manifest, stats, bytes: (await fsp.stat(file)).size, sha256: await digest(file),
    dataQuality: sourceChanges.length || stats.invalidLines || stats.partialLines || stats.timestampMissing || !stats.windowRecords ? 'needs_review' : 'local_records_exported_coverage_unverified' };
  await atomicJSON(path.join(folder, 'summary.json'), summary);
  return { folder, file, summary };
}
module.exports = { DAY, latestEnd, dayName, scrub, publicConfig, publicState, atomicJSON, digest, records, buildArchive };
