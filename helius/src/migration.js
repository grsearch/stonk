'use strict';
const schema = require('./migration-layout.json');
const { PUMP, WSOL } = require('./config');
const TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
// Pump uses Pubkey::default() for native SOL quote state/events. The AMM
// instruction must still explicitly reference WSOL (see COIN_CREATION.md).
const NATIVE_SOL_QUOTE = '11111111111111111111111111111111';

// Attribute data to runtime invocation frames, never arbitrary Program log strings.
function programData(logs, program) {
  const stack = [], committed = [];
  for (const line of logs || []) {
    let m = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (m) {
      if (+m[2] !== stack.length + 1) { stack.length = 0; if (+m[2] !== 1) continue; }
      stack.push({ program: m[1], events: [] }); continue;
    }
    m = /^Program (\w+) (success|failed:.*)$/.exec(line);
    if (m) {
      const frame = stack.pop();
      if (!frame || frame.program !== m[1]) { stack.length = 0; continue; }
      if (m[2] === 'success') (stack.at(-1)?.events || committed).push(...frame.events);
      continue;
    }
    m = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (m && stack.at(-1)?.program === program && m[1].length <= 8192) stack.at(-1).events.push(Buffer.from(m[1], 'base64'));
  }
  return committed;
}
function migrations(tx, decode, emit, diagnostic = () => {}) {
  const own = tx.instructions.filter(i => i.program === schema.address);
  if (!own.length) return;
  const specs = own.flatMap(ix => schema.instructions.filter(s => ix.data.subarray(0, 8).equals(Buffer.from(s.discriminator))).map(spec => ({ ix, spec })));
  diagnostic({ stage: 'pump_transactions', count: 1 });
  if (!specs.length) return;
  diagnostic({ stage: 'migration_instructions', count: specs.length });
  const candidates = own.filter(i => i.data.subarray(0, 8).equals(TAG)).map(i => ({ bytes: i.data.subarray(8), transport: 'cpi' }));
  candidates.push(...programData(tx.meta.logMessages, schema.address).map(bytes => ({ bytes, transport: 'runtime_log' })));
  const seen = new Set(); let accepted = 0;
  for (const { bytes, transport } of candidates) {
    if (!schema.events.some(e => bytes.subarray(0, 8).equals(Buffer.from(e.discriminator)))) continue;
    diagnostic({ stage: `completion_events_${transport}`, count: 1 });
    const e = decode(bytes, schema);
    if (!e) { diagnostic({ stage: 'completion_decode_failed', count: 1, signature: tx.signature }); continue; }
    const comparisons = specs.map(({ ix, spec }) => {
      const account = name => ix.accounts[spec.accounts.findIndex(a => a.name === name)];
      const mint = account(spec.name === 'migrate_v2' ? 'base_mint' : 'mint');
      const quote = account(spec.name === 'migrate_v2' ? 'quote_mint' : 'wsol_mint');
      const checks = { mint: mint === e.mint, pool: account('pool') === e.pool,
        pumpAmm: account('pump_amm') === PUMP, quote: quote === WSOL,
        eventQuote: e.quote_mint === undefined || e.quote_mint === WSOL || e.quote_mint === NATIVE_SOL_QUOTE };
      return { instruction: spec.name, accountCount: ix.accounts.length, mint, pool: account('pool'),
        pumpAmm: account('pump_amm'), quote, checks, matched: Object.values(checks).every(Boolean) };
    });
    if (!comparisons.some(c => c.matched)) {
      diagnostic({ stage: 'completion_account_mismatch', count: 1, signature: tx.signature,
        transport, eventBytes: bytes.length,
        event: { mint: e.mint, pool: e.pool, quote: e.quote_mint ?? null, timestamp: String(e.timestamp) },
        comparisons: comparisons.slice(0, 4) }); continue;
    }
    const key = `${e.pool}:${e.mint}:${e.timestamp}`;
    if (seen.has(key)) continue; seen.add(key); accepted++;
    if (e.quote_mint === NATIVE_SOL_QUOTE) diagnostic({ stage: 'migration_native_sol_quote_matched', count: 1 });
    emit({ pool: e.pool, mint: e.mint, createdAt: Number(e.timestamp) * 1000, migrationAt: Number(e.timestamp) * 1000,
      observedAt: tx.receivedAt || Date.now(), signature: tx.signature, slot: tx.slot,
      source: 'pump_migrate_processed', evidenceTransport: transport,
      eventQuoteMint: e.quote_mint ?? null, instructionQuoteMint: WSOL });
  }
  diagnostic({ stage: accepted ? 'migration_matched' : 'migration_without_matching_completion', count: accepted || 1,
    signature: tx.signature, logsAvailable: Array.isArray(tx.meta.logMessages) });
}
module.exports = { migrations, programData };
