'use strict';
const fs = require('node:fs'), path = require('node:path');
const dotenv = require('dotenv');
const { readConfig } = require('../src/stonk/config');
const { assumptions, policyId } = require('../src/shadow/tracker');
const { Model } = require('../src/shadow/model');
const { atomicJSON } = require('../src/reporting/archive');
function check(env) {
  const c = readConfig(env), id = policyId(assumptions({ ...c, ...c.shadow, networkFeeSol: (5000 + c.priorityLamports + c.tipLamports) / 1e9 }));
  const models = [new Model(c.shadow.modelFile, id), new Model(c.shadow.drawdownModelFile, id)];
  return { id, models, statuses: models.map((m, i) => ({ target: ['rebound_60s', 'drawdown_60s_25'][i],
    status: m.model && m.model.target !== ['rebound_60s', 'drawdown_60s_25'][i] ? 'wrong_target' : m.status, modelId: m.id })) };
}
async function install(reboundFile, drawdownFile, envFile = path.resolve(__dirname, '../.env'), now = Date.now()) {
  const original = fs.readFileSync(envFile, 'utf8'), env = { ...process.env, ...dotenv.parse(original) };
  const checked = check({ ...env, SHADOW_MODEL_FILE: path.resolve(reboundFile), SHADOW_DRAWDOWN_MODEL_FILE: path.resolve(drawdownFile) });
  if (checked.statuses.some(s => s.status !== 'experimental_calibrated_model')) throw new Error('Both models must be validated, match their targets and match deployed strategy settings');
  const directory = path.join(path.dirname(path.resolve(envFile)), 'data/models'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = [];
  for (const m of checked.models) { const file = path.join(directory, `frozen-${m.id}-${now}.json`);
    await atomicJSON(file, { ...m.model, evaluationAfter: Math.max(now, m.model.evaluationAfter || 0) }); files.push(file); }
  const keys = ['SHADOW_MODEL_FILE', 'SHADOW_DRAWDOWN_MODEL_FILE'];
  const lines = original.split(/\r?\n/).filter(l => !/^\s*(?:export\s+)?SHADOW_(?:MODEL_FILE|DRAWDOWN_MODEL_FILE)\s*=/.test(l));
  for (let i = 0; i < keys.length; i++) lines.push(`${keys[i]}=${JSON.stringify(files[i].replace(/\\/g, '/'))}`);
  if (fs.readFileSync(envFile, 'utf8') !== original) throw new Error('Environment changed during preparation; retry');
  const backup = `${envFile}.models-backup-${now}`;
  fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(`${envFile}.models-tmp`, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(`${envFile}.models-tmp`, envFile);
  return { installed: true, requiresRestart: true, mode: 'observation_only', backup,
    statuses: check({ ...env, ...dotenv.parse(fs.readFileSync(envFile, 'utf8')) }).statuses };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    try { const file = args[1] || path.resolve(__dirname, '../.env'); const r = check({ ...process.env, ...dotenv.parse(fs.readFileSync(file, 'utf8')) });
      console.log(JSON.stringify({ statuses: r.statuses, restartRequiredAfterInstall: true }, null, 2));
      if (r.statuses.some(s => s.status !== 'experimental_calibrated_model')) process.exitCode = 2;
    } catch (_) { console.error('Model check failed; verify environment and model files'); process.exitCode = 1; }
  } else if (args.length === 2 || args.length === 3) install(...args).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
  else { console.error('Usage: install-observation-models.js REBOUND.json DRAWDOWN.json [ENV_FILE] | --check [ENV_FILE]'); process.exitCode = 1; }
}
module.exports = { install, check };
