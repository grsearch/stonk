'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { options, snapshot, createServer } = require('../src/dashboard/server');
const { readConfig } = require('../src/config');
const { buildArchive } = require('../src/reporting/archive');
const { inspect } = require('../scripts/inspect-export');
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, c: readConfig({ HELIUS_API_KEY: 'secret-api', STATE_FILE: path.join(dir, 'paper.json'), SHADOW_DIRECTORY: path.join(dir, 'shadow') }) }; }
test('1 SOL default and existing explicit configuration remain distinguishable', () => {
  assert.equal(readConfig({ HELIUS_API_KEY: 'x' }).sizeSol, 1); assert.equal(readConfig({ HELIUS_API_KEY: 'x', POSITION_SIZE_SOL: '0.1' }).sizeSol, 0.1);
  assert.equal(options({}).port, 8787); assert.throws(() => options({ DASHBOARD_HOST: '0.0.0.0' }), /token/);
  assert.throws(() => options({ DASHBOARD_PUBLIC_ORIGIN: 'https://dashboard.example.com' }), /token/);
  assert.equal(options({ DASHBOARD_PUBLIC_ORIGIN: 'https://dashboard.example.com', DASHBOARD_TOKEN: 'a'.repeat(32) }).publicOrigin, 'https://dashboard.example.com');
});
test('dashboard marks old health stale and excludes private state and pending bytes', async t => {
  const { dir, c } = setup(t), now = Date.now();
  fs.writeFileSync(c.stateFile, JSON.stringify({ mode: 'paper', privateKey: 'LEAK', pending: { sig: { signature: 'sig', serialized: 'SIGNED_BYTES', privateKey: 'LEAK' } }, positions: {} }));
  fs.writeFileSync(`${c.stateFile}.jsonl`, JSON.stringify({ type: 'health', time: new Date(now - 180000).toISOString(), connected: true }) + '\n');
  const s = await snapshot(c, dir, now); assert.equal(s.status, 'unknown_or_stale');
  for (const secret of ['LEAK', 'SIGNED_BYTES', 'secret-api']) assert.ok(!JSON.stringify(s).includes(secret));
});
test('dashboard HTTP requires token, rejects mutations, and does not serve filesystem paths', async t => {
  const { dir, c } = setup(t), token = 'a'.repeat(32), server = createServer(c, { host: '127.0.0.1', token }, dir);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/api/status')).status, 401);
  assert.equal((await fetch(url + '/api/status', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(url + '/api/status', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(url + '/api/status', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/.env')).status, 404);
  assert.equal((await fetch(url)).status, 200);
});
test('archive inspection distinguishes valid empty export from available training samples', async t => {
  const { dir, c } = setup(t), end = Date.parse('2026-09-06T23:00:00Z');
  const bundle = await buildArchive({ c, outputDir: dir, end }); const result = await inspect(bundle.folder);
  assert.equal(result.integrity, 'verified'); assert.equal(result.sampleRecords, 0); assert.equal(result.windowRecords, 0);
  fs.appendFileSync(bundle.file, 'corruption'); await assert.rejects(inspect(bundle.folder), /checksum/);
});
