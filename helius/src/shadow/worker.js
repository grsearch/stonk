'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parentPort, workerData: config } = require('node:worker_threads');
const { Tracker } = require('./tracker');

const runId = crypto.randomUUID();
fs.mkdirSync(config.directory, { recursive: true });
const name = `samples-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`;
const fd = fs.openSync(path.join(config.directory, name), 'wx', 0o600);
let lines = [], bytes = 0, closing = false;
function flush() {
  if (!lines.length) return;
  const data = lines.join(''); lines = []; bytes = 0;
  fs.writeFileSync(fd, data); fs.fsyncSync(fd);
}
function write(record) {
  const line = JSON.stringify(record) + '\n'; lines.push(line); bytes += Buffer.byteLength(line);
  if (bytes >= 1024 * 1024) flush();
}
const tracker = new Tracker(config, r => write({ ...r, ...(config.calibration?.enabled ? { calibrationRole: 'same_size' } : {}) }), { runId });
const reference = config.calibration?.enabled ? new Tracker({ ...config, sizeSol: 1, stateQuotes: false,
  exitComparisons: false, entryComparisons: false }, r => write({ ...r, calibrationRole: 'reference_1_sol' }), { runId: runId + '-reference' }) : null;
const ageFile = path.join(config.directory, 'migration-age-cache.json');
let ageCacheStatus = 'missing';
try {
  if (fs.statSync(ageFile).size <= 16 * 1024 * 1024) {
    const entries = JSON.parse(fs.readFileSync(ageFile, 'utf8'));
    if (Array.isArray(entries)) { for (const e of entries.slice(-20000)) { tracker.ages.created(e, true); reference?.ages.created(e, true); } ageCacheStatus = 'loaded'; }
    else ageCacheStatus = 'invalid';
  } else ageCacheStatus = 'oversized';
} catch (e) { ageCacheStatus = e.code === 'ENOENT' ? 'missing' : 'read_failed'; }
let ageDirty = false, lastAgeSave = 0;
function saveAges() {
  if (!ageDirty) return;
  try {
    fs.writeFileSync(`${ageFile}.tmp`, JSON.stringify([...tracker.ages.pools.values()]), { mode: 0o600 });
    fs.renameSync(`${ageFile}.tmp`, ageFile); ageDirty = false; ageCacheStatus = 'saved';
  } catch (_) { ageCacheStatus = 'write_failed'; }
  lastAgeSave = Date.now();
}
function publish(status = 'running') { parentPort.postMessage({ type: 'status', value: { status, ...tracker.stats(), calibrationReference: reference?.stats() ?? null, ageCacheStatus, file: name } }); }
const timer = setInterval(() => {
  tracker.tick(Date.now()); reference?.tick(Date.now()); flush(); if (Date.now() - lastAgeSave >= 60000) saveAges(); publish();
  const targets = tracker.stateTargets(); if (targets.length) parentPort.postMessage({ type: 'state_quote_request', targets });
}, 1000);
parentPort.on('message', msg => {
  if (closing) return;
  if (msg.type === 'close') {
    closing = true; clearInterval(timer); tracker.gap('process_shutdown', msg.at); reference?.gap('process_shutdown', msg.at); flush(); saveAges(); fs.closeSync(fd); publish('closed'); parentPort.close(); return;
  }
  if (msg.type !== 'batch') return;
  for (const event of msg.events) {
    if (event.type === 'state_quotes') tracker.stateQuotes(event.results);
    if (event.type === 'swap') {
      const filterStartedAt = Date.now();
      const selection = tracker.onSwap(event.swap, event.candidate, event.fresh);
      if (event.filterId) parentPort.postMessage({ type: 'paper_filter', filterId: event.filterId,
        queueMs: Math.max(0, filterStartedAt - (event.enqueuedAt || filterStartedAt)), computeMs: Date.now() - filterStartedAt,
        selection: selection ? { selectionId: selection.selectionId, arm: selection.arms.prebuyCombined } : null });
      reference?.onSwap(event.swap, event.candidate, event.fresh);
    }
    if (event.type === 'pool_created' && tracker.ages.created(event.event)) {
      reference?.ages.created(event.event);
      ageDirty = true; tracker.emit({ type: config.market === 'stonk' ? 'stonk_migrated' : 'pump_migrated', at: event.event.observedAt, ...event.event });
    }
    if (event.type === 'pool_expired') tracker.poolExpired(event.pool, event.at);
    if (event.type === 'pool_gap') tracker.poolExpired(event.pool, event.at, event.reason);
    if (event.type === 'connection') { tracker.connection(event.connected, event.at); reference?.connection(event.connected, event.at); }
    if (event.type === 'gap') { tracker.gap(event.reason, event.at); tracker.connection(true, event.at); reference?.gap(event.reason, event.at); reference?.connection(true, event.at); }
    if (event.type === 'decision') { tracker.decision(event.key, event.status, event.at, event.extra); reference?.decision(event.key, event.status, event.at, event.extra); }
  }
  // A delayed queue may conservatively censor samples; it must never invent coverage.
  parentPort.postMessage({ type: 'ack' });
});
publish();
