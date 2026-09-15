'use strict';
const { createHash } = require('node:crypto');
const { CPMM, decode58, encode58 } = require('./protocol');
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const discriminator = name => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
function bytes(a) { if (!a?.data || a.data[1] !== 'base64') throw Error('Missing base64 account'); return Buffer.from(a.data[0], 'base64'); }
function key(b, offset) { if (b.length < offset + 32) throw Error('Truncated pubkey'); return encode58(b.subarray(offset, offset + 32)); }
function publicKey(s) { if (typeof s !== 'string' || decode58(s).length !== 32) throw Error('Invalid public key'); }
function mint(a, { quoteAsset = false } = {}) {
  const b = bytes(a); if (![TOKEN, TOKEN2022].includes(a.owner) || b.length < 82 || b[45] !== 1) throw Error('Invalid mint');
  const fees = [];
  const controls = [];
  if (a.owner === TOKEN2022 && b.length > 82) {
    if (b.length < 166 || b[165] !== 1) throw Error('Invalid extended mint');
    for (let i = 166; i + 4 <= b.length;) {
      const type = b.readUInt16LE(i), length = b.readUInt16LE(i + 2); i += 4;
      if (i + length > b.length) throw Error('Invalid mint extension');
      if (type === 1) {
        if (length !== 108) throw Error('Invalid transfer fee');
        for (const offset of [72, 90]) fees.push({ epoch: b.readBigUInt64LE(i + offset).toString(), maximumFee: b.readBigUInt64LE(i + offset + 8).toString(), bps: b.readUInt16LE(i + offset + 16) });
      } else if (quoteAsset && [4, 6, 12, 14, 16, 25, 26].includes(type)) {
        const lengths = { 4: 65, 6: 1, 12: 32, 14: 64, 16: 129, 25: 56, 26: 33 };
        if (length !== lengths[type]) throw Error('Invalid quote mint extension');
        // Existing pool vaults are checked separately. Issuer controls are disclosed, not executed.
        if (type === 14 && b.subarray(i + 32, i + 64).some(v => v !== 0)) throw Error('Active quote transfer hook unsupported');
        if (type === 26 && b[i + 32] !== 0) throw Error('Quote mint paused');
        if (type === 6 && ![1, 2].includes(b[i])) throw Error('Invalid default account state');
        if (type === 25 && ![b.readDoubleLE(i + 32), b.readDoubleLE(i + 48)].every(n => Number.isFinite(n) && n > 0)) throw Error('Invalid UI multiplier');
        controls.push(type);
      } else if (![0, 3, 18, 19, 20, 21, 22, 23].includes(type)) throw Error('Unsupported mint extension');
      i += length;
    }
  }
  if (fees.some(f => f.bps > 10000)) throw Error('Invalid transfer fee bps');
  return { decimals: b[44], program: a.owner, fees, ...(quoteAsset ? { controls, accounting: 'raw_units_not_scaled_ui', executable: false } : {}) };
}
function vault(a, expectedMint, expectedAuthority) {
  const b = bytes(a);
  if (![TOKEN, TOKEN2022].includes(a.owner) || b.length < 165 || key(b, 0) !== expectedMint || b[108] !== 1 ||
      (expectedAuthority && key(b, 32) !== expectedAuthority)) throw Error('Invalid vault');
  return b.readBigUInt64LE(64);
}
function cpmm(a) {
  const b = bytes(a); if (a.owner !== CPMM || b.length < 637 || !b.subarray(0, 8).equals(discriminator('PoolState')) || (b[329] & 4)) throw Error('Invalid CPMM pool');
  return { feeConfig: key(b, 8), vault0: key(b, 72), vault1: key(b, 104), mint0: key(b, 168), mint1: key(b, 200),
    program0: key(b, 232), program1: key(b, 264), decimals0: b[331], decimals1: b[332],
    fees0: b.readBigUInt64LE(341) + b.readBigUInt64LE(357) + b.readBigUInt64LE(397),
    fees1: b.readBigUInt64LE(349) + b.readBigUInt64LE(365) + b.readBigUInt64LE(405) };
}
function clmm(a) {
  const b = bytes(a); if (a.owner !== CLMM || b.length < 1080 || !b.subarray(0, 8).equals(discriminator('PoolState')) || (b[389] & 16)) throw Error('Invalid CLMM pool');
  const u128 = offset => b.readBigUInt64LE(offset) + (b.readBigUInt64LE(offset + 8) << 64n);
  const l = Number(u128(237)), sqrt = Number(u128(253)) / 2 ** 64;
  if (!(l > 0 && sqrt > 0)) throw Error('Empty CLMM pool');
  return { mint0: key(b, 73), mint1: key(b, 105), vault0: key(b, 137), vault1: key(b, 169),
    fees0: b.readBigUInt64LE(309) + b.readBigUInt64LE(1064), fees1: b.readBigUInt64LE(317) + b.readBigUInt64LE(1072), decimals0: b[233], decimals1: b[234],
    price: sqrt ** 2 * 10 ** (b[233] - b[234]), depth0: l / sqrt / 10 ** b[233], depth1: l * sqrt / 10 ** b[234] };
}
module.exports = { TOKEN, TOKEN2022, WSOL, USDC, CLMM, bytes, key, publicKey, mint, vault, cpmm, clmm, discriminator };
