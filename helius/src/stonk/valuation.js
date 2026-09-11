'use strict';
const { CPMM, decode58 } = require('./protocol');
const { WSOL, USDC, CLMM, cpmm, clmm, vault } = require('./accounts');
// Read-only spot valuation. No DAS cached prices and no HTTP source outside Helius.
class Valuation {
  constructor(rpc, now = Date.now) { this.rpc = rpc; this.now = now; this.paths = new Map(); this.rates = new Map(); this.pending = new Map(); }
  async pair(from, to) {
    const id = `${from}:${to}`, at = this.now();
    let path = this.paths.get(id);
    if (!path || at - path.at > (path.rows.length ? 300000 : 30000)) {
      const sorted = [from, to].sort((a, b) => Buffer.compare(decode58(a), decode58(b)));
      const rows = [];
      for (const [program, offset] of [[CLMM, 73], [CPMM, 168]]) {
        try {
          const r = await this.rpc('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', withContext: true,
            filters: [{ memcmp: { offset, bytes: sorted[0] } }, { memcmp: { offset: offset + 32, bytes: sorted[1] } }] }]);
          for (const a of (r.value || []).slice(0, 100)) {
            try { const p = program === CLMM ? clmm(a.account) : cpmm(a.account);
              if (p.mint0 === sorted[0] && p.mint1 === sorted[1]) rows.push({ address: a.pubkey, program, rank: p.depth0 || 0 });
            } catch { /* Unsupported pool layout is not a quote. */ }
          }
        } catch { /* Try the other Raydium pool type. */ }
      }
      path = { rows: rows.sort((a, b) => b.rank - a.rank).slice(0, 20), at }; this.paths.set(id, path);
    }
    if (!path.rows.length) return null;
    const r = await this.rpc('getMultipleAccounts', [path.rows.map(p => p.address), { encoding: 'base64', commitment: 'confirmed' }]);
    if (!Number.isSafeInteger(r.context?.slot) || !Array.isArray(r.value)) return null;
    const candidates = [];
    for (let i = 0; i < path.rows.length; i++) {
      const row = path.rows[i];
      try {
        let p;
        if (row.program === CLMM) p = clmm(r.value[i]);
        else {
          const state = cpmm(r.value[i]);
          const vs = await this.rpc('getMultipleAccounts', [[state.vault0, state.vault1], { encoding: 'base64', commitment: 'confirmed', minContextSlot: r.context.slot }]);
          const x = Number(vault(vs.value[0], state.mint0) - state.fees0) / 10 ** state.decimals0;
          const y = Number(vault(vs.value[1], state.mint1) - state.fees1) / 10 ** state.decimals1;
          if (!(x > 0 && y > 0)) continue;
          p = { ...state, price: y / x, depth0: x, depth1: y };
        }
        if (![p.mint0, p.mint1].includes(from) || ![p.mint0, p.mint1].includes(to)) continue;
        const forward = p.mint0 === from;
        candidates.push({ rate: forward ? p.price : 1 / p.price, depth: forward ? p.depth1 : p.depth0, pool: row.address, slot: r.context.slot });
      } catch { /* Missing/frozen accounts are not usable valuation. */ }
    }
    return candidates.filter(c => c.rate > 0 && Number.isFinite(c.rate)).sort((a, b) => b.depth - a.depth)[0] || null;
  }
  async rate(mint) {
    if (mint === WSOL) return { rate: 1, at: this.now(), source: 'native_wsol', pools: [] };
    const cached = this.rates.get(mint);
    if (cached && this.now() - cached.at < 5000) return cached;
    if (this.pending.has(mint)) return this.pending.get(mint);
    const work = (async () => {
      const started = this.now(); let p = await this.pair(mint, WSOL), pools = [];
      if (p && p.depth >= 100) pools = [p.pool];
      else if (mint !== USDC) {
        const usd = await this.pair(mint, USDC), sol = await this.pair(USDC, WSOL);
        p = usd && sol && sol.depth >= 100 && usd.depth * sol.rate >= 100 ? { rate: usd.rate * sol.rate, slot: Math.min(usd.slot, sol.slot) } : null;
        if (p) pools = [usd.pool, sol.pool];
      } else p = null;
      if (!p || this.now() - started > 15000) throw Error('No fresh on-chain quote/SOL valuation');
      const result = { rate: p.rate, at: started, slot: p.slot, source: 'helius_raydium_spot_proxy', pools, executable: false };
      this.rates.set(mint, result); return result;
    })();
    this.pending.set(mint, work);
    try { return await work; } finally { this.pending.delete(mint); }
  }
}
module.exports = { Valuation };
