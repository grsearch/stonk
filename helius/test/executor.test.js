'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const BN = require('bn.js');
const bs58 = require('bs58').default;
const Executor = require('../src/executor');
const { readConfig, WSOL, PUMP } = require('../src/config');
const { key } = require('./fixtures');

const { executor, state, accountInfo } = require('./executor-fixtures');
for (const cashback of [false, true]) test(`real SDK buy and sell can serialize within packet size, cashback=${cashback}`, async () => {
  const e = executor(), s = state(e, cashback);
  e.state = async () => s;
  const swap = { mint: s.baseMint.toBase58(), pool: s.poolKey.toBase58() };
  const buy = await e.buildSwap('buy', swap);
  const bytes = Buffer.from(buy.serialized, 'base64');
  assert.ok(bytes.length <= 1232, `buy size ${bytes.length}`);
  const tx = VersionedTransaction.deserialize(bytes);
  assert.equal(bs58.encode(tx.signatures[0]), buy.signature);
  const baseCreates = tx.message.compiledInstructions.filter(ix => tx.message.staticAccountKeys[ix.programIdIndex].equals(ASSOCIATED_TOKEN_PROGRAM_ID)
    && tx.message.staticAccountKeys[ix.accountKeyIndexes[1]].equals(s.userBaseTokenAccount));
  assert.equal(baseCreates.length, 1, 'only one base ATA creation');
  s.userBaseAccountInfo = accountInfo(s.baseMint, e.wallet.publicKey, 1000000n);
  const sell = await e.buildSwap('sell', swap, '1000000');
  assert.ok(Buffer.from(sell.serialized, 'base64').length <= 1232);
});
test('pool read and expired blockhash refresh start independently', async () => {
  const e = executor(), s = state(e);
  e.blockhash = null;
  let stateStarted = false, refreshStarted = false, release;
  e.state = () => { stateStarted = true; return new Promise(resolve => { release = () => resolve(s); }); };
  e.refreshBlockhash = async () => { refreshStarted = true; e.blockhash = { blockhash: key(20), at: Date.now(), lastValidBlockHeight: 2000 }; };
  const built = e.buildSwap('buy', { mint: s.baseMint.toBase58() });
  assert.ok(stateStarted && refreshStarted); release();
  assert.ok((await built).signature);
});
for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) test(`cleanup enforces zero balance and correct ATA for ${program}`, async () => {
  const e = executor(), mint = new PublicKey(key(4));
  const ata = e.ata(mint.toBase58(), program.toBase58());
  const item = { mint: mint.toBase58(), ata: ata.toBase58(), tokenProgram: program.toBase58(), createdByBot: true };
  e.rpc.getAccountInfo = async () => accountInfo(mint, e.wallet.publicKey, 1n, program);
  await assert.rejects(e.closeTransaction(item), /not empty/);
  e.rpc.getAccountInfo = async () => accountInfo(mint, e.wallet.publicKey, 0n, program);
  const close = await e.closeTransaction(item); assert.ok(close.signature);
  await assert.rejects(e.closeTransaction({ ...item, ata: key(17) }), /Unmanaged/);
  await assert.rejects(e.closeTransaction({ ...item, createdByBot: false }), /Unmanaged/);
});
