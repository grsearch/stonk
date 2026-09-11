'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction } = require('@solana/web3.js');
const { Engine } = require('../src/engine');
const { readConfig } = require('../src/config');
const { normalize, parseSwaps } = require('../src/parser');
const { key } = require('./fixtures');
function setup(side = 'buy') {
  const wallet = key(1), ata = key(2);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(wallet), recentBlockhash: key(4),
    instructions: [new TransactionInstruction({ programId: new PublicKey(key(3)), keys: [{ pubkey: new PublicKey(ata), isSigner: false, isWritable: true }], data: Buffer.alloc(0) })] }).compileToV0Message());
  const receipt = { slot: 100, transaction: [Buffer.from(tx.serialize()).toString('base64'), 'base64'],
    meta: { err: { InstructionError: [0, { Custom: 1 }] }, fee: 5000, preBalances: [100000000, 2000000, 0], postBalances: [99995000, 2000000, 0], preTokenBalances: [], postTokenBalances: [] } };
  const c = readConfig({ HELIUS_API_KEY: 'test', DRY_RUN: 'false', LIVE_CALIBRATION: 'true', WALLET_PRIVATE_KEY_BS58: 'unused' });
  const store = { data: { wallet, positions: {}, pending: {}, cleanup: {}, seen: {}, cooldown: {}, streamDays: {} }, logs: [],
    save() { this.saved = JSON.stringify(this.data); }, log(type, r) { this.logs.push({ type, ...r }); } };
  const executor = { rpc: { async getSignatureStatuses() { return { value: [{ err: receipt.meta.err, confirmationStatus: 'confirmed' }] }; } }, async receipt() { return receipt; } };
  const engine = new Engine(c, store, executor, { connected: true, budgetExceeded: () => false });
  store.data.pending.failed = { signature: 'failed', side, mint: 'old', ata, submittedAt: Date.now() - 200000 };
  return { receipt, c, store, executor, engine };
}
test('failed chain transactions remain excluded from market parsing but usable for fee accounting', () => {
  const { receipt } = setup(); const envelope = { transaction: { transaction: receipt.transaction, meta: receipt.meta } };
  assert.equal(normalize(envelope), null); assert.deepEqual(parseSwaps(envelope), []);
  assert.equal(normalize(envelope, { allowFailed: true }).keys[0], key(1));
});
for (const side of ['buy', 'sell', 'close']) test(`confirmed failed ${side} clears pending only after accounting and survives restart`, async () => {
  const { engine, store, executor } = setup(side);
  store.data.positions.old = { rawAmount: '123' }; store.data.cleanup.old = { dueAt: 0 };
  await engine.reconcile();
  assert.equal(engine.pending(), false); assert.ok(Math.abs(engine.calibration.s.lossSol - .000005) < 1e-12);
  assert.equal(store.data.positions.old.rawAmount, '123'); assert.ok(store.data.cleanup.old);
  assert.equal(store.logs.find(r => r.type === 'calibration_receipt').status, 'failed');
  const restored = { ...store, data: JSON.parse(store.saved) };
  const next = new Engine(engine.c, restored, executor, engine.stream); await next.reconcile();
  assert.equal(next.pending(), false); assert.equal(next.calibration.s.lossSol, engine.calibration.s.lossSol);
});
for (const reason of ['stop_loss', 'max_hold']) test(`failed pending transaction no longer blocks another position's ${reason}`, async () => {
  const { engine, store, executor } = setup(); let sent = false;
  store.data.positions.other = { mint: 'other', pool: key(9), rawAmount: '1', entryPrice: 1, high: 1,
    lastPrice: reason === 'stop_loss' ? .0181 : 1, lastPriceAt: Date.now(), openedAt: Date.now() - (reason === 'max_hold' ? 2100000 : 60000) };
  executor.buildSwap = async () => ({ signature: 'exit', serialized: 'unused' });
  executor.submit = async () => { sent = true; };
  engine.pollPositions = async () => {}; engine.cleanup = async () => {};
  await engine.tick(); assert.equal(sent, true); assert.equal(store.data.pending.exit.reason, reason);
  assert.equal(store.data.pending.failed, undefined);
});
test('missing receipt retains pending and does not manufacture a failed transaction fee', async () => {
  const { engine, executor, store } = setup(); executor.receipt = async () => null;
  await engine.reconcile(); assert.ok(store.data.pending.failed); assert.equal(engine.calibration.s.lossSol, 0);
});
