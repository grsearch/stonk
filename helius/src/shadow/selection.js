'use strict';
const crypto = require('node:crypto');
// Fixed retrospective loss-reduction hypotheses, not a validated profit claim.
const RULES = Object.freeze({ version: 7, minReboundProbability: 0.6, highReboundProbability: 0.8, maxDrawdownProbability: 0.25, maxLoss25Probability: 0.25, minExpectedNetReturn: 0,
  maxPriorBuyFraction5Exclusive: 0.8, rejectMigrationAgeMinMs: 1800000, rejectMigrationAgeMaxExclusiveMs: 7200000,
  rejectConsecutiveSellsAtLeast: 3, rejectNetSellWindowSeconds: 5,
  unknownHistoryComparison: 'allow_vs_reject_with_unknown_subgroup',
  minPriorBuyFraction15: 0.2, minPriorReturn60Pct: -20, maxDumpSolExclusive: 40 });
const ID = crypto.createHash('sha256').update(JSON.stringify(RULES)).digest('hex').slice(0, 16);
function selection(experiments, predictions, fresh, rebound, snapshot, age) {
  const v = snapshot?.values || {};
  const flowKnown = snapshot?.ready && Number.isFinite(v.buyFraction15) && v.buyFraction15 >= 0 && v.buyFraction15 <= 1
    && Number.isFinite(v.buySol15) && Number.isFinite(v.sellSol15) && v.buySol15 >= 0 && v.sellSol15 >= 0 && v.buySol15 + v.sellSol15 > 0;
  const returnKnown = snapshot?.ready && Number.isFinite(v.return60Pct) && v.trades60 >= 2;
  const pressureKnown = snapshot?.ready && Number.isInteger(v.consecutiveSells) && v.consecutiveSells >= 0
    && Number.isFinite(v.buySol5) && v.buySol5 >= 0 && Number.isFinite(v.sellSol5) && v.sellSol5 >= 0;
  const buy5Known = snapshot?.ready && Number.isFinite(v.buyFraction5) && v.buyFraction5 >= 0 && v.buyFraction5 <= 1
    && Number.isFinite(v.buySol5) && v.buySol5 >= 0 && Number.isFinite(v.sellSol5) && v.sellSol5 >= 0 && v.buySol5 + v.sellSol5 > 0;
  const risk = predictions?.loss25, net = predictions?.netReturn;
  const riskKnown = risk?.status === 'experimental_calibrated_model' && risk.target === 'loss_25' && risk.modelId
    && Number.isFinite(risk.probability) && risk.probability >= 0 && risk.probability <= 1;
  const netKnown = net?.status === 'experimental_calibrated_model' && net.target === 'net_return' && net.modelId && Number.isFinite(net.expectedNetReturn);
  const drawdown = predictions?.drawdown60;
  const knownProbability = (p, target) => p?.status === 'experimental_calibrated_model' && p.target === target && !!p.modelId
    && Number.isFinite(p.probability) && p.probability >= 0 && p.probability <= 1;
  const reboundKnown = knownProbability(rebound, 'rebound_60s'), drawdownKnown = knownProbability(drawdown, 'drawdown_60s_25');
  const ageKnown = ((age?.definition === 'since_pump_graduation_migration' && age.source === 'pump_migrate_processed' && age.status === 'observed_processed_not_finalized') ||
    (age?.definition === 'since_stonk_graduation_migration' && age.source === 'stonk_migrate_confirmed' && age.status === 'observed_confirmed_not_finalized')) && Number.isFinite(age.migrationAgeMs) && age.migrationAgeMs >= 0;
  const checks = {
    migrationAge: { pass: ageKnown ? !(age.migrationAgeMs >= RULES.rejectMigrationAgeMinMs && age.migrationAgeMs < RULES.rejectMigrationAgeMaxExclusiveMs) : null,
      reason: ageKnown ? 'migration_age_30_to_120_minutes' : 'unavailable_verified_migration_age' },
    priorBuyBurst: { pass: buy5Known ? v.buyFraction5 < RULES.maxPriorBuyFraction5Exclusive : null,
      reason: buy5Known ? 'prior_buy_fraction_5s_at_least_80pct' : 'unavailable_prior_buy_flow_5s' },
    consecutivePressure: { pass: pressureKnown ? !(v.consecutiveSells >= RULES.rejectConsecutiveSellsAtLeast && v.sellSol5 > v.buySol5) : null,
      reason: pressureKnown ? 'consecutive_sells_3_and_net_sell_5s' : 'unavailable_consecutive_sell_pressure' },
    priorBuy: { pass: flowKnown ? v.buyFraction15 >= RULES.minPriorBuyFraction15 : null, reason: flowKnown ? 'prior_buy_fraction_15s_minimum' : 'unavailable_prior_buy_flow' },
    priorReturn: { pass: returnKnown ? v.return60Pct >= RULES.minPriorReturn60Pct : null, reason: returnKnown ? 'prior_return_60s_minimum' : 'unavailable_prior_return' },
    dumpSize: { pass: Number.isFinite(v.sellSol) && v.sellSol >= 0 ? v.sellSol < RULES.maxDumpSolExclusive : null, reason: 'dump_size_below_40_sol' },
    rebound: { pass: reboundKnown ? rebound.probability >= RULES.minReboundProbability : null, reason: reboundKnown ? 'rebound_probability_minimum' : 'unavailable_rebound60_prediction' },
    highRebound: { pass: reboundKnown ? rebound.probability >= RULES.highReboundProbability : null, reason: reboundKnown ? 'high_rebound_probability_minimum' : 'unavailable_rebound60_prediction' },
    drawdown: { pass: drawdownKnown ? drawdown.probability < RULES.maxDrawdownProbability : null, reason: drawdownKnown ? 'drawdown60_probability_limit' : 'unavailable_drawdown60_prediction' },
    fresh: { pass: !!fresh, reason: fresh ? 'fresh' : 'stale_candidate' },
    size: { pass: experiments.belowMaxSell, reason: 'sell_size_limit' },
    flow: { pass: experiments.avoidPriorSellPressure, reason: 'prior_sell_pressure_or_unknown_history' },
    risk: { pass: riskKnown ? risk.probability < RULES.maxLoss25Probability : null, reason: riskKnown ? 'loss25_probability_limit' : risk?.status || 'missing_risk_prediction' },
    net: { pass: netKnown ? net.expectedNetReturn > RULES.minExpectedNetReturn : null, reason: netKnown ? 'expected_net_return_not_positive' : net?.status || 'missing_return_prediction' },
  };
  const arms = {};
  for (const [name, keys] of Object.entries({ avoidWeakBuy: ['fresh', 'priorBuy'], avoidPriorFall: ['fresh', 'priorReturn'], avoidLargeDump: ['fresh', 'dumpSize'],
    prebuyLegacy: ['fresh', 'priorBuy', 'priorReturn', 'dumpSize'],
    avoidConsecutivePressure: ['fresh', 'consecutivePressure'],
    prebuyBeforeBuy80: ['fresh', 'priorBuy', 'priorReturn', 'dumpSize', 'consecutivePressure'],
    avoidBuyBurst: ['fresh', 'priorBuyBurst'],
    prebuyBeforeAge: ['fresh', 'priorBuy', 'priorReturn', 'dumpSize', 'consecutivePressure', 'priorBuyBurst'],
    avoidMigrationAge: ['fresh', 'migrationAge'],
    prebuyCombined: ['fresh', 'priorBuy', 'priorReturn', 'dumpSize', 'consecutivePressure', 'priorBuyBurst', 'migrationAge'],
    joint: ['fresh', 'rebound', 'drawdown'], highRebound: ['fresh', 'highRebound'], baseline: ['fresh'], market: ['fresh', 'size', 'flow'], risk: ['fresh', 'risk'], net: ['fresh', 'net'], combined: ['fresh', 'size', 'flow', 'risk', 'net'] })) {
    const rejected = keys.filter(k => checks[k].pass === false), unknown = keys.filter(k => checks[k].pass !== true && checks[k].pass !== false);
    arms[name] = { status: rejected.length ? 'reject' : unknown.length ? 'unknown' : 'pass',
      rejected: rejected.map(k => ({ check: k, reason: checks[k].reason })), unknown: unknown.map(k => ({ check: k, reason: checks[k].reason })) };
  }
  const prebuy = arms.prebuyCombined;
  arms.prebuyAllowUnknown = { ...prebuy, status: prebuy.status === 'unknown' ? 'pass' : prebuy.status };
  arms.prebuyRequireKnown = { ...prebuy, status: prebuy.status === 'unknown' ? 'reject' : prebuy.status,
    rejected: prebuy.status === 'unknown' ? [...prebuy.unknown.map(x => ({ ...x, reason: 'history_required:' + x.reason }))] : prebuy.rejected };
  arms.prebuyUnknownOnly = { ...prebuy, status: prebuy.status === 'unknown' ? 'pass' : 'reject',
    rejected: prebuy.status === 'pass' ? [{ check: 'history', reason: 'known_history_not_in_unknown_subgroup' }] : prebuy.rejected };
  return { version: RULES.version, selectionId: ID, rules: RULES, marketExperimentId: experiments.experimentId,
    modelIds: { rebound: rebound?.modelId || null, drawdown: drawdown?.modelId || null, risk: risk?.modelId || null, net: net?.modelId || null }, scope: 'observation_only_candidate_filter', checks, arms };
}
module.exports = { selection };
