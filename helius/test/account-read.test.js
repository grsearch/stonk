'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { readAccounts } = require('../src/account-read');
function setup(errors, overrides = {}) {
  let time = 1000; const calls = [], logs = [], waits = [];
  const rpc = { async getMultipleAccountsInfoAndContext(keys, options) {
    calls.push(options); const e = errors.shift(); if (e) throw e;
    return { context: { slot: 123 }, value: [] };
  } };
  return { calls, logs, waits, run: () => readAccounts(rpc, [], { slot: 123, receivedAt: 1000, eventTime: 1000, isEntry: true, ...overrides },
    { maxSignalAgeMs: 2500 }, (type, r) => logs.push({ type, ...r }),
    { now: () => time, sleep: async ms => { waits.push(ms); time += ms; } }) };
}
const lag = () => Object.assign(new Error('accounts: minimum context slot'), { code: -32016, data: { contextSlot: 120 } });

test('live entry policy allows only one additional slot retry inside the original signal deadline', async () => {
  let now = 1000, calls = 0; const waits = [];
  const rpc = { async getMultipleAccountsInfoAndContext() { if (++calls <= 3) throw lag(); return { context: { slot: 123 }, value: [] }; } };
  await readAccounts(rpc, [], { slot: 123, receivedAt: 1000, eventTime: 1000, isEntry: true },
    { maxSignalAgeMs: 2500, liveEntryPolicy: {} }, () => {}, { now: () => now, sleep: async ms => { now += ms; waits.push(ms); } });
  assert.equal(calls, 4); assert.deepEqual(waits, [100, 200, 300]);
});
test('lagging execution read retries twice with original slot then succeeds', async () => {
  const s = setup([lag(), lag()]); await s.run();
  assert.deepEqual(s.waits, [100, 200]); assert.equal(s.calls.length, 3);
  assert.ok(s.calls.every(c => c.minContextSlot === 123 && c.commitment === 'processed'));
  assert.equal(s.logs[0].contextSlot, 120); assert.equal(s.logs.at(-1).type, 'execution_account_read_recovered');
});
test('persistent lag is bounded and keeps RPC code', async () => {
  const s = setup([lag(), lag(), lag()]); await assert.rejects(s.run(), { code: -32016 });
  assert.equal(s.calls.length, 3); assert.equal(s.logs.at(-1).retry, false);
});
test('rate limits and other errors are not blindly retried or exposed in diagnostics', async () => {
  for (const code of [429, -32602, undefined]) {
    const s = setup([Object.assign(new Error('https://secret.example/key'), { code })]);
    await assert.rejects(s.run()); assert.equal(s.calls.length, 1); assert.ok(!JSON.stringify(s.logs).includes('secret'));
  }
});
test('stale entry does not retry, but old position exit can catch up', async () => {
  const entry = setup([lag()], { receivedAt: -2000 }); await assert.rejects(entry.run()); assert.equal(entry.calls.length, 1);
  const exit = setup([lag()], { receivedAt: -2000, isEntry: false }); await exit.run(); assert.equal(exit.calls.length, 2);
});
