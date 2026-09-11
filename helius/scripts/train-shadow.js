'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadDataset, train } = require('../src/shadow/training');
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--data', '--out', '--target', '--policy'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --data DIRECTORY --out MODEL.json --target rebound_60s [--policy HASH]');
    options[args[i]] = args[i + 1];
  }
  const target = options['--target'] || 'rebound_60s';
  if (!['rebound_30s', 'rebound_60s', 'strategy_proxy', 'loss_25', 'net_return', 'drawdown_60s_25'].includes(target)) throw new Error('Unknown target');
  const directory = path.resolve(options['--data'] || path.join(__dirname, '../data/shadow'));
  const out = path.resolve(options['--out'] || path.join(__dirname, '../data/models/shadow.json'));
  const dataset = await loadDataset(directory, target, options['--policy']);
  const result = train(dataset.rows, target, dataset.policyId);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.report.json`, JSON.stringify({ target, policyId: dataset.policyId, dataset: dataset.stats, ...result.report }, null, 2), { mode: 0o600 });
  if (result.model) fs.writeFileSync(out, JSON.stringify(result.model, null, 2), { mode: 0o600 });
  else if (fs.existsSync(out)) fs.unlinkSync(out); // Never leave an older successful model at a failed run's output path.
  console.log(JSON.stringify({ ...result.report, dataset: dataset.stats, modelWritten: !!result.model, report: `${out}.report.json` }, null, 2));
  if (!result.model) process.exitCode = 2;
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
