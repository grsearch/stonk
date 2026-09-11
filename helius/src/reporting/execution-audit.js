'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');

function decompose(paperPnl, comparison) {
  const e = comparison.executionBreakdown?.entry, x = comparison.executionBreakdown?.exit;
  if (!e || !x) return { status: 'legacy_missing_breakdown' };
  const v = [paperPnl, comparison.netPnlSol, e.sizeSol, e.spotAmount, e.curveAmount, e.afterFeeAmount, e.filledAmount,
    e.networkFeeSol, x.spotPrice, x.spotProceeds, x.curveOut, x.afterFeeOut, x.afterSlippageOut, x.networkFeeSol];
  if (!v.every(Number.isFinite)) return { status: 'invalid_breakdown' };
  const components = {
    timingAndExitRule: e.spotAmount * x.spotPrice - e.sizeSol - paperPnl,
    entryCurveImpact: (e.curveAmount - e.spotAmount) * x.spotPrice,
    entryFeeEffect: (e.afterFeeAmount - e.curveAmount) * x.spotPrice,
    entrySlippageAndRounding: (e.filledAmount - e.afterFeeAmount) * x.spotPrice,
    entryNetworkFee: -e.networkFeeSol,
    exitCurveImpact: x.curveOut - x.spotProceeds,
    exitFee: x.afterFeeOut - x.curveOut,
    exitSlippage: x.afterSlippageOut - x.afterFeeOut,
    exitNetworkFee: -x.networkFeeSol,
  };
  const residualSol = comparison.netPnlSol - paperPnl - Object.values(components).reduce((a, b) => a + b, 0);
  return { status: Math.abs(residualSol) <= 1e-8 ? 'reconciled' : 'mismatch', components, residualSol };
}
async function executionAudit(directory) {
  const quality = await require('../../scripts/inspect-export').inspect(directory);
  const start = Date.parse(quality.window.start), end = Date.parse(quality.window.endExclusive);
  const calibrationReceipts = new Map(), calibrationComparisons = new Map();
  const funnel = new (require('./execution-funnel').ExecutionFunnel)();
  const sells = new Map(), comparisons = new Map(), filters = new Map();
  const input = fs.createReadStream(path.join(directory, 'analysis.jsonl.gz')), unzip = zlib.createGunzip();
  input.on('error', e => unzip.destroy(e)); input.pipe(unzip);
  try {
    for await (const line of readline.createInterface({ input: unzip, crlfDelay: Infinity })) {
      const { dataset, record: r } = JSON.parse(line), at = r.at ?? Date.parse(r.time);
      if (dataset === 'state_snapshot') funnel.snapshot(r.calibration);
      if (dataset === 'trading' && at >= start && at < end) funnel.record(r);
      if (dataset === 'trading' && r.type === 'paper_sell' && at >= start && at < end && r.positionId && r.pool) sells.set(`${r.positionId}:${r.pool}`, r);
      if (dataset === 'shadow' && r.type === 'execution_comparison' && at < end) {
        if (r.calibrationRole) calibrationComparisons.set(r.calibrationRole + ':' + r.key, r);
        if (r.calibrationRole !== 'reference_1_sol') comparisons.set(r.key, r);
      }
      if (dataset === 'trading' && r.type === 'calibration_receipt' && at < end) calibrationReceipts.set(r.batchId + ':' + r.signature, r);
      if (calibrationReceipts.size > 100000 || calibrationComparisons.size > 200000) throw new Error('Calibration audit size limit');
      if (dataset === 'trading' && r.type === 'paper_prebuy_filter' && at < end && r.signature && r.pool) filters.set(`${r.signature}:${r.pool}`, r);
      if (sells.size > 100000 || comparisons.size > 100000 || filters.size > 100000) throw new Error('Execution audit size limit exceeded');
    }
  } finally { input.destroy(); unzip.destroy(); }
  const rows = [], totals = { paperCloses: sells.size, matchedObserved: 0, noComparison: 0, censored: 0,
    missingPaperPnl: 0, reconciled: 0, legacyMissingBreakdown: 0, mismatchedBreakdown: 0, paperPnlSol: 0, proxyPnlSol: 0 };
  for (const [key, p] of sells) {
    const c = comparisons.get(key), row = { key, mint: p.mint, paper: { openedAt: p.openedAt, closedAt: Date.parse(p.time), reason: p.reason, pnlSol: p.grossPnlSol }, diagnostic: p.diagnostic };
    const filter = filters.get(key);
    row.policyId = c?.policyId ?? null;
    row.prebuyStatus = ['pass', 'unknown', 'reject', 'unavailable'].includes(filter?.status) ? filter.status : 'unmatched';
    row.prebuyWaitMs = Number.isFinite(filter?.waitMs) ? filter.waitMs : null;
    if (!c) { totals.noComparison++; row.status = 'no_comparison_in_archive'; }
    else if (c.status !== 'observed_proxy' || !Number.isFinite(c.netPnlSol)) { totals.censored++; row.status = 'proxy_unknown'; row.reason = c.reason; }
    else if (!Number.isFinite(p.grossPnlSol)) { totals.missingPaperPnl++; row.status = 'missing_paper_pnl'; }
    else {
      totals.matchedObserved++; totals.paperPnlSol += p.grossPnlSol; totals.proxyPnlSol += c.netPnlSol;
      row.status = 'matched'; row.proxy = { policyId: c.policyId, entryAt: c.entryAt, exitAt: c.exitAt, triggerAt: c.triggerAt,
        pnlSol: c.netPnlSol, reason: c.reason, assumptions: c.executionPolicy };
      row.entryTimeDifferenceMs = Number.isFinite(c.entryAt) && Number.isFinite(p.openedAt) ? c.entryAt - p.openedAt : null;
      row.exitTimeDifferenceMs = Number.isFinite(c.exitAt) ? c.exitAt - Date.parse(p.time) : null;
      row.pnlDifferenceSol = c.netPnlSol - p.grossPnlSol;
      row.decomposition = decompose(p.grossPnlSol, c);
      const status = row.decomposition.status;
      totals[status === 'reconciled' ? 'reconciled' : status === 'legacy_missing_breakdown' ? 'legacyMissingBreakdown' : 'mismatchedBreakdown']++;
    }
    rows.push(row);
  }
  return { schema: 2, executionFunnel: funnel.result(), calibration: require('./calibration-audit').calibrationAudit(calibrationReceipts, calibrationComparisons, start, end), window: quality.window, totals, costSummary: costSummary(rows), migrationPipeline: quality.audit.migrationPipeline,
    note: 'Signed accounting bridge under fixed proxy assumptions, not causal attribution or actual fees. Timing term also includes exit-rule and position-size differences. Missing observations remain unknown.', rows };
}
function costSummary(rows) {
  function summarize(list) {
    const matched = list.filter(r => r.status === 'matched'), reconciled = matched.filter(r => r.decomposition?.status === 'reconciled');
    const sum = (a, f) => a.length ? a.reduce((n, r) => n + f(r), 0) : null;
    const components = {};
    for (const r of reconciled) for (const [k, v] of Object.entries(r.decomposition.components)) components[k] = (components[k] || 0) + v;
    const quantiles = values => {
      values = values.filter(Number.isFinite).sort((a, b) => a - b);
      return { count: values.length, p50: values[Math.floor(values.length * .5)] ?? null, p95: values[Math.floor(values.length * .95)] ?? null };
    };
    return { closes: list.length, matched: matched.length, unknown: list.length - matched.length,
      matchedPaperSol: sum(matched, r => r.paper.pnlSol), matchedProxySol: sum(matched, r => r.proxy.pnlSol),
      reconciled: reconciled.length, reconciledPaperSol: sum(reconciled, r => r.paper.pnlSol), reconciledProxySol: sum(reconciled, r => r.proxy.pnlSol),
      components: reconciled.length ? components : null,
      entryTimeDifferenceMs: quantiles(matched.map(r => r.entryTimeDifferenceMs)), prebuyWaitMs: quantiles(list.map(r => r.prebuyWaitMs)) };
  }
  const byPrebuyStatus = {}, byPolicy = {};
  for (const status of new Set(rows.map(r => r.prebuyStatus || 'unmatched'))) byPrebuyStatus[status] = summarize(rows.filter(r => (r.prebuyStatus || 'unmatched') === status));
  const policyKey = r => r.policyId || r.proxy?.policyId || 'unmatched';
  for (const policy of new Set(rows.map(policyKey))) byPolicy[policy] = summarize(rows.filter(r => policyKey(r) === policy));
  return { version: 1, scope: 'Paired paper closes only. Component sums cover reconciled rows only; not realized fees or causal savings. Unknown comparisons are excluded, never zero returns.',
    all: summarize(rows), byPrebuyStatus, byPolicy };
}
module.exports = { executionAudit, decompose, costSummary };
