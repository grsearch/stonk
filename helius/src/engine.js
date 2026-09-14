'use strict';
const normalize = (...args) => require('./parser').normalize(...args);
const parseSwaps = (...args) => require('./parser').parseSwaps(...args);

const { isSignal, matchesBaseSignal, exitReason, exitConfig } = require('./strategy');

function canClose(item, data, now) {
  return item.createdByBot && item.dueAt <= now && !data.positions[item.mint]
    && !Object.values(data.pending).some(p => p.mint === item.mint);
}

class Engine {
  constructor(config, store, executor, stream, shadow = null) {
    this.c = config; this.store = store; this.data = store.data; this.executor = executor; this.stream = stream;
    this.busy = false; this.reconciling = false; this.stopped = false; this.minute = 0; this.candidates = 0;
    this.lastSlots = new Map(); this.lastPoll = 0; this.lastCleanup = 0;
    this.seen = new Map(); this.ticks = 0; this.swaps = 0;
    this.shadow = shadow;
    this.calibration = new (require('./calibration'))(config, store);
    this.entryGuards = new Map();
    this.entryWaiters = new Set();
    for (const receipt of Object.values(this.data.calibration?.transactions || {})) {
      if (receipt.receiptObservedAt + (config.liveEntryPolicy?.lossCooldownMs || 0) > Date.now())
        require('./live-entry-policy').recordLoss(config, this.data, receipt);
    }
    this.migrationDiagnostics = {}; this.migrationDiagnosticSamples = 0;
  }
  shadowEvent(method, ...args) { try { return this.shadow?.[method](...args); } catch (_) { /* Paper filter handles unavailable results; errors never escape the sidecar. */ } }
  onTransaction(result) {
    if (this.stopped || !result.signature || this.seen.has(result.signature)) {
      result.traffic = { category: this.stopped ? 'engine_stopped' : !result.signature ? 'missing_signature' : 'duplicate' }; return;
    }
    this.seen.set(result.signature, Date.now()); this.ticks++;
    if (this.seen.size > 20000) this.seen.delete(this.seen.keys().next().value);
    let migrationMatched = false;
    const parsed = parseSwaps(result, event => { this.stream.fresh?.created(event); this.shadowEvent('poolCreated', event); }, d => {
      if (d.stage === 'migration_matched' && d.count > 0) migrationMatched = true;
      this.migrationDiagnostics[d.stage] = (this.migrationDiagnostics[d.stage] || 0) + d.count;
      if (d.signature && this.migrationDiagnosticSamples < 20) {
        this.migrationDiagnosticSamples++; this.store.log('migration_diagnostic', d);
      }
    }, info => { result.traffic = migrationMatched ? { ...info, category: 'verified_migration', reasons: ['verified_migration'] } : info; }, tx => this.stream.fresh?.transaction(tx));
    this.onSwaps(parsed);
  }
  onSwaps(parsed) {
    if (this.stopped) return;
    for (const swap of parsed) {
      this.swaps++;
      this.stream.fresh?.reserve(swap.pool, swap.liquidity, swap.slot);
      const admitted = !this.stream.fresh?.reason(swap);
      const filter = this.shadowEvent('observe', swap, admitted && matchesBaseSignal(swap, this.c), admitted && isSignal(swap, this.c));
      const previous = this.lastSlots.get(swap.pool);
      if (previous && swap.slot < previous.slot) continue;
      for (const guard of this.entryGuards.values()) guard.observe(swap);
      this.lastSlots.set(swap.pool, { slot: swap.slot, at: Date.now() });
      if (this.lastSlots.size > 20000) this.lastSlots.delete(this.lastSlots.keys().next().value);
      const p = this.data.positions[swap.mint];
      if (p && p.pool === swap.pool && swap.slot >= (p.slot || 0)) {
        // Detect an elapsed gap before the returning quote resets the stream clock.
        this.latchQuoteTimeout(p);
        p.lastObservation = { source: 'stream', previousPrice: p.lastPrice, previousPriceAt: p.lastPriceAt,
          eventTime: swap.eventTime, receivedAt: swap.receivedAt, handledAt: Date.now(), slot: swap.slot, signature: swap.signature };
        p.lastPrice = swap.price; p.lastPriceAt = Date.now(); p.lastStreamQuoteAt = Date.now(); p.high = Math.max(p.high, swap.price);
        // Never continue using an ancient signal slot for a later execution RPC.
        Object.assign(p, { slot: swap.slot, virtual: swap.virtual });
        const reason = p.exitRetryReason || exitReason(p, swap.price, this.c);
        if (reason) this.sell(p, reason).catch(e => this.error('sell', e));
      }
      if (admitted && isSignal(swap, this.c)) this.buy(swap, filter).catch(e => this.error('buy', e));
    }
  }
  error(stage, err) {
    // Network exceptions can contain the API key URL. Redact both URLs and configured secrets.
    let message = String(err.message).replace(/https?:\/\/\S+/g, '[endpoint]');
    for (const secret of [this.c.apiKey, this.c.privateKey]) if (secret) message = message.split(secret).join('[redacted]');
    this.store.log('operation_error', { stage, code: Number.isInteger(err.code) ? err.code : null,
      contextSlot: Number.isSafeInteger(err.data?.contextSlot) ? err.data.contextSlot : null, error: message });
  }
  pending() { return Object.keys(this.data.pending).length > 0; }
  async buy(swap, filter) {
    if (!this.c.calibration?.enabled) return this.prepareBuy(swap, filter);
    const guard = new (require('./entry-guard').EntryGuard)(swap, this.c.liveEntryPolicy?.reserveExclusiveSol);
    const token = Symbol(); this.entryGuards.set(token, guard);
    try { return await this.prepareBuy(swap, filter, guard); }
    finally { this.entryGuards.delete(token); }
  }
  async prepareBuy(swap, filter, guard) {
    if (this.c.market === 'stonk' && (!this.c.dryRun || !isSignal(swap, this.c))) return;
    if (this.stream.fresh?.reason(swap)) return;
    const policyReason = require('./live-entry-policy').reason(this.c, this.data, swap);
    if (policyReason) {
      this.store.log('live_entry_policy', { version: 1, mint: swap.mint, pool: swap.pool, sourceSignature: swap.signature,
        reason: policyReason, reserveSol: swap.liquidity, cooldownUntil: this.data.lossCooldowns?.[swap.mint] ?? null });
      this.shadowEvent('decision', swap, 'skipped', { reason: policyReason }); return;
    }
    if ((this.c.dryRun && this.c.paperPrebuyFilter) || this.c.calibration?.enabled) {
      const startedAt = Date.now();
      // Same pre-dump snapshot as the research worker; no duplicate history or RPC.
      const result = swap.sellSol >= 40 ? { arm: { status: 'reject', rejected: [{ check: 'dumpSize', reason: 'dump_size_below_40_sol' }] } }
        : await filter;
      const arm = result?.arm;
      const reason = !arm ? 'prebuy_filter_unavailable' : arm.status === 'reject' ? 'prebuy_risk_filter'
        : this.c.calibration?.enabled && require('./entry-guard').historyUnavailable(arm) ? 'prebuy_history_required'
        : !isSignal(swap, this.c) ? 'expired_after_prebuy_filter' : null;
      const detail = { version: 1, scope: this.c.calibration?.enabled ? 'live_calibration' : 'paper_only', selectionId: result?.selectionId ?? null,
        status: arm?.status || 'unavailable', rejected: arm?.rejected || [], unknown: arm?.unknown || [], waitMs: Date.now() - startedAt };
      this.store.log(this.c.calibration?.enabled ? 'calibration_prebuy_filter' : 'paper_prebuy_filter', { mint: swap.mint, pool: swap.pool, signature: swap.signature, ...detail, reason });
      this.shadowEvent('decision', swap, reason ? 'skipped' : 'prebuy_filter_checked', { reason, prebuyFilter: detail });
      if (reason) return;
    }
    const rejectGuard = detail => {
      if (!detail) return false;
      this.store.log('live_entry_cancelled', { version: 1, mint: swap.mint, pool: swap.pool, sourceSignature: swap.signature, ...detail });
      this.shadowEvent('decision', swap, 'not_submitted', detail); return true;
    };
    if (!this.c.dryRun && this.c.liveEntryPolicy && (this.busy || this.reconciling || this.pending())) {
      await this.waitForEntry(swap, guard);
      if (!isSignal(swap, this.c)) { this.shadowEvent('decision', swap, 'skipped', { reason: 'expired_after_entry_wait' }); return; }
    }
    if (rejectGuard(guard?.rejected)) return;
    const policyAfterWait = require('./live-entry-policy').reason(this.c, this.data, swap);
    if (policyAfterWait) {
      this.store.log('live_entry_policy', { version: 1, mint: swap.mint, pool: swap.pool, sourceSignature: swap.signature,
        reason: policyAfterWait, reserveSol: swap.liquidity, cooldownUntil: this.data.lossCooldowns?.[swap.mint] ?? null });
      this.shadowEvent('decision', swap, 'skipped', { reason: policyAfterWait }); return;
    }
    const now = Date.now();
    if (this.stream.fresh?.reason(swap, now)) return;
    const reason = this.calibration.reason() || (this.stopped ? 'stopped' : this.busy ? 'wallet_busy' : this.reconciling ? 'reconciling'
      : this.pending() ? 'pending_transaction' : this.exitDue() ? 'exit_priority' : !this.stream.connected ? 'stream_disconnected'
        : this.stream.budgetExceeded() ? 'stream_budget' : this.data.positions[swap.mint] ? 'already_held'
          : Object.keys(this.data.positions).length >= this.c.maxPositions ? 'position_limit'
            : (this.data.cooldown[swap.mint] || 0) > now ? 'cooldown' : this.data.seen[swap.signature] ? 'duplicate_signal' : null);
    if (reason) { this.shadowEvent('decision', swap, 'skipped', { reason }); return; }
    const minute = Math.floor(now / 60000);
    if (minute !== this.minute) { this.minute = minute; this.candidates = 0; }
    if (this.candidates >= this.c.maxCandidatesPerMinute) { this.shadowEvent('decision', swap, 'skipped', { reason: 'candidate_limit' }); return; }
    this.candidates++; this.busy = true;
    this.data.seen[swap.signature] = now;
    this.data.cooldown[swap.mint] = now + this.c.cooldownMs;
    this.store.save();
    this.shadowEvent('decision', swap, 'preparing', { mode: this.c.dryRun ? 'paper' : 'live' });
    try {
      this.store.log('dump_signal', { mint: swap.mint, pool: swap.pool, sellSol: swap.sellSol, impact: swap.impact, signal: swap.signature });
      if (this.c.dryRun) {
        const rawAmount = Math.floor(this.c.sizeSol / swap.price).toString();
        this.data.positions[swap.mint] = { ...swap, rawAmount, entryPrice: swap.price, entrySol: this.c.sizeSol,
          high: swap.price, lastPrice: swap.price, lastPriceAt: now, openedAt: now, createdByBot: false };
        delete this.data.cleanup[swap.mint]; this.store.save(); this.store.log('paper_buy', { mint: swap.mint, pool: swap.pool,
          positionId: swap.signature, sourceSignature: swap.signature, openedAt: now, rawAmount, entryPrice: swap.price, entrySol: this.c.sizeSol });
        this.shadowEvent('decision', swap, 'paper_buy'); return;
      }
      const built = await this.executor.buildSwap('buy', swap);
      if (this.stream.fresh?.reason(swap)) return;
      if (guard && rejectGuard(guard.check(built.quoteStatePrice, 'rpc_state', built.quoteStateSlot))) return;
      if (this.stopped || !this.stream.connected || !isSignal(swap, this.c)) {
        this.store.log('signal_expired_before_send', { mint: swap.mint });
        this.shadowEvent('decision', swap, 'not_submitted', { reason: 'expired_or_stopped' }); return;
      }
      const previousCleanup = this.data.cleanup[swap.mint];
      const pending = { ...built, side: 'buy', mint: swap.mint, swap, createdByBot: built.createdByBot || previousCleanup?.createdByBot || false, submittedAt: Date.now() };
      // Persist signed bytes before sending. Reconcile uncertainty; never rebuild an unknown transaction.
      this.calibration.reserve(pending);
      this.data.pending[pending.signature] = pending;
      const journalStartedAt = Date.now();
      this.store.save();
      const sendStartedAt = Date.now();
      await this.executor.submit(pending);
      this.shadowEvent('decision', swap, 'buy_submitted', { signature: pending.signature, receiveToSendMs: sendStartedAt - swap.receivedAt });
      this.store.log('buy_submitted', { mint: swap.mint, signature: pending.signature,
        receiveToSendMs: sendStartedAt - swap.receivedAt, senderAckMs: Date.now() - sendStartedAt,
        journalMs: sendStartedAt - journalStartedAt,
        receiveToSubmitMs: Date.now() - swap.receivedAt, stateMs: built.stateMs, buildSignMs: built.buildSignMs });
    } catch (err) {
      this.shadowEvent('decision', swap, this.pending() ? 'submission_uncertain' : 'preparation_failed');
      throw err;
    } finally { this.busy = false; }
  }
  exitDue() {
    return !this.c.dryRun && Object.values(this.data.positions).some(p => p.exitRetryReason || exitReason(p, p.lastPrice, this.c));
  }
  async waitForEntry(swap, guard) {
    if (this.c.dryRun || !this.c.liveEntryPolicy || !(this.busy || this.reconciling || this.pending())) return;
    if (this.entryWaiters.size >= this.c.liveEntryPolicy.maxWaiters || this.entryWaiters.has(swap.pool)) return;
    const start = Date.now(), deadline = Math.min(start + this.c.liveEntryPolicy.waitMs,
      swap.receivedAt + this.c.maxSignalAgeMs, swap.eventTime + this.c.maxSignalAgeMs + 1000);
    this.entryWaiters.add(swap.pool);
    try {
      while (Date.now() < deadline && !this.stopped && this.stream.connected && !guard?.rejected
        && (this.busy || this.reconciling || this.pending())) {
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
    } finally {
      this.entryWaiters.delete(swap.pool);
      this.store.log('live_entry_wait', { mint: swap.mint, pool: swap.pool, sourceSignature: swap.signature,
        waitMs: Date.now() - start, stillBusy: !!(this.busy || this.reconciling || this.pending()) });
    }
  }
  async sell(p, reason) {
    if (this.c.market === 'stonk' && !this.c.dryRun) throw new Error('Stonk live trading is disabled');
    if (this.c.market === 'stonk' && Date.now() >= p.graduatedAt + 1800000) { this.expirePool(p.pool); return; }
    if (!this.c.dryRun && !p.exitRetryReason) { p.exitRetryReason = reason; this.store.save(); }
    reason = p.exitRetryReason || reason;
    p.exitDiagnostic ||= { version: 1, firstTriggerAt: Date.now(), reason, triggerPrice: p.lastPrice,
      observation: p.lastObservation || { source: 'timer_or_legacy', priceAt: p.lastPriceAt }, quoteTimeout: p.quoteTimeout || null,
      blockedAttempts: 0 };
    if (this.stopped || this.busy || this.reconciling || this.pending() || (p.retryAfter || 0) > Date.now()) { p.exitDiagnostic.blockedAttempts++; return; }
    this.busy = true;
    const executionStartedAt = Date.now();
    const diagnostic = { ...p.exitDiagnostic, executionStartedAt, triggerToExecutionMs: executionStartedAt - p.exitDiagnostic.firstTriggerAt };
    try {
      if (this.c.dryRun) {
        this.store.log('paper_sell', { mint: p.mint, pool: p.pool, positionId: p.signature, reason, openedAt: p.openedAt,
          heldMs: Date.now() - p.openedAt, rawAmount: p.rawAmount, entrySol: p.entrySol, entryPrice: p.entryPrice, exitPrice: p.lastPrice,
          grossPnlSol: Number(p.rawAmount) * p.lastPrice - p.entrySol, spotPnlPct: (p.lastPrice / p.entryPrice - 1) * 100,
          accountingVersion: 'paper_spot_v1', diagnostic });
        this.shadowEvent('decision', p, 'paper_sell', { mint: p.mint, positionId: p.signature, reason,
          accountingVersion: 'paper_spot_v1', grossPnlSol: Number(p.rawAmount) * p.lastPrice - p.entrySol, diagnostic });
        delete this.data.positions[p.mint]; this.store.save(); return;
      }
      const built = await this.executor.buildSwap('sell', p, p.rawAmount);
      if (this.stopped) return;
      const pending = { ...built, side: 'sell', mint: p.mint, reason, swap: p, diagnostic, submittedAt: Date.now() };
      this.data.pending[pending.signature] = pending; this.store.save();
      const sendAt = Date.now();
      await this.executor.submit(pending);
      this.store.log('sell_submitted', { mint: p.mint, signature: pending.signature, reason,
        diagnostic: { ...diagnostic, sendAt, triggerToSendMs: sendAt - diagnostic.firstTriggerAt, senderAckMs: Date.now() - sendAt } });
    } catch (err) {
      // A journaled signature may have landed even when submit throws. Reconcile
      // it first; never build a replacement while its outcome is unknown.
      if (!Object.values(this.data.pending).some(x => x.mint === p.mint && x.side === 'sell')) {
        this.scheduleExitRetry(p, reason, err.code === -32016 ? 'account_slot' : 'preparation_error');
      }
      throw err;
    }
    finally { this.busy = false; }
  }
  scheduleExitRetry(p, reason, kind) {
    p.exitRetryReason = reason;
    const retry = require('./exit-retry').planExitRetry(p, this.data, kind);
    this.store.save();
    this.store.log('exit_retry_scheduled', { mint: p.mint, pool: p.pool, reason, ...retry });
  }
  async reconcile() {
    if (this.c.dryRun || this.reconciling || this.busy || !this.pending()) return;
    this.reconciling = true;
    try {
      const entries = Object.values(this.data.pending);
      const statuses = (await this.executor.rpc.getSignatureStatuses(entries.map(p => p.signature), { searchTransactionHistory: true })).value;
      for (let i = 0; i < entries.length; i++) {
        const p = entries[i], status = statuses[i];
        if (status?.err && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
          if (this.c.calibration?.enabled) { const receipt = await this.executor.receipt(p.signature); if (!receipt) continue; this.accountCalibration(p, receipt); }
          this.failPending(p, 'chain_error', status.err); continue;
        }
        if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
          if (p.side === 'close') {
            if (status.confirmationStatus !== 'finalized') continue;
            if (this.c.calibration?.enabled) { const receipt = await this.executor.receipt(p.signature, 'finalized'); if (!receipt) continue; this.accountCalibration(p, receipt); }
            delete this.data.cleanup[p.mint]; delete this.data.pending[p.signature];
            this.store.save(); this.store.log('account_closed', { mint: p.mint, signature: p.signature }); continue;
          }
          const receipt = await this.executor.receipt(p.signature);
          if (!receipt) continue;
          this.applyReceipt(p, receipt);
        } else if (!status && Date.now() - p.submittedAt > 90000) {
          const height = await this.executor.rpc.getBlockHeight('finalized');
          if (height > p.lastValidBlockHeight + 32) {
            const receipt = await this.executor.receipt(p.signature, 'finalized');
            if (receipt && p.side !== 'close') this.applyReceipt(p, receipt);
            else if (receipt && p.side === 'close') {
              this.accountCalibration(p, receipt);
              if (receipt.meta?.err) this.failPending(p, 'receipt_error', receipt.meta.err);
              else {
                delete this.data.cleanup[p.mint]; delete this.data.pending[p.signature]; this.store.save();
                this.store.log('account_closed', { mint: p.mint, signature: p.signature });
              }
            }
            else if (!receipt) this.failPending(p, 'expired_unlanded');
          }
        }
        if (this.data.pending[p.signature] && Date.now() - p.submittedAt > 120000 && !p.warned) {
          p.warned = true; this.store.save(); this.store.log('pending_needs_attention', { signature: p.signature, side: p.side });
        }
      }
    } finally { this.reconciling = false; }
  }
  failPending(p, reason, chainError) {
    if (reason === 'expired_unlanded') this.calibration.unlanded(p);
    delete this.data.pending[p.signature];
    if (p.side === 'sell' && this.data.positions[p.mint]) {
      const kind = require('./exit-retry').isSlippageFailure(chainError) ? 'confirmed_slippage'
        : reason === 'expired_unlanded' ? 'expired_unlanded' : 'confirmed_other_failure';
      this.scheduleExitRetry(this.data.positions[p.mint], p.reason, kind);
    } else if (this.data.positions[p.mint]) this.data.positions[p.mint].retryAfter = Date.now() + 10000;
    if (p.side === 'close' && this.data.cleanup[p.mint]) this.data.cleanup[p.mint].dueAt = Date.now() + this.c.cleanupIntervalMs;
    this.store.save(); this.store.log('transaction_failed', { signature: p.signature, side: p.side, reason, chainError });
    if (p.swap) this.shadowEvent('decision', p.swap, 'transaction_failed', { side: p.side, signature: p.signature, reason });
  }
  accountCalibration(p, receipt) {
    if (!this.c.calibration?.enabled) return;
    // Failed receipts still contain authoritative balances/fees. Market parsing must continue to ignore them.
    const tx = normalize({ transaction: { transaction: receipt.transaction, meta: receipt.meta }, signature: p.signature, slot: receipt.slot }, { allowFailed: true });
    if (!tx) throw new Error('Calibration receipt unavailable');
    this.calibration.receipt(p, receipt, tx);
  }
  applyReceipt(p, receipt) {
    this.accountCalibration(p, receipt);
    if (receipt.meta?.err) { this.failPending(p, 'receipt_error', receipt.meta.err); return; }
    const result = { transaction: { transaction: receipt.transaction, meta: receipt.meta }, signature: p.signature, slot: receipt.slot };
    const tx = normalize(result);
    if (!tx) throw new Error('Invalid receipt');
    const index = tx.keys.indexOf(p.ata);
    const amount = list => BigInt(list?.find(b => b.accountIndex === index && b.mint === p.mint)?.uiTokenAmount.amount || '0');
    const pre = amount(tx.meta.preTokenBalances), post = amount(tx.meta.postTokenBalances);
    let actual = {};
    if (p.side === 'buy') {
      const acquired = post - pre;
      if (acquired <= 0n) throw new Error('Confirmed buy missing positive balance delta; manual reconciliation required');
      const ownSwap = parseSwaps(result).find(s => s.pool === p.swap.pool && s.side === 'buy');
      if (!ownSwap) throw new Error('Confirmed buy missing PumpSwap fill event; manual reconciliation required');
      const entrySol = ownSwap.quoteSol + Number(receipt.meta.fee) / 1e9 + this.c.tipLamports / 1e9;
      const entryPrice = entrySol / Number(acquired);
      actual = { entrySol, rawAcquired: acquired.toString(), quoteSol: ownSwap.quoteSol };
      this.data.positions[p.mint] = { ...p.swap, rawAmount: acquired.toString(), ata: p.ata, createdByBot: p.createdByBot,
        entrySol, entryPrice, high: entryPrice, lastPrice: ownSwap.price, lastPriceAt: Date.now(), lastStreamQuoteAt: Date.now(), openedAt: Date.now(), buySignature: p.signature };
      delete this.data.cleanup[p.mint];
    } else {
      const position = this.data.positions[p.mint];
      if (!position || pre - post < BigInt(position.rawAmount)) throw new Error('Sell fill does not match tracked amount; manual reconciliation required');
      const fill = parseSwaps(result).find(s => s.pool === p.swap.pool && s.side === 'sell');
      actual = { buySignature: position.buySignature, openedAt: position.openedAt, heldMs: Date.now() - position.openedAt,
        entrySol: position.entrySol, reason: p.reason, rawSold: (pre - post).toString(), quoteSol: fill?.quoteSol ?? null,
        netPnlSol: fill ? fill.quoteSol - Number(receipt.meta.fee) / 1e9 - this.c.tipLamports / 1e9 - position.entrySol : null };
      const economicReceipt = this.calibration.s?.transactions[p.signature];
      const previousLossCooldown = this.data.lossCooldowns?.[p.mint] || 0;
      require('./live-entry-policy').recordLoss(this.c, this.data, economicReceipt || {
        side: 'sell', status: 'confirmed', mint: p.mint, netPnlSol: actual.netPnlSol, receiptObservedAt: Date.now() });
      if ((this.data.lossCooldowns?.[p.mint] || 0) > previousLossCooldown)
        this.store.log('live_loss_cooldown_started', { mint: p.mint, signature: p.signature,
          netPnlSol: economicReceipt?.netPnlSol ?? actual.netPnlSol, cooldownUntil: this.data.lossCooldowns[p.mint] });
      if (post === 0n && position.createdByBot) {
        this.data.cleanup[p.mint] = { mint: p.mint, ata: p.ata, tokenProgram: position.tokenProgram,
          createdByBot: true, soldAt: Date.now(), dueAt: Date.now() + this.c.closeAfterMs };
      }
      delete this.data.positions[p.mint];
    }
    delete this.data.pending[p.signature]; this.store.save();
    this.shadowEvent('decision', p.swap, `${p.side}_confirmed`, { mode: 'live', mint: p.mint, signature: p.signature, slot: receipt.slot,
      networkFeeSol: Number(receipt.meta.fee) / 1e9, ...actual });
    this.store.log(`${p.side}_confirmed`, { mint: p.mint, signature: p.signature, confirmMs: Date.now() - p.submittedAt,
      pool: p.swap?.pool, sourceSignature: p.swap?.signature, networkFeeSol: Number(receipt.meta.fee) / 1e9,
      assumedTipSol: this.c.tipLamports / 1e9, ...actual,
      diagnostic: p.diagnostic,
      triggerSlot: p.swap?.slot, landedSlot: receipt.slot,
      slotGap: p.swap?.slot !== undefined ? receipt.slot - p.swap.slot : undefined });
  }
  async cleanup() {
    if (this.c.dryRun || this.stopped || this.busy || this.pending() || this.reconciling) return;
    const item = Object.values(this.data.cleanup).find(x => canClose(x, this.data, Date.now()));
    if (!item) return;
    // The same lock covers buys and closes, including their asynchronous account checks.
    this.busy = true;
    try {
      const built = await this.executor.closeTransaction(item);
      if (this.stopped) return;
      if (!built) { delete this.data.cleanup[item.mint]; this.store.save(); return; }
      const pending = { ...built, side: 'close', mint: item.mint, submittedAt: Date.now() };
      this.data.pending[pending.signature] = pending; this.store.save();
      await this.executor.submit(pending);
    } catch (err) {
      item.dueAt = Date.now() + this.c.cleanupIntervalMs; this.store.save(); this.error('account_cleanup', err);
    } finally { this.busy = false; }
  }
  async pollPositions() {
    if (this.c.dryRun || this.busy || this.pending() || this.reconciling || this.stopped) return;
    // Only owned positions are polled; never poll the market or a token watchlist.
    const positions = Object.values(this.data.positions);
    if (!positions.length) return;
    const { PublicKey } = require('@solana/web3.js');
    const keys = positions.flatMap(p => [new PublicKey(p.baseVault), new PublicKey(p.quoteVault), new PublicKey(p.pool)]);
    const response = await this.executor.rpc.getMultipleAccountsInfoAndContext(keys, 'confirmed');
    const { unpackAccount } = require('@solana/spl-token');
    const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (this.data.positions[p.mint] !== p) continue;
      const bInfo = response.value[3 * i], qInfo = response.value[3 * i + 1], poolInfo = response.value[3 * i + 2];
      if (!bInfo || !qInfo || !poolInfo) { this.store.log('position_vault_missing', { mint: p.mint }); continue; }
      if (response.context.slot < (p.slot || 0)) continue;
      const b = unpackAccount(keys[3 * i], bInfo, new PublicKey(p.tokenProgram));
      const q = unpackAccount(keys[3 * i + 1], qInfo, TOKEN_PROGRAM_ID);
      p.virtual = require('@pump-fun/pump-swap-sdk').PUMP_AMM_SDK.decodePool(poolInfo).virtualQuoteReserves.toString();
      if (!b.amount) continue;
      p.lastObservation = { source: 'confirmed_rpc_poll', previousPrice: p.lastPrice, previousPriceAt: p.lastPriceAt,
        receivedAt: Date.now(), slot: response.context.slot };
      p.lastPrice = Number(q.amount + BigInt(p.virtual || '0')) / Number(b.amount) / 1e9;
      p.lastPriceAt = Date.now(); p.high = Math.max(p.high, p.lastPrice); p.slot = response.context.slot;
      this.latchQuoteTimeout(p);
      const reason = p.exitRetryReason || exitReason(p, p.lastPrice, this.c);
      if (reason) await this.sell(p, reason);
    }
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      // Persist all due intents before any RPC or pending transaction can block us.
      for (const p of Object.values(this.data.positions)) this.latchQuoteTimeout(p);
      await this.reconcile();
      // Timeout exits must work even if market streaming disconnects or hits its budget.
      for (const p of Object.values(this.data.positions)) {
        if (this.c.market === 'stonk' && Date.now() >= p.graduatedAt + 1800000) { this.expirePool(p.pool); continue; }
        const fresh = Date.now() - p.lastPriceAt <= Math.max(5000, this.c.positionPollMs * 2);
        const reason = p.exitRetryReason || (fresh ? exitReason(p, p.lastPrice, this.c)
          : Date.now() - p.openedAt >= exitConfig(this.c).maxHoldMs ? 'max_hold' : null);
        if (reason) await this.sell(p, reason);
      }
      if (Date.now() - this.lastPoll >= this.c.positionPollMs) { this.lastPoll = Date.now(); await this.pollPositions(); }
      if (Date.now() - this.lastCleanup >= this.c.cleanupIntervalMs) { this.lastCleanup = Date.now(); await this.cleanup(); }
    } catch (err) { this.error('maintenance', err); }
    finally { this.ticking = false; }
  }
  expirePool(pool) {
    for (const p of Object.values(this.data.positions)) if (p.pool === pool) {
      this.store.log('paper_censored', { mint: p.mint, pool, positionId: p.signature, reason: 'graduation_window_end',
        entrySol: p.entrySol, openedAt: p.openedAt, netPnlSol: null });
      delete this.data.positions[p.mint]; this.store.save();
    }
    this.shadowEvent('poolExpired', pool, Date.now());
  }
  latchQuoteTimeout(p, now = Date.now()) {
    if (this.c.dryRun || !this.c.quoteTimeoutMs || p.exitRetryReason) return;
    // Legacy positions start from their original opening time, never a poll/restart.
    const last = p.lastStreamQuoteAt ?? p.openedAt;
    if (!Number.isFinite(last) || now - last < this.c.quoteTimeoutMs) return;
    const fresh = now - p.lastPriceAt <= Math.max(5000, this.c.positionPollMs * 2);
    const reason = p.exitDiagnostic?.reason || (fresh ? exitReason(p, p.lastPrice, this.c, now)
      : now - p.openedAt >= exitConfig(this.c).maxHoldMs ? 'max_hold' : null) || 'quote_timeout';
    p.exitRetryReason = reason;
    p.quoteTimeout = { version: 1, detectedAt: now, lastStreamQuoteAt: last, gapMs: now - last, thresholdMs: this.c.quoteTimeoutMs };
    this.store.save();
    this.store.log('exit_triggered', { mint: p.mint, pool: p.pool, reason, ...p.quoteTimeout });
  }
  report() {
    const now = Date.now();
    for (const [sig, at] of Object.entries(this.data.seen)) if (now - at > 86400000) delete this.data.seen[sig];
    for (const [mint, until] of Object.entries(this.data.cooldown)) if (until < now) delete this.data.cooldown[mint];
    const days = Object.keys(this.data.streamDays).sort();
    for (const day of days.slice(0, -7)) delete this.data.streamDays[day];
    this.store.save();
    const dayBytes = this.data.streamDays[new Date().toISOString().slice(0, 10)] || 0;
    this.store.log('health', { calibration: this.calibration.s ? { batchId: this.calibration.s.batchId, attempts: this.calibration.s.attempts, lossSol: this.calibration.s.lossSol, stoppedReason: this.calibration.reason(), limits: this.calibration.s.limits } : null, connected: this.stream.connected, transactions: this.ticks, parsedSwaps: this.swaps,
      rpcRequests: this.executor.rpcCalls + (this.c.market === 'stonk' ? 0 : this.shadowEvent('stats')?.stateQuotes?.requests || 0), migrationDiagnostics: this.migrationDiagnostics,
      positions: Object.keys(this.data.positions).length, pending: Object.keys(this.data.pending).length,
      streamMBToday: +(dayBytes / 1e6).toFixed(3), estimatedStreamCreditsToday: +(dayBytes / 1e6 * 20).toFixed(1) });
    const shadow = this.shadowEvent('stats');
    if (shadow) this.store.log('shadow_health', shadow);
  }
}
module.exports = { Engine, isSignal, exitReason, canClose };
