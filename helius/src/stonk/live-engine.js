'use strict';
const { WINDOW_MS: STONK_WINDOW_MS } = require('./protocol');
const { Engine } = require('../engine');
const { exitReason } = require('../strategy');
function fill(p, receipt, wallet) {
  const meta = receipt.meta, message = receipt.transaction?.message;
  const keys = [...(message?.staticAccountKeys || message?.accountKeys || []), ...(meta?.loadedAddresses?.writable || []), ...(meta?.loadedAddresses?.readonly || [])].map(k => k.toBase58?.() || k.pubkey?.toBase58?.() || String(k));
  if (!meta || meta.err || !receipt.transaction.signatures.includes(p.signature) || keys[0] !== wallet || !keys.includes(p.swap.pool)) throw Error('Unverified Stonk receipt');
  const index = keys.indexOf(p.ata);
  if (index < 0) throw Error('Missing wallet token account');
  const amount = list => {
    const r = list?.find(r => r.accountIndex === index && r.mint === p.mint);
    if (r && r.owner !== wallet) throw Error('Receipt token owner mismatch');
    return BigInt(r?.uiTokenAmount.amount || '0');
  };
  const delta = amount(meta.postTokenBalances) - amount(meta.preTokenBalances);
  const solDelta = (meta.postBalances[0] - meta.preBalances[0]) / 1e9;
  if (!Number.isFinite(solDelta) || (p.side === 'buy' ? delta <= 0n || solDelta >= 0 : delta !== -BigInt(p.inputAmount))) throw Error('Receipt amount mismatch');
  if (p.side === 'buy' && delta < BigInt(p.minOutputAmount)) throw Error('Buy output below signed minimum');
  return { rawDelta: delta, solDelta, feeSol: meta.fee / 1e9, slot: receipt.slot };
}
class LiveEngine extends Engine {
  applyReceipt(p, receipt) {
    if (receipt.meta?.err) return this.failPending(p, 'receipt_error', receipt.meta.err);
    const actual = fill(p, receipt, this.data.wallet), now = Date.now();
    let event;
    if (p.side === 'buy') {
      const entrySol = -actual.solDelta, entryPrice = entrySol / Number(actual.rawDelta);
      this.data.positions[p.mint] = { ...p.swap, rawAmount: actual.rawDelta.toString(), ata: p.ata, tokenProgram: p.tokenProgram,
        entrySol, entryPrice, high: p.swap.price, lastPrice: p.swap.price, lastPriceAt: now, lastStreamQuoteAt: now,
        openedAt: p.submittedAt, buySignature: p.signature, createdByBot: false };
      event = { type: 'buy_confirmed', fields: { mint: p.mint, signature: p.signature, sourceSignature: p.swap.signature, slot: actual.slot,
        sourceSlot: p.swap.slot, slotDelta: actual.slot - p.swap.slot, rawAcquired: actual.rawDelta.toString(), entrySol, accountingVersion: 'stonk_wallet_sol_delta_v1' } };
    } else {
      const position = this.data.positions[p.mint];
      if (!position || BigInt(position.rawAmount) !== -actual.rawDelta) throw Error('Position receipt mismatch');
      const netPnlSol = actual.solDelta - position.entrySol;
      require('../live-entry-policy').recordLoss(this.c, this.data, { side: 'sell', status: 'confirmed', mint: p.mint, netPnlSol, receiptObservedAt: now });
      delete this.data.positions[p.mint];
      event = { type: 'sell_confirmed', fields: { mint: p.mint, signature: p.signature, buySignature: position.buySignature, reason: p.reason,
        netPnlSol, quoteSol: actual.solDelta, entrySol: position.entrySol, heldMs: now - position.openedAt, slot: actual.slot,
        accountingVersion: 'stonk_wallet_sol_delta_v1' } };
    }
    delete this.data.pending[p.signature]; this.store.save();
    this.store.log(event.type, event.fields);
    this.shadowEvent('decision', p.swap, event.type, { mode: 'live', ...event.fields });
  }
  expirePool(pool) {
    // Graduation limits entry, never erase an actual wallet holding.
    for (const p of Object.values(this.data.positions)) if (p.pool === pool) {
      p.exitRetryReason ||= 'graduation_window_end'; this.store.save();
    }
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcile();
      for (const p of Object.values(this.data.positions)) {
        const now = Date.now();
        const why = p.exitRetryReason || (now >= p.graduatedAt + STONK_WINDOW_MS ? 'graduation_window_end'
          : now - p.openedAt >= this.c.maxHoldMs ? 'max_hold' : now - p.lastPriceAt >= this.c.quoteTimeoutMs ? 'quote_timeout'
            : exitReason(p, p.lastPrice, this.c, now));
        if (why) await this.sell(p, why);
      }
    } catch (e) { this.error('stonk_live_maintenance', e); }
    finally { this.ticking = false; }
  }
}
module.exports = { LiveEngine, fill };
