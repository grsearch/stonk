'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
test('state survives restart; live/paper mismatch and duplicate process are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helius-test-')); const file = path.join(dir, 'state.json');
  const a = new Store(file, 'paper', 'wallet');
  a.data.pending.sig = { serialized: 'signed bytes' }; a.save();
  assert.throws(() => new Store(file, 'paper', 'wallet'), /Another bot/);
  a.close(); const b = new Store(file, 'paper', 'wallet');
  assert.equal(b.data.pending.sig.serialized, 'signed bytes'); b.close();
  assert.throws(() => new Store(file, 'live', 'wallet'), /mismatch/);
  fs.writeFileSync(file, '{broken'); assert.throws(() => new Store(file, 'paper', 'wallet'));
});
