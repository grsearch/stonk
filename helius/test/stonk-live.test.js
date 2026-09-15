'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Keypair, PublicKey, TransactionInstruction, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const bs58 = require('bs58').default;
const { readConfig } = require('../src/stonk/config');
const { LiveExecutor, quoteValid, ROUTER } = require('../src/stonk/live-executor');
const { LiveEngine, fill } = require('../src/stonk/live-engine');
const { WSOL } = require('../src/stonk/accounts');
const wallet = Keypair.generate(), mint = Keypair.generate().publicKey.toBase58(), pool = Keypair.generate().publicKey.toBase58();
const c = readConfig({ HELIUS_API_KEY: 'test', STONK_LIVE_ENABLED: 'true', WALLET_PRIVATE_KEY_BS58: bs58.encode(wallet.secretKey) });
function quote() { return { success: true, data: { swapType: 'BaseIn', inputMint: WSOL, outputMint: mint, inputAmount: '100000000',
  outputAmount: '1000', otherAmountThreshold: '900', slippageBps: 1000, routePlan: [{ poolId: pool, inputMint: WSOL, outputMint: mint }] } }; }
const expected = { input: WSOL, output: mint, amount: '100000000', pool, side: 'buy', slippage: 1000 };
test('live requires explicit opt-in and a valid wallet; uses a separate ledger and 0.1 SOL', () => {
  assert.equal(readConfig({ HELIUS_API_KEY: 'test', DRY_RUN: 'false' }).dryRun, true);
  assert.throws(() => readConfig({ HELIUS_API_KEY: 'test', STONK_LIVE_ENABLED: 'true' }));
  assert.equal(c.dryRun, false); assert.equal(c.sizeSol, .1); assert.match(c.stateFile, /live.json$/);
  assert.match(c.shadow.directory, /shadow-live$/); assert.equal(c.maxHoldMs, 20000); assert.equal(c.liveEntryPolicy.lossCooldownMs, 60000);
});
test('quote validation rejects altered budget, destination, minimum, fees and wrong target pool', () => {
  assert.ok(quoteValid(quote(), expected));
  for (const change of [{ inputAmount: '100000001' }, { outputMint: WSOL }, { otherAmountThreshold: '1' }, { referrerAmount: '1' },
    { routePlan: [{ poolId: 'other', inputMint: WSOL, outputMint: mint }] }]) {
    const q = quote(); Object.assign(q.data, change); assert.throws(() => quoteValid(q, expected));
  }
});
function instructions() {
  const owner = wallet.publicKey.toBase58(), input = getAssociatedTokenAddressSync(new PublicKey(WSOL), wallet.publicKey).toBase58();
  const output = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey).toBase58();
  const ix = (data, keys) => new TransactionInstruction({ programId: new PublicKey(ROUTER), data, keys: keys.map(k => ({ pubkey: new PublicKey(k), isSigner: k === owner, isWritable: true })) });
  const wrap = Buffer.alloc(9); wrap[0] = 5; wrap.writeBigUInt64LE(100000000n, 1);
  const swap = Buffer.alloc(17); swap.writeBigUInt64LE(100000000n, 1); swap.writeBigUInt64LE(900n, 9);
  return { output, ixs: [ix(wrap, [owner, input, WSOL]), ix(swap, [owner,owner,owner,owner,owner,input,output,pool]), ix(Buffer.from([6]), [owner,input,owner])] };
}
test('signed instruction validation binds amount, recipient and route, rejecting arbitrary programs', () => {
  const e = new LiveExecutor(c), { ixs, output } = instructions();
  e.validateInstructions(ixs, quote().data, 'buy', output);
  const altered = instructions(); altered.ixs[1].data.writeBigUInt64LE(899n, 9); assert.throws(() => e.validateInstructions(altered.ixs, quote().data, 'buy', output));
  const foreign = instructions(); foreign.ixs[1].programId = Keypair.generate().publicKey; assert.throws(() => e.validateInstructions(foreign.ixs, quote().data, 'buy', output));
  const redirected = instructions(); redirected.ixs[2].keys[2].pubkey = Keypair.generate().publicKey; assert.throws(() => e.validateInstructions(redirected.ixs, quote().data, 'buy', output));
});
function receipt(side, net = 100000000) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey).toBase58();
  const token = amount => ({ accountIndex: 1, mint, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount } });
  return { pending: { side, signature: 'sig', mint, ata, inputAmount: side === 'buy' ? '100000000' : '1000', minOutputAmount: '900', swap: { pool, mint }, submittedAt: Date.now() },
    receipt: { slot: 10, transaction: { signatures: ['sig'], message: { accountKeys: [wallet.publicKey, new PublicKey(ata), new PublicKey(pool)] } },
      meta: { err: null, fee: 5000, preBalances: [1000000000,0,0], postBalances: [1000000000 + (side === 'buy' ? -net : net),0,0],
        preTokenBalances: [token(side === 'buy' ? '0' : '1000')], postTokenBalances: [token(side === 'buy' ? '1000' : '0')] } } };
}
test('receipt accounting binds wallet, signature and token delta, including negative net exit proceeds', () => {
  const b = receipt('buy'); assert.equal(fill(b.pending,b.receipt,wallet.publicKey.toBase58()).rawDelta,1000n);
  const s = receipt('sell',-1000); assert.equal(fill(s.pending,s.receipt,wallet.publicKey.toBase58()).solDelta,-.000001);
  s.receipt.transaction.signatures=['other'];assert.throws(()=>fill(s.pending,s.receipt,wallet.publicKey.toBase58()));
});
test('confirmed buy/sell settles ledger and starts loss cooldown, while expiry preserves holdings', () => {
  const store={data:{wallet:wallet.publicKey.toBase58(),positions:{},pending:{},cleanup:{},cooldown:{},seen:{}},logs:[],save(){},log(type,r){this.logs.push({type,...r})}};
  const e=new LiveEngine(c,store,{stonkLive:true},{connected:true});const b=receipt('buy');store.data.pending.sig=b.pending;e.applyReceipt(b.pending,b.receipt);
  assert.equal(store.data.positions[mint].rawAmount,'1000');assert.equal(Object.keys(store.data.pending).length,0);
  e.expirePool(pool);assert.ok(store.data.positions[mint]);assert.equal(store.data.positions[mint].exitRetryReason,'graduation_window_end');
  const s=receipt('sell',90000000);e.applyReceipt(s.pending,s.receipt);assert.equal(store.data.positions[mint],undefined);assert.ok(store.data.lossCooldowns[mint]>Date.now()+59000);
});
test('live timer still sells after graduation expiry and does not fabricate a closure',async()=>{
  const now=Date.now(),p={mint,pool,graduatedAt:now-1800001,openedAt:now-20001,lastPriceAt:now};
  const store={data:{positions:{[mint]:p},pending:{},cleanup:{},cooldown:{},seen:{}},save(){},log(){}};
  const e=new LiveEngine(c,store,{stonkLive:true},{connected:true});let why;e.sell=async(_p,r)=>{why=r};await e.tick();
  assert.equal(why,'graduation_window_end');assert.ok(store.data.positions[mint]);
});
