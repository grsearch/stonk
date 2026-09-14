'use strict';
const { armExitReason } = require('./exit-comparisons');
// Each source has independent positions; never produces training labels or continuous exits.
class Recovery {
  constructor(c, emit, quote, type = 'no_stop_recovery') {
    this.c = c; this.emit = emit; this.quote = quote; this.type = type;
    this.active = new Map(); this.byPool = new Map(); this.counts = { started: 0, completed: 0, expired: 0, capacity: 0 };
  }
  write(r, fields, at) { this.emit({ type: this.type, recoveryVersion: 1, id: r.id, key: r.key, variant: r.arm.name, at,
    quoteSource: this.type === 'state_exit_recovery' ? 'helius_account_state' : 'processed_swap',
    assumptions: { takeProfitPct: r.arm.takeProfit ?? this.c.takeProfit, fixedStopEnabled: !r.arm.noFixedStop,
      ...(r.arm.earlyFailure ? { earlyFailure: r.arm.earlyFailure } : {}),
      quickTakePct: r.arm.quickTakePct ?? null, quickWindowMs: r.arm.quickWindowMs ?? null,
      quickTakeBasis: r.arm.quickWindowMs ? 'price_from_proxy_entry' : null,
      stopLossPct: r.arm.noFixedStop ? null : this.c.stopLoss, trailArmPct: this.c.trailArm, trailDropPct: this.c.trailDrop,
      maxHoldMs: this.c.maxHoldMs, exitDelayMs: r.arm.delay ?? this.c.exitDelayMs, netTakePct: r.arm.netTake ?? null },
    quoteSlot: r.quoteSlot ?? null, quoteRequestAt: r.quoteRequestAt ?? null,
    selection: r.selection, entryAt: r.entry.at, entryCostSol: r.entry.cost, coverage: 'discontinuous',
    ...(r.arm.earlyFailure ? { earlyAssessment: r.arm.failureState?.assessment ?? { status: 'unavailable', reason: 'coverage_gap_before_assessment' } } : {}),
    gapReason: r.gapReason, gapAt: r.gapAt, deadlineAt: r.deadlineAt, firstQuoteAt: r.firstQuoteAt,
    minObservedNetPct: r.min, maxObservedNetPct: r.max, ...fields }); }
  add(s, reason, at) {
    if (!s.entry) return;
    const arms = (s.exitComparisons || []).filter(a => this.type === 'no_stop_recovery' ? a.name === 'no_fixed_stop'
      : this.type === 'state_exit_recovery' || a.name !== 'no_fixed_stop');
    if (this.type !== 'no_stop_recovery' && !s.strategyDone) arms.push({ name: 'baseline', position: { ...s.entry },
      pending: s.exitPending && { reason: s.exitPending.reason, at: s.exitPending.triggerAt, dueAt: s.exitPending.dueAt } });
    for (const a of arms) this.addArm(s, { ...a, noFixedStop: a.noFixedStop ?? (a.name === 'no_fixed_stop') }, reason, at);
  }
  addArm(s, a, reason, at) {
    const mapKey = this.type === 'no_stop_recovery' ? s.id : s.id + ':' + a.name;
    if (a.done || this.active.has(mapKey)) return;
    const r = { id: s.id, mapKey, arm: a, key: s.key, selection: s.selection, source: { ...s.last }, pool: s.source.pool, entry: { ...s.entry },
      position: { ...a.position }, pending: a.pending && { ...a.pending }, gapReason: reason, gapAt: at,
      deadlineAt: s.entry.at + this.c.maxHoldMs, firstQuoteAt: null, min: null, max: null,
      lastSignature: s.last?.signature, lastSlot: s.last?.slot ?? s.entry.slot, lastAt: at };
    if (at > this.expiresAt(r)) return;
    if (this.active.size >= this.c.maxActive || (this.byPool.get(r.pool)?.size || 0) >= this.c.maxActivePerPool) {
      this.counts.capacity++; this.write(r, { phase: 'finished', status: 'unknown', reason: 'recovery_capacity', netPnlSol: null }, at); return;
    }
    this.active.set(mapKey, r); if (!this.byPool.has(r.pool)) this.byPool.set(r.pool, new Set()); this.byPool.get(r.pool).add(mapKey);
    this.counts.started++; this.write(r, { phase: 'started', status: 'pending', netPnlSol: null }, at);
  }
  expiresAt(r) { return r.deadlineAt + (r.arm.delay ?? this.c.exitDelayMs) + this.c.maxGapMs; }
  finish(r, fields, at) {
    this.write(r, { phase: 'finished', ...fields }, at); this.active.delete(r.mapKey);
    const ids = this.byPool.get(r.pool); ids.delete(r.mapKey); if (!ids.size) this.byPool.delete(r.pool);
  }
  observe(swap, at) {
    for (const id of [...(this.byPool.get(swap.pool) || [])]) {
      const r = this.active.get(id);
      if ((swap.signature && swap.signature === r.lastSignature) || at < r.lastAt || swap.slot < r.lastSlot) continue;
      if (this.type === 'state_exit_recovery' && (!Number.isFinite(swap.requestAt) || swap.requestAt < r.gapAt)) continue;
      if (at > this.expiresAt(r)) { this.expire(r, at); continue; }
      const net = this.quote(swap, r.entry.amount, this.c); if (!Number.isFinite(net)) continue;
      r.lastSignature = swap.signature; r.lastAt = at; r.lastSlot = swap.slot;
      r.quoteSlot = swap.slot; r.quoteRequestAt = swap.requestAt ?? null;
      const pnl = (net / r.entry.cost - 1) * 100;
      r.min = r.min === null ? pnl : Math.min(r.min, pnl); r.max = r.max === null ? pnl : Math.max(r.max, pnl);
      if (r.firstQuoteAt === null) { r.firstQuoteAt = at; this.write(r, { phase: 'first_quote', status: 'quote_only', quoteNetSol: net, sinceGapMs: at - r.gapAt }, at); }
      const delay = r.arm.delay ?? this.c.exitDelayMs;
      if (!r.pending && at >= r.deadlineAt) r.pending = { reason: 'max_hold', at: r.deadlineAt, dueAt: r.deadlineAt + delay };
      // A snapshot requested before the execution deadline cannot be a delayed fill.
      if (r.pending && swap.requestAt !== undefined && swap.requestAt < r.pending.dueAt) continue;
      if (r.pending && at >= r.pending.dueAt) {
        this.counts.completed++; this.finish(r, { status: this.type === 'state_exit_recovery' ? 'account_state_proxy' : 'discontinuous_proxy',
          reason: r.pending.reason, netPnlSol: net - r.entry.cost, exitAt: at, triggerAt: r.pending.at,
          actualExitDelayMs: at - r.pending.at, netPnlPct: pnl }, at);
      } else if (!r.pending) {
        r.position.high = Math.max(r.position.high, swap.price);
        const reason = armExitReason(this.c, r.arm, r.position, swap.price, pnl, at);
        if (reason) r.pending = { reason, at, dueAt: at + delay };
      }
    }
  }
  expire(r, at) { this.counts.expired++; this.finish(r, { status: 'unknown', reason: 'no_exit_quote_by_deadline', netPnlSol: null }, at); }
  tick(at) { for (const r of [...this.active.values()]) if (at > this.expiresAt(r)) this.expire(r, at); }
  close(reason, at) { for (const r of [...this.active.values()]) this.finish(r, { status: 'unknown', reason, netPnlSol: null }, at); }
  stats() { return { ...this.counts, active: this.active.size }; }
}
module.exports = { Recovery };
