'use strict';
const BAR_MS = 15000;
// Wilder RSI, seeded with the first seven changes. Flat series has no directional signal.
function rsi(closes, period = 7) {
  if (closes.length <= period || closes.some(x => !(x > 0 && Number.isFinite(x)))) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= period) { gain += g / period; loss += l / period; }
    else { gain = (gain * (period - 1) + g) / period; loss = (loss * (period - 1) + l) / period; }
  }
  return gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function candles(items, graduatedAt, now) {
  const start = Math.ceil(graduatedAt / BAR_MS) * BAR_MS;
  const map = new Map();
  for (const b of items) {
    const at = b.unix_time * 1000;
    if (!Number.isSafeInteger(at) || at % BAR_MS || at < start || at + BAR_MS > now ||
      !['o', 'h', 'l', 'c'].every(k => Number.isFinite(b[k]) && b[k] > 0) || !(b.v >= 0)) continue;
    map.set(at, { ...b, at });
  }
  const sorted = [...map.values()].sort((a, b) => a.at - b.at), result = [];
  for (const b of sorted) {
    const last = result.at(-1);
    // The API omits empty intervals; pad only inside a successfully returned history range.
    if (last) for (let at = last.at + BAR_MS; at < b.at; at += BAR_MS)
      result.push({ at, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, synthetic: true });
    result.push(b);
  }
  return result;
}
function flow(trades, now, reserveSol, config) {
  const a = trades.filter(t => t.receivedAt <= now && t.receivedAt > now - 15000);
  const latest = a.filter(t => t.receivedAt > now - 5000), prior = a.filter(t => t.receivedAt <= now - 5000);
  const sum = (rows, side) => rows.filter(t => t.side === side).reduce((s, t) => s + t.quoteSol, 0);
  const buy = sum(a, 'buy'), sell = sum(a, 'sell'), buy5 = sum(latest, 'buy'), sell5 = sum(latest, 'sell');
  const buyers = new Set(a.filter(t => t.side === 'buy').map(t => t.user).filter(Boolean)).size;
  const minimum = Math.max(config.minFlowSol, reserveSol * config.minFlowReserveFraction);
  const notNewLow = latest.length > 0 && prior.length > 0 && Math.min(...latest.map(t => t.vaultRatioAfter)) >= Math.min(...prior.map(t => t.vaultRatioAfter));
  return { buy, sell, buy5, sell5, buyers, minimum, notNewLow,
    pass: buy + sell >= minimum && buy / (buy + sell) >= config.buyFraction && buy5 >= sell5 && buyers >= config.minBuyers && notNewLow };
}
function exitDecision(position, { now, rsiValue, rsiAt, netSol }, config) {
  if (position.exitRetryReason) return position.exitRetryReason;
  if (now - position.openedAt >= config.maxHoldMs) return 'rsi_max_hold';
  const freshRsi = Number.isFinite(rsiValue) && now - rsiAt <= 30000;
  // At a simultaneous observation RSI has priority. Once trailing owns the position it stays owner.
  if (position.rsiExitOwner !== 'trailing' && freshRsi && rsiValue > config.sellRsi) {
    position.rsiExitOwner = 'rsi'; return 'rsi_over_80';
  }
  if (Number.isFinite(netSol) && netSol >= 0) {
    if (!position.rsiExitOwner && netSol >= position.entrySol * (1 + config.trailArm / 100)) position.rsiExitOwner = 'trailing';
    if (position.rsiExitOwner === 'trailing') {
      position.rsiPeakNetSol = Math.max(position.rsiPeakNetSol || 0, netSol);
      if (netSol <= position.rsiPeakNetSol * (1 - config.trailDrop / 100)) return 'rsi_trailing_10';
    }
  }
  return null;
}
module.exports = { BAR_MS, rsi, candles, flow, exitDecision };
