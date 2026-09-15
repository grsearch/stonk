'use strict';
const path = require('node:path');
const { readConfig: original } = require('../config');
const { config: monitorConfig } = require('./monitor');
function readConfig(env = process.env) {
  const c = original({ ...env, MIN_SELL_SOL: env.MIN_SELL_SOL ?? '7', MAX_HOLD_MS: env.MAX_HOLD_MS ?? '20000',
    SHADOW_EXPERIMENT_LOSS_COOLDOWN_MS: env.SHADOW_EXPERIMENT_LOSS_COOLDOWN_MS ?? '60000', DRY_RUN: 'true', LIVE_CALIBRATION: 'false', SHADOW_ENABLED: 'true', WALLET_PRIVATE_KEY_BS58: '',
    STATE_FILE: env.STATE_FILE || 'data/stonk/paper.json', SHADOW_DIRECTORY: env.SHADOW_DIRECTORY || 'data/stonk/shadow' });
  c.paperLossCooldownMs = c.shadow.experimentLossCooldownMs;
  c.liveEntryPolicy.lossCooldownMs = c.paperLossCooldownMs;
  // Retain the future live policy without loading or enabling an executor.
  c.liveExitPolicy = { version: 1, takeProfit: 10, trailArm: 8, trailDrop: 3, maxHoldMs: c.maxHoldMs };
  c.market = 'stonk'; c.stonk = monitorConfig(env);
  if (env.STONK_MAX_STREAM_BYTES_PER_DAY === undefined) c.stonk.maxBytes = c.maxBytesPerDay || Infinity;
  // A mistaken environment value must never turn this distribution into a live executor.
  Object.defineProperties(c, { dryRun: { value: true, writable: false }, privateKey: { value: '', writable: false } });
  Object.defineProperty(c.shadow, 'enabled', { value: true, writable: false });
  c.shadow.modelFile ||= path.resolve(__dirname, '../../../observation-models/20260908/rebound60.json');
  c.shadow.drawdownModelFile ||= path.resolve(__dirname, '../../../observation-models/20260908/drawdown60.json');
  return c;
}
module.exports = { readConfig };
