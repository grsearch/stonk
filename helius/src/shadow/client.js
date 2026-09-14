'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class ShadowClient {
  constructor(c, { workerFactory = (file, options) => new Worker(file, options), stateQuotes } = {}) {
    this.status = { status: 'disabled' }; this.enabled = !!c.shadow?.enabled;
    this.queue = []; this.inFlight = false; this.scheduled = false; this.dropped = 0; this.needsGap = false;
    this.accepting = true; this.exited = false; this.drain = null;
    this.filterTiming = { version: 1, requests: 0, responses: 0, timeouts: 0, lateResponses: 0,
      maxQueueMs: 0, maxComputeMs: 0, maxRoundTripMs: 0 };
    this.paperFilter = (c.dryRun && c.paperPrebuyFilter) || !!c.calibration?.enabled; this.filters = new Map(); this.filterSequence = 0;
    if (!this.enabled) return;
    this.stateQuotes = stateQuotes || new (require('./state-quotes').StateQuotes)(c);
    // Never serialize the wallet secret or the API URL/key into a learning event or workerData.
    const config = { ...c.shadow, market: c.market, freshSubscriptions: c.freshSubscriptions, calibration: c.calibration, sizeSol: c.sizeSol, takeProfit: c.takeProfit, stopLoss: c.stopLoss,
      trailArm: c.trailArm, trailDrop: c.trailDrop, maxHoldMs: c.maxHoldMs,
      minSellSol: c.minSellSol, minImpact: c.minImpact, maxImpact: c.maxImpact, minLiquidity: c.minLiquidity,
      maxSourceLagMs: c.maxSignalAgeMs + 1000,
      networkFeeSol: (5000 + c.priorityLamports + c.tipLamports) / 1e9 };
    try {
      this.worker = workerFactory(path.join(__dirname, 'worker.js'), { workerData: config,
        resourceLimits: { maxOldGenerationSizeMb: c.calibration?.enabled ? 512 : 256 }, env: {} });
      this.status = { status: 'starting' };
      this.worker.on('message', msg => {
        if (msg.type === 'paper_filter') {
          const f = this.filterTiming;
          f.maxQueueMs = Math.max(f.maxQueueMs, msg.queueMs || 0);
          f.maxComputeMs = Math.max(f.maxComputeMs, msg.computeMs || 0);
          if (this.filters.has(msg.filterId)) { f.responses++; this.filters.get(msg.filterId)(msg.selection); }
          else f.lateResponses++;
        }
        if (msg.type === 'ack') { this.inFlight = false; this.pump(); }
        if (msg.type === 'status') this.status = msg.value;
        if (msg.type === 'state_quote_request' && this.accepting) {
          this.stateQuotes.poll(msg.targets).then(results => { if (results.length) this.enqueue({ type: 'state_quotes', results }); })
            .catch(() => { /* Fail closed; transport never logs URLs or server error text. */ });
        }
      });
      this.worker.on('error', () => { this.stateQuotes.close(); this.enabled = false; this.status = { status: 'worker_error' }; this.queue = []; });
      this.worker.on('exit', code => { this.exited = true; this.enabled = false; this.queue = []; this.status = { ...this.status, workerExitCode: code }; this.resolveClose?.(); });
      this.worker.unref();
    } catch (_) { this.enabled = false; this.status = { status: 'worker_unavailable' }; }
  }
  enqueue(message) {
    if (!this.enabled || !this.accepting) return;
    if (this.queue.length >= 4096) { this.dropped += this.queue.length; this.queue = []; this.needsGap = true; }
    this.queue.push(message);
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; this.pump(); }); }
  }
  pump() {
    if (!this.enabled || this.inFlight) return;
    if (!this.queue.length && !this.needsGap) { this.drain?.(); return; }
    const events = this.queue.splice(0, 128);
    if (this.needsGap) { events.unshift({ type: 'gap', reason: 'main_queue_overflow', at: Date.now() }); this.needsGap = false; }
    this.inFlight = true;
    try { this.worker.postMessage({ type: 'batch', events }); }
    catch (_) { this.enabled = false; this.status = { status: 'worker_send_error' }; }
  }
  observe(swap, candidate, fresh) {
    const enqueuedAt = Date.now();
    let filterId, result;
    if (this.paperFilter && candidate && fresh && this.enabled && this.accepting && this.filters.size < 128) {
      filterId = ++this.filterSequence;
      this.filterTiming.requests++;
      result = new Promise(resolve => {
        const finish = value => {
          this.filterTiming.maxRoundTripMs = Math.max(this.filterTiming.maxRoundTripMs, Date.now() - enqueuedAt);
          clearTimeout(timer); this.filters.delete(filterId); resolve(value);
        };
        const timer = setTimeout(() => { this.filterTiming.timeouts++; finish(null); }, 250);
        this.filters.set(filterId, finish);
      });
    }
    this.enqueue({ type: 'swap', swap: { ...swap }, candidate, fresh, filterId, enqueuedAt });
    return result;
  }
  poolCreated(event) { this.enqueue({ type: 'pool_created', event }); }
  poolExpired(pool, at = Date.now()) { this.enqueue({ type: 'pool_expired', pool, at }); }
  connection(connected) { this.enqueue({ type: 'connection', connected, at: Date.now() }); }
  decision(swap, status, extra = {}) {
    this.enqueue({ type: 'decision', key: `${swap.signature}:${swap.pool}`, status, at: Date.now(), extra });
  }
  stats() { return { ...this.status, filterTiming: { ...this.filterTiming }, stateQuotes: this.stateQuotes?.stats() ?? null, queueDepth: this.queue.length, dropped: this.dropped }; }
  async close() {
    this.accepting = false;
    for (const finish of this.filters.values()) finish(null);
    this.stateQuotes?.close();
    if (!this.worker || this.exited) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.worker.terminate().finally(resolve); }, 4000);
      this.resolveClose = () => { clearTimeout(timer); resolve(); };
      this.drain = () => { this.drain = null; this.worker.postMessage({ type: 'close', at: Date.now() }); };
      if (this.enabled) this.pump(); else { clearTimeout(timer); this.worker.terminate().finally(resolve); }
    });
  }
}
module.exports = ShadowClient;
