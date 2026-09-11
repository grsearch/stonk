'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { FEATURE_NAMES } = require('./features');
const { sigmoid, rawLogit, inTrainingRange, score } = require('./model');

async function loadDataset(directory, target, wantedPolicy) {
  const files = fs.readdirSync(directory).filter(n => /^samples-.*\.jsonl$/.test(n)).sort();
  const eligible = [], stats = { files: files.length, invalidFiles: 0, samples: 0, immatureOrCensored: 0, insufficientHistory: 0, duplicates: 0, conflicts: 0 };
  for (const name of files) {
    const rows = new Map(); let invalid = false;
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(directory, name)), crlfDelay: Infinity });
    for await (const line of lines) {
      let r;
      try { r = JSON.parse(line); } catch (_) { invalid = true; continue; }
      if (r.type === 'sample' && r.schema === 1) {
        stats.samples++;
        if (!r.features?.ready || !r.decisionFresh) { stats.insufficientHistory++; continue; }
        if (!(r.features.lastHistorySequence < r.sequence) || !Number.isFinite(r.at)
          || !FEATURE_NAMES.every(k => Number.isFinite(r.features.values[k]))) { invalid = true; continue; }
        rows.set(r.id, { id: r.id, key: r.key, at: r.at, mint: r.source?.mint, pool: r.source?.pool, policyId: r.policyId, values: r.features.values });
      }
      if (r.type === 'outcome' && r.target === (['loss_25', 'net_return'].includes(target) ? 'strategy_proxy' : target === 'drawdown_60s_25' ? 'rebound_60s' : target) && rows.has(r.id)) {
        const row = rows.get(r.id);
        if (r.status === 'observed_proxy' && [0, 1].includes(r.label) && Number.isFinite(r.at) && r.at >= row.at && r.policyId === row.policyId) {
          const minEnd = target === 'rebound_30s' ? row.at + 30000 : ['rebound_60s', 'drawdown_60s_25'].includes(target) ? row.at + 60000 : row.at;
          if (r.at < minEnd || row.y !== undefined) { invalid = true; continue; }
          if (['loss_25', 'net_return'].includes(target) && (!Number.isFinite(r.netPnlSol) || !Number.isFinite(r.entryCostSol) || r.entryCostSol <= 0)) continue;
          if (target === 'drawdown_60s_25' && !Number.isFinite(r.minNetPct)) continue;
          const netReturn = Number.isFinite(r.netPnlSol) && r.entryCostSol > 0 ? r.netPnlSol / r.entryCostSol : null;
          Object.assign(row, { y: target === 'drawdown_60s_25' ? Number(r.minNetPct <= -25) : target === 'loss_25' ? Number(netReturn <= -0.25) : target === 'net_return' ? netReturn : r.label,
            endAt: r.at, netPnlSol: r.netPnlSol, netReturn });
        }
      }
      if (rows.size + eligible.length > 100000) throw new Error('Dataset exceeds 100000 rows; select a smaller date range');
    }
    if (invalid) { stats.invalidFiles++; continue; } // Including a crash-truncated final line: conservative whole-file exclusion.
    for (const row of rows.values()) {
      if (row.y === undefined) stats.immatureOrCensored++;
      else eligible.push(row);
    }
  }
  eligible.sort((a, b) => a.at - b.at);
  const selectedPolicy = wantedPolicy || eligible.at(-1)?.policyId || null;
  const unique = new Map(), conflicts = new Set();
  for (const row of eligible.filter(x => x.policyId === selectedPolicy)) {
    if (unique.has(row.key)) {
      stats.duplicates++;
      if (unique.get(row.key).y !== row.y) { conflicts.add(row.key); stats.conflicts++; }
    } else unique.set(row.key, row);
  }
  const rows = [...unique.values()].filter(r => !conflicts.has(r.key));
  return { rows, policyId: selectedPolicy, stats: { ...stats, eligible: rows.length } };
}
function chronologicalSplit(rows) {
  if (rows.length < 5) return { train: [], calibration: [], test: [], purged: rows.length };
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const calStart = sorted[Math.floor(sorted.length * 0.6)].at, testStart = sorted[Math.floor(sorted.length * 0.8)].at;
  const train = sorted.filter(r => r.at < calStart && r.endAt < calStart);
  const calibration = sorted.filter(r => r.at >= calStart && r.at < testStart && r.endAt < testStart);
  const test = sorted.filter(r => r.at >= testStart);
  return { train, calibration, test, calStart, testStart, purged: rows.length - train.length - calibration.length - test.length };
}
function fitLogistic(xs, ys, iterations = 500) {
  const dimensions = xs[0].length, w = Array(dimensions).fill(0);
  const prior = Math.max(0.001, Math.min(0.999, ys.reduce((a, b) => a + b, 0) / ys.length));
  let intercept = Math.log(prior / (1 - prior));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const grad = Array(dimensions).fill(0); let offset = 0;
    for (let i = 0; i < xs.length; i++) {
      const error = sigmoid(intercept + xs[i].reduce((sum, x, k) => sum + x * w[k], 0)) - ys[i];
      offset += error;
      for (let k = 0; k < dimensions; k++) grad[k] += error * xs[i][k];
    }
    intercept -= 0.05 * offset / xs.length;
    for (let k = 0; k < dimensions; k++) w[k] -= 0.05 * (grad[k] / xs.length + 0.001 * w[k]);
  }
  return { weights: w, intercept };
}
function metrics(probabilities, ys) {
  if (!ys.length) return null;
  let brier = 0, logLoss = 0, correct = 0;
  const bins = Array.from({ length: 5 }, () => ({ count: 0, probabilitySum: 0, positives: 0 }));
  for (let i = 0; i < ys.length; i++) {
    const p = Math.max(1e-9, Math.min(1 - 1e-9, probabilities[i])), y = ys[i];
    brier += (p - y) ** 2; logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p); correct += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    const b = bins[Math.min(4, Math.floor(p * 5))]; b.count++; b.probabilitySum += p; b.positives += y;
  }
  let ece = 0;
  const reliability = bins.map((b, i) => {
    if (!b.count) return { lower: i / 5, upper: (i + 1) / 5, count: 0 };
    const observed = b.positives / b.count, predicted = b.probabilitySum / b.count;
    ece += b.count / ys.length * Math.abs(observed - predicted);
    const z = 1.96, denominator = 1 + z * z / b.count;
    const centre = (observed + z * z / (2 * b.count)) / denominator;
    const width = z * Math.sqrt(observed * (1 - observed) / b.count + z * z / (4 * b.count * b.count)) / denominator;
    return { lower: i / 5, upper: (i + 1) / 5, count: b.count, predicted, observed, empirical95Interval: [centre - width, centre + width] };
  });
  return { count: ys.length, brier: brier / ys.length, logLoss: logLoss / ys.length, accuracy: correct / ys.length, ece, reliability };
}
function train(rows, target, policyId) {
  if (target === 'net_return') return trainReturn(rows, policyId);
  const split = chronologicalSplit(rows), groups = [split.train, split.calibration, split.test];
  const enough = groups.every((g, i) => g.length >= (i === 0 ? 300 : 100) && g.filter(r => r.y === 1).length >= 20 && g.filter(r => r.y === 0).length >= 20);
  const counts = { train: split.train.length, calibration: split.calibration.length, test: split.test.length, purged: split.purged };
  if (!enough) return { model: null, report: { status: 'insufficient_data', counts, requirement: 'train>=300, calibration>=100, test>=100; each split >=20 per class, after overlap purge' } };
  const means = FEATURE_NAMES.map(k => split.train.reduce((a, r) => a + r.values[k], 0) / split.train.length);
  const scales = FEATURE_NAMES.map((k, i) => Math.sqrt(split.train.reduce((a, r) => a + (r.values[k] - means[i]) ** 2, 0) / split.train.length) || 1);
  const x = split.train.map(r => FEATURE_NAMES.map((k, i) => (r.values[k] - means[i]) / scales[i]));
  const fitted = fitLogistic(x, split.train.map(r => r.y));
  const model = { schema: 1, target, policyId, features: FEATURE_NAMES, means, scales, ...fitted };
  const coverage = { calibrationTotal: split.calibration.length, testTotal: split.test.length };
  split.calibration = split.calibration.filter(r => inTrainingRange(model, r.values));
  split.test = split.test.filter(r => inTrainingRange(model, r.values));
  Object.assign(coverage, { calibrationScored: split.calibration.length, testScored: split.test.length,
    calibrationRejected: coverage.calibrationTotal - split.calibration.length, testRejected: coverage.testTotal - split.test.length });
  if ([split.calibration, split.test].some(g => g.length < 100 || g.filter(r => r.y === 1).length < 20 || g.filter(r => r.y === 0).length < 20))
    return { model: null, report: { status: 'insufficient_scored_data', counts, coverage } };
  const logits = split.calibration.map(r => rawLogit(model, r.values));
  const mean = logits.reduce((a, b) => a + b, 0) / logits.length;
  const scale = Math.sqrt(logits.reduce((a, b) => a + (b - mean) ** 2, 0) / logits.length) || 1;
  const cal = fitLogistic(logits.map(v => [(v - mean) / scale]), split.calibration.map(r => r.y));
  model.calibration = { a: Math.max(0, cal.weights[0] / scale), b: cal.intercept - Math.max(0, cal.weights[0] / scale) * mean };
  const p = split.test.map(r => score(model, r.values));
  const tested = metrics(p, split.test.map(r => r.y));
  const baselineRate = split.calibration.reduce((sum, r) => sum + r.y, 0) / split.calibration.length;
  const baseline = metrics(split.test.map(() => baselineRate), split.test.map(r => r.y));
  const passed = tested.brier < baseline.brier && tested.ece <= 0.1;
  model.validation = { passed, testCount: split.test.length, calibrationCount: split.calibration.length, test: tested, baseline,
    trainEnd: Math.max(...split.train.map(r => r.endAt)), calibrationStart: split.calStart,
    calibrationEnd: Math.max(...split.calibration.map(r => r.endAt)), testStart: split.testStart };
  model.createdAt = new Date().toISOString(); model.labelMeaning = 'Observed-swap counterfactual proxy, not live trade success';
  model.evaluationAfter = Math.max(...rows.map(r => r.endAt));
  const trainingMints = new Set([...split.train, ...split.calibration].map(r => r.mint));
  const unseen = split.test.map((r, i) => ({ r, p: p[i] })).filter(x => !trainingMints.has(x.r.mint));
  return { model, report: { status: passed ? 'experimental_validation_passed' : 'validation_failed', counts,
    validation: model.validation, coverage, economics: economics(split.test, p, ['loss_25', 'drawdown_60s_25'].includes(target) ? p => p < 0.5 : p => p >= 0.5),
    unseenMintTest: metrics(unseen.map(x => x.p), unseen.map(x => x.r.y)),
    warning: 'One historical holdout is not proof of live profitability. Never select thresholds on this test set and report them as new validation.' } };
}
function economics(rows, predictions, select) {
  const chosen = rows.filter((r, i) => select(predictions[i])), known = chosen.filter(r => Number.isFinite(r.netPnlSol));
  return { selected: chosen.length, known: known.length, unknown: chosen.length - known.length,
    netPnlSol: known.length ? known.reduce((sum, r) => sum + r.netPnlSol, 0) : null,
    note: 'Fixed threshold; candidate outcomes, not portfolio returns or a profitability validation gate.' };
}
function returnMetrics(ps, ys) {
  if (!ys.length) return null;
  return { count: ys.length, mse: ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / ys.length,
    mae: ps.reduce((s, p, i) => s + Math.abs(p - ys[i]), 0) / ys.length };
}
function trainReturn(rows, policyId) {
  const split = chronologicalSplit(rows), counts = { train: split.train.length, calibration: split.calibration.length, test: split.test.length, purged: split.purged };
  if (split.train.length < 300 || split.calibration.length < 100 || split.test.length < 100)
    return { model: null, report: { status: 'insufficient_data', counts } };
  const means = FEATURE_NAMES.map(k => split.train.reduce((a, r) => a + r.values[k], 0) / split.train.length);
  const scales = FEATURE_NAMES.map((k, i) => Math.sqrt(split.train.reduce((a, r) => a + (r.values[k] - means[i]) ** 2, 0) / split.train.length) || 1);
  const m = { schema: 1, target: 'net_return', policyId, features: FEATURE_NAMES, means, scales,
    weights: FEATURE_NAMES.map(() => 0), intercept: split.train.reduce((a, r) => a + r.y, 0) / split.train.length, calibration: { a: 1, b: 0 } };
  const xs = split.train.map(r => FEATURE_NAMES.map((k, i) => (r.values[k] - means[i]) / scales[i]));
  // A step bounded by the average squared input norm keeps squared-loss descent stable.
  const step = 0.5 / (1 + xs.reduce((a, x) => a + x.reduce((s, v) => s + v * v, 0), 0) / xs.length);
  for (let t = 0; t < 1000; t++) {
    const g = m.weights.map(() => 0); let bias = 0;
    xs.forEach((x, i) => { const err = m.intercept + x.reduce((s, v, j) => s + v * m.weights[j], 0) - split.train[i].y;
      bias += err; x.forEach((v, j) => { g[j] += err * v; }); });
    m.intercept -= step * bias / xs.length; m.weights = m.weights.map((w, j) => w - step * (g[j] / xs.length + 0.01 * w));
  }
  const cal = split.calibration.filter(r => inTrainingRange(m, r.values)), test = split.test.filter(r => inTrainingRange(m, r.values));
  const coverage = { calibrationTotal: split.calibration.length, testTotal: split.test.length, calibrationScored: cal.length, testScored: test.length,
    calibrationRejected: split.calibration.length - cal.length, testRejected: split.test.length - test.length };
  if (cal.length < 100 || test.length < 100) return { model: null, report: { status: 'insufficient_scored_data', counts, coverage } };
  m.calibration.b = cal.reduce((s, r) => s + r.y - rawLogit(m, r.values), 0) / cal.length;
  const ps = test.map(r => score(m, r.values)), prior = cal.reduce((s, r) => s + r.y, 0) / cal.length;
  const tested = returnMetrics(ps, test.map(r => r.y)), baseline = returnMetrics(test.map(() => prior), test.map(r => r.y));
  m.validation = { passed: tested.mse < baseline.mse, testCount: test.length, calibrationCount: cal.length, test: tested, baseline,
    trainEnd: Math.max(...split.train.map(r => r.endAt)), calibrationStart: split.calStart, calibrationEnd: Math.max(...cal.map(r => r.endAt)), testStart: split.testStart };
  m.createdAt = new Date().toISOString(); m.evaluationAfter = Math.max(...rows.map(r => r.endAt));
  m.labelMeaning = 'Net proxy return relative to entry cost; not SOL, probability or live return';
  return { model: m, report: { status: m.validation.passed ? 'experimental_validation_passed' : 'validation_failed', counts, coverage,
    validation: m.validation, economics: economics(test, ps, p => p > 0) } };
}
module.exports = { loadDataset, chronologicalSplit, fitLogistic, metrics, train, returnMetrics };
