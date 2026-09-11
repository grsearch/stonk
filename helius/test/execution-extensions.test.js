'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { MintLayout, ExtensionType: E, TOKEN_2022_PROGRAM_ID: T, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const { executionAccount } = require('../src/execution-extensions');
const { executor, state, accountInfo } = require('./executor-fixtures');
const { ExecutionFunnel } = require('../src/reporting/execution-funnel');
const { PUMP_AMM_SDK } = require('@pump-fun/pump-swap-sdk');
const { PUMP, WSOL } = require('../src/config');
function extended(info, kind, entries) {
  const prefix = Buffer.alloc(166); info.data.copy(prefix); prefix[165] = kind === 'mint' ? 1 : 2;
  return { ...info, owner: T, data: Buffer.concat([prefix, ...entries.map(([type, data]) => {
    const h = Buffer.alloc(4); h.writeUInt16LE(type); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]);
  })]) };
}
function mintInfo(mint) {
  const info = { owner: T, data: Buffer.alloc(82) };
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, info.data);
  const metadata = Buffer.alloc(80); mint.toBuffer().copy(metadata, 32);
  return extended(info, 'mint', [[E.MetadataPointer, Buffer.alloc(64)], [E.TokenMetadata, metadata]]);
}
test('execution permits valid metadata and blocks fee/hook/unknown and malformed TLV', () => {
  const e = executor(), s = state(e), info = mintInfo(s.baseMint), logs = [];
  const m = executionAccount(info, 'baseMint', 'mint', s.baseMint, T, d => logs.push(d));
  assert.equal(m.supply, 1000000000000000n); assert.equal(logs[0].extensions.length, 2);
  for (const type of [E.TransferFeeConfig, E.TransferHook, E.PermanentDelegate, 60000]) {
    const bad = extended({ ...info, data: info.data.subarray(0, 82) }, 'mint', [[type, Buffer.alloc(0)]]);
    assert.throws(() => executionAccount(bad, 'baseMint', 'mint', s.baseMint, T), /unsupported_extensions/);
  }
  const bad = { ...info, data: Buffer.from(info.data) }; bad.data[165] = 2;
  assert.throws(() => executionAccount(bad, 'baseMint', 'mint', s.baseMint, T), /invalid_extension_layout/);
});
for (const cashback of [false, true]) test(`metadata mint uses actual SDK buy/sell and ImmutableOwner cleanup, cashback=${cashback}`, async () => {
  const e = executor(), s = state(e, cashback);
  s.baseTokenProgram = T; s.userBaseTokenAccount = getAssociatedTokenAddressSync(s.baseMint, e.wallet.publicKey, false, T);
  s.baseMintAccount = executionAccount(mintInfo(s.baseMint), 'baseMint', 'mint', s.baseMint, T);
  e.state = async () => s;
  const swap = { mint: s.baseMint.toBase58(), pool: s.poolKey.toBase58() };
  const buy = await e.buildSwap('buy', swap);
  const tx = VersionedTransaction.deserialize(Buffer.from(buy.serialized, 'base64'));
  assert.ok(tx.message.staticAccountKeys.some(k => k.equals(T)));
  assert.ok(Buffer.from(buy.serialized, 'base64').length <= 1232);
  s.userBaseAccountInfo = extended(accountInfo(s.baseMint, e.wallet.publicKey, 1000000n, T), 'account', [[E.ImmutableOwner, Buffer.alloc(0)]]);
  executionAccount(s.userBaseAccountInfo, 'userBase', 'account', s.userBaseTokenAccount, T);
  assert.ok((await e.buildSwap('sell', swap, '1000000')).signature);
  e.rpc.getAccountInfo = async () => s.userBaseAccountInfo;
  const item = { mint: swap.mint, ata: s.userBaseTokenAccount.toBase58(), tokenProgram: T.toBase58(), createdByBot: true };
  await assert.rejects(e.closeTransaction(item), /not empty/);
  s.userBaseAccountInfo = extended(accountInfo(s.baseMint, e.wallet.publicKey, 0n, T), 'account', [[E.ImmutableOwner, Buffer.alloc(0)]]);
  const close = await e.closeTransaction(item);
  const ctx = VersionedTransaction.deserialize(Buffer.from(close.serialized, 'base64'));
  assert.ok(ctx.message.compiledInstructions.some(ix => ctx.message.staticAccountKeys[ix.programIdIndex].equals(T) && ix.data[0] === 9));
  s.userBaseAccountInfo = extended(accountInfo(s.baseMint, e.wallet.publicKey, 0n, T), 'account', [[E.MemoTransfer, Buffer.from([1])]]);
  await assert.rejects(e.closeTransaction(item), /unsupported_extensions/);
});
test('funnel deduplicates retries and receipts, and separates batch count mismatch', () => {
  const f = new ExecutionFunnel();
  for (let attempt = 1; attempt <= 3; attempt++) f.record({ type: 'execution_account_read_failed', side: 'buy', sourceSignature: 's', pool: 'p', code: -32016, retry: attempt < 3 });
  for (let i = 0; i < 2; i++) f.record({ type: 'calibration_receipt', signature: 'tx', side: 'buy', status: 'confirmed' });
  f.snapshot({ batchId: 'b', attempts: 0, transactions: { tx: { signature: 'tx', side: 'buy', status: 'confirmed' } } });
  const r = f.result(); assert.equal(r.counts.slotLagCandidates, 1); assert.equal(r.counts.accountReadTerminalFailures, 1);
  assert.equal(r.counts['receipt:buy:confirmed'], 1); assert.equal(r.batchSnapshots[0].status, 'count_mismatch');
});
test('execution state validates mint, vault and wallet extensions before building', async t => {
  const e = executor(), s = state(e), logs = [];
  e.store.log = (type, r) => logs.push({ type, ...r });
  t.mock.method(PUMP_AMM_SDK, 'decodePool', () => s.pool);
  t.mock.method(PUMP_AMM_SDK, 'decodeGlobalConfig', () => s.globalConfig);
  t.mock.method(PUMP_AMM_SDK, 'decodeFeeConfig', () => s.feeConfig);
  const b = accountInfo(s.baseMint, s.poolKey, 1000000000000n, T);
  const q = accountInfo(new PublicKey(WSOL), s.poolKey, 100000000000n);
  const values = [{ owner: new PublicKey(PUMP) }, {}, {}, mintInfo(s.baseMint), b, q, null, null];
  e.rpc.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 200 }, value: values });
  const swap = { mint: s.baseMint.toBase58(), pool: s.poolKey.toBase58(), baseVault: s.pool.poolBaseTokenAccount.toBase58(),
    quoteVault: s.pool.poolQuoteTokenAccount.toBase58(), tokenProgram: T.toBase58(), slot: 199, signature: 'signal', receivedAt: Date.now(), eventTime: Date.now() };
  const valid = await e.state(swap, 'buy'); assert.equal(valid.baseMintAccount.isInitialized, true);
  assert.equal(logs[0].sourceSignature, 'signal'); assert.equal(logs[0].extensions.length, 2);
  values[6] = extended(accountInfo(s.baseMint, e.wallet.publicKey, 0n, T), 'account', [[E.TransferHookAccount, Buffer.from([0])]]);
  await assert.rejects(e.state(swap, 'buy'), /userBase: unsupported_extensions/);
  values[6] = null;
  values[4] = extended(b, 'account', [[E.TransferFeeAmount, Buffer.alloc(8)]]);
  await assert.rejects(e.state(swap, 'sell'), /baseVault: unsupported_extensions/);
});
