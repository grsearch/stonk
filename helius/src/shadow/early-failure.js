'use strict';
// Fixed observational hypothesis, not a fitted threshold or live execution policy.
const RULES = Object.freeze({ version: 1, evaluateAfterMs: 3000, maxEvaluationLagMs: 1000,
  maxNetPct: -8, minSellTrades: 2, minSellBuyRatio: 1.5, finalWindowMs: 1000 });
function state() { return { buySol: 0, sellSol: 0, buyTrades: 0, sellTrades: 0,
  finalBuySol: 0, finalSellSol: 0, missingFlow: false, assessment: null }; }
function finish(s, status, reason, at, entryAt, netPct = null) {
  if (s.assessment) return null;
  s.assessment = { version: 1, status, reason, evaluatedAt: at, entryAt,
    dueAt: entryAt + RULES.evaluateAfterMs, evaluationLagMs: at - entryAt - RULES.evaluateAfterMs,
    netPct, buySol: s.buySol, sellSol: s.sellSol, buyTrades: s.buyTrades, sellTrades: s.sellTrades,
    finalBuySol: s.finalBuySol, finalSellSol: s.finalSellSol, missingFlow: s.missingFlow };
  return s.assessment;
}
function observe(s, swap, netPct, at, entryAt) {
  if (s.assessment) return null;
  const age = at - entryAt;
  // Exclude the entry tick and all activity after the fixed three-second window.
  if (age > 0 && age <= RULES.evaluateAfterMs) {
    if (!['buy', 'sell'].includes(swap.side) || !Number.isFinite(swap.quoteSol) || swap.quoteSol < 0) s.missingFlow = true;
    else if (swap.quoteSol > 0) {
      s[`${swap.side}Sol`] += swap.quoteSol; s[`${swap.side}Trades`]++;
      if (age > RULES.evaluateAfterMs - RULES.finalWindowMs) s[swap.side === 'buy' ? 'finalBuySol' : 'finalSellSol'] += swap.quoteSol;
    }
  }
  if (age < RULES.evaluateAfterMs) return null;
  if (age > RULES.evaluateAfterMs + RULES.maxEvaluationLagMs) return finish(s, 'unavailable', 'no_timely_evaluation_quote', at, entryAt);
  if (s.missingFlow || !Number.isFinite(netPct)) return finish(s, 'unavailable', 'incomplete_flow_or_quote', at, entryAt);
  if (!s.buyTrades && !s.sellTrades) return finish(s, 'unavailable', 'no_post_entry_flow_observed', at, entryAt);
  const failed = netPct <= RULES.maxNetPct + 1e-10 && s.sellTrades >= RULES.minSellTrades
    && s.sellSol > 0 && s.sellSol >= s.buySol * RULES.minSellBuyRatio
    && s.finalSellSol > s.finalBuySol;
  return finish(s, failed ? 'failed' : 'not_failed', failed ? 'net_loss_and_persistent_sell_pressure' : 'conditions_not_met', at, entryAt, netPct);
}
module.exports = { RULES, state, finish, observe };
