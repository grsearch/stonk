'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect, DEFAULT_SIGNATURES } = require('../scripts/diagnose-migration');
test('migration historical diagnosis limits Helius calls and never exposes RPC errors or keys', async () => {
  let calls = 0;
  const report = await collect('https://mainnet.helius-rpc.com/?api-key=SECRET', DEFAULT_SIGNATURES, async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    assert.equal(body.method, 'getTransaction');assert.equal(body.params[1].encoding, 'json');
    if (calls === 1) return { ok: true, json: async () => ({ error: { code: -32000, message: url } }) };
    throw new Error(url);
  });
  assert.equal(calls, 2);assert.equal(report.rows[0].status, 'rpc_error');
  assert.equal(report.rows[1].status, 'request_or_decode_failed');
  assert.ok(!JSON.stringify(report).includes('SECRET'));
  await assert.rejects(collect('https://example.com', DEFAULT_SIGNATURES));
  await assert.rejects(collect('https://mainnet.helius-rpc.com', Array(4).fill(DEFAULT_SIGNATURES[0])));
});
