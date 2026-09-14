'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { collect, evaluate, run } = require('../scripts/train-calibration-archives');
function archive(root, name, records) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const data = zlib.gzipSync(records.map(record => JSON.stringify({ dataset: 'shadow', record })).join('\n'));
  fs.writeFileSync(path.join(dir, 'analysis.jsonl.gz'), data);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }));
  return dir;
}
const session = { type: 'session', policyId: 'p', calibrationRole: 'same_size', policy: { sizeSol: 0.05 } };
const sample = { type: 'sample', policyId: 'p', calibrationRole: 'same_size', id: 'a', key: 'a', at: 10 };
test('archive training requires exact size, deduplicates context, excludes reference role and conflicting records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  try {
    const a = archive(root, 'a', [session, sample, { ...sample, id: 'reference', calibrationRole: 'reference_1_sol' }]);
    const b = archive(root, 'b', [session, sample]);
    const c = archive(root, 'c', [{ ...sample, at: 11 }]);
    assert.equal((await collect([a, b], 'p', .05)).records.length, 1);
    assert.equal((await collect([a, b, c], 'p', .05)).records.length, 0);
    await assert.rejects(collect([a], 'p', 1), /size mismatch/);
    await assert.rejects(collect([a], 'absent', .05), /No matching/);
    fs.appendFileSync(path.join(a, 'analysis.jsonl.gz'), 'bad');
    await assert.rejects(collect([a], 'p', .05), /checksum/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('holdout evaluation reports out of range and unseen mints separately without refitting', () => {
  const model = { features: ['x'], means: [0], scales: [1], weights: [1], intercept: 0, calibration: { a: 1, b: 0 }, target: 'net_return' };
  const saved = JSON.stringify(model);
  const rows = [1, -1, 100].map((x, i) => ({ values: { x }, mint: String(i), y: x, netPnlSol: x, netReturn: x }));
  const report = evaluate(model, rows, [{ mint: '0' }], 'net_return');
  assert.equal(report.scored, 2); assert.equal(report.outOfRange, 1);
  assert.equal(report.all.selected.netPnlSol, 1); assert.equal(report.unseenMints.allScored.count, 1);
  assert.equal(JSON.stringify(model), saved);
});
test('insufficient archive data writes a report without producing models or changing existing outputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  try {
    const a = archive(root, 'a', [session]); const out = path.join(root, 'result');
    const r = await run({ directories: [a], policyId: 'p', sizeSol: .05, cutoff: 100, out });
    assert.ok(Object.values(r.targets).every(x => !x.modelWritten && x.training.status === 'insufficient_data'));
    assert.deepEqual(fs.readdirSync(out), ['report.json']);
    await assert.rejects(run({ directories: [a], policyId: 'p', sizeSol: .05, cutoff: 100, out }), /already exists/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
