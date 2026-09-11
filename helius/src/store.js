'use strict';
const fs = require('node:fs');
const path = require('node:path');

// One process per state file. A corrupt state file must never become an empty wallet ledger.
class Store {
  constructor(file, mode, wallet) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.lockFile = `${file}.lock`;
    try { this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid state lock; inspect manually');
      try { process.kill(pid, 0); throw new Error('Another bot process owns this state'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
      fs.unlinkSync(this.lockFile);
      this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
    }
    fs.writeFileSync(this.lockFd, String(process.pid));
    try {
      this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
        version: 1, mode, wallet, positions: {}, cleanup: {}, cooldown: {}, pending: {}, seen: {}, streamDays: {},
      };
      if (this.data.version !== 1 || this.data.mode !== mode || this.data.wallet !== wallet) throw new Error('State mode/wallet mismatch');
      for (const key of ['positions', 'cleanup', 'cooldown', 'pending', 'seen', 'streamDays']) {
        if (!this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) throw new Error(`Invalid state: ${key}`);
      }
    } catch (err) { this.close(); throw err; }
  }
  save() {
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  }
  log(type, fields = {}) {
    const record = { time: new Date().toISOString(), type, ...fields };
    fs.appendFileSync(`${this.file}.jsonl`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(record));
  }
  close() {
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); this.lockFd = undefined; fs.unlinkSync(this.lockFile); }
  }
}
module.exports = Store;
