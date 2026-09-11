'use strict';
const fs = require('node:fs/promises');
const DAY = 86400000;
const TYPES = /^(paper_buy|paper_sell|paper_censored|buy_confirmed|sell_confirmed|buy_submitted|sell_submitted|transaction_failed|account_closed)$/;
const FIELDS = ['time', 'type', 'mint', 'pool', 'signature', 'positionId', 'reason', 'entrySol', 'quoteSol', 'rawAmount', 'netPnlSol', 'grossPnlSol', 'spotPnlPct', 'confirmMs', 'receiveToSendMs', 'networkFeeSol', 'assumedTipSol', 'heldMs'];
class Ledger {
  constructor(file) { this.file = file; this.offset = 0; this.identity = null; this.events = []; this.invalid = 0; this.firstAt = null; this.pending = null; }
  async update(now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = this.read(now).finally(() => { this.pending = null; }); return this.pending;
  }
  async read(now) {
    const fd = await fs.open(this.file, 'r');
    try {
      const stat = await fd.stat(), identity = `${stat.dev}:${stat.ino}`;
      if (this.identity !== identity || stat.size < this.offset) { this.offset = 0; this.events = []; this.invalid = 0; this.firstAt = null; }
      this.identity = identity; let position = this.offset, rest = Buffer.alloc(0);
      while (position < stat.size) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - position));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
        position += bytesRead; rest = Buffer.concat([rest, buffer.subarray(0, bytesRead)]);
        let begin = 0, nl;
        while ((nl = rest.indexOf(10, begin)) >= 0) {
          const line = rest.subarray(begin, nl).toString('utf8'); this.offset += nl + 1 - begin; begin = nl + 1;
          try {
            const row = JSON.parse(line), at = Date.parse(row.time);
            if (!Number.isFinite(at)) { this.invalid++; continue; }
            this.firstAt = Math.min(this.firstAt ?? Infinity, at);
            if (TYPES.test(row.type) && at >= now - DAY) this.events.push({ ...Object.fromEntries(FIELDS.filter(k => row[k] !== undefined).map(k => [k, row[k]])), at, order: this.offset });
          } catch (_) { this.invalid++; }
        }
        rest = rest.subarray(begin);
        if (rest.length > 32 * 1024 * 1024) throw new Error('Oversized ledger record');
      }
      // A partial final line is re-read after the writer finishes it.
      this.events = this.events.filter(r => r.at >= now - DAY);
    } finally { await fd.close(); }
  }
  view(mode, now = Date.now(), page = 1, pageSize = 20) {
    const start = now - DAY, rows = this.events.filter(r => r.at >= start && r.at <= now).sort((a, b) => b.at - a.at || b.order - a.order);
    const pnl = { start, end: now, mode, totalSol: 0, closed: 0, known: 0, unknown: 0, wins: 0, losses: 0, flat: 0, duplicates: 0,
      invalidLines: this.invalid, sourceStartsAt: this.firstAt, fullWindowAvailable: this.firstAt !== null && this.firstAt <= start };
    const seen = new Set();
    for (const r of rows) {
      if (r.type !== (mode === 'live' ? 'sell_confirmed' : 'paper_sell')) continue;
      const key = mode === 'live' ? r.signature : r.positionId;
      if (key && seen.has(key)) { pnl.duplicates++; continue; } if (key) seen.add(key);
      pnl.closed++;
      const value = mode === 'live' ? r.netPnlSol : r.grossPnlSol;
      if (!Number.isFinite(value)) { pnl.unknown++; continue; }
      pnl.known++; pnl.totalSol += value;
      if (value > 0) pnl.wins++; else if (value < 0) pnl.losses++; else pnl.flat++;
    }
    pnl.winRatePct = pnl.known ? pnl.wins / pnl.known * 100 : null;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize)), selected = Math.min(page, totalPages);
    return { pnl24h: pnl, trades: rows.slice((selected - 1) * pageSize, selected * pageSize).map(({ at, order, ...r }) => r),
      pagination: { page: selected, pageSize, total: rows.length, totalPages, start, end: now } };
  }
}
module.exports = { Ledger };
