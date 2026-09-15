'use strict';
const { cpmm, mint, vault } = require('./accounts');
const { active } = require('./protocol');
const { afterTransfer } = require('./proxy-quotes');
class Adapter {
  constructor(rpc, valuation, now = Date.now) { this.rpc = rpc; this.valuation = valuation; this.now = now; this.cache = new Map(); }
  keys(s) { return [s.pool, s.mint, s.quoteMint, s.baseVault, s.quoteVault]; }
  async state(s, values, slot) {
    if (!active(s, this.now())) throw Error('Graduation window ended');
    const pool = cpmm(values[0]), base = mint(values[1]), quote = mint(values[2], { quoteAsset: true });
    const order = pool.mint0 === s.mint;
    if ((order ? pool.mint0 : pool.mint1) !== s.mint || (order ? pool.mint1 : pool.mint0) !== s.quoteMint || (order ? pool.vault0 : pool.vault1) !== s.baseVault ||
        (order ? pool.vault1 : pool.vault0) !== s.quoteVault || (order ? pool.program0 : pool.program1) !== base.program ||
        (order ? pool.program1 : pool.program0) !== quote.program) throw Error('CPMM identity mismatch');
    const postBase = vault(values[3], s.mint) - (order ? pool.fees0 : pool.fees1);
    const postQuote = vault(values[4], s.quoteMint) - (order ? pool.fees1 : pool.fees0);
    if (postBase <= 0n || postQuote <= 0n) throw Error('Empty effective reserves');
    const fx = await this.valuation.rate(s.quoteMint);
    if (!active(s, this.now())) throw Error('Graduation window ended');
    const metadata = { at: this.now(), slot, feeBase: (order ? pool.fees0 : pool.fees1).toString(), feeQuote: (order ? pool.fees1 : pool.fees0).toString(),
      baseDecimals: base.decimals, quoteDecimals: quote.decimals, tokenProgram: base.program, transferFees: { base: base.fees, quote: quote.fees },
      quoteAssetControls: quote.controls, quoteAccounting: quote.accounting };
    this.cache.set(s.pool, metadata);
    return this.convert({ ...s, ...metadata, postBase: postBase.toString(), postQuoteRaw: postQuote.toString(), slot }, fx);
  }
  async prepare(s) {
    const r = await this.rpc('getMultipleAccounts', [this.keys(s), { encoding: 'base64', commitment: 'confirmed', minContextSlot: s.slot }]);
    if (!Number.isSafeInteger(r.context?.slot) || r.context.slot < s.slot) throw Error('Stale account state');
    return this.state(s, r.value, r.context.slot);
  }
  convert(s, fx) {
    const postQuote = Number(s.postQuoteRaw) / 10 ** s.quoteDecimals * fx.rate;
    return { ...s, market: 'stonk', fx, price: postQuote / Number(s.postBase), liquidity: postQuote,
      postQuote: String(Math.floor(postQuote * 1e9)), virtual: '0', valuation: 'helius_onchain_spot_proxy' };
  }
  async swap(s, receivedAt) {
    let meta = this.cache.get(s.pool);
    if (!meta || this.now() - meta.at > 15000) { await this.prepare(s); meta = this.cache.get(s.pool); }
    const fx = await this.valuation.rate(s.quoteMint);
    if (this.now() - fx.at > 15000 || !active(s, this.now())) throw Error('Stale valuation');
    // Keep the event's own reserves. Do not use a later RPC snapshot as the earlier execution observation.
    const enriched = this.convert({ ...s, ...meta, slot: s.slot,
      postBase: (BigInt(s.postBase) - BigInt(meta.feeBase)).toString(),
      postQuoteRaw: (BigInt(s.postQuoteRaw) - BigInt(meta.feeQuote)).toString(),
      receivedAt, eventTime: s.blockTime * 1000 }, fx);
    if (!(Number(enriched.postBase) > 0 && Number(enriched.postQuoteRaw) > 0)) throw Error('Invalid swap reserves');
    const rawQuote = Math.abs(Number(s.quoteVaultDeltaRaw));
    const netQuote = s.side === 'sell' ? afterTransfer(rawQuote, meta.transferFees.quote) : rawQuote;
    if (netQuote === null) throw Error('Unrepresentable quote amount');
    const quoteSol = netQuote / 10 ** s.quoteDecimals * fx.rate;
    return { ...enriched, quoteSol, sellSol: s.side === 'sell' ? quoteSol : 0, impact: -s.vaultRatioChangePct };
  }
}
module.exports = { Adapter };
