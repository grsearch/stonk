'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Ledger } = require('../src/dashboard/ledger');
function setup(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return path.join(d, 'trades.jsonl'); }
const line = (at, extra) => JSON.stringify({ time: new Date(at).toISOString(), ...extra }) + '\n';
test('24h PnL excludes old, future, submitted, missing values and duplicate closes', async t => {
  const file = setup(t), now = Date.now();
  fs.writeFileSync(file, line(now - 86400001, { type: 'paper_sell', grossPnlSol: 100 })
    + line(now - 86400000, { type: 'paper_sell', grossPnlSol: 2, positionId: 'a' })
    + line(now - 1000, { type: 'paper_sell', grossPnlSol: 2, positionId: 'a' })
    + line(now - 500, { type: 'paper_sell', grossPnlSol: -1, positionId: 'b' })
    + line(now - 400, { type: 'paper_sell', positionId: 'unknown', spotPnlPct: 15 })
    + line(now - 300, { type: 'sell_submitted', netPnlSol: 100 })
    + line(now + 1000, { type: 'paper_sell', grossPnlSol: 100 }));
  const ledger = new Ledger(file); await ledger.update(now); const p = ledger.view('paper', now).pnl24h;
  assert.equal(p.totalSol, 1); assert.equal(p.closed, 3); assert.equal(p.unknown, 1); assert.equal(p.winRatePct, 50); assert.equal(p.duplicates, 1);
  assert.equal(p.fullWindowAvailable, true); assert.equal(ledger.view('live', now).pnl24h.totalSol, 0);
});
test('ledger reads beyond 2MB, pages past 60 events and incrementally completes partial records', async t => {
  const file = setup(t), now = Date.now();
  const events = Array.from({ length: 85 }, (_, i) => line(now - 100000 + i, { type: 'sell_confirmed', signature: String(i), netPnlSol: 1 }));
  fs.writeFileSync(file, events.join('') + line(now - 1, { type: 'health', padding: 'x'.repeat(2200000) }));
  const ledger = new Ledger(file); await ledger.update(now);
  assert.equal(ledger.view('live', now).pnl24h.totalSol, 85);
  const page = ledger.view('live', now, 5, 20); assert.equal(page.trades.length, 5); assert.equal(page.pagination.total, 85);
  const partial = line(now, { type: 'sell_confirmed', signature: 'new', netPnlSol: -2 });
  fs.appendFileSync(file, partial.slice(0, -3)); await ledger.update(now); assert.equal(ledger.view('live', now).pnl24h.totalSol, 85);
  fs.appendFileSync(file, partial.slice(-3)); await ledger.update(now); assert.equal(ledger.view('live', now).pnl24h.totalSol, 83);
  await ledger.update(now); assert.equal(ledger.view('live', now).pagination.total, 86);
});
test('truncation resets index and rolling window expires old closes', async t => {
  const file = setup(t), now = Date.now(); fs.writeFileSync(file, line(now - 1, { type: 'paper_sell', grossPnlSol: 4 }));
  const ledger = new Ledger(file); await ledger.update(now); assert.equal(ledger.view('paper', now + 86400000).pnl24h.closed, 0);
  fs.writeFileSync(file, line(now, { type: 'paper_sell' })); await ledger.update(now);
  assert.equal(ledger.view('paper', now).pnl24h.totalSol, 0); assert.equal(ledger.view('paper', now).pnl24h.unknown, 1);
});
