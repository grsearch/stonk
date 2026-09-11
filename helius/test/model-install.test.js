'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { install, check } = require('../scripts/install-observation-models');
const { readConfig } = require('../src/config'), { assumptions, policyId } = require('../src/shadow/tracker');
const { train } = require('../src/shadow/training'), { FEATURE_NAMES } = require('../src/shadow/features');
test('pair installation validates before editing, preserves trading secrets and advances observation time', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pair-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env'), original = 'HELIUS_API_KEY=test-private-value\nPOSITION_SIZE_SOL=1\nSHADOW_MODEL_FILE=old\nSHADOW_MODEL_FILE=duplicate\n';
  fs.writeFileSync(envFile, original);
  const c = readConfig({ HELIUS_API_KEY: 'test', POSITION_SIZE_SOL: '1' });
  const id = policyId(assumptions({ ...c, ...c.shadow, networkFeeSol: (5000 + c.priorityLamports + c.tipLamports) / 1e9 }));
  const rows = Array.from({ length: 1000 }, (_, i) => ({ at: i * 100000, endAt: i * 100000 + 60000, y: i % 2,
    values: Object.fromEntries(FEATURE_NAMES.map(k => [k, k === 'sellSol' ? i % 2 : 0])) }));
  const model = train(rows, 'rebound_60s', id).model, rebound = path.join(dir, 'b.json'), down = path.join(dir, 'd.json');
  fs.writeFileSync(rebound, JSON.stringify(model)); fs.writeFileSync(down, JSON.stringify(model));
  await assert.rejects(install(rebound, down, envFile, 200000000)); assert.equal(fs.readFileSync(envFile, 'utf8'), original);
  fs.writeFileSync(down, JSON.stringify({ ...model, target: 'drawdown_60s_25' }));
  const result = await install(rebound, down, envFile, 200000000), text = fs.readFileSync(envFile, 'utf8');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original); assert.equal((text.match(/^SHADOW_MODEL_FILE=/gm) || []).length, 1);
  assert.ok(text.includes('HELIUS_API_KEY=test-private-value')); assert.ok(text.includes('POSITION_SIZE_SOL=1'));
  const env = require('dotenv').parse(text), checked = check(env); assert.ok(checked.statuses.every(s => s.status === 'experimental_calibrated_model'));
  assert.ok(checked.models.every(m => m.model.evaluationAfter === 200000000));
});
