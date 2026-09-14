'use strict';
const crypto = require('node:crypto');
const { Features } = require('./features');
const { Model } = require('./model');
const { exitReason } = require('../strategy');
const { Experiments } = require('./experiments');
const { Age } = require('./age');
const { ExitComparisons } = require('./exit-comparisons');
const { Recovery } = require('./recovery');
const { selection } = require('./selection');
const { EntryComparisons, RULES: ENTRY_RULES, ARMS: ENTRY_ARMS } = require('./entry-comparisons');

function assumptions(c) {
  return { version: 1, sizeSol: c.sizeSol, takeProfit: c.takeProfit, stopLoss: c.stopLoss, trailArm: c.trailArm,
    trailDrop: c.trailDrop, maxHoldMs: c.maxHoldMs, entryDelayMs: c.entryDelayMs, entryDeadlineMs: c.entryDeadlineMs,
    exitDelayMs: c.exitDelayMs, feeBps: c.feeBps, slippageBps: c.slippageBps, networkFeeSol: c.networkFeeSol,
    reboundPct: c.reboundPct, maxGapMs: c.maxGapMs, horizons: [30000, 60000],
    candidateFilter: { minSellSol: c.minSellSol, minImpact: c.minImpact, maxImpact: c.maxImpact, minLiquidity: c.minLiquidity } };
}
function policyId(policy) { return crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16); }
function buyQuote(s, c) {
  if (s.market === 'stonk') return require('../stonk/proxy-quotes').buyQuote(s, c);
  const x = Number(s.postBase), y = Number(s.postQuote) / 1e9 + Number(s.virtual || '0') / 1e9;
  const input = c.sizeSol * (1 - c.feeBps / 10000);
  const amount = Math.floor(x * input / (y + input) * (1 - c.slippageBps / 10000));
  return x > 0 && y > 0 && Number.isSafeInteger(amount) && amount > 0 ? { amount, cost: c.sizeSol + c.networkFeeSol,
    breakdown: { version: 1, sizeSol: c.sizeSol, spotPrice: y / x, spotAmount: c.sizeSol * x / y,
      curveAmount: x * c.sizeSol / (y + c.sizeSol), afterFeeAmount: x * input / (y + input),
      filledAmount: amount, networkFeeSol: c.networkFeeSol,
      postBase: s.postBase, postQuote: s.postQuote, virtual: s.virtual || '0' } } : null;
}
function liquidationDetails(s, amount, c) {
  if (s.market === 'stonk') return require('../stonk/proxy-quotes').liquidationDetails(s, amount, c);
  const x = Number(s.postBase), realQuote = Number(s.postQuote) / 1e9, effective = realQuote + Number(s.virtual || '0') / 1e9;
  const curveOut = effective * amount / (x + amount), afterFeeOut = curveOut * (1 - c.feeBps / 10000);
  const out = afterFeeOut * (1 - c.slippageBps / 10000);
  if (!(x > 0 && effective > 0 && out >= 0 && out <= realQuote)) return null;
  return { version: 1, spotPrice: effective / x, spotProceeds: effective * amount / x, curveOut, afterFeeOut,
    afterSlippageOut: out, networkFeeSol: c.networkFeeSol, net: out - c.networkFeeSol,
    postBase: s.postBase, postQuote: s.postQuote, virtual: s.virtual || '0' };
}
function liquidation(s, amount, c) { return liquidationDetails(s, amount, c)?.net ?? null; }
class Tracker {
  constructor(c, write, { runId = crypto.randomUUID(), now = Date.now } = {}) {
    this.c = c; this.write = write; this.runId = runId; this.now = now;
    this.runStartedAt = this.now();
    this.policy = assumptions(c); this.policyId = policyId(this.policy);
    this.features = new Features(c); this.model = new Model(c.modelFile, this.policyId);
    this.riskModel = new Model(c.riskModelFile, this.policyId); this.returnModel = new Model(c.returnModelFile, this.policyId);
    if (this.riskModel.model && this.riskModel.model.target !== 'loss_25') { this.riskModel.model = null; this.riskModel.status = 'wrong_target'; }
    if (this.returnModel.model && this.returnModel.model.target !== 'net_return') { this.returnModel.model = null; this.returnModel.status = 'wrong_target'; }
    this.exitComparisons = c.exitComparisons ? new ExitComparisons(c, r => this.emit(r)) : null;
    this.drawdownModel = new Model(c.drawdownModelFile, this.policyId);
    if (this.drawdownModel.model && this.drawdownModel.model.target !== 'drawdown_60s_25') { this.drawdownModel.model = null; this.drawdownModel.status = 'wrong_target'; }
    this.recovery = c.exitComparisons ? new Recovery(c, r => this.emit(r), liquidation) : null;
    this.exitRecovery = c.exitComparisons ? new Recovery(c, r => this.emit(r), liquidation, 'exit_recovery') : null;
    this.stateRecovery = c.exitComparisons && c.stateQuotes ? new Recovery(c, r => this.emit(r), liquidation, 'state_exit_recovery') : null;
    this.experiments = new Experiments(c, this.now());
    this.ages = new Age();
    this.active = new Map(); this.byPool = new Map(); this.lastOrder = new Map(); this.seen = new Map();
    this.sequence = 0; this.connected = false; this.lastGlobalAt = 0; this.samples = 0; this.outcomes = 0; this.censored = 0;
    this.entryComparisons = c.entryComparisons ? new EntryComparisons(c, r => this.emit(r), { buyQuote, liquidationDetails }) : null;
    this.write({ type: 'session', schema: 1, runId, at: this.now(), policy: this.policy, policyId: this.policyId,
      drawdownModelStatus: this.drawdownModel.status, modelStatus: this.model.status, riskModelStatus: this.riskModel.status, returnModelStatus: this.returnModel.status,
      noStopRecoveryVersion: this.recovery ? 1 : null, exitComparisonVersion: this.exitComparisons ? 1 : null,
      freshSubscriptions: c.freshSubscriptions, exitResearchVersion: 4, stateQuoteVersion: this.stateRecovery ? 1 : null, stateQuoteSchedulingVersion: this.stateRecovery ? 3 : null, selectionVersion: 7,
      exitVariants: this.exitComparisons ? require('./exit-comparisons').ARMS : [],
      entryResearchVersion: this.entryComparisons ? 1 : null, entryRules: this.entryComparisons ? ENTRY_RULES : null,
      entryVariants: this.entryComparisons ? ENTRY_ARMS : [], entryResearchRequiresKnownPrebuyPass: true,
      source: c.market === 'stonk' ? 'confirmed_stonk_cpmm_swaps' : 'processed_pumpswap_swaps',
      modelDomain: c.market === 'stonk' ? 'original_models_reference_only_not_stonk_validated' : 'pumpswap', observationalOnly: true });
  }
  emit(record) { this.write({ schema: 1, runId: this.runId, policyId: this.policyId, ...record }); }
  connection(connected, at) {
    if (!connected) this.gap('stream_disconnected', at);
    else { this.connected = true; this.lastGlobalAt = at; this.emit({ type: 'connection', connected, at }); }
  }
  gap(reason, at = this.now()) {
    this.entryComparisons?.gap(reason, at);
    for (const sample of [...this.active.values()]) this.finishIncomplete(sample, reason, at);
    if (['process_shutdown', 'clock_moved_backwards'].includes(reason)) {
      this.recovery?.close(reason, at); this.exitRecovery?.close(reason, at); this.stateRecovery?.close(reason, at);
    }
    this.features.reset(); this.lastOrder.clear(); this.connected = false; this.experiments.reset(at);
    this.emit({ type: 'coverage_gap', reason, at });
  }
  onSwap(s, candidate, fresh, at = s.receivedAt) {
    if (this.c.market === 'stonk' && (!Number.isSafeInteger(s.graduatedAt) || at < s.graduatedAt || at >= s.graduatedAt + 1800000)) return;
    this.sequence++;
    const key = `${s.signature}:${s.pool}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, at); if (this.seen.size > 100000) this.seen.delete(this.seen.keys().next().value);
    if (this.lastGlobalAt && (at - this.lastGlobalAt > this.c.maxGapMs || at < this.lastGlobalAt)) {
      this.gap(at < this.lastGlobalAt ? 'clock_moved_backwards' : 'global_delivery_gap', at); this.connected = true;
    }
    this.lastGlobalAt = at;
    if (!Number.isFinite(s.eventTime) || at - s.eventTime > this.c.maxSourceLagMs || s.eventTime > at + 2000) {
      this.entryComparisons?.gap('stale_source_observation', at, s.pool);
      for (const id of [...(this.byPool.get(s.pool) || [])]) this.finishIncomplete(this.active.get(id), 'stale_source_observation', at);
      this.features.invalidate(s.pool);
      if (candidate) this.emit({ type: 'excluded_candidate', key, at, reason: 'stale_source_observation' });
      return;
    }
    const previous = this.lastOrder.get(s.pool);
    if (previous && s.slot < previous.slot) {
      this.entryComparisons?.gap('out_of_order_slot', at, s.pool);
      if (candidate) this.emit({ type: 'excluded_candidate', key, at, reason: 'out_of_order_slot' });
      return;
    }
    this.lastOrder.delete(s.pool); this.lastOrder.set(s.pool, { slot: s.slot, at });
    if (this.lastOrder.size > this.c.maxPools) this.lastOrder.delete(this.lastOrder.keys().next().value);
    // One pool observation per swap, shared by overlapping samples; no additional RPC.
    if (candidate || this.byPool.has(s.pool) || this.recovery?.byPool.has(s.pool) || this.exitRecovery?.byPool.has(s.pool) || this.entryComparisons?.byPool.has(s.pool)) this.emit({ type: 'pool_observation', key, at, pool: s.pool, mint: s.mint,
      signature: s.signature, slot: s.slot, side: s.side, eventTime: s.eventTime, price: s.price,
      ...(s.side === 'buy' && this.entryComparisons?.needsBuyer(s.pool, at) ? { user: s.user ?? null, buyerIdentityVersion: 1 } : {}),
      postBase: s.postBase, postQuote: s.postQuote, virtual: s.virtual, quoteSol: s.quoteSol, sellSol: s.sellSol });
    this.recovery?.observe(s, at);
    this.exitRecovery?.observe(s, at);
    this.entryComparisons?.observe(s, at);
    // Older candidates see this event as a future observation; the new candidate snapshot excludes it.
    for (const id of [...(this.byPool.get(s.pool) || [])]) {
      const sample = this.active.get(id); if (sample) this.observe(sample, s, at);
    }
    let candidateSelection = null;
    if (candidate) {
      const id = `${this.runId}:${key}`, snapshot = this.features.snapshot(s, at);
      const sample = { id, key, at, source: { signature: s.signature, pool: s.pool, mint: s.mint, slot: s.slot },
        features: snapshot, prediction: this.model.predict(snapshot, at), experiments: this.experiments.evaluate(s, snapshot, at), lastAt: at, last: s, entry: null,
        horizons: { rebound_30s: { ms: 30000, hit: false, maxNetPct: null, minNetPct: null },
          rebound_60s: { ms: 60000, hit: false, maxNetPct: null, minNetPct: null } }, strategyDone: false, exitPending: null };
      this.samples++;
      sample.objectivePredictions = { drawdown60: this.drawdownModel.predict(snapshot, at), loss25: this.riskModel.predict(snapshot, at), netReturn: this.returnModel.predict(snapshot, at) };
      sample.age = this.ages.snapshot(s, at);
      sample.selection = selection(sample.experiments, sample.objectivePredictions, fresh, sample.prediction, snapshot, sample.age);
      candidateSelection = sample.selection;
      this.entryComparisons?.add(sample, s, fresh && this.connected && sample.selection.arms.prebuyCombined.status === 'pass', at);
      this.emit({ type: 'sample', id, key, at, source: sample.source, sequence: this.sequence,
        features: snapshot, prediction: sample.prediction, objectivePredictions: sample.objectivePredictions, experiments: sample.experiments,
        selection: sample.selection, runStartedAt: this.runStartedAt, observationVersion: 'selection-v7',
        age: sample.age, decisionFresh: fresh, policy: this.policy });
      if (!fresh || !this.connected) this.finishIncomplete(sample, !fresh ? 'stale_candidate' : 'stream_not_continuous', at);
      else if (this.active.size >= this.c.maxActive) this.finishIncomplete(sample, 'active_capacity', at);
      else if ((this.byPool.get(s.pool)?.size || 0) >= this.c.maxActivePerPool) this.finishIncomplete(sample, 'pool_active_capacity', at);
      else {
        this.active.set(id, sample);
        if (!this.byPool.has(s.pool)) this.byPool.set(s.pool, new Set());
        this.byPool.get(s.pool).add(id);
      }
    }
    this.features.add(s, at, this.sequence);
    return candidateSelection;
  }
  label(sample, target, fields, at) {
    this.outcomes++; if (fields.status === 'censored') this.censored++;
    this.emit({ type: 'outcome', id: sample.id, key: sample.key, target, at, ...fields });
    if (target === 'strategy_proxy') this.emit({ type: 'execution_comparison', comparisonVersion: 1,
      id: sample.id, key: sample.key, at, experiments: sample.experiments, prediction: sample.prediction, objectivePredictions: sample.objectivePredictions,
      executionPolicy: this.policy, selection: sample.selection, runStartedAt: this.runStartedAt, observationVersion: 'selection-v7', ...fields });
  }
  finishIncomplete(sample, reason, at) {
    if (['pool_observation_gap', 'stale_source_observation', 'unquotable_exit', 'stream_disconnected', 'global_delivery_gap', 'main_queue_overflow'].includes(reason)) {
      this.recovery?.add(sample, reason, at); this.exitRecovery?.add(sample, reason, at); this.stateRecovery?.add(sample, reason, at);
    }
    this.exitComparisons?.censor(sample, reason, at);
    for (const [name, h] of Object.entries(sample.horizons)) {
      if (!h.done) { h.done = true; this.label(sample, name, { status: 'censored', label: null, reason }, at); }
    }
    if (!sample.strategyDone) { sample.strategyDone = true; this.label(sample, 'strategy_proxy', { status: 'censored', label: null, reason }, at); }
    this.remove(sample);
  }
  remove(sample) {
    this.active.delete(sample.id); const set = this.byPool.get(sample.source.pool);
    set?.delete(sample.id); if (!set?.size) this.byPool.delete(sample.source.pool);
  }
  observe(sample, s, at) {
    if (at < sample.lastAt) return;
    if (at - sample.lastAt > this.c.maxGapMs) { this.finishIncomplete(sample, 'pool_observation_gap', at); this.recovery?.observe(s, at); this.exitRecovery?.observe(s, at); return; }
    if (!sample.entry) {
      if (at > sample.at + this.c.entryDeadlineMs) { this.finishIncomplete(sample, 'no_timely_entry_observation', at); return; }
      if (at < sample.at + this.c.entryDelayMs) { sample.lastAt = at; sample.last = s; return; }
      const quote = buyQuote(s, this.c);
      if (!quote) { this.finishIncomplete(sample, 'unquotable_entry', at); return; }
      sample.entry = { ...quote, at, slot: s.slot, entryPrice: quote.cost / quote.amount, openedAt: at, high: quote.cost / quote.amount };
      this.emit({ type: 'proxy_entry', id: sample.id, at, slot: s.slot, amount: String(quote.amount), costSol: quote.cost,
        actualEntryDelayMs: at - sample.at });
    }
    const exitDetails = liquidationDetails(s, sample.entry.amount, this.c), net = exitDetails?.net ?? null;
    if (net === null) { this.finishIncomplete(sample, 'unquotable_exit', at); return; }
    const pnl = (net / sample.entry.cost - 1) * 100;
    this.exitComparisons?.observe(sample, s, net, at);
    for (const [target, h] of Object.entries(sample.horizons)) {
      if (h.done) continue;
      // Never allow a tick received after the horizon to become its successful rebound.
      if (at <= sample.at + h.ms) {
        h.maxNetPct = h.maxNetPct === null ? pnl : Math.max(h.maxNetPct, pnl);
        h.minNetPct = h.minNetPct === null ? pnl : Math.min(h.minNetPct, pnl);
        if (pnl >= this.c.reboundPct) h.hit = true;
      }
      if (at >= sample.at + h.ms) {
        h.done = true;
        this.label(sample, target, { status: 'observed_proxy', label: h.hit ? 1 : 0, maxNetPct: h.maxNetPct,
          minNetPct: h.minNetPct, entryAt: sample.entry.at, observationEnd: at }, at);
      }
    }
    if (!sample.strategyDone) {
      if (sample.exitPending && at >= sample.exitPending.dueAt) {
        sample.strategyDone = true;
        this.label(sample, 'strategy_proxy', { status: 'observed_proxy', label: pnl > 0 ? 1 : 0, netPnlPct: pnl,
          netPnlSol: net - sample.entry.cost, entryCostSol: sample.entry.cost, exitProceedsSol: net,
          executionBreakdown: { version: 1, entry: sample.entry.breakdown, exit: exitDetails },
          entryAt: sample.entry.at, exitAt: at, reason: sample.exitPending.reason,
          triggerAt: sample.exitPending.triggerAt, triggerPrice: sample.exitPending.price ?? null,
          exitObservationPrice: s.price, exitObservationSlot: s.slot,
          actualExitDelayMs: at - sample.exitPending.triggerAt }, at);
      } else if (!sample.exitPending) {
        sample.entry.high = Math.max(sample.entry.high, s.price);
        const reason = exitReason(sample.entry, s.price, this.c, at);
        if (reason) sample.exitPending = { reason, triggerAt: at, price: s.price, dueAt: at + this.c.exitDelayMs };
      }
    }
    sample.last = s; sample.lastAt = at;
    if (sample.strategyDone && Object.values(sample.horizons).every(h => h.done) && (!this.exitComparisons || this.exitComparisons.done(sample))) this.remove(sample);
  }
  tick(at) {
    if (this.c.market === 'stonk') for (const e of this.ages.pools.values())
      if (at >= e.createdAt + 1800000) this.poolExpired(e.pool, at);
    this.entryComparisons?.tick(at);
    this.recovery?.tick(at);
    this.exitRecovery?.tick(at); this.stateRecovery?.tick(at);
    for (const sample of [...this.active.values()]) {
      this.exitComparisons?.tick(sample, at);
      if (!sample.entry && at > sample.at + this.c.entryDeadlineMs) this.finishIncomplete(sample, 'no_timely_entry_observation', at);
      else if (at - sample.lastAt > this.c.maxGapMs) this.finishIncomplete(sample, 'pool_observation_gap', at);
      else if (sample.entry && !sample.strategyDone && !sample.exitPending && at - sample.entry.at >= this.c.maxHoldMs) {
        sample.exitPending = { reason: 'max_hold', triggerAt: at, dueAt: at + this.c.exitDelayMs };
      }
    }
  }
  poolExpired(pool, at, reason = 'graduation_window_end') {
    this.entryComparisons?.gap(reason, at, pool);
    for (const id of [...(this.byPool.get(pool) || [])]) this.finishIncomplete(this.active.get(id), reason, at);
    for (const recovery of [this.recovery, this.exitRecovery, this.stateRecovery])
      for (const id of [...(recovery?.byPool.get(pool) || [])]) recovery.finish(recovery.active.get(id), { status: 'unknown', reason, netPnlSol: null }, at);
    this.features.invalidate(pool);
  }
  stateTargets() {
    const pools = new Map();
    for (const r of this.stateRecovery?.active.values() || []) {
      const s = r.source, slot = Math.max(r.lastSlot || 0, this.lastOrder.get(r.pool)?.slot || 0, pools.get(r.pool)?.slot || 0);
      const schedules = pools.get(r.pool)?.schedules || [];
      schedules.push({ dueAt: r.pending?.dueAt ?? r.deadlineAt + (r.arm.delay ?? this.stateRecovery.c.exitDelayMs),
        expiresAt: this.stateRecovery.expiresAt(r) });
      pools.set(r.pool, { pool: r.pool, mint: s.mint, baseVault: s.baseVault, quoteVault: s.quoteVault, tokenProgram: s.tokenProgram,
        ...(this.c?.market === 'stonk' ? { quoteMint: s.quoteMint, graduatedAt: s.graduatedAt, market: 'stonk' } : {}), slot, schedules });
    }
    return [...pools.values()];
  }
  stateQuotes(results, at = this.now()) {
    if (!this.stateRecovery) return;
    for (const r of results) {
      const discardReason = r.status !== 'quoted' || !r.quote ? 'unavailable'
        : at - r.at > 3000 || r.at > at || r.at - r.requestAt > 3000 ? 'stale_delivery'
        : r.quote.slot < (this.lastOrder.get(r.pool)?.slot || 0) ? 'older_than_stream'
        : !this.stateRecovery.byPool.has(r.pool) ? 'no_active_recovery' : null;
      this.emit({ ...r, discardReason });
      if (discardReason) continue;
      this.stateRecovery.observe(r.quote, r.at);
    }
  }
  decision(key, status, at, extra = {}) {
    if (status === 'paper_sell' || status === 'sell_confirmed') this.experiments.closed(extra.mint, at, extra.netPnlSol ?? extra.grossPnlSol);
    this.emit({ type: 'decision', key, status, at, ...extra });
  }
  stats() { return { samples: this.samples, outcomes: this.outcomes, censored: this.censored, active: this.active.size,
    entryComparisons: this.entryComparisons?.stats() ?? null,
    recovery: this.recovery?.stats() ?? null, migrationAge: { ...this.ages.counters, cachedPools: this.ages.pools.size },
    exitRecovery: this.exitRecovery?.stats() ?? null, stateRecovery: this.stateRecovery?.stats() ?? null,
    historyPools: this.features.pools.size, historyEvents: this.features.total, historyEvictions: this.features.evictions, model: this.model.status,
    drawdownModel: this.drawdownModel.status, riskModel: this.riskModel.status, returnModel: this.returnModel.status, exitComparisons: !!this.exitComparisons }; }
}
module.exports = { Tracker, assumptions, policyId, buyQuote, liquidation, liquidationDetails };
