'use strict';
// Different sources are parallel experiments, not additive profit or replacement labels.
function recoveryAudit(records, outcomes) {
  const groups = new Map();
  for (const r of records.values()) {
    const meta = { runId: r.runId, policyId: r.policyId, type: r.type, variant: r.variant,
      recoveryVersion: r.recoveryVersion, selectionId: r.selection?.selectionId ?? null, modelIds: r.selection?.modelIds ?? null };
    const key = JSON.stringify(meta);
    const names = ['all', 'joint', 'highRebound', ...['prebuyBeforeAge', 'avoidMigrationAge', 'prebuyBeforeBuy80', 'avoidBuyBurst', 'prebuyLegacy', 'avoidConsecutivePressure', 'avoidWeakBuy', 'avoidPriorFall', 'avoidLargeDump', 'prebuyCombined', 'prebuyAllowUnknown', 'prebuyRequireKnown', 'prebuyUnknownOnly'].filter(n => r.selection?.arms?.[n])];
    if (!groups.has(key)) groups.set(key, { ...meta });
    for (const name of names) {
      groups.get(key)[name] ||= {};
      if (name !== 'all' && r.selection?.arms?.[name]?.status !== 'pass') continue;
      const b = groups.get(key)[name]; b.records = (b.records || 0) + 1;
      if (r.phase !== 'finished') { b.pending = (b.pending || 0) + 1; continue; }
      b.finished = (b.finished || 0) + 1;
      const expected = r.type === 'state_exit_recovery' ? 'account_state_proxy' : 'discontinuous_proxy';
      if (r.status !== expected || !Number.isFinite(r.netPnlSol)) {
        b.unknown = (b.unknown || 0) + 1; b.unknownReasons ||= {};
        b.unknownReasons[r.reason || 'unknown'] = (b.unknownReasons[r.reason || 'unknown'] || 0) + 1; continue;
      }
      b.quoted = (b.quoted || 0) + 1; b.estimatedNetSol = (b.estimatedNetSol || 0) + r.netPnlSol;
      if (r.entryCostSol > 0 && r.netPnlSol / r.entryCostSol <= -.5) b.loss50 = (b.loss50 || 0) + 1;
      const o = outcomes.get(r.id + ':strategy_proxy');
      if (o?.policyId === r.policyId && o.status === 'observed_proxy' && Number.isFinite(o.netPnlSol)) {
        b.pairedWithContinuousBaseline = (b.pairedWithContinuousBaseline || 0) + 1;
        b.baselinePairedSol = (b.baselinePairedSol || 0) + o.netPnlSol;
        b.recoveryPairedSol = (b.recoveryPairedSol || 0) + r.netPnlSol;
      }
      const sourceBaseline = records.get(`${r.id}:${r.type}:baseline`);
      if (r.variant !== 'baseline' && sourceBaseline?.phase === 'finished' && sourceBaseline.policyId === r.policyId
        && sourceBaseline.status === expected && Number.isFinite(sourceBaseline.netPnlSol)) {
        b.pairedWithSourceBaseline = (b.pairedWithSourceBaseline || 0) + 1;
        b.sourceBaselinePairedSol = (b.sourceBaselinePairedSol || 0) + sourceBaseline.netPnlSol;
        b.sourceVariantPairedSol = (b.sourceVariantPairedSol || 0) + r.netPnlSol;
        b.sourceDifferenceSol = (b.sourceDifferenceSol || 0) + r.netPnlSol - sourceBaseline.netPnlSol;
      }
    }
  }
  return { scope: 'Latest recovery activity in export window, grouped by variant and source; not continuous coverage, training labels, or portfolio PnL. Never add sources together.', groups: [...groups.values()] };
}
module.exports = { recoveryAudit };
