'use strict';
function calibrationAudit(receipts, comparisons, start, end) {
  const rows = [], transactions = [...receipts.values()].filter(r => Date.parse(r.time) >= start && Date.parse(r.time) < end);
  for (const r of transactions.filter(r => r.side === 'sell' && r.status === 'confirmed')) {
    const key = `${r.sourceSignature}:${r.pool}`;
    const proxy = role => {
      const c = comparisons.get(`${role}:${key}`);
      return c?.status === 'observed_proxy' && Number.isFinite(c.netPnlSol) ? { netPnlSol: c.netPnlSol,
        sizeSol: c.executionPolicy?.sizeSol, entryAt: c.entryAt, exitAt: c.exitAt, policyId: c.policyId } : null;
    };
    const same = proxy('same_size'), reference = proxy('reference_1_sol');
    rows.push({ batchId: r.batchId, signature: r.signature, buySignature: r.buySignature, key, mint: r.mint,
      liveNetPnlSol: r.netPnlSol ?? null, sameSize: same, reference1Sol: reference,
      differenceSol: same && Number.isFinite(r.netPnlSol) ? r.netPnlSol - same.netPnlSol : null });
  }
  return { version: 1, transactions, rows, paired: rows.filter(r => r.differenceSol !== null).length,
    unknown: rows.filter(r => r.differenceSol === null).length,
    note: 'Real receipt wallet changes adjusted for managed account lamport changes; failures/close fees recorded separately. Network fee includes priority fee. Missing shadow results remain unknown. One-SOL reference is not scalable live PnL; no shadow-gap interpolation.' };
}
module.exports = { calibrationAudit };
