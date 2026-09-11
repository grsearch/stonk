'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('../src/config');
const { Model } = require('../src/shadow/model');
const { assumptions, policyId } = require('../src/shadow/tracker');
const { atomicJSON } = require('../src/reporting/archive');
async function prepare(source, env = process.env, now = Date.now()) {
  const c = readConfig({ ...env, HELIUS_API_KEY: env.HELIUS_API_KEY || 'offline-model-check' });
  const id = policyId(assumptions({ ...c, ...c.shadow, networkFeeSol: (5000 + c.priorityLamports + c.tipLamports) / 1e9 }));
  const checked = new Model(path.resolve(source), id);
  if (!checked.model) throw new Error('Model is not validated or does not match this configuration');
  const model = { ...checked.model, evaluationAfter: Math.max(now, checked.model.evaluationAfter || 0) };
  const directory = path.resolve(__dirname, '../data/models');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `observation-${checked.id}-${now}.json`);
  await atomicJSON(file, model);
  const setting = model.target === 'drawdown_60s_25' ? 'SHADOW_DRAWDOWN_MODEL_FILE' : model.target === 'loss_25' ? 'SHADOW_RISK_MODEL_FILE' : model.target === 'net_return' ? 'SHADOW_RETURN_MODEL_FILE' : 'SHADOW_MODEL_FILE';
  return { file, evaluationAfter: model.evaluationAfter, setting: `${setting}=${file}`, mode: 'observation_only', requiresTradingServiceRestart: true };
}
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node helius/scripts/prepare-observation-model.js MODEL.json'); process.exitCode = 1; }
  else prepare(process.argv[2]).then(r => console.log(JSON.stringify(r, null, 2))).catch(() => { console.error('Model preparation failed: verify file, validation, strategy configuration and permissions.'); process.exitCode = 1; });
}
module.exports = { prepare };
