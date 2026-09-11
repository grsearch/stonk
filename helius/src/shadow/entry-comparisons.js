'use strict';
const { exitReason } = require('../strategy');
const RULES = Object.freeze({ version: 1, minObserveMs: 500, confirmationWindowMs: 3000, reboundFromLowPct: 2, minBuySwaps: 2 });
const ARMS = Object.freeze(['immediate', 'confirm_buy_flow', 'confirm_two_buyers']);
// Independent candidate-level research. No orders, RPC, model changes or baseline label mutation.
class EntryComparisons {
  constructor(c, emit, quotes) {
    this.c = c; this.emit = emit; this.quotes = quotes; this.active = new Map(); this.byPool = new Map();
    this.counts = { candidates: 0, entered: 0, observed: 0, censored: 0, notEntered: 0, skipped: 0 };
  }
  write(s, a, fields, at) {
    this.emit({ type: 'entry_comparison', entryResearchVersion: 1, id: s.id, key: s.key, candidateAt: s.at,
      variant: a.name, at, entryAt: a.entry?.at ?? null, confirmedAt: a.confirmedAt ?? null,
      entryCostSol: a.entry?.cost ?? null, ...fields });
  }
  finish(s, a, status, reason, at, extra = {}) {
    if (a.done) return;
    a.done = true;
    this.counts[status === 'observed_proxy' ? 'observed' : status === 'not_entered' ? 'notEntered' : status === 'skipped' ? 'skipped' : 'censored']++;
    this.write(s, a, { phase: 'finished', status, reason, netPnlSol: null, ...extra }, at);
    if (s.arms.every(x => x.done)) {
      this.active.delete(s.id); const set = this.byPool.get(s.pool); set?.delete(s.id); if (!set?.size) this.byPool.delete(s.pool);
    }
  }
  add(sample, swap, eligible, at = sample.at) {
    const s = { id: sample.id, key: sample.key, pool: sample.source.pool, at, lastAt: at, low: swap.price,
      buys: 0, buyers: new Set(), missingBuyer: false, arms: ARMS.map(name => ({ name, done: false, entry: null,
        confirmedAt: name === 'immediate' ? at : null, pending: null })) };
    this.counts.candidates++;
    const reason = !eligible ? 'prebuy_not_known_pass' : !Number.isFinite(s.low) || s.low <= 0 ? 'invalid_candidate_price'
      : this.active.size >= Math.min(this.c.maxActive || 1000, 1000) ? 'entry_research_capacity'
      : (this.byPool.get(s.pool)?.size || 0) >= Math.min(this.c.maxActivePerPool || 100, 100) ? 'entry_research_pool_capacity' : null;
    if (reason) { for (const a of s.arms) this.finish(s, a, eligible ? 'censored' : 'skipped', reason, at); return; }
    this.active.set(s.id, s); if (!this.byPool.has(s.pool)) this.byPool.set(s.pool, new Set()); this.byPool.get(s.pool).add(s.id);
    for (const a of s.arms) this.write(s, a, { phase: 'started', status: 'observing', netPnlSol: null }, at);
  }
  needsBuyer(pool, at = null) {
    return [...(this.byPool.get(pool) || [])].some(id => {
      const s = this.active.get(id);
      return s && (at === null || at <= s.at + RULES.confirmationWindowMs)
        && s.arms.some(a => !a.done && a.name === 'confirm_two_buyers' && a.confirmedAt === null);
    });
  }
  gap(reason, at, pool) {
    for (const s of [...this.active.values()]) if (!pool || s.pool === pool)
      for (const a of s.arms) this.finish(s, a, 'censored', reason, at);
  }
  expire(s, a, at) {
    if (a.confirmedAt === null && at > s.at + RULES.confirmationWindowMs) {
      this.finish(s, a, s.missingBuyer && a.name === 'confirm_two_buyers' ? 'censored' : 'not_entered',
        s.missingBuyer && a.name === 'confirm_two_buyers' ? 'buyer_identity_unavailable' : 'no_confirmation', at); return true;
    }
    if (!a.entry && a.confirmedAt !== null && at > a.confirmedAt + this.c.entryDeadlineMs) {
      this.finish(s, a, 'censored', 'no_timely_entry_observation', at); return true;
    }
    return false;
  }
  observe(swap, at) {
    for (const id of [...(this.byPool.get(swap.pool) || [])]) {
      const s = this.active.get(id); if (!s || at < s.lastAt) continue;
      if (at - s.lastAt > this.c.maxGapMs) { this.gap('pool_observation_gap', at, s.pool); continue; }
      if (!Number.isFinite(swap.price) || swap.price <= 0) { this.gap('invalid_observation_price', at, s.pool); continue; }
      // Triggering dump is excluded. Only subsequent accepted stream events count; distinct buyers are capped at two.
      if (at <= s.at + RULES.confirmationWindowMs) {
        s.low = Math.min(s.low, swap.price);
        if (swap.side === 'buy') {
          s.buys = Math.min(RULES.minBuySwaps, s.buys + 1);
          if (typeof swap.user === 'string' && swap.user.length) { if (s.buyers.size < 2) s.buyers.add(swap.user); }
          else s.missingBuyer = true;
        }
      }
      for (const a of s.arms) {
        if (a.done || this.expire(s, a, at)) continue;
        if (a.confirmedAt === null) {
          const buyersReady = a.name === 'confirm_two_buyers' ? s.buyers.size >= 2 : s.buys >= 2;
          if (at - s.at < RULES.minObserveMs || !buyersReady || swap.price < s.low * 1.02) continue;
          a.confirmedAt = at;
          this.write(s, a, { phase: 'confirmed', status: 'awaiting_entry', netPnlSol: null,
            lowPrice: s.low, confirmationPrice: swap.price, buySwapsCapped: s.buys, distinctBuyersCapped: s.buyers.size,
            buyerIdentityMissing: s.missingBuyer }, at);
          continue; // Confirmation quote is never reused as an execution quote.
        }
        if (!a.entry) {
          if (at < a.confirmedAt + this.c.entryDelayMs) continue;
          const quote = this.quotes.buyQuote(swap, this.c);
          if (!quote) { this.finish(s, a, 'censored', 'unquotable_entry', at); continue; }
          a.entry = { ...quote, at, openedAt: at, entryPrice: quote.cost / quote.amount, high: quote.cost / quote.amount };
          this.counts.entered++;
          this.write(s, a, { phase: 'entered', status: 'holding', netPnlSol: null, actualEntryDelayMs: at - a.confirmedAt,
            signalToEntryMs: at - s.at, amount: String(quote.amount), entryBreakdown: quote.breakdown }, at);
        }
        const details = this.quotes.liquidationDetails(swap, a.entry.amount, this.c);
        if (!details) { this.finish(s, a, 'censored', 'unquotable_exit', at); continue; }
        if (a.pending && at >= a.pending.dueAt) {
          this.finish(s, a, 'observed_proxy', a.pending.reason, at, { netPnlSol: details.net - a.entry.cost,
            exitAt: at, triggerAt: a.pending.at, actualExitDelayMs: at - a.pending.at,
            executionBreakdown: { version: 1, entry: a.entry.breakdown, exit: details } });
        } else if (!a.pending) {
          a.entry.high = Math.max(a.entry.high, swap.price);
          const reason = exitReason(a.entry, swap.price, this.c, at);
          if (reason) a.pending = { reason, at, dueAt: at + this.c.exitDelayMs };
        }
      }
      s.lastAt = at;
    }
  }
  tick(at) {
    for (const s of [...this.active.values()]) {
      // A long delivery gap is unknown, not evidence that confirmation never happened.
      if (at - s.lastAt > this.c.maxGapMs) { this.gap('pool_observation_gap', at, s.pool); continue; }
      for (const a of s.arms) if (!a.done && !this.expire(s, a, at) && a.entry && !a.pending && at - a.entry.at >= this.c.maxHoldMs)
        a.pending = { reason: 'max_hold', at, dueAt: at + this.c.exitDelayMs };
    }
  }
  stats() { return { version: 1, ...this.counts, active: this.active.size }; }
}
module.exports = { EntryComparisons, RULES, ARMS };
