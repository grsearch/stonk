'use strict';
// Preserve the trigger slot on every attempt; never turn a lagging read into a stale quote.
async function readAccounts(rpc, keys, swap, c, log, timing = {}) {
  const now = timing.now || Date.now;
  const sleep = timing.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  const entryRetry = swap.isEntry && !!c.liveEntryPolicy;
  const deadline = Math.min(started + (entryRetry ? 1100 : 700), swap.isEntry
    ? Math.min(swap.receivedAt + c.maxSignalAgeMs, swap.eventTime + c.maxSignalAgeMs + 1000) : Infinity);
  const requestedSlot = Number.isSafeInteger(swap.slot) && swap.slot > 0 ? swap.slot : null;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await rpc.getMultipleAccountsInfoAndContext(keys, {
        commitment: 'processed', ...(requestedSlot ? { minContextSlot: requestedSlot } : {}),
      });
      if (requestedSlot && (!Number.isSafeInteger(result.context?.slot) || result.context.slot < requestedSlot)) {
        const error = new Error('Account response is older than required slot'); error.code = -32016;
        error.data = { contextSlot: result.context?.slot }; throw error;
      }
      if (attempt) log('execution_account_read_recovered', { attempt: attempt + 1, requestedSlot, contextSlot: result.context.slot });
      return result;
    } catch (error) {
      const code = Number.isInteger(error.code) ? error.code : null;
      const delay = (entryRetry ? [100, 200, 300] : [100, 200])[attempt];
      const retry = code === -32016 && delay !== undefined && now() + delay < deadline;
      log('execution_account_read_failed', { method: 'getMultipleAccounts', code,
        reason: code === -32016 ? 'minimum_context_slot_not_reached' : code === 429 ? 'rate_limited' : 'rpc_or_transport_error',
        requestedSlot, contextSlot: Number.isSafeInteger(error.data?.contextSlot) ? error.data.contextSlot : null,
        attempt: attempt + 1, elapsedMs: now() - started, retry, retryDelayMs: retry ? delay : null });
      if (!retry) throw error;
      await sleep(delay);
      if (now() >= deadline) throw error;
    }
  }
}
module.exports = { readAccounts };
