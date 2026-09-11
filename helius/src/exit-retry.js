'use strict';
// Budget the extra short retries, not the ordinary position-management loop.
// Persist counters in the ledger so restarting does not refill the budget.
function planExitRetry(position, data, kind, now = Date.now()) {
  const fresh = b => b && now >= b.start && now - b.start < 60000 ? b : { start: now, used: 0 };
  position.exitRetryBudget = fresh(position.exitRetryBudget);
  data.exitRetryBudget = fresh(data.exitRetryBudget);
  const eligible = kind === 'account_slot' || kind === 'confirmed_slippage';
  const fast = eligible && position.exitRetryBudget.used < 3 && data.exitRetryBudget.used < 6;
  const delayMs = fast ? [250, 500, 1000][position.exitRetryBudget.used] : 10000;
  if (fast) { position.exitRetryBudget.used++; data.exitRetryBudget.used++; }
  position.retryAfter = now + delayMs;
  return { version: 1, kind, fast, delayMs, retryAfter: position.retryAfter,
    positionFastRetries: position.exitRetryBudget.used, globalFastRetries: data.exitRetryBudget.used };
}
function isSlippageFailure(error) { return error?.InstructionError?.[1]?.Custom === 6004; }
module.exports = { planExitRetry, isSlippageFailure };
