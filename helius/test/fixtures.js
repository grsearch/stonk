'use strict';
const bs58 = require('bs58').default;
const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const layout = require('../src/pump-layout.json');
const { PUMP, WSOL } = require('../src/config');
const { CPI_TAG } = require('../src/parser');
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58();

function eventBytes(name, overrides = {}) {
  const spec = layout.events.find(x => x.name === name);
  const fields = layout.types.find(x => x.name === name).type.fields;
  const buffers = [Buffer.from(spec.discriminator)];
  for (const field of fields) {
    const value = overrides[field.name] ?? (field.type === 'pubkey' ? key(9) : field.type === 'string' ? 'buy' : 0);
    if (field.type === 'pubkey') buffers.push(Buffer.from(bs58.decode(value)));
    else if (field.type === 'string') {
      const b = Buffer.from(value), len = Buffer.alloc(4); len.writeUInt32LE(b.length); buffers.push(len, b);
    } else {
      const len = { bool: 1, u8: 1, u16: 2, u64: 8, i64: 8, i128: 16 }[field.type];
      const b = Buffer.alloc(len);
      if (len === 16) { const n = BigInt.asUintN(128, BigInt(value)); b.writeBigUInt64LE(n & ((1n << 64n) - 1n)); b.writeBigUInt64LE(n >> 64n, 8); }
      else if (field.type === 'i64') b.writeBigInt64LE(BigInt(value));
      else if (len === 8) b.writeBigUInt64LE(BigInt(value));
      else b.writeUIntLE(Number(value), 0, len);
      buffers.push(b);
    }
  }
  return Buffer.concat(buffers);
}

function fixture({ side = 'sell', virtual = 0n, encoding = 'parsed', failed = false, duplicate = false, alt = false } = {}) {
  const accounts = [key(1), key(2), key(3), key(4), WSOL, key(5), key(6), key(7), key(8), key(9), key(10), TOKEN_PROGRAM_ID.toBase58()];
  const [pool, user, , mint, , ata, , baseVault, quoteVault] = accounts;
  const keys = [...new Set([user, ...accounts, PUMP])];
  const sell = side === 'sell';
  const spec = layout.instructions.find(x => x.name === side);
  const ix = { programId: PUMP, accounts, data: bs58.encode(Buffer.concat([Buffer.from(spec.discriminator), Buffer.alloc(16)])) };
  const evt = { programId: PUMP, accounts: [], data: bs58.encode(Buffer.concat([CPI_TAG, eventBytes(sell ? 'SellEvent' : 'BuyEvent', {
    pool, user, timestamp: Math.floor(Date.now() / 1000), user_quote_amount_out: 20000000000n, user_quote_amount_in: 20000000000n,
    virtual_quote_reserves: virtual,
  })])) };
  let actualKeys = keys;
  let transaction = { message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions: [ix] } };
  let loadedAddresses = { writable: [], readonly: [] };
  let inner = [evt];
  if (encoding === 'base64') {
    const top = new TransactionInstruction({ programId: new PublicKey(PUMP), keys: accounts.map(pubkey => ({ pubkey: new PublicKey(pubkey), isSigner: pubkey === user, isWritable: true })), data: Buffer.from(bs58.decode(ix.data)) });
    const message = new TransactionMessage({ payerKey: new PublicKey(user), recentBlockhash: key(20), instructions: [top] });
    const table = new AddressLookupTableAccount({ key: new PublicKey(key(21)), state: {
      deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined,
      addresses: accounts.filter(k => k !== user).map(k => new PublicKey(k)),
    } });
    const compiled = alt ? message.compileToV0Message([table]) : message.compileToLegacyMessage();
    if (alt) {
      loadedAddresses = { writable: compiled.addressTableLookups.flatMap(l => Array.from(l.writableIndexes).map(i => table.state.addresses[i].toBase58())), readonly: [] };
    }
    actualKeys = [...(compiled.staticAccountKeys || compiled.accountKeys).map(k => k.toBase58()), ...loadedAddresses.writable];
    transaction = [Buffer.from(new VersionedTransaction(compiled).serialize()).toString('base64'), 'base64'];
    inner = [{ programIdIndex: actualKeys.indexOf(PUMP), accounts: [], data: evt.data }];
  }
  const bal = (vault, m, amount, decimals = 6) => ({ accountIndex: actualKeys.indexOf(vault), mint: m, uiTokenAmount: { amount: String(amount), decimals } });
  const meta = { err: failed ? { InstructionError: [0, 'error'] } : null, fee: 5000, loadedAddresses,
    preTokenBalances: [bal(baseVault, mint, sell ? 1000000000n : 1250000000n), bal(quoteVault, WSOL, sell ? 100000000000n : 80000000000n, 9), bal(ata, mint, sell ? 250000000n : 0n)],
    postTokenBalances: [bal(baseVault, mint, sell ? 1250000000n : 1000000000n), bal(quoteVault, WSOL, sell ? 80000000000n : 100000000000n, 9), bal(ata, mint, sell ? 0n : 250000000n)],
    innerInstructions: [{ index: 0, instructions: duplicate ? [...inner, evt] : inner }],
  };
  return { signature: key(30), slot: 100, receivedAt: Date.now(), transaction: { transaction, meta }, pool, mint, ata, user };
}
module.exports = { fixture, eventBytes, key };
