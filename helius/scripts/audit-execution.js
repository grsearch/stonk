'use strict';
const path = require('node:path');
const { executionAudit } = require('../src/reporting/execution-audit');
const { atomicJSON } = require('../src/reporting/archive');
async function main(directory) {
  const report = await executionAudit(directory), file = path.join(directory, 'execution-audit.json');
  await atomicJSON(file, report); console.log(JSON.stringify({ file, totals: report.totals, migrationPipeline: report.migrationPipeline }, null, 2));
}
if (require.main === module) main(path.resolve(process.argv[2] || '.')).catch(e => { console.error(e.message); process.exitCode = 1; });
