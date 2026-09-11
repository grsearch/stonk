'use strict';
const { VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const layout = require('./pump-layout.json');
const { migrations } = require('./migration');
const { PUMP, WSOL } = require('./config');
const CPI_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

function normalize(result, { allowFailed = false } = {}) {
  const envelope = result.transaction;
  if (!envelope?.meta || (envelope.meta.err && !allowFailed)) return null;
  const tx = envelope.transaction;
  let keys, instructions;
  if (Array.isArray(tx)) {
    const message = VersionedTransaction.deserialize(Buffer.from(tx[0], tx[1])).message;
    keys = [...(message.staticAccountKeys || message.accountKeys).map(k => k.toBase58()),
      ...(envelope.meta.loadedAddresses?.writable || []), ...(envelope.meta.loadedAddresses?.readonly || [])];
    instructions = message.compiledInstructions || message.instructions;
  } else {
    keys = tx.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
    // jsonParsed already contains lookup-table accounts.
    if (typeof tx.message.accountKeys[0] === 'string') keys.push(...(envelope.meta.loadedAddresses?.writable || []), ...(envelope.meta.loadedAddresses?.readonly || []));
    instructions = tx.message.instructions;
  }
  const all = [...instructions, ...(envelope.meta.innerInstructions || []).flatMap(x => x.instructions)];
  return { ...result, meta: envelope.meta, keys, instructions: all.map(ix => ({
    program: ix.programId || keys[ix.programIdIndex],
    accounts: Array.from(ix.accountKeyIndexes || ix.accounts || []).map(a => typeof a === 'number' ? keys[a] : a),
    data: typeof ix.data === 'string' ? Buffer.from(bs58.decode(ix.data)) : Buffer.from(ix.data || []),
  })) };
}

function decodeEvent(data, schema = layout) {
  const event = schema.events.find(e => data.subarray(0, 8).equals(Buffer.from(e.discriminator)));
  if (!event) return null;
  const fields = schema.types.find(t => t.name === event.name).type.fields;
  let offset = 8;
  const out = { name: event.name };
  for (const { name, type } of fields) {
    // Older deployed event schemas omit trailing extension fields.
    if (offset === data.length) break;
    const len = { u8: 1, bool: 1, u16: 2, u64: 8, i64: 8, i128: 16, pubkey: 32 }[type];
    if (type === 'string') {
      if (offset + 4 > data.length) return null;
      const size = data.readUInt32LE(offset); offset += 4;
      if (offset + size > data.length) return null;
      out[name] = data.subarray(offset, offset + size).toString(); offset += size;
    } else {
      if (!len || offset + len > data.length) return null;
      const b = data.subarray(offset, offset + len);
      out[name] = type === 'pubkey' ? bs58.encode(b) : type === 'i128'
        ? BigInt.asIntN(128, b.readBigUInt64LE() | (b.readBigUInt64LE(8) << 64n))
        : type === 'i64' ? b.readBigInt64LE() : type === 'u64' ? b.readBigUInt64LE() : BigInt(b.readUIntLE(0, len));
      offset += len;
    }
  }
  if (out.name === 'CreatePoolEvent') return out.pool && out.base_mint && out.quote_mint && out.timestamp !== undefined ? out : null;
  if (out.name === 'CompletePumpAmmMigrationEvent') return out.pool && out.mint && out.timestamp !== undefined ? out : null;
  return out.pool && out.user && (out.user_quote_amount_out !== undefined || out.user_quote_amount_in !== undefined) ? out : null;
}

function parseSwaps(result, onPoolCreated, onMigrationDiagnostic, onTraffic) {
  const tx = normalize(result);
  if (!tx) return [];
  if (onPoolCreated) migrations(tx, decodeEvent, onPoolCreated, onMigrationDiagnostic);
  const events = tx.instructions.filter(i => i.program === PUMP && i.data.subarray(0, 8).equals(CPI_TAG))
    .map(i => decodeEvent(i.data.subarray(8))).filter(Boolean);
  for (const e of events) if (e.name === 'CreatePoolEvent' && e.quote_mint === WSOL && e.base_mint !== WSOL) {
    onPoolCreated?.({ pool: e.pool, mint: e.base_mint, createdAt: Number(e.timestamp) * 1000,
      observedAt: result.receivedAt || Date.now(), signature: result.signature, slot: result.slot,
      source: 'pumpswap_create_pool_processed' });
  }
  // Use authenticated PumpSwap CPI events, never arbitrary "Program data" logs.
  const swaps = tx.instructions.filter(i => i.program === PUMP).map(ix => {
    const spec = layout.instructions.find(s => ix.data.subarray(0, 8).equals(Buffer.from(s.discriminator)));
    return spec ? { ix, side: spec.name === 'sell' ? 'sell' : 'buy' } : null;
  }).filter(Boolean);
  const resultSwaps = [];
  const rejected = new Set();
  const reject = reason => { rejected.add(reason); };
  for (const { ix, side } of swaps) {
    const [pool, user, , mint, quote, , , baseVault, quoteVault] = ix.accounts;
    if (quote !== WSOL || mint === WSOL) { reject('unsupported_pair'); continue; }
    if (!pool || !baseVault || !quoteVault) { reject('missing_instruction_accounts'); continue; }
    if (tx.instructions.some(other => other.program === PUMP && other.accounts[0] === pool && other !== ix
      && !other.data.subarray(0, 8).equals(CPI_TAG))) { reject('multiple_pool_instructions'); continue; }
    // Transaction-level balances cannot attribute a single dump in multi-hop repeats.
    if (swaps.filter(s => s.ix.accounts[0] === pool).length !== 1) { reject('repeated_pool_swaps'); continue; }
    const matches = events.filter(e => e.pool === pool && e.user === user && e.name === (side === 'sell' ? 'SellEvent' : 'BuyEvent'));
    if (matches.length !== 1) { reject(matches.length ? 'ambiguous_swap_event' : 'missing_authenticated_swap_event'); continue; }
    const event = matches[0];
    const balance = (list, vault, expectedMint) => list?.find(x => tx.keys[x.accountIndex] === vault && x.mint === expectedMint)?.uiTokenAmount;
    const b0 = balance(tx.meta.preTokenBalances, baseVault, mint), b1 = balance(tx.meta.postTokenBalances, baseVault, mint);
    const q0 = balance(tx.meta.preTokenBalances, quoteVault, WSOL), q1 = balance(tx.meta.postTokenBalances, quoteVault, WSOL);
    if (![b0, b1, q0, q1].every(x => x?.amount !== undefined)) { reject('missing_vault_balances'); continue; }
    const preBase = BigInt(b0.amount), postBase = BigInt(b1.amount), preQuote = BigInt(q0.amount), postQuote = BigInt(q1.amount);
    const virtual = event.virtual_quote_reserves || 0n;
    if (preBase <= 0n || postBase <= 0n || preQuote + virtual <= 0n || postQuote + virtual <= 0n) { reject('nonpositive_reserves'); continue; }
    if (side === 'sell' && !(postBase > preBase && postQuote < preQuote)) { reject('balance_direction_mismatch'); continue; }
    if (side === 'buy' && !(postBase < preBase && postQuote > preQuote)) { reject('balance_direction_mismatch'); continue; }
    // Prices are SOL per raw token unit; amounts stay BigInt until ratios/telemetry.
    const priceBefore = Number(preQuote + virtual) / Number(preBase) / 1e9;
    const price = Number(postQuote + virtual) / Number(postBase) / 1e9;
    resultSwaps.push({ pool, mint, user, baseVault, quoteVault, tokenProgram: ix.accounts[11], decimals: b1.decimals,
      side, signature: result.signature, slot: result.slot, receivedAt: result.receivedAt || Date.now(),
      eventTime: Number(event.timestamp) * 1000, price, impact: (1 - price / priceBefore) * 100,
      sellSol: side === 'sell' ? Number(event.user_quote_amount_out) / 1e9 : 0,
      quoteSol: Number(side === 'sell' ? event.user_quote_amount_out : event.user_quote_amount_in) / 1e9,
      liquidity: Number(postQuote) / 1e9, virtual: virtual.toString(),
      postBase: postBase.toString(), postQuote: postQuote.toString(),
    });
  }
  onTraffic?.({ category: resultSwaps.length
    ? (new Set(resultSwaps.map(s => s.side)).size > 1 ? 'parsed_mixed' : `parsed_${resultSwaps[0].side}`)
    : swaps.length ? 'unparsed_swap' : 'other_transaction',
    reasons: resultSwaps.length ? ['parsed_swap'] : swaps.length ? [...rejected]
      : [tx.instructions.some(i => i.program === PUMP && !i.data.subarray(0, 8).equals(CPI_TAG))
        ? 'unsupported_amm_instruction' : tx.instructions.some(i => i.program === PUMP) ? 'amm_event_only' : 'no_amm_instruction'],
    pools: swaps.map(s => s.ix.accounts[0]).filter(Boolean) });
  return resultSwaps;
}
module.exports = { normalize, decodeEvent, parseSwaps, CPI_TAG };
