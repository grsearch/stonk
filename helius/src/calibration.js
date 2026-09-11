'use strict';
const crypto = require('node:crypto');
// Persistent calibration accounting. Accounting faults stop entry; counts/losses are statistics only.
class Calibration {
  constructor(c, store) {
    this.c = c; this.store = store;
    if (!c.calibration?.enabled) {
      if (store.data.calibration) throw new Error('Calibration state requires calibration mode');
      return;
    }
    const limits = { sizeSol: c.sizeSol, maxBuys: c.calibration.maxBuys, lossLimitSol: c.calibration.lossLimitSol };
    let s = store.data.calibration;
    if (!s) {
      if (['positions', 'pending', 'cleanup'].some(k => Object.keys(store.data[k]).length)) throw new Error('Calibration requires an empty dedicated state');
      s = store.data.calibration = { version: 2, batchId: crypto.randomUUID(), limits, attempts: 0,
        lossSol: 0, cashDeltaSol: 0, rentDeltaSol: 0, stoppedReason: null, transactions: {}, buys: {} };
      store.save();
    }
    if (![1, 2].includes(s.version) || s.limits?.sizeSol !== limits.sizeSol
      || !Number.isInteger(s.attempts) || s.attempts < 0 || !Number.isFinite(s.lossSol) || s.lossSol < 0
      || !Number.isFinite(s.cashDeltaSol) || !Number.isFinite(s.rentDeltaSol) || typeof s.batchId !== 'string'
      || !s.transactions || Array.isArray(s.transactions) || !s.buys || Array.isArray(s.buys)) throw new Error('Invalid or changed calibration budget');
    this.s = s;
    if (s.version === 1) {
      // Preserve the batch and every receipt/position; retire only the two explicitly removed stops.
      s.previousLimits = { ...s.limits };
      s.version = 2; s.limits = limits;
      if (['calibration_buy_limit', 'calibration_loss_limit'].includes(s.stoppedReason)) s.stoppedReason = null;
      store.save();
      store.log('calibration_limits_removed', { batchId: s.batchId, attempts: s.attempts, lossSol: s.lossSol, version: 2 });
    }
  }
  reason() {
    if (!this.s) return null;
    if (this.s.stoppedReason) return this.s.stoppedReason;
    return null;
  }
  reserve(p) {
    if (!this.s) return;
    const reason = this.reason(); if (reason) throw new Error(reason);
    this.s.attempts++;
    p.calibrationBatchId = this.s.batchId; p.calibrationAttempt = this.s.attempts;
    // Caller persists this reservation and signed pending transaction atomically, before submit.
  }
  receipt(p, receipt, tx) {
    if (!this.s || this.s.transactions[p.signature]) return;
    const m = receipt.meta, wallet = tx.keys.indexOf(this.store.data.wallet);
    const balance = (a, i) => i >= 0 && Number.isSafeInteger(a?.[i]) ? a[i] : null;
    const pre = balance(m?.preBalances, wallet), post = balance(m?.postBalances, wallet);
    const valid = pre !== null && post !== null && Number.isSafeInteger(m?.fee);
    let rent = 0, accountsValid = true;
    for (const address of [...new Set([p.ata, p.quoteAta].filter(Boolean))]) {
      const i = tx.keys.indexOf(address), a = balance(m?.preBalances, i), b = balance(m?.postBalances, i);
      if (a === null || b === null) { accountsValid = false; this.s.stoppedReason = 'calibration_accounting_unavailable'; continue; }
      // Executor refuses pre-existing WSOL and uses only native SOL wrapping in this mode.
      rent += (b - a) / 1e9;
    }
    const cash = valid ? (post - pre) / 1e9 : null;
    if (!valid) this.s.stoppedReason = 'calibration_accounting_unavailable';
    const economic = cash === null || !accountsValid ? null : cash + rent;
    const index = tx.keys.indexOf(p.ata);
    const amount = list => list?.find(x => x.accountIndex === index && x.mint === p.mint)?.uiTokenAmount?.amount || '0';
    const rawBaseDelta = (BigInt(amount(m?.postTokenBalances)) - BigInt(amount(m?.preTokenBalances))).toString();
    const event = { rawBaseDelta, version: 1, batchId: this.s.batchId, signature: p.signature, side: p.side, mint: p.mint,
      sourceSignature: p.swap?.signature, pool: p.swap?.pool, status: m?.err ? 'failed' : 'confirmed',
      submittedAt: p.submittedAt, receiptObservedAt: Date.now(), landedSlot: receipt.slot,
      blockTime: receipt.blockTime ?? null, walletCashDeltaSol: cash, accountLamportDeltaSol: rent,
      economicDeltaSol: economic, networkFeeSol: valid ? m.fee / 1e9 : null,
      senderTipSol: m?.err ? 0 : p.senderTipSol ?? null, computeUnitsConsumed: m?.computeUnitsConsumed ?? null,
      note: 'Network fee includes priority fee. Account lamport delta is separate from trading PnL; blockTime is not millisecond landing latency.' };
    if (cash !== null) { this.s.cashDeltaSol += cash; this.s.rentDeltaSol += rent; }
    if (economic !== null) {
      if (m?.err || p.side === 'close') this.s.lossSol += Math.max(0, -economic);
      else if (p.side === 'buy') this.s.buys[p.mint] = { signature: p.signature, economicDeltaSol: economic, sourceSignature: p.swap?.signature };
      else if (p.side === 'sell') {
        const buy = this.s.buys[p.mint];
        if (!buy) this.s.stoppedReason = 'calibration_buy_accounting_missing';
        else {
          event.buySignature = buy.signature;
          event.netPnlSol = buy.economicDeltaSol + economic;
          this.s.lossSol += Math.max(0, -event.netPnlSol);
          delete this.s.buys[p.mint];
        }
      }
    }
    this.s.transactions[p.signature] = event;
    this.store.log('calibration_receipt', event);
  }
  unlanded(p) {
    if (this.s) this.store.log('calibration_unlanded', { batchId: this.s.batchId, signature: p.signature, side: p.side, feeSol: 0 });
  }
}
module.exports = Calibration;
