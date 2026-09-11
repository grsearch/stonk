'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { digest } = require('../src/reporting/archive');
const { FEATURE_NAMES } = require('../src/shadow/features');
const { chronologicalSplit } = require('../src/shadow/training');
const MAX_INSPECTION_BYTES = 4 * 1024 * 1024 * 1024;
function checkInspectionBytes(bytes) {
  if (bytes > MAX_INSPECTION_BYTES) {
    const error = new Error('Inspection limit: 4 GiB uncompressed');
    error.code = 'INSPECTION_SIZE_LIMIT'; throw error;
  }
}
async function inspect(directory) {
  const file = path.join(directory, 'analysis.jsonl.gz'), summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
  if (await digest(file) !== summary.sha256 || fs.statSync(file).size !== summary.bytes) throw new Error('Archive checksum/size mismatch');
  const counts = {}, samples = new Map(), outcomes = new Map(); let lines = 0, bytes = 0, first = null, footer = null;
  const audit = { windowCounts: {}, coverageGapReasons: {}, featureReasons: {}, policies: {}, paper: { closed: 0, wins: 0, losses: 0, flat: 0, missingPnl: 0, grossPnlSol: 0 }, shadowHealth: { observations: 0, maxQueueDepth: 0, maxDroppedPerSession: 0, maxHistoryEvictionsPerSession: 0 } };
  const recoveryResults = new Map();
  const researchRecovery = new Map();
  const entryComparisons = new Map();
  audit.stateQuotes = { quoted: 0, unavailable: 0, reasons: {}, discardReasons: {}, extensionRejections: {}, rpcDiagnosticCategories: {}, rpcCodes: {}, urgentPools: 0, deadlineOverrides: 0, slotCatchupScheduledPools: 0 };
  audit.modelPredictions = { rebound: {}, drawdown: {} };
  const closes = new Set(), delays = [];
  const comparisons = new Map(), paperResults = new Map(), exitComparisons = new Map();
  audit.migrationPipeline = { parser: null, worker: null, cacheStatus: null, parserAt: null, workerAt: null };
  const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
  const input = fs.createReadStream(file), unzip = zlib.createGunzip();
  input.on('error', e => unzip.destroy(e)); input.pipe(unzip);
  unzip.on('data', chunk => { bytes += chunk.length; try { checkInspectionBytes(bytes); } catch (e) { unzip.destroy(e); } });
  try {
    for await (const line of readline.createInterface({ input: unzip, crlfDelay: Infinity })) {
      const row = JSON.parse(line), r = row.record; if (!r || !row.dataset) throw new Error('Invalid archive row');
      lines++; counts[`${row.dataset}:${r.type || ''}`] = (counts[`${row.dataset}:${r.type || ''}`] || 0) + 1;
      if (row.dataset === 'manifest') first = r;
      if (row.dataset === 'summary') footer = r;
      const at = r.at ?? Date.parse(r.time), inside = at >= Date.parse(summary.window.start) && at < Date.parse(summary.window.endExclusive);
      if (inside) {
        const pipeline = audit.migrationPipeline;
        if (row.dataset === 'trading' && r.type === 'health' && r.migrationDiagnostics && at >= (pipeline.parserAt || 0)) {
          pipeline.parser = r.migrationDiagnostics; pipeline.parserAt = at;
        }
        if (row.dataset === 'trading' && r.type === 'shadow_health' && r.migrationAge && at >= (pipeline.workerAt || 0)) {
          pipeline.worker = r.migrationAge; pipeline.cacheStatus = r.ageCacheStatus || null; pipeline.workerAt = at;
        }
        inc(audit.windowCounts, `${row.dataset}:${r.type || ''}`);
        if (row.dataset === 'trading' && r.type === 'paper_sell') {
          if (r.positionId && r.pool && Number.isFinite(r.grossPnlSol)) paperResults.set(`${r.positionId}:${r.pool}`, r.grossPnlSol);
          const key = r.positionId || `${r.mint}:${r.openedAt}`;
          if (!closes.has(key)) {
            closes.add(key); audit.paper.closed++;
            if (Number.isFinite(r.grossPnlSol)) { audit.paper.grossPnlSol += r.grossPnlSol; audit.paper[r.grossPnlSol > 0 ? 'wins' : r.grossPnlSol < 0 ? 'losses' : 'flat']++; }
            else audit.paper.missingPnl++;
          }
        }
        if (row.dataset === 'trading' && r.type === 'shadow_health') {
          const h = audit.shadowHealth; h.observations++;
          h.maxQueueDepth = Math.max(h.maxQueueDepth, r.queueDepth || 0);
          h.maxDroppedPerSession = Math.max(h.maxDroppedPerSession, r.dropped || 0);
          h.maxHistoryEvictionsPerSession = Math.max(h.maxHistoryEvictionsPerSession, r.historyEvictions || 0);
        }
        if (row.dataset === 'shadow' && r.type === 'coverage_gap') inc(audit.coverageGapReasons, r.reason || 'unknown');
        if (row.dataset === 'shadow' && r.type === 'proxy_entry' && Number.isFinite(r.actualEntryDelayMs) && delays.length < 100000) delays.push(r.actualEntryDelayMs);
        if (row.dataset === 'shadow' && r.type === 'sample') {
          inc(audit.modelPredictions.rebound, r.prediction?.status || 'absent');
          inc(audit.modelPredictions.drawdown, r.objectivePredictions?.drawdown60?.status || 'absent');
          inc(audit.featureReasons, r.features?.ready ? 'ready' : r.features?.reason || 'missing_features');
          if (r.policyId) audit.policies[r.policyId] = r.policy;
        }
      }
      if (row.dataset !== 'shadow') continue;
      if (inside && r.type === 'entry_comparison') {
        const key = `${r.id}:${r.variant}`, previous = entryComparisons.get(key);
        if (!previous || r.at >= previous.at) entryComparisons.set(key, r);
        if (entryComparisons.size > 300000) throw new Error('Entry comparison inspection limit exceeded');
      }
      if (inside && r.type === 'state_quote') {
        for (const d of r.accountDiagnostics || []) if (d.status === 'rejected') {
          if (d.blockedExtensions?.length) for (const e of d.blockedExtensions) inc(audit.stateQuotes.extensionRejections, `${d.role}:${e.type}:${e.name}`);
          else inc(audit.stateQuotes.extensionRejections, `${d.role}:${d.reason}`);
        }
        if (r.rpcDiagnostic?.category) inc(audit.stateQuotes.rpcDiagnosticCategories, r.rpcDiagnostic.category);
        if (Number.isSafeInteger(r.rpcDiagnostic?.code)) inc(audit.stateQuotes.rpcCodes, String(r.rpcDiagnostic.code));
        if (r.scheduling?.urgent) audit.stateQuotes.urgentPools++;
        if (r.scheduling?.deadlineOverride) audit.stateQuotes.deadlineOverrides++;
        if (r.scheduling?.retryKind === 'slot_catchup') audit.stateQuotes.slotCatchupScheduledPools++;
        if (r.discardReason) inc(audit.stateQuotes.discardReasons, r.discardReason);
        if (r.status === 'quoted') audit.stateQuotes.quoted++;
        else { audit.stateQuotes.unavailable++; inc(audit.stateQuotes.reasons, r.reason || 'unknown'); }
      }
      if (inside && ['exit_recovery', 'state_exit_recovery'].includes(r.type)) researchRecovery.set(`${r.id}:${r.type}:${r.variant}`, r);
      if (researchRecovery.size > 900000) throw new Error('Research recovery inspection limit exceeded');
      if (r.type === 'no_stop_recovery' && inside && r.phase === 'finished') recoveryResults.set(r.id, r);
      if (recoveryResults.size > 100000) throw new Error('Recovery inspection limit exceeded');
      if (r.type === 'sample') samples.set(r.id, r);
      if (r.type === 'outcome') outcomes.set(`${r.id}:${r.target}`, r);
      if (r.type === 'execution_comparison' && inside) comparisons.set(r.id, r);
      if (r.type === 'exit_comparison' && inside) exitComparisons.set(`${r.id}:${r.variant}:${r.comparisonVersion}`, r);
      if (exitComparisons.size > 300000) throw new Error('Exit comparison inspection limit exceeded');
      if (samples.size > 100000 || outcomes.size > 300000 || comparisons.size > 100000) throw new Error('Inspection sample limit exceeded');
    }
  } finally { input.destroy(); unzip.destroy(); }
  if (!first || !footer || JSON.stringify(first.window) !== JSON.stringify(summary.window) || JSON.stringify(footer) !== JSON.stringify(summary.stats)) throw new Error('Manifest/summary mismatch');
  const targets = {};
  for (const target of ['rebound_30s', 'rebound_60s', 'strategy_proxy']) {
    const rows = []; let censored = 0;
    const cohort = { samples: 0, observed: 0, positive: 0, negative: 0, censored: 0, missingAtExport: 0, censorReasons: {} };
    for (const s of samples.values()) {
      if (!(s.at >= Date.parse(summary.window.start) && s.at < Date.parse(summary.window.endExclusive))) continue;
      cohort.samples++;
      const o = outcomes.get(`${s.id}:${target}`);
      if (!o) cohort.missingAtExport++;
      else if (o.status === 'censored') { cohort.censored++; inc(cohort.censorReasons, o.reason || 'unknown'); }
      else if (o.status === 'observed_proxy' && [0, 1].includes(o.label)) { cohort.observed++; cohort[o.label ? 'positive' : 'negative']++; }
    }
    for (const o of outcomes.values()) {
      if (o.target !== target) continue;
      if (o.status === 'censored') censored++;
      const s = samples.get(o.id), horizon = target === 'rebound_30s' ? 30000 : target === 'rebound_60s' ? 60000 : 0;
      if (!(s?.at >= Date.parse(summary.window.start) && s.at < Date.parse(summary.window.endExclusive))
        || !s?.features?.ready || !s.decisionFresh || !(s.features.lastHistorySequence < s.sequence)
        || !FEATURE_NAMES.every(k => Number.isFinite(s.features.values?.[k])) || !Number.isFinite(s.at)
        || o.status !== 'observed_proxy' || ![0, 1].includes(o.label) || !Number.isFinite(o.at) || o.at < s.at + horizon || s.policyId !== o.policyId) continue;
      rows.push({ key: s.key, at: s.at, endAt: o.at, y: o.label, policyId: s.policyId });
    }
    const policies = {};
    for (const policy of new Set(rows.map(r => r.policyId))) {
      const group = rows.filter(r => r.policyId === policy), unique = new Map(), conflicts = new Set();
      for (const row of group) { if (unique.has(row.key) && unique.get(row.key).y !== row.y) conflicts.add(row.key); else if (!unique.has(row.key)) unique.set(row.key, row); }
      const valid = [...unique.values()].filter(r => !conflicts.has(r.key)), split = chronologicalSplit(valid);
      const groups = [split.train, split.calibration, split.test];
      policies[policy] = { eligible: valid.length, positive: valid.filter(r => r.y === 1).length, negative: valid.filter(r => r.y === 0).length,
        splitCounts: groups.map(g => g.length), purged: split.purged,
        meetsTrainingMinimum: groups.every((g, i) => g.length >= (i === 0 ? 300 : 100) && g.filter(r => r.y === 1).length >= 20 && g.filter(r => r.y === 0).length >= 20) };
    }
    targets[target] = { censored, policies, windowCandidateCohort: cohort };
  }
  delays.sort((a, b) => a - b);
  audit.proxyEntryDelayMs = { count: delays.length, p50: delays.length ? delays[Math.floor((delays.length - 1) * 0.5)] : null, p95: delays.length ? delays[Math.floor((delays.length - 1) * 0.95)] : null };
  audit.warnings = [];
  audit.executionComparisons = {};
  audit.exitComparisons = {};
  for (const r of exitComparisons.values()) {
    const key = `${r.policyId}:${r.comparisonVersion}:${r.variant}`;
    const b = audit.exitComparisons[key] ||= { completedRecords: 0, observed: 0, unknown: 0, netPnlSol: 0,
      paired: 0, baselinePairedSol: 0, variantPairedSol: 0, differenceSol: 0 };
    b.completedRecords++;
    if (r.status !== 'observed_proxy' || !Number.isFinite(r.netPnlSol)) { b.unknown++; continue; }
    b.observed++; b.netPnlSol += r.netPnlSol;
    const baseline = outcomes.get(`${r.id}:strategy_proxy`);
    if (baseline?.policyId === r.policyId && baseline.status === 'observed_proxy' && Number.isFinite(baseline.netPnlSol)) {
      b.paired++; b.baselinePairedSol += baseline.netPnlSol; b.variantPairedSol += r.netPnlSol;
      b.differenceSol += r.netPnlSol - baseline.netPnlSol;
    }
  }
  audit.exitComparisonNote = 'Completed variant records in export window; unfinished arms are not included. Compare paired totals only. Candidate-level proxy, not portfolio or live PnL.';
  audit.paperProxyPairs = { matchedObserved: 0, paperGrossPnlSol: 0, proxyNetPnlSol: 0 };
  for (const r of comparisons.values()) {
    for (const name of ['baseline', 'belowMaxSell', 'avoidPriorSellPressure', 'lossCooldown', 'combined']) {
      const key = `${r.policyId}:${r.experiments?.experimentId}:${name}`;
      const b = audit.executionComparisons[key] ||= { candidates: 0, pass: 0, reject: 0, unknownRule: 0, observedPassed: 0, censoredPassed: 0, positivePassed: 0, netPnlSol: 0 };
      b.candidates++;
      const eligible = r.experiments?.[name];
      if (eligible === false) { b.reject++; continue; }
      if (eligible !== true) { b.unknownRule++; continue; }
      b.pass++;
      if (r.status !== 'observed_proxy' || !Number.isFinite(r.netPnlSol)) { b.censoredPassed++; continue; }
      b.observedPassed++; b.positivePassed += r.label === 1 ? 1 : 0; b.netPnlSol += r.netPnlSol;
    }
    if (paperResults.has(r.key) && r.status === 'observed_proxy' && Number.isFinite(r.netPnlSol)) {
      audit.paperProxyPairs.matchedObserved++;
      audit.paperProxyPairs.paperGrossPnlSol += paperResults.get(r.key); audit.paperProxyPairs.proxyNetPnlSol += r.netPnlSol;
    }
  }
  audit.migrationAge = {};
  for (const s of samples.values()) {
    if (!(s.at >= Date.parse(summary.window.start) && s.at < Date.parse(summary.window.endExclusive))) continue;
    const age = s.age?.migrationAgeMs, minutes = age / 60000;
    const bucket = !Number.isFinite(age) ? 'unknown' : minutes < 5 ? '0-5m' : minutes < 15 ? '5-15m' : minutes < 30 ? '15-30m' : minutes < 60 ? '30-60m' : minutes < 240 ? '1-4h' : '4h+';
    const b = audit.migrationAge[`${s.policyId}:${bucket}`] ||= { candidates: 0, observed60s: 0, positive60s: 0, severeProxyDrawdown60s: 0 };
    b.candidates++; const o = outcomes.get(`${s.id}:rebound_60s`);
    if (o?.status === 'observed_proxy') { b.observed60s++; b.positive60s += o.label === 1 ? 1 : 0; b.severeProxyDrawdown60s += o.minNetPct <= -50 ? 1 : 0; }
  }
  audit.comparisonNote = 'Versioned candidate-level proxy comparisons, not independent portfolio returns; paper pairs can have different entry/exit times. AGE is time since observed Pump migration (processed, not finalized), not token creation or ordinary pool creation; >=50% proxy drawdown is not a confirmed rug.';
  if (Object.keys(audit.migrationAge).length && Object.keys(audit.migrationAge).every(k => k.endsWith(':unknown'))) {
    audit.warnings.push('All migration ages are unknown: inspect migrationPipeline; collection is not yet verified.');
  }
  if (Object.keys(audit.coverageGapReasons).length) audit.warnings.push('Coverage gaps exist; censored labels are unknown, not negative.');
  if (Object.keys(audit.featureReasons).some(k => k !== 'ready')) audit.warnings.push('Some candidates lack prior history and cannot train.');
  if (Object.keys(audit.policies).length > 1) audit.warnings.push('Multiple policies: train and evaluate separately.');
  if (audit.paper.closed) audit.warnings.push('Paper PnL is gross spot simulation, excluding execution impact, fees and delay; proxy delay is not live buy latency.');
  if (!Object.values(targets).some(t => Object.values(t.policies).some(p => p.meetsTrainingMinimum))) audit.warnings.push('No target/policy meets the training minimum.');
  audit.noStopRecovery = { scope: 'discontinuous_research_only_finish_window_not_training_or_complete_exit_profit', groups: [] };
  const recoveryGroups = new Map();
  for (const r of recoveryResults.values()) {
    const meta = { runId: r.runId, policyId: r.policyId, selectionId: r.selection?.selectionId ?? null, modelIds: r.selection?.modelIds ?? null };
    const key = JSON.stringify(meta);
    let g = recoveryGroups.get(key); if (!g) { g = { ...meta, all: {}, joint: {}, highRebound: {} }; recoveryGroups.set(key, g); }
    for (const name of ['all', 'joint', 'highRebound']) {
      if (name !== 'all' && r.selection?.arms[name]?.status !== 'pass') continue;
      const b = g[name]; b.finished = (b.finished || 0) + 1;
      if (r.status === 'discontinuous_proxy' && Number.isFinite(r.netPnlSol)) {
        b.quoted = (b.quoted || 0) + 1; b.quotedNetSol = (b.quotedNetSol || 0) + r.netPnlSol;
        const o = outcomes.get(r.id + ':strategy_proxy');
        if (o?.policyId === r.policyId && o.status === 'observed_proxy' && Number.isFinite(o.netPnlSol)) {
          b.paired = (b.paired || 0) + 1; b.baselinePairedSol = (b.baselinePairedSol || 0) + o.netPnlSol;
          b.recoveryPairedSol = (b.recoveryPairedSol || 0) + r.netPnlSol;
        }
      } else b.unknown = (b.unknown || 0) + 1;
    }
  }
  audit.noStopRecovery.groups = [...recoveryGroups.values()];
  audit.researchRecovery = require('../src/reporting/recovery-audit').recoveryAudit(researchRecovery, outcomes);
  audit.entryComparisons = require('../src/reporting/entry-audit').entryAudit(entryComparisons);
  if (audit.modelPredictions.rebound.no_model || audit.modelPredictions.drawdown.no_model) audit.warnings.push('Observation models are not loaded for some candidates; install both model files and verify after restart.');
  audit.selectionValidation = require('../src/reporting/selection-validation').selectionValidation(samples, outcomes, summary.window, exitComparisons);
  return { integrity: 'verified', lines, window: summary.window, snapshotAt: summary.snapshotAt, windowRecords: summary.stats.windowRecords,
    configSizeSol: summary.config?.sizeSol, sampleRecords: samples.size, counts, targets, audit, dataQuality: summary.dataQuality,
    note: 'Training minimum is not validation of predictive performance. Snapshots alone are not training samples.' };
}
if (require.main === module) inspect(path.resolve(process.argv[2] || '.')).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { inspect, MAX_INSPECTION_BYTES, checkInspectionBytes };
