'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalize, decodeEvent } = require('../src/parser');
const { migrations } = require('../src/migration');
const schema = require('../src/migration-layout.json');
const DEFAULT_SIGNATURES = [
  'CquySjoqPnu1JLTbGCbuFLTJ25zBWLMQJDoeY7mnpvDxPjNKfipG6LtxC4NembWQdPDmKq3L69VxF5TTgV8LQmn',
  '5pen4asuPwEL2DMUViDLZsGc7dJ72AKKeEHKvVi1nqCUXB1uVF4tCvee7Djt3Zd31oT4Ex854mM7exheWt9gAXCu',
];
function inspect(signature, result) {
  if (!result) return { signature, status: 'transaction_not_found' };
  const tx = normalize({ signature, slot: result.slot, receivedAt: Date.now(),
    transaction: { meta: result.meta, transaction: result.transaction } });
  if (!tx) return { signature, status: 'transaction_failed_or_missing_meta' };
  const diagnostics = [], events = [];
  migrations(tx, decodeEvent, e => events.push(e), d => diagnostics.push(d));
  // Public Pump instructions only; no endpoint, environment or wallet credentials.
  const instructions = tx.instructions.filter(i => i.program === schema.address).slice(0, 32)
    .map(i => ({ accounts: i.accounts, dataBase64: i.data.toString('base64') }));
  return { signature, status: 'inspected', slot: result.slot, blockTime: result.blockTime,
    diagnostics, events, instructions };
}
async function collect(url, signatures, fetcher = fetch) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password ||
    !(u.hostname.endsWith('.helius-rpc.com') || u.hostname.endsWith('.helius.xyz'))) throw new Error('Only HTTPS Helius RPC is allowed');
  if (!signatures.length || signatures.length > 3 || signatures.some(s => !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s))) throw new Error('Provide 1–3 valid signatures');
  const rows = [];
  for (const signature of signatures) {
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
          method: 'getTransaction', params: [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) });
      if (!response.ok) { rows.push({ signature, status: 'http_error', httpStatus: response.status }); continue; }
      const body = await response.json();
      if (body.error) { rows.push({ signature, status: 'rpc_error', code: Number(body.error.code) || null }); continue; }
      rows.push(inspect(signature, body.result));
    } catch (_) { rows.push({ signature, status: 'request_or_decode_failed' }); }
  }
  return { version: 1, generatedAt: new Date().toISOString(), definition: 'since_pump_graduation_migration',
    requestedTransactions: signatures.length, rows };
}
async function main() {
  const { readConfig } = require('../src/config');
  const config = readConfig();
  const signatures = process.argv.slice(2);
  const report = await collect(config.rpcUrl, signatures.length ? signatures : DEFAULT_SIGNATURES);
  const directory = path.resolve(__dirname, '../data');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `migration-diagnosis-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(file);
  for (const row of report.rows) console.log(`${row.signature}: ${row.status}; matched=${row.events?.length || 0}`);
  if (report.rows.some(r => r.status !== 'inspected')) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('Migration diagnosis failed; check local configuration and RPC access. No credentials were printed.'); process.exitCode = 1; });
module.exports = { inspect, collect, DEFAULT_SIGNATURES };
