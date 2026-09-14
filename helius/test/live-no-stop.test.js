'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { exitReason } = require('../src/strategy');
const { publicConfig } = require('../src/reporting/archive');
const paper = readConfig({ HELIUS_API_KEY: 'test' });
const live = { ...paper, dryRun: false };
const p = { entryPrice: 1, high: 1, openedAt: 1000 };
test('live fixed stop disabled even with existing 25 percent configuration', () => {
  for (const price of [.75, .5, .01]) assert.equal(exitReason(p, price, live, 2000), null);
  assert.equal(publicConfig(live).liveFixedStopLoss, false);
  assert.equal(exitReason(p, .5, paper, 2000), 'stop_loss');
});
test('live take profit, trailing and maximum holding exits remain active', () => {
  assert.equal(exitReason(p, 1.21, live, 2000), 'take_profit');
  assert.equal(exitReason({ ...p, high: 1.15 }, 1.1, live, 2000), 'trailing');
  assert.equal(exitReason(p, .5, live, 1000 + live.maxHoldMs), 'max_hold');
});
