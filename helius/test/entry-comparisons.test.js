'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EntryComparisons } = require('../src/shadow/entry-comparisons');
const { entryAudit } = require('../src/reporting/entry-audit');
const config = { sizeSol: 1, entryDelayMs: 500, entryDeadlineMs: 2500, exitDelayMs: 500,
  maxGapMs: 10000, maxHoldMs: 30000, maxActive: 20, maxActivePerPool: 10, stopLoss: 25, takeProfit: 20, trailArm: 10, trailDrop: 3 };
const quotes = { buyQuote: s => ({ amount: 1 / s.price, cost: 1, breakdown: { price: s.price } }),
  liquidationDetails: (s, amount) => ({ net: s.price * amount, price: s.price }) };
function setup(extra = {}) {
  const records = [], x = new EntryComparisons({ ...config, ...extra }, r => records.push(r), quotes);
  x.add({ id: 'a', key: 'a', at: 0, source: { pool: 'p' } }, { price: 1 }, true);
  const swap = (at, price, user = 'buyer1', side = 'buy') => x.observe({ pool: 'p', price, user, side }, at);
  return { x, records, swap, arm: name => x.active.get('a')?.arms.find(a => a.name === name) };
}
test('confirmation uses past low, excludes trigger, separates two swaps from two buyers, and delays entry', () => {
  const { x, swap, arm, records } = setup();
  swap(100, .9); swap(500, .918);
  assert.equal(arm('confirm_buy_flow').confirmedAt, 500);
  assert.equal(arm('confirm_two_buyers').confirmedAt, null);
  swap(600, .93, 'buyer2'); assert.equal(arm('confirm_two_buyers').confirmedAt, 600);
  swap(999, .94); assert.equal(arm('confirm_buy_flow').entry, null);
  swap(1000, .95); assert.equal(arm('confirm_buy_flow').entry.at, 1000);
  swap(1100, .96); assert.equal(arm('confirm_two_buyers').entry.at, 1100);
  assert.equal(x.needsBuyer('p'), false);
  assert.equal(records.find(r => r.variant === 'confirm_buy_flow' && r.phase === 'confirmed').lowPrice, .9);
});
test('exact 3s confirmation is valid; later price cannot backfill it; unavailable identities stay unknown', () => {
  const a = setup(); a.swap(100, 1); a.swap(3000, 1.02, 'buyer2'); assert.equal(a.arm('confirm_two_buyers').confirmedAt, 3000);
  const b = setup(); b.swap(100, 1); b.swap(3001, 1.02, 'buyer2');
  assert.equal(b.records.find(r => r.variant === 'confirm_buy_flow' && r.phase === 'finished').status, 'not_entered');
  const c = setup(); c.swap(100, 1, null); c.swap(500, 1.02, null); c.x.tick(3001);
  assert.equal(c.records.find(r => r.variant === 'confirm_two_buyers' && r.phase === 'finished').reason, 'buyer_identity_unavailable');
  assert.equal(c.arm('confirm_buy_flow').confirmedAt, 500);
});
test('each arm recomputes entry amount and delayed exits; no shared baseline position', () => {
  const { swap, arm, records } = setup(); swap(100, 1); swap(500, 1.02, 'buyer2'); swap(1000, 1.1);
  assert.equal(arm('immediate').entry.amount, 1 / 1.02);
  assert.equal(arm('confirm_buy_flow').entry.amount, 1 / 1.1);
  swap(1500, 1.34); swap(2000, 1.25);
  const done = records.filter(r => r.phase === 'finished'); assert.equal(done.length, 3);
  assert.ok(Math.abs(done.find(r => r.variant === 'confirm_buy_flow').netPnlSol - (1.25 / 1.1 - 1)) < 1e-12);
  assert.equal(done.find(r => r.variant === 'confirm_buy_flow').actualExitDelayMs, 500);
});
test('capacity, prebuy unknown, expiry, gaps and restart never become fake profitable outcomes', () => {
  const { x, records } = setup({ maxActive: 1 });
  x.add({ id: 'b', at: 0, source: { pool: 'p' } }, { price: 1 }, true);
  assert.equal(records.filter(r => r.reason === 'entry_research_capacity').length, 3);
  x.add({ id: 'c', at: 0, source: { pool: 'q' } }, { price: 1 }, false);
  assert.equal(records.filter(r => r.status === 'skipped').length, 3);
  x.gap('process_shutdown', 100); assert.equal(x.active.size, 0); assert.equal(x.byPool.size, 0);
  assert.equal(records.some(r => r.status === 'observed_proxy'), false);
  const late = setup(); late.x.tick(11000);
  assert.equal(late.records.filter(r => r.reason === 'pool_observation_gap').length, 3);
  const expiry = setup(); expiry.x.tick(2501);
  assert.equal(expiry.records.find(r => r.variant === 'immediate' && r.phase === 'finished').reason, 'no_timely_entry_observation');
});
test('max hold is measured from confirmed arm entry and still waits for exit quote', () => {
  const { x, swap, arm, records } = setup({ maxHoldMs: 2000 });
  swap(100, 1); swap(500, 1.02, 'buyer2'); swap(1000, 1.03); x.tick(2999);
  assert.equal(arm('confirm_buy_flow').pending, null); x.tick(3000);
  assert.equal(arm('confirm_buy_flow').pending.reason, 'max_hold');
  swap(3499, 1.03); assert.equal(records.some(r => r.variant === 'confirm_buy_flow' && r.phase === 'finished'), false);
  swap(3500, 1.02); assert.equal(records.find(r => r.variant === 'confirm_buy_flow' && r.phase === 'finished').exitAt, 3500);
});
test('entry audit pairs only observed same-policy outcomes and keeps skipped, pending, unknown separate', () => {
  const rows = new Map([['a:immediate', { id: 'a', variant: 'immediate', policyId: 'p', entryResearchVersion: 1, phase: 'finished', status: 'observed_proxy', netPnlSol: -.1, entryAt: 1 }],
    ['a:confirm_buy_flow', { id: 'a', variant: 'confirm_buy_flow', policyId: 'p', entryResearchVersion: 1, phase: 'finished', status: 'observed_proxy', netPnlSol: .2, entryAt: 2 }],
    ['b:confirm_buy_flow', { id: 'b', variant: 'confirm_buy_flow', policyId: 'p', entryResearchVersion: 1, phase: 'finished', status: 'censored', netPnlSol: null }],
    ['c:confirm_buy_flow', { id: 'c', variant: 'confirm_buy_flow', policyId: 'p', entryResearchVersion: 1, phase: 'entered', status: 'holding', entryAt: 3 }]]);
  const g = entryAudit(rows).groups.find(g => g.variant === 'confirm_buy_flow');
  assert.equal(g.netPnlSol, .2); assert.equal(g.paired, 1); assert.equal(g.unknown, 1); assert.equal(g.pending, 1);
});
