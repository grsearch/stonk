'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { migrations } = require('../src/migration');
const { decodeEvent, CPI_TAG } = require('../src/parser');
const schema = require('../src/migration-layout.json');
const { PUMP, WSOL } = require('../src/config');
const bs58 = require('bs58').default;
const { key } = require('./fixtures');
function run(name, eventQuote, change = {}) {
  const spec = schema.instructions.find(s => s.name === name);
  const values = { mint: key(2), pool: key(3), timestamp: 1000, quote_mint: eventQuote };
  const fields = schema.types[0].type.fields.filter(f => f.name !== 'quote_mint' || eventQuote !== undefined);
  const bytes = Buffer.concat([Buffer.from(schema.events[0].discriminator), ...fields.map(f => {
    if (f.type === 'pubkey') return Buffer.from(bs58.decode(values[f.name] || key(4)));
    const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(values[f.name] || 0)); return b;
  })]);
  const accounts = { mint: key(2), base_mint: key(2), pool: key(3), pump_amm: PUMP, wsol_mint: WSOL, quote_mint: WSOL, ...change };
  const tx = { signature: 'test', receivedAt: 1000001, slot: 1, meta: {}, instructions: [
    { program: schema.address, accounts: spec.accounts.map(a => accounts[a.name] || key(4)), data: Buffer.from(spec.discriminator) },
    { program: schema.address, accounts: [], data: Buffer.concat([CPI_TAG, bytes]) },
  ] };
  const events = [], diagnostics = []; migrations(tx, decodeEvent, e => events.push(e), d => diagnostics.push(d));
  return { events, diagnostics };
}
for (const name of ['migrate', 'migrate_v2']) {
  test(`${name}: default native SOL event quote requires matching WSOL instruction`, () => {
    const r = run(name, '11111111111111111111111111111111');
    assert.equal(r.events.length, 1); assert.equal(r.events[0].migrationAt, 1000000);
    assert.equal(r.events[0].instructionQuoteMint, WSOL);
    assert.ok(r.diagnostics.some(d => d.stage === 'migration_native_sol_quote_matched'));
    for (const change of [{ pool: key(9) }, { mint: key(9), base_mint: key(9) }, { pump_amm: key(9) },
      { quote_mint: key(9), wsol_mint: key(9) }, { quote_mint: '11111111111111111111111111111111', wsol_mint: '11111111111111111111111111111111' }])
      assert.equal(run(name, '11111111111111111111111111111111', change).events.length, 0);
    assert.equal(run(name, key(9)).events.length, 0);
    assert.equal(run(name, key(9), { quote_mint: key(9), wsol_mint: key(9) }).events.length, 0);
    assert.equal(run(name, WSOL).events.length, 1);
    assert.equal(run(name, undefined).events.length, 1);
  });
}
