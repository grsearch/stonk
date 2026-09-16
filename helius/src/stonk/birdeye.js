'use strict';
const { WSOL } = require('./accounts');
class Birdeye {
  constructor(key, request = fetch) { this.key = key; this.request = request; this.requests = 0; this.failures = 0; }
  async get(path, params) {
    this.requests++;
    try {
      const r = await this.request('https://public-api.birdeye.so' + path + '?' + new URLSearchParams(params), {
        headers: { 'X-API-KEY': this.key, 'x-chain': 'solana' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!r.ok) throw Error('Birdeye HTTP ' + r.status);
      const d = await r.json(); if (d.success !== true || !d.data) throw Error('Birdeye invalid response');
      return d.data;
    } catch (e) { this.failures++; throw Error(/^Birdeye /.test(e.message) ? e.message : 'Birdeye request failed'); }
  }
  async solPrice() {
    const d = await this.get('/defi/price', { address: WSOL });
    if (!(d.value > 0) || !Number.isFinite(d.value) || !Number.isSafeInteger(d.updateUnixTime) ||
      Math.abs(Date.now() - d.updateUnixTime * 1000) > 60000) throw Error('Birdeye stale SOL price');
    return { value: d.value, at: d.updateUnixTime * 1000 };
  }
  async bars(pool, inversion, from, to) {
    const d = await this.get('/defi/v3/ohlcv/pair', { address: pool, type: '15s', inversion: String(inversion),
      time_from: Math.floor(from / 1000), time_to: Math.floor(to / 1000) });
    if (!Array.isArray(d.items) || d.items.some(x => x.address !== pool)) throw Error('Birdeye pool mismatch');
    return d.items;
  }
}
module.exports = { Birdeye };
