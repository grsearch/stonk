'use strict';
const FEATURE_NAMES = ['sellSol', 'impactPct', 'liquiditySol', 'sellLiquidityRatio', 'orderLiquidityRatio',
  ...[5, 15, 60].flatMap(s => [`buySol${s}`, `sellSol${s}`, `buyers${s}`, `sellers${s}`, `trades${s}`, `buyFraction${s}`]),
  'return60Pct', 'volatility60', 'sellerSellSol60', 'consecutiveSells'];

class Features {
  constructor(options) { this.o = options; this.pools = new Map(); this.total = 0; this.evictions = 0; }
  reset() { this.pools.clear(); this.total = 0; }
  invalidate(pool) { const h = this.pools.get(pool); if (h) this.total -= h.events.length; this.pools.delete(pool); }
  snapshot(s, now) {
    const h = this.pools.get(s.pool);
    const events = (h?.events || []).filter(x => x.ts >= now - 60000 && x.ts <= now);
    const f = { sellSol: s.sellSol, impactPct: s.impact, liquiditySol: s.liquidity,
      sellLiquidityRatio: s.sellSol / s.liquidity, orderLiquidityRatio: this.o.sizeSol / s.liquidity };
    for (const seconds of [5, 15, 60]) {
      const list = events.filter(x => x.ts >= now - seconds * 1000), buyers = new Set(), sellers = new Set();
      let buy = 0, sell = 0;
      for (const x of list) {
        if (x.side === 'buy') { buy += x.quoteSol; buyers.add(x.user); }
        else { sell += x.quoteSol; sellers.add(x.user); }
      }
      Object.assign(f, { [`buySol${seconds}`]: buy, [`sellSol${seconds}`]: sell,
        [`buyers${seconds}`]: buyers.size, [`sellers${seconds}`]: sellers.size, [`trades${seconds}`]: list.length,
        [`buyFraction${seconds}`]: buy + sell > 0 ? buy / (buy + sell) : 0.5 });
    }
    const returns = events.slice(1).map((x, i) => Math.log(x.price / events[i].price));
    const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    f.return60Pct = events.length > 1 ? (events.at(-1).price / events[0].price - 1) * 100 : 0;
    f.volatility60 = returns.length ? Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length) : 0;
    f.sellerSellSol60 = events.filter(x => x.user === s.user && x.side === 'sell').reduce((a, b) => a + b.quoteSol, 0);
    f.consecutiveSells = 0;
    for (let i = events.length - 1; i >= 0 && events[i].side === 'sell'; i--) f.consecutiveSells++;
    const historyMs = h ? Math.max(0, now - Math.max(h.firstAt, h.truncatedAt || 0)) : 0;
    const ready = historyMs >= 60000 && events.length >= this.o.minHistorySwaps && FEATURE_NAMES.every(k => Number.isFinite(f[k]));
    return { values: f, ready, historyMs, historyTrades: events.length,
      reason: ready ? null : 'insufficient_prior_history', lastHistorySequence: h?.lastSequence || 0 };
  }
  add(s, now, sequence) {
    let h = this.pools.get(s.pool);
    if (!h) { h = { firstAt: now, events: [], lastSequence: 0, lastAt: now }; this.pools.set(s.pool, h); }
    this.total -= h.events.length;
    h.events = h.events.filter(x => x.ts >= now - 60000);
    h.events.push({ ts: now, price: s.price, quoteSol: s.quoteSol, user: s.user, side: s.side });
    if (h.events.length > this.o.maxEventsPerPool) { h.events.splice(0, h.events.length - this.o.maxEventsPerPool); h.truncatedAt = now; }
    h.lastSequence = sequence; h.lastAt = now; this.total += h.events.length;
    // LRU eviction bounds both pool count and global event memory.
    this.pools.delete(s.pool); this.pools.set(s.pool, h);
    while (this.pools.size > this.o.maxPools || this.total > this.o.maxHistoryEvents) {
      const key = this.pools.keys().next().value; this.total -= this.pools.get(key).events.length; this.pools.delete(key); this.evictions++;
    }
  }
}
module.exports = { Features, FEATURE_NAMES };
