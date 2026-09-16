'use strict';
const { LiveEngine } = require('./live-engine');
const { exitDecision } = require('./rsi');
class RsiEngine extends LiveEngine {
  constructor(...args) { super(...args); this.nextQuote = new Map(); this.rsiValues = new Map(); }
  expirePool() {} // Graduation/FDV removes entry eligibility, not management of funded positions.
  exitDue() { return Object.values(this.data.positions).some(p => p.exitRetryReason || Date.now() - p.openedAt >= this.c.maxHoldMs); }
  applyReceipt(p, receipt) {
    super.applyReceipt(p, receipt);
    if (p.side === 'buy' && this.data.positions[p.mint]) {
      Object.assign(this.data.positions[p.mint], { strategy: 'rsi', openedAt: Date.now(), rsiExitOwner: null, rsiPeakNetSol: null });
      this.store.save();
    }
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcile();
      // Latch time/RSI exits before waiting on network requests for other positions.
      for (const p of Object.values(this.data.positions)) {
        const value = this.rsiValues.get(p.pool) || {};
        const reason = exitDecision(p, { now: Date.now(), rsiValue: value.value, rsiAt: value.at }, this.c.rsi);
        if (reason) { p.exitRetryReason ||= reason; this.store.save(); }
      }
      for (const p of Object.values(this.data.positions)) {
        if (p.exitRetryReason) { await this.sell(p, p.exitRetryReason); continue; }
        if ((this.nextQuote.get(p.mint) || 0) > Date.now()) continue;
        this.nextQuote.set(p.mint, Date.now() + 3000);
        try {
          const q = await this.executor.quote('sell', p, p.rawAmount);
          if (!this.data.positions[p.mint]) continue;
          const netSol = Number(q.data.outputAmount) / 1e9 - (this.c.priorityLamports + 5000) / 1e9;
          const value = this.rsiValues.get(p.pool) || {}, previousOwner = p.rsiExitOwner;
          const reason = exitDecision(p, { now: Date.now(), rsiValue: value.value, rsiAt: value.at, netSol }, this.c.rsi);
          p.lastExecutableNetSol = netSol; p.lastExecutableQuoteAt = Date.now();
          this.store.save();
          this.store.log('rsi_exit_quote', { mint: p.mint, pool: p.pool, netSol, entrySol: p.entrySol,
            owner: p.rsiExitOwner, peakNetSol: p.rsiPeakNetSol, reason, routePools: q.data.routePlan.map(x => x.poolId) });
          if (previousOwner !== p.rsiExitOwner) this.store.log('rsi_exit_owner', { mint: p.mint, owner: p.rsiExitOwner });
          if (reason) await this.sell(p, reason);
        } catch (e) {
          this.error('rsi_exit_quote', e);
          // A quiet tape is not an exit. Persistent failure to get executable quotes is.
          if (Date.now() - (p.lastExecutableQuoteAt || p.openedAt) >= 60000) {
            p.exitRetryReason ||= 'rsi_exit_quote_unavailable'; this.store.save(); await this.sell(p, p.exitRetryReason);
          }
        }
      }
    } catch (e) { this.error('rsi_maintenance', e); }
    finally { this.ticking = false; }
  }
}
module.exports = { RsiEngine };
