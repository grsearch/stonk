'use strict';
function matchesBaseSignal(s, c) {
  if (c.market === 'stonk' && (s.market !== 'stonk' || !Number.isSafeInteger(s.graduatedAt) ||
      Date.now() < s.graduatedAt || Date.now() >= s.graduatedAt + 1800000)) return false;
  return s.side === 'sell' && s.sellSol >= c.minSellSol && s.impact >= c.minImpact && s.impact <= c.maxImpact && s.liquidity >= c.minLiquidity;
}
function isSignal(s, c, now = Date.now()) {
  return matchesBaseSignal(s, c) && now - s.receivedAt <= c.maxSignalAgeMs
    && now - s.eventTime <= c.maxSignalAgeMs + 1000 && s.eventTime <= now + 2000;
}
function exitReason(position, price, c, now = Date.now()) {
  const pnl = (price / position.entryPrice - 1) * 100;
  if (pnl <= -c.stopLoss) return 'stop_loss';
  if (pnl >= c.takeProfit) return 'take_profit';
  if (c.trailArm > 0 && (position.high / position.entryPrice - 1) * 100 >= c.trailArm && (1 - price / position.high) * 100 >= c.trailDrop) return 'trailing';
  if (now - position.openedAt >= c.maxHoldMs) return 'max_hold';
  return null;
}
module.exports = { matchesBaseSignal, isSignal, exitReason };
