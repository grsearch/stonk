'use strict';
const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } = require('@solana/spl-token');
const { PUMP_AMM_SDK, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA } = require('@pump-fun/pump-swap-sdk');
const BN = require('bn.js');
const bs58 = require('bs58').default;
const { performance } = require('node:perf_hooks');
const { PUMP, WSOL } = require('./config');
const { executionAccount } = require('./execution-extensions');

const TIP = new PublicKey('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE');
function buyQuoteLamports(c) {
  const budget = new BN(Math.round(c.sizeSol * 1e9).toString());
  // SDK expands the quote by slippage. Reserve that allowance inside the calibration cap.
  return c.calibration?.enabled ? budget.muln(10000).divn(10000 + c.buySlippageBps) : budget;
}
class Executor {
  constructor(config, store) {
    this.c = config; this.store = store; this.rpcCalls = 0; this.blockhash = null;
    this.wallet = config.dryRun ? null : Keypair.fromSecretKey(bs58.decode(config.privateKey));
    this.rpc = new Connection(config.rpcUrl, {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: async (url, options) => {
        this.rpcCalls++;
        return fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
      },
    });
  }
  async start() {
    if (!this.wallet) return;
    await this.refreshBlockhash();
    this.timer = setInterval(() => this.refreshBlockhash().catch(() => this.store.log('blockhash_refresh_failed')), this.c.blockhashMs);
    const ping = async () => {
      try {
        const response = await fetch(new URL('/ping', this.c.senderUrl), { signal: AbortSignal.timeout(2000) });
        await response.arrayBuffer(); // Consume the body so the connection can return to the pool.
      } catch (_) { /* The normal submit path handles an unavailable Sender. */ }
    };
    ping(); this.pingTimer = setInterval(ping, 5000);
  }
  async refreshBlockhash() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.rpc.getLatestBlockhash('confirmed').then(value => { this.blockhash = { ...value, at: Date.now() }; }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  ata(mint, program) {
    return getAssociatedTokenAddressSync(new PublicKey(mint), this.wallet.publicKey, false, new PublicKey(program));
  }
  async state(swap, side) {
    const user = this.wallet.publicKey;
    const baseTokenProgram = new PublicKey(swap.tokenProgram);
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(baseTokenProgram))) throw new Error('Unsupported token program');
    const baseMint = new PublicKey(swap.mint), poolKey = new PublicKey(swap.pool);
    const userBaseTokenAccount = this.ata(swap.mint, swap.tokenProgram);
    const userQuoteTokenAccount = this.ata(WSOL, TOKEN_PROGRAM_ID.toBase58());
    const keys = [poolKey, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, baseMint,
      new PublicKey(swap.baseVault), new PublicKey(swap.quoteVault), userBaseTokenAccount, userQuoteTokenAccount];
    // Addresses come from the authenticated swap: one round trip replaces SDK's three sequential reads.
    const response = await require('./account-read').readAccounts(this.rpc, keys, { ...swap, isEntry: side === 'buy' }, this.c,
      (type, record) => this.store?.log(type, { ...record, side, sourceSignature: swap.signature, pool: swap.pool, mint: swap.mint }));
    const [poolAccountInfo, globalInfo, feeInfo, mintInfo, b, q, userBaseAccountInfo, userQuoteAccountInfo] = response.value;
    if (!poolAccountInfo?.owner.equals(new PublicKey(PUMP)) || !globalInfo || !feeInfo || !mintInfo || !b || !q) throw new Error('Pool/config accounts unavailable');
    const pool = PUMP_AMM_SDK.decodePool(poolAccountInfo);
    if (!pool.baseMint.equals(baseMint) || pool.quoteMint.toBase58() !== WSOL || pool.poolBaseTokenAccount.toBase58() !== swap.baseVault || pool.poolQuoteTokenAccount.toBase58() !== swap.quoteVault) throw new Error('Pool identity mismatch');
    if (!mintInfo.owner.equals(baseTokenProgram)) throw new Error('Mint token program mismatch');
    const inspect = (info, role, kind, address, program) => executionAccount(info, role, kind, address, program,
      d => this.store?.log('execution_token_extensions', { ...d, side, sourceSignature: swap.signature, pool: swap.pool, mint: swap.mint }));
    const baseMintAccount = inspect(mintInfo, 'baseMint', 'mint', baseMint, baseTokenProgram);
    inspect(b, 'baseVault', 'account', keys[4], baseTokenProgram);
    inspect(q, 'quoteVault', 'account', keys[5], TOKEN_PROGRAM_ID);
    if (userBaseAccountInfo) inspect(userBaseAccountInfo, 'userBase', 'account', userBaseTokenAccount, baseTokenProgram);
    if (userQuoteAccountInfo) inspect(userQuoteAccountInfo, 'userQuote', 'account', userQuoteTokenAccount, TOKEN_PROGRAM_ID);
    const base = unpackAccount(keys[4], b, baseTokenProgram), quote = unpackAccount(keys[5], q, TOKEN_PROGRAM_ID);
    if (!base.mint.equals(baseMint) || quote.mint.toBase58() !== WSOL || !base.owner.equals(poolKey) || !quote.owner.equals(poolKey)) throw new Error('Invalid pool vault');
    if (!base.isInitialized || !quote.isInitialized || base.isFrozen || quote.isFrozen) throw new Error('Invalid vault state');
    if (base.amount === 0n || quote.amount === 0n) throw new Error('Empty pool');
    return { poolKey, poolAccountInfo, pool, globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(globalInfo),
      feeConfig: PUMP_AMM_SDK.decodeFeeConfig(feeInfo), baseMint, baseMintAccount,
      baseTokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID, user, userBaseTokenAccount, userQuoteTokenAccount,
      userBaseAccountInfo, userQuoteAccountInfo, poolBaseAmount: new BN(base.amount.toString()), poolQuoteAmount: new BN(quote.amount.toString()),
      contextSlot: response.context.slot };
  }
  async buildSwap(side, swap, rawAmount) {
    const t0 = performance.now();
    // A stale blockhash refresh need not wait for the independent pool read.
    const [state] = await Promise.all([this.state(swap, side),
      !this.blockhash || Date.now() - this.blockhash.at > 25000 ? this.refreshBlockhash() : Promise.resolve()]);
    const stateMs = performance.now() - t0;
    const account = state.userBaseAccountInfo ? unpackAccount(state.userBaseTokenAccount, state.userBaseAccountInfo, state.baseTokenProgram) : null;
    if (account && (!account.owner.equals(this.wallet.publicKey) || !account.mint.equals(state.baseMint) || !account.isInitialized || account.isFrozen)) throw new Error('Invalid wallet token account');
    if (this.c.calibration?.enabled && side === 'buy' && state.userQuoteAccountInfo) throw new Error('Calibration requires no pre-existing WSOL account; use a dedicated wallet');
    if (side === 'buy' && account?.amount > 0n) throw new Error('Wallet already holds this mint; refusing to merge external holdings');
    if (side === 'buy' && Number(state.poolQuoteAmount.toString()) / 1e9 < this.c.minLiquidity) throw new Error('Pool liquidity below threshold');
    if (side === 'buy' && !this.c.dryRun && this.c.liveEntryPolicy
      && Number(state.poolQuoteAmount.toString()) / 1e9 <= this.c.liveEntryPolicy.reserveExclusiveSol)
      throw new Error('Live reserve must exceed 100 SOL');
    if (side === 'sell' && (!account || account.amount < BigInt(rawAmount))) throw new Error('Wallet balance below tracked position');
    const ixs = side === 'buy'
      ? await PUMP_AMM_SDK.buyQuoteInput(state, buyQuoteLamports(this.c), this.c.buySlippageBps / 100)
      : await PUMP_AMM_SDK.sellBaseInput(state, new BN(rawAmount), this.c.sellSlippageBps / 100);
    // Reused ATA may have been closed since a previous trade. This instruction is race-safe.
    if (side === 'buy') {
      const ensureAta = createAssociatedTokenAccountIdempotentInstruction(
        this.wallet.publicKey, state.userBaseTokenAccount, this.wallet.publicKey, state.baseMint, state.baseTokenProgram);
      const alreadyEnsured = ixs.some(ix => ix.programId.equals(ensureAta.programId)
        && ix.data.equals(ensureAta.data) && ix.keys[1]?.pubkey.equals(state.userBaseTokenAccount));
      if (!alreadyEnsured) ixs.unshift(ensureAta);
    }
    const signed = await this.sign(ixs, true);
    return { ...signed, quoteStatePrice: (Number(state.poolQuoteAmount.toString()) + Number(state.pool.virtualQuoteReserves?.toString() || 0)) / Number(state.poolBaseAmount.toString()) / 1e9,
      quoteStateSlot: state.contextSlot, quoteAta: state.userQuoteTokenAccount.toBase58(), senderTipSol: this.c.tipLamports / 1e9, ata: state.userBaseTokenAccount.toBase58(),
      createdByBot: !state.userBaseAccountInfo, stateMs: +stateMs.toFixed(3),
      buildSignMs: +(performance.now() - t0 - stateMs).toFixed(3) };
  }
  async sign(ixs, sender) {
    if (!this.wallet) throw new Error('Signing is disabled in DRY_RUN');
    if (!this.blockhash || Date.now() - this.blockhash.at > 25000) await this.refreshBlockhash();
    const bh = this.blockhash;
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.c.computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.ceil(this.c.priorityLamports * 1e6 / this.c.computeUnits) }), ...ixs];
    if (sender) instructions.push(SystemProgram.transfer({ fromPubkey: this.wallet.publicKey, toPubkey: TIP, lamports: this.c.tipLamports }));
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: this.wallet.publicKey, recentBlockhash: bh.blockhash, instructions }).compileToV0Message());
    tx.sign([this.wallet]);
    const bytes = Buffer.from(tx.serialize());
    if (bytes.length > 1232) throw new Error('Transaction exceeds Solana packet size; not submitted');
    return { signature: bs58.encode(tx.signatures[0]), serialized: bytes.toString('base64'), lastValidBlockHeight: bh.lastValidBlockHeight };
  }
  async submit(pending) {
    if (this.c.dryRun) throw new Error('Submission disabled in DRY_RUN');
    if (pending.side === 'close') {
      return this.rpc.sendRawTransaction(Buffer.from(pending.serialized, 'base64'), { skipPreflight: false, maxRetries: 0 });
    }
    try {
      const response = await fetch(this.c.senderUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [pending.serialized, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
        signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      if (!response.ok || body.error || body.result !== pending.signature) throw new Error('Sender rejected transaction');
      return body.result;
    } catch (_) {
      // Identical signed bytes only: uncertain HTTP responses cannot produce duplicate buys.
      return this.rpc.sendRawTransaction(Buffer.from(pending.serialized, 'base64'), { skipPreflight: true, maxRetries: 0 });
    }
  }
  async closeTransaction(item) {
    const expected = this.ata(item.mint, item.tokenProgram);
    if (item.mint === WSOL || expected.toBase58() !== item.ata || !item.createdByBot) throw new Error('Unmanaged account');
    const info = await this.rpc.getAccountInfo(expected, 'finalized');
    if (!info) return null;
    executionAccount(info, 'cleanup', 'account', expected, new PublicKey(item.tokenProgram),
      d => this.store?.log('execution_token_extensions', { ...d, side: 'close', mint: item.mint }));
    const account = unpackAccount(expected, info, new PublicKey(item.tokenProgram));
    if (!account.owner.equals(this.wallet.publicKey) || !account.mint.equals(new PublicKey(item.mint))) throw new Error('Account owner/mint mismatch');
    if (account.amount !== 0n || (account.closeAuthority && !account.closeAuthority.equals(this.wallet.publicKey))) throw new Error('Account not empty or close authority differs');
    // A nonzero balance arriving after this check causes CloseAccount to fail atomically on-chain.
    return { ...(await this.sign([createCloseAccountInstruction(expected, this.wallet.publicKey, this.wallet.publicKey, [], new PublicKey(item.tokenProgram))], false)), ata: expected.toBase58(), senderTipSol: 0 };
  }
  async receipt(signature, commitment = 'confirmed') {
    this.rpcCalls++;
    const response = await fetch(this.c.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'base64', commitment, maxSupportedTransactionVersion: 0 }] }),
      signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error('Transaction receipt unavailable');
    return body.result;
  }
  stop() { clearInterval(this.timer); clearInterval(this.pingTimer); }
}
module.exports = Executor;
module.exports.buyQuoteLamports = buyQuoteLamports;
