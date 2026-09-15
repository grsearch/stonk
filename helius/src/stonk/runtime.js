'use strict';
const { Engine } = require('../engine');
const Store = require('../store');
const ShadowClient = require('../shadow/client');
const { StateQuotes } = require('../shadow/state-quotes');
const { publicConfig } = require('../reporting/archive');
const { Monitor } = require('./monitor');
const { Adapter } = require('./adapter');
const { Valuation } = require('./valuation');
const { publicKey } = require('./accounts');
const { active } = require('./protocol');
const { FreshPools } = require('../fresh-pools');
const { diagnostic } = require('./diagnostics');
// Deliberately contains no signer, wallet, Sender or transaction construction implementation.
class PaperExecutor {
  constructor() { this.rpcCalls = 0; }
  async start() {}
  stop() {}
  async buildSwap() { throw Error('Stonk live execution disabled'); }
  async submit() { throw Error('Stonk live execution disabled'); }
  async closeAccount() { throw Error('Stonk live execution disabled'); }
}
class Runtime {
  constructor(c, { monitorOptions = {}, workerFactory, store } = {}) {
    if (c.market !== 'stonk' || !c.shadow.enabled || c.calibration.enabled) throw Error('Stonk requires paper and Shadow');
    this.c = c; this.executor = c.dryRun ? new PaperExecutor() : new (require('./live-executor').LiveExecutor)(c);
    this.store = store || new Store(c.stateFile, c.dryRun ? 'paper' : 'live', c.dryRun ? 'stonk-paper' : this.executor.wallet.publicKey.toBase58());
    this.fresh = new FreshPools(this.store, { market: 'stonk' });
    this.monitor = new Monitor(c.stonk, { ...monitorOptions,
      shouldSubscribe: pool => this.fresh.addresses().includes(pool),
      onPool: p => this.pool(p), onSwap: (s, at) => this.swap(s, at), onExpired: pool => { this.engine.expirePool(pool); this.adapter.cache.delete(pool); },
      onConnection: connected => { this.stream.connected = connected; this.shadow.connection(connected); },
      onGap: reason => this.shadow.enqueue({ type: 'gap', reason, at: Date.now() }) });
    const rpc = async (...args) => { this.executor.rpcCalls++; return this.monitor.rpc(...args); };
    this.adapter = new Adapter(rpc, new Valuation(rpc));
    this.stream = { fresh: this.fresh, connected: false, budgetExceeded: () => this.monitor.dayUsage().bytes >= c.stonk.maxBytes };
    this.stateQuotes = new StateQuotes(c, { keys: s => this.adapter.keys(s),
      validate: s => { if (!active(s, Date.now())) throw Error('Graduation window ended'); for (const key of this.adapter.keys(s)) publicKey(key); },
      decode: (s, values, slot) => this.adapter.state(s, values, slot),
      request: async (_url, options) => { const body = JSON.parse(options.body); const result = await rpc(body.method, body.params, { signal: options.signal });
        return { ok: true, json: async () => ({ result }) }; } });
    this.shadow = new ShadowClient(c, { stateQuotes: this.stateQuotes, ...(workerFactory ? { workerFactory } : {}) });
    const EngineType = c.dryRun ? Engine : require('./live-engine').LiveEngine;
    this.engine = new EngineType(c, this.store, this.executor, this.stream, this.shadow);
    this.preparing = new Map();
    this.coverage = { valued: 0, unvalued: 0, reasons: {} };
  }
  pool(p) {
    const event = { ...p, source: 'stonk_migrate_confirmed', createdAt: p.graduatedAt, migrationAt: p.graduatedAt, observedAt: Date.now() };
    this.fresh.created(event);
    this.shadow.poolCreated(event);
    this.monitor.syncSubscriptions();
    this.warm(p);
  }
  warm(p) {
    if (this.preparing.has(p.pool)) return;
    const task = this.adapter.prepare(p).then(q => {
      this.fresh.reserve(p.pool, q.liquidity, q.slot);
      this.monitor.syncSubscriptions();
    }).catch(e => this.store.log('stonk_valuation_unavailable', { pool: p.pool, quoteMint: p.quoteMint,
      ...diagnostic(e), valuationDetails: e.valuationDetails })).finally(() => this.preparing.delete(p.pool));
    this.preparing.set(p.pool, task);
  }
  async swap(s, at) {
    if (this.engine.stopped) return;
    this.engine.ticks++;
    try {
      const normalized = await this.adapter.swap(s, at);
      if (!active(s, Date.now()) || this.engine.stopped) return;
      this.coverage.valued++;
      this.engine.onSwaps([normalized]);
    } catch (e) {
      this.coverage.unvalued++;
      const details = diagnostic(e); this.coverage.reasons[details.reason] = (this.coverage.reasons[details.reason] || 0) + 1;
      this.store.log('stonk_unvalued_observation', { pool: s.pool, mint: s.mint, quoteMint: s.quoteMint, signature: s.signature,
        ...details, valuationDetails: e.valuationDetails, rawObservation: s });
      // Unknown valuation must break the proxy's coverage, not create profitable labels.
      this.shadow.enqueue({ type: 'pool_gap', pool: s.pool, reason: 'valuation_unavailable', at: Date.now() });
    }
  }
  start() {
    for (const p of Object.values(this.store.data.positions)) if (!active(p, Date.now())) this.engine.expirePool(p.pool);
    this.store.log('starting', { mode: this.c.dryRun ? 'paper' : 'live', market: 'stonk', liveExecution: this.c.dryRun ? 'disabled' : 'raydium_atomic', strategyConfig: publicConfig(this.c) });
    this.monitor.start();
    this.tick = setInterval(() => this.engine.tick(), 1000);
    this.reportTimer = setInterval(() => this.report(), 60000);
    this.warmTimer = setInterval(() => {
      const subscribed = new Set(this.fresh.addresses());
      for (const p of this.monitor.pools.values()) if (subscribed.has(p.pool)) this.warm(p);
    }, 10000);
    this.report();
  }
  report() {
    this.fresh.prune();
    this.stream.stonkHealth = { ...this.coverage, discoveryComplete: this.monitor.health.discoveryComplete,
      discoveryError: this.monitor.health.discoveryError, processingErrors: this.monitor.stats.processingErrors || 0 };
    this.executor.rpcCalls = this.monitor.totalRpc;
    this.store.data.streamDays = Object.fromEntries(Object.entries(this.monitor.usage).map(([day, usage]) => [day, usage.bytes]));
    this.engine.report();
  }
  async stop() {
    this.engine.stopped = true; clearInterval(this.tick); clearInterval(this.reportTimer); clearInterval(this.warmTimer);
    await this.monitor.stop(); await Promise.allSettled(this.preparing.values());
    while (this.engine.busy || this.engine.ticking) await new Promise(r => setTimeout(r, 10));
    await this.shadow.close(); this.report(); this.store.close();
  }
}
module.exports = { Runtime, PaperExecutor };
