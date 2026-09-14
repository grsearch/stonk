'use strict';
// Offline only. No model installation, network access or trading configuration changes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib'), readline = require('node:readline');
const { digest } = require('../src/reporting/archive');
const { loadDataset, train, metrics, returnMetrics } = require('../src/shadow/training');
const { score } = require('../src/shadow/model');
const { checkInspectionBytes } = require('./inspect-export');

async function collect(directories, policyId, sizeSol) {
  if (!policyId || !(sizeSol > 0)) throw new Error('Explicit policy and positive size required');
  const records = new Map(), conflicts = new Set(), policies = new Map(), sources = [];
  let duplicates = 0;
  for (const directory of directories) {
    const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
    const file = path.join(directory, 'analysis.jsonl.gz');
    if (await digest(file) !== summary.sha256 || fs.statSync(file).size !== summary.bytes) throw new Error('Archive checksum/size mismatch');
    const input = fs.createReadStream(file), unzip = zlib.createGunzip(); let bytes = 0;
    input.on('error', e => unzip.destroy(e)); input.pipe(unzip);
    unzip.on('data', b => { bytes += b.length; try { checkInspectionBytes(bytes); } catch (e) { unzip.destroy(e); } });
    try {
      for await (const line of readline.createInterface({ input: unzip, crlfDelay: Infinity })) {
        const envelope = JSON.parse(line), r = envelope.record;
        if (envelope.dataset !== 'shadow' || !r || r.policyId !== policyId || r.calibrationRole !== 'same_size') continue;
        if (r.type === 'session') {
          if (r.policy?.sizeSol !== sizeSol) throw new Error('Policy size mismatch');
          const value = JSON.stringify(r.policy);
          if (policies.has(policyId) && policies.get(policyId) !== value) throw new Error('Conflicting policy definition');
          policies.set(policyId, value);
        }
        if (!['sample', 'outcome'].includes(r.type)) continue;
        if (!r.id || !Number.isFinite(r.at)) throw new Error('Invalid training record');
        const key = `${r.id}:${r.type}:${r.target || ''}`, text = JSON.stringify(r);
        if (records.has(key)) {
          duplicates++;
          if (records.get(key).text !== text) conflicts.add(r.id);
        } else records.set(key, { text, r });
        if (records.size > 500000) throw new Error('Too many training records; use a smaller archive range');
      }
    } finally { input.destroy(); unzip.destroy(); }
    sources.push({ sha256: summary.sha256, window: summary.window });
  }
  if (!policies.has(policyId)) throw new Error('No matching same_size session with verified size');
  // Linked context is intentional: cross-boundary closes need their original samples.
  // Dedup before feeding the legacy loader; never use reference_1_sol or recovery labels.
  const selected = [...records.values()].filter(x => !conflicts.has(x.r.id)).map(x => x.r)
    .sort((a, b) => a.at - b.at || (a.type === 'sample' ? -1 : 1));
  return { records: selected, provenance: { policyId, sizeSol, role: 'same_size', sources, duplicates,
    conflictingIdsExcluded: conflicts.size, records: selected.length } };
}

function evaluate(model, rows, trainingRows, target) {
  const scored = rows.map(r => ({ r, p: score(model, r.values) })).filter(x => Number.isFinite(x.p));
  const mints = new Set(trainingRows.map(r => r.mint).filter(Boolean));
  const summary = xs => {
    const selected = xs.filter(x => target === 'net_return' ? x.p > 0 : target === 'loss_25' ? x.p < 0.5 : x.p >= 0.5);
    const econ = a => ({ count: a.length, known: a.filter(x => Number.isFinite(x.r.netPnlSol)).length,
      netPnlSol: a.length ? a.reduce((s, x) => s + (Number.isFinite(x.r.netPnlSol) ? x.r.netPnlSol : 0), 0) : null,
      losses: a.filter(x => x.r.netPnlSol < 0).length, severeLosses: a.filter(x => x.r.netReturn <= -0.25).length });
    return { metrics: target === 'net_return' ? returnMetrics(xs.map(x => x.p), xs.map(x => x.r.y)) : metrics(xs.map(x => x.p), xs.map(x => x.r.y)),
      allScored: econ(xs), selected: econ(selected), rejected: econ(xs.filter(x => !selected.includes(x))) };
  };
  return { total: rows.length, scored: scored.length, outOfRange: rows.length - scored.length,
    fixedThreshold: target === 'net_return' ? '>0 expected net return' : target === 'loss_25' ? '<0.5 loss probability' : '>=0.5 profit probability',
    all: summary(scored), unseenMints: summary(scored.filter(x => x.r.mint && !mints.has(x.r.mint))),
    currentEntryRules: summary(scored.filter(x => x.r.currentEntryRules === true)),
    entryRuleScope: 'Known prebuy history + six checks not rejected + signal reserve >100 SOL; no portfolio/cooldown/execution simulation',
    scope: 'Known continuous proxy outcomes only; candidate sums, not portfolio or live profits. Censored outcomes excluded.' };
}

async function run({ directories, policyId, sizeSol, cutoff, out }) {
  if (!Number.isFinite(cutoff)) throw new Error('An explicit chronological holdout cutoff is required');
  if (fs.existsSync(out)) throw new Error('Output directory already exists; use a new run directory');
  const data = await collect(directories, policyId, sizeSol);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-training-'));
  const report = { version: 1, provenance: data.provenance, cutoff: new Date(cutoff).toISOString(), targets: {},
    warning: 'Research only. Historical data already reviewed is not an untouched test. Never auto-install or change live filters from these reports.' };
  try {
    fs.writeFileSync(path.join(temp, 'samples-merged.jsonl'), data.records.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
    fs.mkdirSync(out, { recursive: true });
    const sampleByKey = new Map(data.records.filter(r => r.type === 'sample').map(r => [r.key, r]));
    for (const target of ['loss_25', 'net_return', 'strategy_proxy']) {
      const dataset = await loadDataset(temp, target, policyId);
      for (const row of dataset.rows) {
        const s = sampleByKey.get(row.key), arm = s?.selection?.arms?.prebuyCombined;
        row.currentEntryRules = !!s?.features?.ready && !!arm && ['pass', 'unknown'].includes(arm.status)
          && !(arm.unknown || []).some(x => x.check !== 'migrationAge') && s.features.values.liquiditySol > 100;
      }
      const before = dataset.rows.filter(r => r.at < cutoff && r.endAt < cutoff);
      const after = dataset.rows.filter(r => r.at >= cutoff);
      const fitted = train(before, target, policyId);
      report.targets[target] = { dataset: dataset.stats, fitRows: before.length, holdoutRows: after.length,
        boundaryPurged: dataset.rows.length - before.length - after.length, training: fitted.report,
        holdout: fitted.model ? evaluate(fitted.model, after, before, target) : null,
        modelWritten: !!fitted.model, runtimeValidated: !!fitted.model?.validation?.passed };
      if (fitted.model) fs.writeFileSync(path.join(out, `${target}.research.json`), JSON.stringify(fitted.model, null, 2), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2), options = {}, directories = [];
  for (let i = 0; i < args.length; i += 2) {
    if (!['--archive', '--policy', '--size-sol', '--holdout-start', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Expected --archive DIR (repeatable) --policy HASH --size-sol 0.05 --holdout-start ISO_DATE --out NEW_DIRECTORY');
    if (args[i] === '--archive') directories.push(path.resolve(args[i + 1])); else options[args[i]] = args[i + 1];
  }
  if (!directories.length || !options['--out']) throw new Error('Archive and output required');
  const result = await run({ directories, policyId: options['--policy'], sizeSol: Number(options['--size-sol']),
    cutoff: Date.parse(options['--holdout-start']), out: path.resolve(options['--out']) });
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { collect, evaluate, run };
