'use strict';
const { PUMP } = require('./config');
const PUMP_FUN = require('./migration-layout.json').address;
const options = { commitment: 'processed', encoding: 'base64', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 0 };
class PoolSubscriptions {
  constructor(send, fail, log) { this.send = send; this.fail = fail; this.log = log; this.next = 1; this.pending = new Map(); this.roles = new Map(); this.discovery = null; this.active = null; this.activeKey = ''; this.updating = false; }
  request(method, params, data) {
    const id = this.next++; this.pending.set(id, { ...data, at: Date.now() }); this.send({ jsonrpc: '2.0', id, method, params });
  }
  start() {
    // AND, not accountInclude OR: successful strict migrations invoke both programs.
    this.request('transactionSubscribe', [{ vote: false, failed: false, accountRequired: [PUMP_FUN, PUMP] }, options], { kind: 'discovery' });
  }
  update(addresses) {
    if ([...this.pending.values()].some(x=>Date.now()-x.at>10000)) { this.fail(); return; }
    if (this.discovery == null || this.updating) return;
    const key = addresses.join(','); if (key === this.activeKey) return;
    if (!addresses.length) {
      if (this.active != null) this.request('transactionUnsubscribe', [this.active], { kind: 'remove', subscription: this.active });
      this.active = null; this.activeKey = ''; return;
    }
    this.updating = true;
    this.request('transactionSubscribe', [{ vote: false, failed: false, accountInclude: addresses, accountRequired: [PUMP] }, options], { kind: 'pools', key, count: addresses.length });
  }
  ack(msg) {
    const p = this.pending.get(msg.id); if (!p) return false;
    this.pending.delete(msg.id);
    if (msg.error || (p.kind !== 'remove' && !Number.isSafeInteger(msg.result)) || (p.kind === 'remove' && msg.result !== true)) { this.fail(); return true; }
    if (p.kind === 'remove') this.roles.delete(p.subscription);
    else {
      this.roles.set(msg.result, p.kind);
      if (p.kind === 'discovery') this.discovery = msg.result;
      else {
        const old = this.active; this.active = msg.result; this.activeKey = p.key; this.updating = false;
        // Subscribe before removing old filter; Engine deduplicates overlapping signatures.
        if (old != null) this.request('transactionUnsubscribe', [old], { kind: 'remove', subscription: old });
        this.log('fresh_pool_subscription', { version: 1, pools: p.count });
      }
    }
    return true;
  }
  ready(addresses) { return this.discovery != null && (!addresses.length || this.active != null); }
}
module.exports = { PoolSubscriptions };
