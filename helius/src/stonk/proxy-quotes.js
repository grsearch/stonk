'use strict';
// Preserve the original proxy fee/slippage assumptions and add Token-2022 transfer fees.
// SOL conversion is a marked spot-valuation proxy, not a routed executable trade.
function afterTransfer(amount, fees = []) {
  const n = Math.floor(amount); if (!Number.isSafeInteger(n) || n < 0) return null;
  let fee = 0n; const raw = BigInt(n);
  // The maximum across both on-chain schedules is conservative across an epoch boundary.
  for (const f of fees) { const proportional = (raw * BigInt(f.bps) + 9999n) / 10000n;
    const capped = proportional < BigInt(f.maximumFee) ? proportional : BigInt(f.maximumFee); if (capped > fee) fee = capped; }
  return Number(raw - fee);
}
function valid(s) { return s.fx?.rate > 0 && Number.isFinite(s.fx.rate) && s.transferFees && s.quoteDecimals >= 0; }
function buyQuote(s, c) {
  if (!valid(s)) return null;
  const x = Number(s.postBase), y = Number(s.postQuoteRaw), scale = 10 ** s.quoteDecimals;
  const gross = c.sizeSol / s.fx.rate * scale;
  const transferred = afterTransfer(gross, s.transferFees.quote); if (transferred === null) return null;
  const input = transferred * (1 - c.feeBps / 10000);
  const curve = x * input / (y + input);
  const net = afterTransfer(curve, s.transferFees.base); if (net === null) return null;
  const amount = Math.floor(net * (1 - c.slippageBps / 10000));
  if (!(x > 0 && y > 0 && Number.isSafeInteger(amount) && amount > 0)) return null;
  return { amount, cost: c.sizeSol + c.networkFeeSol, breakdown: { version: 1, market: 'stonk', sizeSol: c.sizeSol,
    spotPrice: s.price, spotAmount: c.sizeSol / s.price, curveAmount: x * gross / (y + gross), afterFeeAmount: curve,
    filledAmount: amount, networkFeeSol: c.networkFeeSol, postBase: s.postBase, postQuote: s.postQuote, virtual: '0',
    quoteMint: s.quoteMint, fx: s.fx, transferFees: s.transferFees, accounting: 'cpmm_fx_spot_proxy_not_routed' } };
}
function liquidationDetails(s, amount, c) {
  if (!valid(s)) return null;
  const x = Number(s.postBase), y = Number(s.postQuoteRaw), base = afterTransfer(amount, s.transferFees.base);
  if (base === null || !(x > 0 && y > 0)) return null;
  const curve = y * base / (x + base), afterFee = curve * (1 - c.feeBps / 10000);
  const received = afterTransfer(afterFee, s.transferFees.quote); if (received === null) return null;
  const factor = s.fx.rate / 10 ** s.quoteDecimals, out = received * factor * (1 - c.slippageBps / 10000);
  if (!(out >= 0 && Number.isFinite(out))) return null;
  return { version: 1, spotPrice: s.price, spotProceeds: s.price * amount, curveOut: curve * factor, afterFeeOut: afterFee * factor,
    afterSlippageOut: out, networkFeeSol: c.networkFeeSol, net: out - c.networkFeeSol,
    postBase: s.postBase, postQuote: s.postQuote, virtual: '0', quoteMint: s.quoteMint, fx: s.fx,
    transferFees: s.transferFees, accounting: 'cpmm_fx_spot_proxy_not_routed' };
}
module.exports = { afterTransfer, buyQuote, liquidationDetails };
