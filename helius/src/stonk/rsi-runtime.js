'use strict';
const Store = require('../store');
const { FreshPools } = require('../fresh-pools');
const { Monitor } = require('./monitor');
const { Adapter } = require('./adapter');
const { Valuation } = require('./valuation');
const { LiveExecutor } = require('./live-executor');
const { RsiEngine } = require('./rsi-engine');
const { Birdeye } = require('./birdeye');
const { active, decode58 } = require('./protocol');
const { rsi, candles, flow, BAR_MS } = require('./rsi');
const { publicConfig } = require('../reporting/archive');
class RsiRuntime {
  constructor(c, { store, monitorOptions = {}, executor, birdeye } = {}) {
    if (c.dryRun || !c.birdeyeApiKey || c.shadow.enabled) throw Error('RSI requires explicit live mode, Birdeye and Shadow disabled');
    this.c = c; this.executor = executor || new LiveExecutor(c);
    this.store = store || new Store(c.stateFile, 'live', this.executor.wallet.publicKey.toBase58());
    this.fresh = new FreshPools(this.store, { market: 'stonk' });
    this.birdeye = birdeye || new Birdeye(c.birdeyeApiKey);
    this.states = new Map(); this.coverage = { valued: 0, unvalued: 0 }; this.working = new Map();
    this.shadow = { close: async () => {} }; // Compatibility with startup cleanup; no worker or tests run.
    const retained = pool => Object.values(this.store.data.positions).some(p => p.pool === pool) ||
      Object.values(this.store.data.pending).some(p => p.swap?.pool === pool);
    this.retained = retained;
    this.monitor = new Monitor(c.stonk, { ...monitorOptions, retainPool: retained,
      shouldSubscribe: pool => retained(pool) || this.fresh.addresses().includes(pool),
      onPool: p => this.pool(p), onSwap: (s, at) => this.swap(s, at),
      onExpired: pool => { if (!retained(pool)) this.states.delete(pool); },
      onConnection: value => { this.stream.connected = value; if (!value) this.resetFlow(); },
      onGap: () => this.resetFlow() });
    const rpc = (...args) => this.monitor.rpc(...args);
    this.adapter = new Adapter(rpc, new Valuation(rpc), Date.now, (p, now) => active(p, now) || retained(p.pool));
    this.stream = { connected: false, fresh: this.fresh, budgetExceeded: () => false };
    this.engine = new RsiEngine(c, this.store, this.executor, this.stream);
    this.store.data.rsiEpisodes ||= {};
    for (const p of Object.values(this.store.data.positions)) {
      // Never silently apply a new exit policy to a legacy position on restart.
      if (p.strategy !== 'rsi') throw Error('Legacy position must finish before RSI activation');
    }
  }
  resetFlow() { for (const state of this.states.values()) { state.flow = []; state.flowSince = Date.now(); } }
  pool(p) {
    this.fresh.created({ ...p, source: 'stonk_migrate_confirmed', createdAt: p.graduatedAt, migrationAt: p.graduatedAt });
    if (!this.states.has(p.pool)) this.states.set(p.pool, { pool: p, items: new Map(), flow: [], flowSince: Date.now(), last: null, nextPoll: 0 });
    this.monitor.syncSubscriptions();
  }
  stopObserving(pool, reason, detail = {}) {
    this.fresh.close(pool, reason, Date.now());
    this.store.log('rsi_monitor_closed', { pool, reason, ...detail });
    this.monitor.syncSubscriptions();
  }
  fdv(q, state) {
    if (!this.sol || Date.now() - this.sol.at > 60000 || !(Number(q.supplyRaw) > 0)) { state.fdvAt = 0; return false; }
    const fdvUsd = q.price * Number(q.supplyRaw) * this.sol.value;
    if (!(fdvUsd > 0 && Number.isFinite(fdvUsd))) { state.fdvAt = 0; return false; }
    state.fdv = fdvUsd; state.fdvAt = Date.now();
    const p = this.fresh.pools[q.pool];
    if (p) { p.fdvUsd = fdvUsd; p.fdvAt = state.fdvAt; }
    if (fdvUsd < this.c.rsi.minFdvUsd && !p?.closedReason) this.stopObserving(q.pool, 'fdv_below_15000_usd', { fdvUsd });
    return fdvUsd >= this.c.rsi.minFdvUsd;
  }
  async swap(s, at) {
    if (this.engine.stopped) return;
    this.engine.ticks++;
    let state = this.states.get(s.pool); if (!state) { this.pool(s); state = this.states.get(s.pool); }
    try {
      const q = await this.adapter.swap(s, at);
      if (this.engine.stopped || q.slot < (state.last?.slot || 0)) return;
      this.coverage.valued++; this.engine.swaps++;
      this.fresh.reserve(s.pool, q.liquidity, q.slot);
      state.last = q;
      if (Date.now() - q.receivedAt <= 3000 && Date.now() - q.eventTime <= 5000 && q.eventTime <= Date.now() + 2000) {
        state.flow.push(q); state.flow = state.flow.filter(t => t.receivedAt > Date.now() - 15000);
      } else { state.flow = []; state.flowSince = Date.now(); }
      this.fdv(q, state);
      const held = this.store.data.positions[q.mint];
      if (held && held.pool === q.pool) Object.assign(held, { slot: q.slot, lastPrice: q.price, lastPriceAt: Date.now() });
      // Full validated observations are kept even when no strategy sample is active.
      this.store.log('rsi_observation', { ...q, fdvUsd: state.fdv, fdvAt: state.fdvAt });
      this.tryEntry(state);
    } catch (e) {
      this.coverage.unvalued++; state.flow = []; state.flowSince = Date.now(); state.fdvAt = 0;
      this.engine.error('rsi_observation', e);
    }
  }
  tryEntry(state) {
    const now = Date.now(), q = state.last, bar = state.bar;
    if (!q || !bar || this.engine.stopped || !this.stream.connected || !active(q, now) || this.fresh.reason(q) ||
      now - state.fdvAt > 15000 || state.fdv < this.c.rsi.minFdvUsd || now - q.receivedAt > this.c.maxSignalAgeMs ||
      now - q.eventTime > this.c.maxSignalAgeMs + 1000 || now - state.flowSince < 15000 ||
      now - (bar.at + BAR_MS) > 20000 || state.rsi === null || state.rsi >= 30 || bar.c < bar.o || !(bar.v > 0) ||
      this.store.data.rsiEpisodes[q.pool]?.consumed || state.attemptBar === bar.at || this.store.data.positions[q.mint]) return;
    const f = flow(state.flow, now, q.liquidity, this.c.rsi);
    if (!f.pass) return;
    state.attemptBar = bar.at;
    const signal = { ...q, strategy: 'rsi', rsiSignal: { value: state.rsi, barAt: bar.at, expiresAt: now + this.c.maxSignalAgeMs,
      fdvUsd: state.fdv, flow: f } };
    this.store.log('rsi_entry_candidate', { mint: q.mint, pool: q.pool, signal: q.signature, ...signal.rsiSignal });
    this.engine.buy(signal).then(() => {
      if (this.store.data.seen[q.signature]) {
        this.store.data.rsiEpisodes[q.pool] = { consumed: true, at: Date.now() }; this.store.save();
      }
    }).catch(e => this.engine.error('rsi_buy', e));
  }
  async poll(state) {
    const p = state.pool;
    if (this.engine.stopped || (this.fresh.pools[p.pool]?.closedReason && !this.retained(p.pool))) return;
    try {
      const q = await this.adapter.prepare(p);
      if (this.engine.stopped) return;
      this.fresh.reserve(p.pool, q.liquidity, q.slot); this.fdv(q, state);
      if (this.fresh.pools[p.pool]?.closedReason && !this.retained(p.pool)) return;
      const end = Math.floor(Date.now() / BAR_MS) * BAR_MS - 1;
      const from = state.lastFetchEnd ? state.lastFetchEnd - 3 * BAR_MS : p.graduatedAt;
      const inverted = Buffer.compare(decode58(p.mint), decode58(p.quoteMint)) > 0;
      const items = await this.birdeye.bars(p.pool, inverted, from, end);
      if (this.engine.stopped) return;
      for (const b of items) state.items.set(b.unix_time, b);
      state.lastFetchEnd = end;
      const bars = candles([...state.items.values()], p.graduatedAt, end + 1);
      const bar = bars.at(-1); if (!bar) return;
      // Different pool direction/units must never silently invert the oscillator.
      const ratio = Number(q.postQuoteRaw) / 10 ** q.quoteDecimals / (Number(q.postBase) / 10 ** q.baseDecimals);
      if (!(bar.c / ratio > 0.05 && bar.c / ratio < 20)) throw Error('Birdeye price orientation mismatch');
      const value = rsi(bars.map(b => b.c)); state.rsi = value; state.bar = bar;
      this.engine.rsiValues.set(p.pool, { value, at: bar.at + BAR_MS });
      if (value !== null && value >= 30 && this.store.data.rsiEpisodes[p.pool]?.consumed) {
        this.store.data.rsiEpisodes[p.pool] = { consumed: false, at: Date.now() }; this.store.save();
      }
      this.store.log('rsi_bar', { pool: p.pool, mint: p.mint, bar, rsi: value, count: bars.length, fdvUsd: state.fdv, inversion: inverted });
      this.tryEntry(state);
    } catch (e) { this.engine.error('rsi_poll', e); }
  }
  schedule() {
    if (this.engine.stopped) return;
    const now = Date.now();
    // Bound concurrency; prioritize funded positions. Poll once per completed candle.
    const states = [...this.states.values()].sort((a, b) => Number(this.retained(b.pool.pool)) - Number(this.retained(a.pool.pool)));
    for (const state of states) {
      if (this.working.size >= 3) break;
      if (state.nextPoll > now || this.working.has(state.pool.pool) ||
        (this.fresh.pools[state.pool.pool]?.closedReason && !this.retained(state.pool.pool))) continue;
      state.nextPoll = Math.floor(now / BAR_MS) * BAR_MS + BAR_MS + 700;
      const work = this.poll(state).finally(() => this.working.delete(state.pool.pool));
      this.working.set(state.pool.pool, work);
    }
  }
  async updateSol() {
    if (this.solPending || this.engine.stopped) return;
    this.solPending = true;
    try { this.sol = await this.birdeye.solPrice(); }
    catch (e) { this.engine.error('rsi_sol_usd', e); }
    finally { this.solPending = false; }
  }
  start() {
    this.store.data.runtimeStart = { time: new Date().toISOString(), strategyConfig: publicConfig(this.c) }; this.store.save();
    this.store.log('starting', { mode: 'live', market: 'stonk', strategy: 'rsi', strategyConfig: publicConfig(this.c) });
    this.monitor.start();
    for (const p of Object.values(this.store.data.positions)) {
      this.monitor.pools.set(p.pool, p); this.pool(p);
    }
    this.updateSol(); this.solTimer = setInterval(() => this.updateSol(), 15000);
    this.timer = setInterval(() => { this.engine.tick(); this.schedule(); }, 1000);
    this.reportTimer = setInterval(() => this.report(), 60000); this.report();
  }
  report() {
    this.fresh.prune();
    this.stream.stonkHealth = { ...this.coverage, strategy: 'rsi', shadowDisabled: true, discoveryComplete: this.monitor.health.discoveryComplete,
      discoveryError: this.monitor.health.discoveryError, birdeyeRequests: this.birdeye.requests, birdeyeFailures: this.birdeye.failures };
    this.store.data.streamDays = Object.fromEntries(Object.entries(this.monitor.usage).map(([day, u]) => [day, u.bytes]));
    this.engine.report();
  }
  async stop() {
    this.engine.stopped = true; clearInterval(this.timer); clearInterval(this.solTimer); clearInterval(this.reportTimer);
    await this.monitor.stop(); await Promise.allSettled(this.working.values());
    while (this.engine.busy || this.engine.ticking || this.solPending) await new Promise(r => setTimeout(r, 20));
    this.report(); this.store.close();
  }
}
module.exports = { RsiRuntime };
