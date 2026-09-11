'use strict';
const path = require('node:path');
const { readConfig } = require('../src/config');
const { buildArchive, atomicJSON } = require('../src/reporting/archive');
const { inspect } = require('./inspect-export');

async function run({ env = process.env, hours = 1, now = Date.now() } = {}) {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Hours must be greater than 0 and at most 24');
  const c = readConfig({ ...env, HELIUS_API_KEY: env.HELIUS_API_KEY || 'offline-report' });
  const secrets = Object.entries(env).filter(([k]) => /SECRET|PRIVATE|API_KEY|SECURITY_TOKEN|PASSWORD/.test(k)).map(([, v]) => v).filter(v => typeof v === 'string');
  const bundle = await buildArchive({ c, outputDir: path.resolve(__dirname, '..', env.COS_EXPORT_DIRECTORY || 'data/exports'),
    start: now - Math.round(hours * 3600000), end: now, now, manual: true, secrets });
  const quality = await inspect(bundle.folder);
  await atomicJSON(path.join(bundle.folder, 'quality.json'), quality);
  await atomicJSON(path.join(bundle.folder, 'execution-audit.json'), await require('../src/reporting/execution-audit').executionAudit(bundle.folder));
  return { status: 'local_export_only', folder: bundle.folder, window: bundle.summary.window, quality };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--hours')) { console.error('Usage: node scripts/export-recent.js [--hours 1]'); process.exitCode = 1; }
  else run({ hours: args.length ? Number(args[1]) : 1 }).then(r => console.log(JSON.stringify(r, null, 2))).catch(() => {
    console.error('Recent export failed. Check hours, local files and available disk space.'); process.exitCode = 1;
  });
}
module.exports = { run };
