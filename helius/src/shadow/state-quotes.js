'use strict';
const { PUMP, WSOL } = require('../config');
const fail = (reason, diagnostics) => { const e = new Error(reason); e.reason = reason; e.diagnostics = diagnostics; throw e; };
function decodeState(s, values, slot) {
  const { PublicKey } = require('@solana/web3.js');
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount } = require('@solana/spl-token');
  const { inspectExtensions } = require('./account-extensions');
  const { PUMP_AMM_SDK } = require('@pump-fun/pump-swap-sdk');
  const infos = values.map(a => a && ({ ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], 'base64') }));
  const [p, m, b, q] = infos;
  if (!p || !m || !b || !q) fail('missing_account');
  if (p.owner.toBase58() !== PUMP || p.data.length < 243) fail('invalid_pool');
  const pool = PUMP_AMM_SDK.decodePool(p), program = new PublicKey(s.tokenProgram);
  if (!pool.baseMint.equals(new PublicKey(s.mint)) || pool.quoteMint.toBase58() !== WSOL
    || pool.poolBaseTokenAccount.toBase58() !== s.baseVault || pool.poolQuoteTokenAccount.toBase58() !== s.quoteVault) fail('pool_identity_mismatch');
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(program)) || !m.owner.equals(program)) fail('invalid_token_program');
  const accountDiagnostics = [inspectExtensions(m, 'baseMint', 'mint', new PublicKey(s.mint), program),
    inspectExtensions(b, 'baseVault', 'account', new PublicKey(s.baseVault), program),
    inspectExtensions(q, 'quoteVault', 'account', new PublicKey(s.quoteVault), TOKEN_PROGRAM_ID)];
  const rejected = accountDiagnostics.find(d => d.status === 'rejected');
  if (rejected) fail(rejected.reason, accountDiagnostics);
  const mint = unpackMint(new PublicKey(s.mint), m, program);
  if (!mint.isInitialized || mint.freezeAuthority) fail('mint_not_supported', accountDiagnostics);
  const base = unpackAccount(new PublicKey(s.baseVault), b, program), quote = unpackAccount(new PublicKey(s.quoteVault), q, TOKEN_PROGRAM_ID);
  if (base.mint.toBase58() !== s.mint || quote.mint.toBase58() !== WSOL || base.owner.toBase58() !== s.pool
    || quote.owner.toBase58() !== s.pool || !base.isInitialized || !quote.isInitialized || base.isFrozen || quote.isFrozen) fail('invalid_vault');
  const virtual = BigInt(pool.virtualQuoteReserves.toString());
  if (base.amount === 0n || quote.amount === 0n || virtual < 0n) fail('empty_or_invalid_reserves');
  const price = Number(quote.amount + virtual) / Number(base.amount) / 1e9;
  if (!(price > 0) || !Number.isFinite(price)) fail('invalid_price');
  return { pool: s.pool, mint: s.mint, slot, price, postBase: base.amount.toString(), postQuote: quote.amount.toString(), virtual: virtual.toString(), accountDiagnostics };
}
// Read-only service. Credentials stay in the main process, never in workerData or records.
class StateQuotes {
  constructor(c, { now = Date.now, request = fetch, decode = decodeState,
    keys = s => [s.pool, s.mint, s.baseVault, s.quoteVault],
    validate = s => { const { PublicKey } = require('@solana/web3.js'); for (const k of [s.pool, s.mint, s.baseVault, s.quoteVault, s.tokenProgram]) new PublicKey(k); } } = {}) {
    this.c = c; this.now = now; this.request = request; this.decode = decode;
    this.keys = keys; this.validate = validate;
    this.history = []; this.pools = new Map(); this.busy = false; this.closed = false;
    this.counts = { requests: 0, queriedPools: 0, quotedPools: 0, failedPools: 0, budgetSkips: 0,
      reservedBudgetSkips: 0, backoffSkips: 0, deadlineOverrides: 0, urgentPools: 0, rpcErrors: {} };
  }
  stats() { return { ...this.counts, rpcErrors: { ...this.counts.rpcErrors }, schedulingVersion: 3, validationVersion: 2, enabled: !!this.c.shadow.stateQuotes, inFlight: this.busy }; }
  close() { this.closed = true; this.controller?.abort(); }
  async poll(targets) {
    if (this.closed || this.busy || !this.c.shadow.stateQuotes) return [];
    const at = this.now(), cfg = this.c.shadow;
    this.history = this.history.filter(t => at - t < 60000);
    const unique = new Map(targets.slice(0, 1000).map(s => [s.pool, s]));
    for (const [p, state] of this.pools) if (!unique.has(p) && at - state.lastAt > 300000) this.pools.delete(p);
    if (this.history.length >= cfg.stateQuoteRequestsPerMinute) { this.counts.budgetSkips++; return []; }
    const candidates = [...unique.values()].map(s => {
      const old = this.pools.get(s.pool);
      const schedules = (s.schedules || []).filter(d => Number.isFinite(d.dueAt) && Number.isFinite(d.expiresAt) && d.expiresAt >= at);
      const due = schedules.filter(d => d.dueAt <= at).sort((a, b) => a.expiresAt - b.expiresAt)[0];
      // One fresh attempt after a newly due exit, even if an earlier quote set a long backoff.
      const override = schedules.some(d => d.dueAt <= at && (old?.requestAt ?? -Infinity) < d.dueAt)
        && (!old || at - old.lastAt >= 1000);
      return { ...s, urgent: !!due, deadline: due?.expiresAt ?? Infinity, override,
        soon: schedules.some(d => d.dueAt > at && d.dueAt - at <= 15000),
        eligible: at >= (old?.nextAt || 0) || override };
    });
    this.counts.backoffSkips += candidates.filter(s => !s.eligible).length;
    const eligible = candidates.filter(s => s.eligible);
    // Reserve one of the existing minute budget slots for an imminent delayed exit.
    if (!eligible.some(s => s.urgent) && candidates.some(s => s.soon)
      && this.history.length >= Math.max(0, cfg.stateQuoteRequestsPerMinute - 1)) {
      this.counts.reservedBudgetSkips++; return [];
    }
    const selected = eligible.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.deadline - b.deadline
      || (this.pools.get(a.pool)?.lastAt || 0) - (this.pools.get(b.pool)?.lastAt || 0)).slice(0, 20);
    if (!selected.length) return [];
    const valid = [], results = [];
    for (const s of selected) {
      try { this.validate(s);
        if (!Number.isSafeInteger(s.slot) || s.slot < 0) throw new Error(); valid.push(s);
      } catch (_) { results.push(this.result(s, at, null, 'invalid_target')); }
    }
    if (!valid.length) return results;
    const requestedMinContextSlot = Math.max(...valid.map(s => s.slot));
    for (const s of valid) s.requestedMinContextSlot = requestedMinContextSlot;
    this.busy = true; this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), 3000);
    this.history.push(at); this.counts.requests++; this.counts.queriedPools += valid.length;
    try {
      const keys = [...new Set(valid.flatMap(s => this.keys(s)))];
      const response = await this.request(this.c.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: this.controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys,
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: requestedMinContextSlot }] }) });
      if (!response.ok) { const e = new Error(); e.reason = response.status === 429 ? 'rate_limited' : 'rpc_http_error';
        e.rpcDiagnostic = { category: e.reason, httpStatus: Number.isInteger(response.status) ? response.status : null }; throw e; }
      const body = await response.json();
      if (body.error) { const e = new Error(); e.reason = 'rpc_error';
        const code = Number.isSafeInteger(body.error.code) ? body.error.code : null;
        e.rpcDiagnostic = { category: code === -32016 ? 'minimum_context_slot' : 'json_rpc_error', code };
        if (code === -32016 && Number.isSafeInteger(body.error.data?.contextSlot) && body.error.data.contextSlot >= 0)
          e.rpcDiagnostic.contextSlot = body.error.data.contextSlot;
        throw e; }
      if (!Array.isArray(body.result?.value) || body.result.value.length !== keys.length) fail('rpc_error');
      const slot = body.result.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < Math.max(...valid.map(s => s.slot))) fail('stale_slot');
      if (this.now() - at > 3000 || this.now() < at) fail('stale_response');
      for (const s of valid) {
        try {
          const quote = await this.decode(s, this.keys(s).map(k => body.result.value[keys.indexOf(k)]), slot);
          // Stonk decoding also awaits FX: account response freshness alone is insufficient.
          if (this.controller.signal.aborted || this.now() - at > 3000 || this.now() < at) fail('stale_response');
          results.push(this.result(s, at, quote));
        }
        catch (e) { results.push(this.result(s, at, null, e.reason || 'account_decode_failed', e.diagnostics)); }
      }
    } catch (e) {
      const diagnostic = e.rpcDiagnostic || { category: this.controller.signal.aborted ? 'timeout_or_abort' : e.reason || 'transport_error' };
      this.counts.rpcErrors[diagnostic.category] = (this.counts.rpcErrors[diagnostic.category] || 0) + 1;
      for (const s of valid) results.push(this.result(s, at, null, e.reason || 'rpc_unavailable', null, diagnostic));
    }
    finally { clearTimeout(timeout); this.busy = false; this.controller = null; }
    return this.closed ? [] : results;
  }
  result(s, requestAt, quote, reason = null, diagnostics = null, rpcDiagnostic = null) {
    const at = this.now(), old = this.pools.get(s.pool), failures = quote ? 0 : (old?.failures || 0) + 1;
    const interval = this.c.shadow.stateQuoteIntervalMs;
    const slotFailures = rpcDiagnostic?.category === 'minimum_context_slot' ? (old?.slotFailures || 0) + 1 : 0;
    // A lagging confirmed node is not an invalid token account. Retry briefly, but only through poll's existing budget.
    const slotRetry = slotFailures > 0 && slotFailures <= 3;
    const delay = slotRetry ? 1000 * 2 ** slotFailures : Math.min(Math.max(120000, interval), interval * 2 ** Math.min(failures, 4));
    this.pools.delete(s.pool);
    this.pools.set(s.pool, { lastAt: at, requestAt, nextAt: at + delay, failures, slotFailures });
    if (s.override) this.counts.deadlineOverrides++;
    if (s.urgent) this.counts.urgentPools++;
    if (this.pools.size > 5000) this.pools.delete(this.pools.keys().next().value);
    this.counts[quote ? 'quotedPools' : 'failedPools']++;
    return { type: 'state_quote', schedulingVersion: 3, scheduling: { urgent: !!s.urgent, deadlineOverride: !!s.override,
      expiresAt: Number.isFinite(s.deadline) ? s.deadline : null, retryKind: slotRetry ? 'slot_catchup' : 'ordinary', nextEligibleAt: at + delay },
      requestedMinContextSlot: s.requestedMinContextSlot ?? null, rpcDiagnostic,
      validationVersion: 2, accountDiagnostics: diagnostics || quote?.accountDiagnostics || null,
      source: 'helius_account_state', pool: s.pool, mint: s.mint, requestAt, at,
      latencyMs: at - requestAt, status: quote ? 'quoted' : 'unavailable', reason, quote: quote && { ...quote, requestAt } };
  }
}
module.exports = { StateQuotes, decodeState };
