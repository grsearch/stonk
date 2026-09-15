'use strict';
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const bs58 = require('bs58').default;
const { CPMM } = require('./protocol');
const { CLMM, WSOL, TOKEN, TOKEN2022, cpmm, clmm, mint } = require('./accounts');
const ROUTER = 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ALLOWED = new Set([ROUTER, CPMM, CLMM, TOKEN, TOKEN2022, ATA, SYSTEM, MEMO, ComputeBudgetProgram.programId.toBase58()]);
const account = a => a && ({ ...a, owner: a.owner.toBase58(), data: [a.data.toString('base64'), 'base64'] });
function quoteValid(q, { input, output, amount, pool, side, slippage }) {
  const d = q?.data;
  if (!q?.success || d?.swapType !== 'BaseIn' || d.inputMint !== input || d.outputMint !== output ||
      d.inputAmount !== String(amount) || d.slippageBps !== slippage || !/^\d+$/.test(d.outputAmount) ||
      !/^\d+$/.test(d.otherAmountThreshold) || BigInt(d.otherAmountThreshold) <= 0n ||
      BigInt(d.otherAmountThreshold) > BigInt(d.outputAmount) ||
      BigInt(d.otherAmountThreshold) < BigInt(d.outputAmount) * BigInt(10000 - slippage) / 10000n ||
      BigInt(d.referrerAmount || '0') !== 0n || !Array.isArray(d.routePlan) || !d.routePlan.length || d.routePlan.length > 3) throw Error('Invalid Raydium quote');
  let next = input;
  const visited = new Set();
  for (const hop of d.routePlan) {
    if (hop.inputMint !== next || visited.has(hop.poolId)) throw Error('Invalid Raydium route');
    visited.add(hop.poolId); next = hop.outputMint;
  }
  if (next !== output || d.routePlan[side === 'buy' ? d.routePlan.length - 1 : 0].poolId !== pool) throw Error('Route misses verified Stonk pool');
  return d;
}
class LiveExecutor {
  constructor(c) {
    this.c = c; this.stonkLive = true; this.rpcCalls = 0;
    this.wallet = Keypair.fromSecretKey(bs58.decode(c.privateKey));
    this.rpc = new Connection(c.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: async (u, o) => { this.rpcCalls++; return fetch(u, { ...o, signal: AbortSignal.timeout(10000) }); } });
  }
  async api(path, body) {
    const r = await fetch('https://transaction-v1.raydium.io' + path, { method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) throw Error('Raydium API unavailable');
    return r.json();
  }
  async quote(side, s, rawAmount) {
    const input = side === 'buy' ? WSOL : s.mint, output = side === 'buy' ? s.mint : WSOL;
    const amount = side === 'buy' ? String(Math.round(this.c.sizeSol * 1e9)) : String(rawAmount);
    const slippage = side === 'buy' ? this.c.buySlippageBps : this.c.sellSlippageBps;
    const q = await this.api('/compute/swap-base-in?' + new URLSearchParams({ inputMint: input, outputMint: output, amount, slippageBps: slippage, txVersion: 'V0' }));
    quoteValid(q, { input, output, amount, pool: s.pool, side, slippage });
    await this.verifyPools(q.data.routePlan, s);
    return q;
  }
  async verifyPools(route, s) {
    const rows = await this.rpc.getMultipleAccountsInfo(route.map(p => new PublicKey(p.poolId)), 'confirmed');
    for (let i = 0; i < rows.length; i++) {
      const a = account(rows[i]), hop = route[i];
      if (!a || ![CPMM, CLMM].includes(a.owner)) throw Error('Non-Raydium pool rejected');
      const p = a.owner === CPMM ? cpmm(a) : clmm(a);
      if (![p.mint0, p.mint1].includes(hop.inputMint) || ![p.mint0, p.mint1].includes(hop.outputMint) || hop.inputMint === hop.outputMint) throw Error('Route mint mismatch');
      if (hop.poolId === s.pool && (a.owner !== CPMM || ![p.mint0, p.mint1].includes(s.mint) || ![p.mint0, p.mint1].includes(s.quoteMint))) throw Error('Stonk pool mismatch');
    }
  }
  async buildUnsigned(side, s, rawAmount, quote) {
    const q = quote || await this.quote(side, s, rawAmount), d = q.data;
    const ma = await this.rpc.getAccountInfo(new PublicKey(s.mint), 'confirmed');
    const m = mint(account(ma)); // Retain strict base-token extension checks.
    const ata = getAssociatedTokenAddressSync(new PublicKey(s.mint), this.wallet.publicKey, false, new PublicKey(m.program));
    const b = await this.api('/transaction/swap-base-in', { swapResponse: q, txVersion: 'V0', wallet: this.wallet.publicKey.toBase58(),
      computeUnitPriceMicroLamports: '100000', wrapSol: side === 'buy', unwrapSol: side === 'sell',
      ...(side === 'buy' ? { outputAccount: ata.toBase58() } : { inputAccount: ata.toBase58() }) });
    if (!b.success || b.data?.length !== 1) throw Error('Only atomic single-transaction Raydium routes supported');
    const tx = VersionedTransaction.deserialize(Buffer.from(b.data[0].transaction, 'base64'));
    if (tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0].equals(this.wallet.publicKey)) throw Error('Unexpected transaction signer');
    const alts = await Promise.all(tx.message.addressTableLookups.map(async l => {
      const a = (await this.rpc.getAddressLookupTable(l.accountKey)).value; if (!a) throw Error('Missing lookup table'); return a;
    }));
    const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts });
    const keys = [...new Set(message.instructions.flatMap(i => [i.programId.toBase58(), ...i.keys.map(k => k.pubkey.toBase58())]))];
    for (let start = 0; start < keys.length; start += 100) {
      const batch = keys.slice(start, start + 100), rows = await this.rpc.getMultipleAccountsInfo(batch.map(k => new PublicKey(k)));
      rows.forEach((a, i) => {
        if (a?.executable && !ALLOWED.has(batch[i])) throw Error('Non-Raydium executable rejected');
        if (a && [TOKEN,TOKEN2022].includes(a.owner.toBase58()) && a.data.length >= 165 && a.data.subarray(32,64).equals(this.wallet.publicKey.toBuffer())) {
          const tokenMint = new PublicKey(a.data.subarray(0,32)).toBase58();
          const permitted = new Set(d.routePlan.flatMap(p=>[p.inputMint,p.outputMint]));
          if (!permitted.has(tokenMint)) throw Error('Unexpected wallet asset in route');
          if (tokenMint === WSOL && a.data.readBigUInt64LE(64) !== 0n) throw Error('Existing WSOL balance requires separate handling');
        }
      });
    }
    this.validateInstructions(message.instructions, d, side, ata.toBase58());
    // Replace API-provided compute fees with the user's bounded local fee budget.
    message.instructions = message.instructions.filter(i => !i.programId.equals(ComputeBudgetProgram.programId));
    message.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(this.c.priorityLamports * 1e6 / 1400000) }));
    const recent = await this.rpc.getLatestBlockhash('confirmed'); message.recentBlockhash = recent.blockhash;
    return { tx: new VersionedTransaction(message.compileToV0Message(alts)), quote: q, ata: ata.toBase58(), alts,
      lastValidBlockHeight: recent.lastValidBlockHeight, tokenProgram: m.program };
  }
  validateInstructions(ixs, d, side, targetAta) {
    const owner = this.wallet.publicKey.toBase58();
    const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL), this.wallet.publicKey).toBase58();
    let swaps = 0, wraps = 0, closes = 0;
    for (const ix of ixs) {
      const program = ix.programId.toBase58(), keys = ix.keys.map(k => k.pubkey.toBase58()), b = ix.data;
      if (program === ComputeBudgetProgram.programId.toBase58()) continue;
      if (program !== ROUTER || ix.keys.some(k => k.isSigner && k.pubkey.toBase58() !== owner)) throw Error('Unexpected instruction');
      if (b[0] === 0 && b.length === 17) {
        swaps++;
        if (b.readBigUInt64LE(1) !== BigInt(d.inputAmount) || b.readBigUInt64LE(9) !== BigInt(d.otherAmountThreshold) ||
            keys[4] !== owner || keys[5] !== (side === 'buy' ? wsolAta : targetAta) || keys[6] !== (side === 'buy' ? targetAta : wsolAta) ||
            d.routePlan.some(p => !keys.includes(p.poolId))) throw Error('Swap instruction does not match quote');
      } else if (b[0] === 5 && b.length === 9 && side === 'buy') {
        wraps++; if (b.readBigUInt64LE(1) !== BigInt(d.inputAmount) || keys[0] !== owner || keys[1] !== wsolAta || keys[2] !== WSOL) throw Error('Unexpected wrap');
      } else if (b[0] === 6 && b.length === 1) {
        closes++; if (keys[0] !== owner || keys[1] !== wsolAta || keys[2] !== owner) throw Error('Unexpected close');
      } else throw Error('Unsupported router instruction');
    }
    if (swaps !== 1 || wraps !== (side === 'buy' ? 1 : 0) || closes !== 1) throw Error('Incomplete atomic route');
  }
  async buildSwap(side, s, rawAmount) {
    const started = Date.now();
    const b = await this.buildUnsigned(side, s, rawAmount);
    // Ensure a reverse route exists before spending SOL; future liquidity cannot be guaranteed.
    if (side === 'buy') await this.quote('sell', s, b.quote.data.otherAmountThreshold);
    const simulation = await this.rpc.simulateTransaction(b.tx, { sigVerify: false, commitment: 'confirmed' });
    if (simulation.value.err) throw Error('Raydium transaction simulation failed');
    const balance = await this.rpc.getBalance(this.wallet.publicKey, 'confirmed');
    if (balance < (side === 'buy' ? Math.round(this.c.sizeSol * 1e9) : 0) + this.c.priorityLamports + 10000000) throw Error('Insufficient SOL including exit reserve');
    b.tx.sign([this.wallet]);
    return { signature: bs58.encode(b.tx.signatures[0]), wire: Buffer.from(b.tx.serialize()).toString('base64'), ata: b.ata,
      tokenProgram: b.tokenProgram, lastValidBlockHeight: b.lastValidBlockHeight, inputAmount: b.quote.data.inputAmount,
      minOutputAmount: b.quote.data.otherAmountThreshold, routePools: b.quote.data.routePlan.map(p => p.poolId),
      quoteStatePrice: s.price, quoteStateSlot: s.slot, stateMs: Date.now() - started, buildSignMs: 0, createdByBot: false };
  }
  async submit(p) {
    const signature = await this.rpc.sendRawTransaction(Buffer.from(p.wire, 'base64'), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
    if (signature !== p.signature) throw Error('Submission signature mismatch');
  }
  receipt(signature, commitment = 'confirmed') { return this.rpc.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 }); }
  stop() {}
}
module.exports = { LiveExecutor, quoteValid, ROUTER, ALLOWED };
