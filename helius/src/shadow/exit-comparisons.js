'use strict';
const { exitReason } = require('../strategy');
// Fixed research arms. They share the baseline entry and never submit orders.
const ARMS = [{ name: 'exit_250ms', delay: 250 }, { name: 'exit_1000ms', delay: 1000 }, { name: 'net_take5', netTake: 5 },
  { name: 'no_fixed_stop', noFixedStop: true },
  { name: 'take30', takeProfit: 30 }, { name: 'take50', takeProfit: 50 },
  { name: 'take30_no_stop', takeProfit: 30, noFixedStop: true },
  { name: 'take50_no_stop', takeProfit: 50, noFixedStop: true },
  { name: 'take8_first3s', quickTakePct: 8, quickWindowMs: 3000 }];
function armConfig(c, a) { return { ...c, takeProfit: a.takeProfit ?? c.takeProfit, stopLoss: a.noFixedStop ? Infinity : c.stopLoss }; }
function armExitReason(c, a, position, price, netPct, at) {
  const age = at - position.openedAt;
  if (a.quickWindowMs && age >= 0 && age <= a.quickWindowMs
    && price >= position.entryPrice * (1 + a.quickTakePct / 100)) return 'quick_take_profit';
  return a.netTake && netPct >= a.netTake ? 'net_take_profit' : exitReason(position, price, armConfig(c, a), at);
}
class ExitComparisons {
  constructor(c, emit) { this.c = c; this.emit = emit; }
  states(s) {
    return s.exitComparisons ||= ARMS.map(a => ({ ...a, position: { ...s.entry }, pending: null, done: false,
      minNetPct: null, maxNetPct: null, firstFixedStopAt: null }));
  }
  write(s, a, fields, at) {
    a.done = true;
    this.emit({ type: 'exit_comparison', comparisonVersion: 1, id: s.id, key: s.key, at,
      variant: a.name, selection: s.selection ?? null, assumptions: { exitDelayMs: a.delay ?? this.c.exitDelayMs, netTakePct: a.netTake ?? null,
        quickTakePct: a.quickTakePct ?? null, quickWindowMs: a.quickWindowMs ?? null, quickTakeBasis: a.quickWindowMs ? 'price_from_proxy_entry' : null,
        sameEntryAsBaseline: true, baselinePolicy: 'envelope_policyId', maxHoldMs: this.c.maxHoldMs,
        fixedStopEnabled: !a.noFixedStop, stopLossPct: a.noFixedStop ? null : this.c.stopLoss,
        takeProfitPct: a.takeProfit ?? this.c.takeProfit, trailArmPct: this.c.trailArm, trailDropPct: this.c.trailDrop },
      entryCostSol: s.entry?.cost ?? null, minNetPct: a.minNetPct ?? null, maxNetPct: a.maxNetPct ?? null,
      firstFixedStopAt: a.firstFixedStopAt ?? null, ...fields });
  }
  observe(s, swap, net, at) {
    const pnl = (net / s.entry.cost - 1) * 100;
    for (const a of this.states(s)) {
      if (a.done) continue;
      a.minNetPct = a.minNetPct === null ? pnl : Math.min(a.minNetPct, pnl);
      a.maxNetPct = a.maxNetPct === null ? pnl : Math.max(a.maxNetPct, pnl);
      if (a.firstFixedStopAt === null && (swap.price / a.position.entryPrice - 1) * 100 <= -this.c.stopLoss)
        a.firstFixedStopAt = at;
      if (a.pending && at >= a.pending.dueAt) {
        this.write(s, a, { status: 'observed_proxy', reason: a.pending.reason, netPnlSol: net - s.entry.cost,
          netPnlPct: pnl, entryAt: s.entry.at, exitAt: at, triggerAt: a.pending.at,
          actualExitDelayMs: at - a.pending.at }, at);
      } else if (!a.pending) {
        a.position.high = Math.max(a.position.high, swap.price);
        // Only this research arm disables the price stop; profit, trailing and time exits remain identical.
        const reason = armExitReason(this.c, a, a.position, swap.price, pnl, at);
        if (reason) a.pending = { reason, at, dueAt: at + (a.delay ?? this.c.exitDelayMs) };
      }
    }
  }
  tick(s, at) {
    if (!s.entry) return;
    for (const a of this.states(s)) if (!a.done && !a.pending && at - s.entry.at >= this.c.maxHoldMs)
      a.pending = { reason: 'max_hold', at, dueAt: at + (a.delay ?? this.c.exitDelayMs) };
  }
  censor(s, reason, at) {
    for (const a of s.exitComparisons || ARMS.map(a => ({ ...a, done: false })))
      if (!a.done) this.write(s, a, { status: 'censored', reason, netPnlSol: null }, at);
  }
  done(s) { return !!s.exitComparisons && s.exitComparisons.every(a => a.done); }
}
module.exports = { ExitComparisons, ARMS, armConfig, armExitReason };
