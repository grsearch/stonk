'use strict';
function bucket() { return { candidates: 0, pass: 0, reject: 0, unknownDecision: 0, selectedKnown: 0,
  selectedCensored: 0, selectedPending: 0, selectedInvalid: 0, wins: 0, severeLosses: 0, severeLossKnown: 0,
  selectedNetSol: 0, pairedCandidates: 0, baselinePairedSol: 0, filteredPairedSol: 0, reasons: {} }; }
function add(b, s, o, arm) {
  b.candidates++; const status = arm.status;
  b[status === 'pass' ? 'pass' : status === 'reject' ? 'reject' : 'unknownDecision']++;
  for (const r of [...(arm.rejected || []), ...(arm.unknown || [])]) b.reasons[`${r.check}:${r.reason}`] = (b.reasons[`${r.check}:${r.reason}`] || 0) + 1;
  const known = o?.policyId === s.policyId && o.at >= s.at && o.status === 'observed_proxy' && Number.isFinite(o.netPnlSol);
  if (known && (status === 'pass' || status === 'reject')) {
    b.pairedCandidates++; b.baselinePairedSol += o.netPnlSol; if (status === 'pass') b.filteredPairedSol += o.netPnlSol;
  }
  if (status !== 'pass') return;
  if (!o) { b.selectedPending++; return; }
  if (o.status === 'censored') { b.selectedCensored++; return; }
  if (!known) { b.selectedInvalid++; return; }
  b.selectedKnown++; b.selectedNetSol += o.netPnlSol; if (o.netPnlSol > 0) b.wins++;
  if (Number.isFinite(o.entryCostSol) && o.entryCostSol > 0) { b.severeLossKnown++; if (o.netPnlSol / o.entryCostSol <= -0.25) b.severeLosses++; }
}
function finish(b) {
  return { ...b, selectedNetSol: b.selectedKnown ? b.selectedNetSol : null,
    meanSelectedNetSol: b.selectedKnown ? b.selectedNetSol / b.selectedKnown : null,
    winRate: b.selectedKnown ? b.wins / b.selectedKnown : null,
    severeLossRate: b.severeLossKnown ? b.severeLosses / b.severeLossKnown : null,
    selectedMissingRate: b.pass ? (b.pass - b.selectedKnown) / b.pass : null,
    pairedDifferenceSol: b.pairedCandidates ? b.filteredPairedSol - b.baselinePairedSol : null };
}
function selectionValidation(samples, outcomes, window, exitComparisons = new Map()) {
  const exitsById = new Map();
  for (const r of exitComparisons.values()) { const list = exitsById.get(r.id) || []; list.push(r); exitsById.set(r.id, list); }
  const start = Date.parse(window.start), end = Date.parse(window.endExclusive), groups = new Map(), unique = new Map(), conflicts = new Set();
  let legacySamples = 0, duplicates = 0;
  for (const s of samples.values()) {
    if (!(s.at >= start && s.at < end)) continue;
    if (!s.selection || ![1, 2, 3, 4, 5, 6, 7].includes(s.selection.version)) { legacySamples++; continue; }
    const key = `${s.runId}:${s.key}`, o = outcomes.get(`${s.id}:strategy_proxy`);
    if (unique.has(key)) {
      duplicates++; const prev = unique.get(key);
      if (JSON.stringify(prev.s.selection) !== JSON.stringify(s.selection) || JSON.stringify(prev.o) !== JSON.stringify(o)) conflicts.add(key);
    } else unique.set(key, { s, o });
  }
  for (const [key, { s, o }] of unique) {
    if (conflicts.has(key)) continue;
    const meta = { runId: s.runId, runStartedAt: s.runStartedAt ?? null, observationVersion: s.observationVersion ?? null,
      policyId: s.policyId, selectionId: s.selection.selectionId, marketExperimentId: s.selection.marketExperimentId, modelIds: s.selection.modelIds };
    const groupKey = JSON.stringify(meta); let g = groups.get(groupKey);
    if (!g) { g = { ...meta, rules: s.selection.rules, arms: {}, reboundBySelection: {}, exitsBySelection: {}, byBeijingHour: {} }; groups.set(groupKey, g); }
    const hour = new Date(s.at + 8 * 3600000).toISOString().slice(0, 13) + ':00+08:00';
    for (const name of Object.keys(s.selection.arms)) {
      const arm = s.selection.arms[name] || { status: 'unknown' };
      add(g.arms[name] ||= bucket(), s, o, arm);
      if (arm.status === 'pass') {
        const b = g.reboundBySelection[name] ||= { selected: 0, known: 0, rebound: 0, drawdown25: 0, both: 0, unknown: 0 };
        b.selected++;
        const h = outcomes.get(s.id + ':rebound_60s');
        if (h?.policyId === s.policyId && h.at >= s.at + 60000 && h.status === 'observed_proxy' && [0, 1].includes(h.label) && Number.isFinite(h.minNetPct)) {
          b.known++; b.rebound += h.label; b.drawdown25 += Number(h.minNetPct <= -25); b.both += Number(h.label === 1 && h.minNetPct <= -25);
        } else b.unknown++;
        const variants = g.exitsBySelection[name] ||= {};
        for (const variant of require('../shadow/exit-comparisons').ARMS.map(a => a.name)) {
          const v = variants[variant] ||= { selected: 0, paired: 0, missingOrUnpaired: 0, baselineSol: 0, variantSol: 0, differenceSol: 0, deepLoss50: 0, deepLossKnown: 0 };
          v.selected++;
          const e = (exitsById.get(s.id) || []).find(e => e.variant === variant && e.comparisonVersion === 1);
          const valid = r => r?.policyId === s.policyId && r.at >= s.at && r.status === 'observed_proxy' && Number.isFinite(r.netPnlSol);
          if (valid(e) && valid(o)) { v.paired++; v.baselineSol += o.netPnlSol; v.variantSol += e.netPnlSol; v.differenceSol += e.netPnlSol - o.netPnlSol;
            if (Number.isFinite(e.entryCostSol) && e.entryCostSol > 0) { v.deepLossKnown++; v.deepLoss50 += Number(e.netPnlSol / e.entryCostSol <= -0.5); }
          } else v.missingOrUnpaired++;
        }
      }
      const h = g.byBeijingHour[hour] ||= {}; add(h[name] ||= bucket(), s, o, arm);
    }
  }
  for (const g of groups.values()) {
    for (const b of Object.values(g.reboundBySelection)) {
      b.reboundRate = b.known ? b.rebound / b.known : null; b.drawdown25Rate = b.known ? b.drawdown25 / b.known : null;
    }
    for (const variants of Object.values(g.exitsBySelection)) for (const v of Object.values(variants)) {
      if (!v.paired) v.baselineSol = v.variantSol = v.differenceSol = null;
    }
    g.arms = Object.fromEntries(Object.entries(g.arms).map(([k, b]) => [k, finish(b)]));
    for (const h of Object.values(g.byBeijingHour)) for (const name of Object.keys(h)) h[name] = finish(h[name]);
  }
  return { version: 1, candidateWindow: window, legacySamples, duplicates, conflicts: conflicts.size, groups: [...groups.values()],
    note: 'Grouped by process start/run, observation version, policy, fixed rules and model IDs. Start time is not proof of deployment Git SHA. Paired comparison uses the same observed candidates with known decisions: rejected candidate = no order/zero return. Unknown decisions and missing outcomes are excluded, not wins or losses. No portfolio capacity, capital or causal fill claim. Not an automatic live-trading approval.' };
}
module.exports = { selectionValidation };
