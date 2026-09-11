'use strict';

// Bounded, interval-local accounting. Multi-pool bytes are allocated equally,
// not claimed to be the actual per-instruction wire size.
class StreamTraffic {
  constructor(log, now = Date.now, limit = 2048) {
    this.log = log; this.now = now; this.limit = limit; this.reset();
  }
  reset() {
    this.start = this.now(); this.total = 0; this.messages = 0;
    this.categories = {}; this.reasons = {}; this.pools = new Map(); this.unattributed = 0; this.overflow = 0;
  }
  record(size, info = {}) {
    this.total += size; this.messages++;
    const category = info.category || 'unclassified';
    const c = this.categories[category] ||= { messages: 0, byteCount: 0 };
    c.messages++; c.byteCount += size;
    const reasons = [...new Set(info.reasons?.length ? info.reasons : [category])];
    for (const reason of reasons) {
      const row = this.reasons[reason] ||= { messages: 0, byteCount: 0 };
      row.messages++; row.byteCount += size / reasons.length;
    }
    const pools = [...new Set(info.pools || [])];
    if (!pools.length) { this.unattributed += size; return; }
    const share = size / pools.length;
    for (const pool of pools) {
      if (!this.pools.has(pool) && this.pools.size >= this.limit) { this.overflow += share; continue; }
      const p = this.pools.get(pool) || { pool, byteCount: 0, messages: 0 };
      p.byteCount += share; p.messages++; this.pools.set(pool, p);
    }
  }
  flush() {
    if (!this.messages) return;
    const rows = [...this.pools.values()].sort((a, b) => b.byteCount - a.byteCount);
    const report = { version: 2, start: this.start, end: this.now(), messages: this.messages,
      byteCount: this.total, categories: this.categories, poolAllocation: 'equal_per_distinct_pool',
      reasons: this.reasons, reasonAllocation: 'equal_per_distinct_reason',
      topPools: rows.slice(0, 20), otherPoolByteCount: rows.slice(20).reduce((s, p) => s + p.byteCount, 0),
      overflowPoolByteCount: this.overflow, unattributedByteCount: this.unattributed,
      trackedPools: rows.length, poolLimit: this.limit };
    this.log('stream_traffic', report); this.reset();
    return report;
  }
}
module.exports = StreamTraffic;
