'use strict';
const crypto = require('node:crypto');

// Candidate-level comparisons only: never feed these decisions back to Engine.
class Experiments {
  constructor(c, at) {
    this.rules = { version: 1, maxSellSol: c.experimentMaxSellSol ?? 40,
      consecutiveSells: 3, sellBuyRatio15s: 2, lossCooldownMs: c.experimentLossCooldownMs ?? 600000 };
    this.id = crypto.createHash('sha256').update(JSON.stringify(this.rules)).digest('hex').slice(0, 16);
    this.losses = new Map(); this.startedAt = at;
  }
  reset(at) { this.losses.clear(); this.startedAt = at; }
  closed(mint, at, pnl) {
    if (typeof mint === 'string' && Number.isFinite(pnl) && pnl < 0) {
      this.losses.delete(mint); this.losses.set(mint, at + this.rules.lossCooldownMs);
      if (this.losses.size > 20000) this.reset(at); // Unknown history, not an invented pass.
    }
  }
  evaluate(s, snapshot, at) {
    const v = snapshot.values || {}, until = this.losses.get(s.mint);
    if (until && until <= at) this.losses.delete(s.mint);
    const size = s.sellSol < this.rules.maxSellSol;
    const flow = snapshot.ready ? !(v.consecutiveSells >= this.rules.consecutiveSells
      && v.sellSol15 > this.rules.sellBuyRatio15s * v.buySol15) : null;
    const cooldown = until > at ? false : at - this.startedAt >= this.rules.lossCooldownMs ? true : null;
    return { version: 1, experimentId: this.id, rules: this.rules,
      scope: 'candidate_filter_only_not_portfolio_backtest', baseline: true,
      belowMaxSell: size, avoidPriorSellPressure: flow, lossCooldown: cooldown,
      combined: [size, flow, cooldown].includes(false) ? false : [size, flow, cooldown].includes(null) ? null : true };
  }
}
module.exports = { Experiments };
