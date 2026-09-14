'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { exitReason, exitConfig } = require('../src/strategy');
const { Engine } = require('../src/engine');
const { publicConfig } = require('../src/reporting/archive');
const env = { HELIUS_API_KEY: 'test', WALLET_PRIVATE_KEY_BS58: 'test', DRY_RUN: 'false',
  TAKE_PROFIT_PCT: '20', TRAILING_ACTIVATE_PCT: '10', MAX_HOLD_MS: '1800000' };
const c = readConfig(env), p = { entryPrice: 100, high: 100, openedAt: 1000 };
test('live and calibration use new exit thresholds despite retained legacy env settings', () => {
  for (const config of [c, readConfig({ ...env, LIVE_CALIBRATION: 'true' })]) {
    assert.deepEqual(config.liveExitPolicy, { version: 1, takeProfit: 10, trailArm: 8, trailDrop: 3, maxHoldMs: 20000 });
    assert.equal(exitReason(p, 109.99, config, 2000), null);
    assert.equal(exitReason(p, 110, config, 2000), 'take_profit');
    assert.equal(exitReason({ ...p, high: 108 }, 104.75, config, 2000), 'trailing');
    assert.equal(exitReason({ ...p, high: 107.99 }, 104, config, 2000), null);
    assert.equal(exitReason(p, 50, config, 20999), null);
    assert.equal(exitReason(p, 50, config, 21000), 'max_hold');
    assert.equal(publicConfig(config).liveExitPolicy.maxHoldMs, 20000);
  }
});
test('paper and shadow source thresholds retain original values', () => {
  const paper = readConfig({ ...env, DRY_RUN: 'true' });
  assert.equal(paper.liveExitPolicy, null);
  assert.equal(exitReason(p, 110, paper, 2000), null);
  assert.equal(exitReason(p, 50, paper, 2000), 'stop_loss');
  assert.equal(exitConfig(paper).maxHoldMs, 1800000);
  assert.equal(c.maxHoldMs, 1800000); // ShadowClient uses research fields, not liveExitPolicy.
});
test('timer uses live twenty second deadline with fresh or stale price', async () => {
  for (const fresh of [true, false]) {
    const now = Date.now(), position = { ...p, mint: 'm', lastPrice: 100, openedAt: now - 21000,
      lastStreamQuoteAt: now, lastPriceAt: fresh ? now : now - 60000 };
    const store = { data: { positions: { m: position }, pending: {} }, save() {}, log() {} };
    const e = new Engine(c, store, {}, { connected: false });
    e.pollPositions = async () => {}; e.cleanup = async () => {};
    let reason; e.sell = async (_, r) => { reason = r; };
    await e.tick(); assert.equal(reason, 'max_hold');
  }
});
