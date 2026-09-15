'use strict';
const { createHash } = require('node:crypto');
const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const PLATFORMS = ['6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt', '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7'];
const WINDOW_MS = 2 * 60 * 60 * 1000;
const tag = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
function decode58(s) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) { const v = alphabet.indexOf(c); if (v < 0) throw Error('Invalid base58'); n = n * 58n + BigInt(v); }
  const bytes = []; while (n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}
function encode58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n, s = ''; for (const b of bytes) n = n * 256n + BigInt(b);
  while (n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; } return s;
}
function normalize(tx) {
  if (!tx?.meta || tx.meta.err || !tx.transaction?.message) return null;
  const message = tx.transaction.message;
  const keys = message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
  if (typeof message.accountKeys[0] === 'string') keys.push(...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || []));
  const instructions = [...message.instructions, ...(tx.meta.innerInstructions || []).flatMap(x => x.instructions)].map(ix => ({
    program: ix.programId || keys[ix.programIdIndex],
    accounts: (ix.accounts || []).map(a => typeof a === 'number' ? keys[a] : a),
    data: typeof ix.data === 'string' ? decode58(ix.data) : Buffer.from(ix.data || []),
  }));
  return { ...tx, keys, instructions };
}
const is = (ix, name) => ix.data.subarray(0, 8).equals(tag(name));
function migrations(tx) {
  // A caught CPI failure can coexist with meta.err=null. Require successful execution logs
  // and newly funded destination vaults, rather than treating an attempted call as graduation.
  if (!tx.meta.logMessages?.includes(`Program ${LAUNCHLAB} success`) ||
      tx.meta.logMessages.some(l => l.startsWith(`Program ${LAUNCHLAB} failed`))) return [];
  return tx.instructions.filter(ix => ix.program === LAUNCHLAB && is(ix, 'migrate_to_cpswap') &&
    PLATFORMS.includes(ix.accounts[3]) && ix.accounts[4] === CPMM && ix.accounts.length >= 13)
    .map(ix => ({ pool: ix.accounts[5], mint: ix.accounts[1], quoteMint: ix.accounts[2], platform: ix.accounts[3],
      baseVault: ix.accounts[8], quoteVault: ix.accounts[9], feeConfig: ix.accounts[10] }))
    .filter(p => p.mint !== p.quoteMint && p.baseVault !== p.quoteVault &&
      [[p.baseVault, p.mint], [p.quoteVault, p.quoteMint]].every(([vault, mint]) => {
        const post = tx.meta.postTokenBalances?.find(b => tx.keys[b.accountIndex] === vault && b.mint === mint);
        const pre = tx.meta.preTokenBalances?.find(b => tx.keys[b.accountIndex] === vault);
        return post && /^\d+$/.test(post.uiTokenAmount?.amount) && BigInt(post.uiTokenAmount.amount) > 0n &&
          (!pre || pre.uiTokenAmount?.amount === '0');
      }));
}
function active(pool, now) { return Number.isSafeInteger(pool.graduatedAt) && now >= pool.graduatedAt && now < pool.graduatedAt + WINDOW_MS; }
function swaps(tx, pools, now) {
  const out = [];
  for (const [pool, p] of pools) {
    if (!active(p, now) || !Number.isSafeInteger(tx.blockTime) || tx.blockTime * 1000 < p.graduatedAt || tx.blockTime * 1000 >= p.graduatedAt + WINDOW_MS) continue;
    const calls = tx.instructions.filter(ix => ix.program === CPMM && ix.accounts.includes(pool));
    // Vault deltas are transaction-wide: reject repeated swaps and mixed LP operations.
    if (calls.length !== 1) continue;
    const ix = calls[0];
    if (ix.accounts[3] !== pool || !(is(ix, 'swap_base_input') || is(ix, 'swap_base_output'))) continue;
    const sell = ix.accounts[10] === p.mint && ix.accounts[11] === p.quoteMint;
    const buy = ix.accounts[10] === p.quoteMint && ix.accounts[11] === p.mint;
    if (!(sell || buy) || ix.accounts[6] !== (sell ? p.baseVault : p.quoteVault) || ix.accounts[7] !== (sell ? p.quoteVault : p.baseVault)) continue;
    const balance = (list, vault, mint) => list?.find(b => tx.keys[b.accountIndex] === vault && b.mint === mint)?.uiTokenAmount;
    const values = [balance(tx.meta.preTokenBalances, p.baseVault, p.mint), balance(tx.meta.postTokenBalances, p.baseVault, p.mint),
      balance(tx.meta.preTokenBalances, p.quoteVault, p.quoteMint), balance(tx.meta.postTokenBalances, p.quoteVault, p.quoteMint)];
    if (!values.every(v => v && /^\d+$/.test(v.amount) && Number.isInteger(v.decimals))) continue;
    const [b0, b1, q0, q1] = values.map(v => BigInt(v.amount));
    if ([b0, b1, q0, q1].some(v => v <= 0n) || (sell ? !(b1 > b0 && q1 < q0) : !(b1 < b0 && q1 > q0))) continue;
    const scale = 10 ** (values[1].decimals - values[3].decimals);
    const before = Number(q0) / Number(b0) * scale, after = Number(q1) / Number(b1) * scale;
    out.push({ pool, mint: p.mint, quoteMint: p.quoteMint, user: ix.accounts[0], slot: tx.slot,
      postBase: b1.toString(), postQuoteRaw: q1.toString(), preBase: b0.toString(), preQuoteRaw: q0.toString(),
      tokenProgram: ix.accounts[sell ? 8 : 9], quoteTokenProgram: ix.accounts[sell ? 9 : 8],
      baseVault: p.baseVault, quoteVault: p.quoteVault, graduatedAt: p.graduatedAt, side: sell ? 'sell' : 'buy',
      ageMs: tx.blockTime * 1000 - p.graduatedAt, blockTime: tx.blockTime,
      baseVaultDeltaRaw: (b1 - b0).toString(), quoteVaultDeltaRaw: (q1 - q0).toString(),
      baseDecimals: values[1].decimals, quoteDecimals: values[3].decimals,
      quoteVaultBalanceRaw: q1.toString(), vaultRatioBefore: before, vaultRatioAfter: after,
      vaultRatioChangePct: (after / before - 1) * 100,
      // Includes accrued pool fees. These are observations, not executable prices or trader net receipts.
      valuation: 'vault_balance_ratio', executableQuote: false });
  }
  return out;
}
module.exports = { LAUNCHLAB, CPMM, PLATFORMS, WINDOW_MS, tag, normalize, migrations, active, swaps, decode58, encode58 };
