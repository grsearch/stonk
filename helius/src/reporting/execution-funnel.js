'use strict';
class ExecutionFunnel {
  constructor() { this.groups = new Map(); this.batches = new Map(); }
  add(group, key) {
    if (!key) return;
    if (!this.groups.has(group)) this.groups.set(group, new Set());
    const s = this.groups.get(group); s.add(key);
    if (s.size > 100000) throw new Error('Execution funnel size limit');
  }
  snapshot(s) {
    if (!s?.batchId) return;
    const txs = Object.values(s.transactions || {});
    const buys = new Set(txs.filter(t => t.side === 'buy' && t.status === 'confirmed').map(t => t.signature));
    this.batches.set(s.batchId, { batchId: s.batchId, attempts: s.attempts,
      confirmedBuysInLedger: buys.size, lossSol: s.lossSol,
      status: Number.isInteger(s.attempts) && buys.size <= s.attempts ? 'count_consistent' : 'count_mismatch' });
  }
  record(r) {
    const key = r.sourceSignature && r.pool ? `${r.sourceSignature}:${r.pool}` : null;
    if (r.type === 'live_entry_policy') this.add(`livePolicyRejected:${r.reason}`, key);
    if (r.type === 'live_entry_wait') this.add(r.stillBusy ? 'entryWaitStillBusy' : 'entryWaitReleased', key);
    if (r.type === 'live_entry_cancelled') this.add(`entryCancelled:${r.reason}`, key);
    if (r.type === 'calibration_prebuy_filter' && r.reason === 'prebuy_history_required' && r.signature && r.pool)
      this.add('historyRequiredCandidates', `${r.signature}:${r.pool}`);
    if (r.type === 'execution_account_read_failed' && r.side === 'buy') {
      this.add('accountReadFailedCandidates', key);
      if (r.code === -32016) this.add('slotLagCandidates', key);
      if (!r.retry) this.add('accountReadTerminalFailures', key);
    }
    if (r.type === 'execution_account_read_recovered' && r.side === 'buy') this.add('accountReadRecoveredCandidates', key);
    if (r.type === 'execution_token_extensions' && r.side === 'buy' && r.status === 'rejected') {
      this.add('extensionRejectedCandidates', key);
      for (const e of r.blockedExtensions || []) this.add(`blockedExtension:${e.type}`, key);
    }
    if (r.type === 'calibration_receipt' && r.signature) this.add(`receipt:${r.side}:${r.status}`, r.signature);
  }
  result() { return { version: 1, counts: Object.fromEntries([...this.groups].map(([k, v]) => [k, v.size])),
    batchSnapshots: [...this.batches.values()], note: 'Window receipts deduplicated by transaction signature; read/extension failures by source signal and pool. Groups overlap, not a complete additive funnel. Legacy missing signal keys cannot be reconstructed. Batch snapshots are export-time lifetime counts, not window counts; consistency does not prove complete logs.' }; }
}
module.exports = { ExecutionFunnel };
