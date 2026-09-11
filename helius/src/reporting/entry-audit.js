'use strict';
function entryAudit(records) {
  const groups = new Map();
  for (const r of records.values()) {
    const key = `${r.policyId}:${r.entryResearchVersion}:${r.variant}`;
    if (!groups.has(key)) groups.set(key, { policyId: r.policyId, version: r.entryResearchVersion, variant: r.variant,
      candidates: 0, entered: 0, observed: 0, netPnlSol: 0, skipped: 0, notEntered: 0, unknown: 0, pending: 0,
      paired: 0, pairedBaselineSol: 0, pairedVariantSol: 0, reasons: {} });
    const g = groups.get(key); g.candidates++; if (Number.isFinite(r.entryAt)) g.entered++;
    if (r.phase !== 'finished') g.pending++;
    else if (r.status === 'skipped') g.skipped++;
    else if (r.status === 'not_entered') g.notEntered++;
    else if (r.status === 'observed_proxy' && Number.isFinite(r.netPnlSol)) {
      g.observed++; g.netPnlSol += r.netPnlSol;
      const b = records.get(`${r.id}:immediate`);
      if (b?.policyId === r.policyId && b.entryResearchVersion === r.entryResearchVersion && b.phase === 'finished'
        && b.status === 'observed_proxy' && Number.isFinite(b.netPnlSol)) {
        g.paired++; g.pairedBaselineSol += b.netPnlSol; g.pairedVariantSol += r.netPnlSol;
      }
    } else g.unknown++;
    if (r.reason) g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
  }
  return { version: 1, scope: 'latest window events; candidate research, not portfolio; unknown and pending excluded from known PnL',
    groups: [...groups.values()] };
}
module.exports = { entryAudit };
