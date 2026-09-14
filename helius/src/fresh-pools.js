'use strict';
const { WSOL } = require('./config');
const WINDOW = 1800000;
class FreshPools {
  constructor(store, { market = 'pump' } = {}) {
    this.market = market;
    this.store = store; this.pools = store.data.freshPools ||= {};
    if (typeof this.pools !== 'object' || Array.isArray(this.pools)) throw new Error('Invalid fresh pool state');
    this.vaultPools = new Map(Object.entries(this.pools).filter(([,p])=>p.quoteVault).map(([pool,p])=>[p.quoteVault,pool]));
  }
  created(e, now = Date.now()) {
    if (e.source !== (this.market === 'stonk' ? 'stonk_migrate_confirmed' : 'pump_migrate_processed') || e.migrationAt !== e.createdAt || !Number.isSafeInteger(e.migrationAt)
      || e.migrationAt > now || now - e.migrationAt >= WINDOW || !e.pool || !e.mint) return;
    const old = this.pools[e.pool];
    if (old) {
      if (old.mint !== e.mint || old.migrationAt !== e.migrationAt) this.close(e.pool, 'migration_conflict', now);
      return;
    }
    this.pools[e.pool] = { mint: e.mint, migrationAt: e.migrationAt, event: e,
      quoteVault: e.quoteVault || null, reserveSol: null, closedReason: null };
    if (e.quoteVault) this.vaultPools.set(e.quoteVault, e.pool);
    this.store.save();
    this.store.log('fresh_pool_discovered', { pool: e.pool, mint: e.mint, migrationAt: e.migrationAt, reserveStatus: 'unknown' });
    this.reserve(e.pool, e.reserveSol, e.slot, now);
  }
  close(pool, reason, now) {
    const p = this.pools[pool]; if (!p || p.closedReason) return;
    p.closedReason = reason; p.closedAt = now; this.store.save();
    this.store.log('fresh_pool_closed', { pool, mint: p.mint, reason, reserveSol: p.reserveSol });
  }
  reserve(pool, value, slot, now = Date.now()) {
    const p = this.pools[pool];
    if (!p || p.closedReason || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(slot)
      || (p.reserveSlot != null && slot < p.reserveSlot)) return;
    const first = p.reserveSol == null; p.reserveSol = value; p.reserveSlot = slot;
    if (value < 50) this.close(pool, 'reserve_below_50', now);
    else if (first) { this.store.save(); this.store.log('fresh_pool_reserve_known', { pool, reserveSol: value, slot }); }
  }
  transaction(tx) {
    // Non-SOL Stonk vaults must be valued by the CPMM adapter before applying SOL limits.
    if (this.market === 'stonk') return;
    if (!tx) return;
    // Exact vault learned from authenticated migrate; missing balance never means zero.
    for (const b of tx.meta.postTokenBalances || []) {
      const pool = this.vaultPools.get(tx.keys[b.accountIndex]);
      if (pool && b.mint === WSOL && b.uiTokenAmount?.decimals === 9 && /^\d+$/.test(b.uiTokenAmount.amount))
        this.reserve(pool, Number(b.uiTokenAmount.amount) / 1e9, tx.slot);
    }
  }
  reason(s, now = Date.now()) {
    const p = this.pools[s.pool];
    if (!p || p.mint !== s.mint) return 'fresh_pool_not_discovered';
    if (p.closedReason) return p.closedReason;
    if (now < p.migrationAt || now - p.migrationAt >= WINDOW) return 'graduation_age_30_minutes';
    return p.reserveSol == null ? 'fresh_pool_reserve_unknown' : null;
  }
  addresses(now = Date.now()) {
    for (const [pool,p] of Object.entries(this.pools)) if (now - p.migrationAt >= WINDOW) this.close(pool, 'graduation_age_30_minutes', now);
    const protectedPools = Object.values(this.store.data.positions || {}).concat(Object.values(this.store.data.pending || {})).map(p=>p.pool || p.swap?.pool).filter(Boolean);
    return [...new Set([...Object.entries(this.pools).filter(([,p])=>!p.closedReason && now >= p.migrationAt && now-p.migrationAt<WINDOW).map(([pool])=>pool), ...protectedPools])].sort();
  }
  prune(now = Date.now()) {
    for (const [pool,p] of Object.entries(this.pools)) if (now-p.migrationAt>86400000) { if (p.quoteVault) this.vaultPools.delete(p.quoteVault); delete this.pools[pool]; }
  }
}
module.exports = { FreshPools, WINDOW };
