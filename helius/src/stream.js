'use strict';
const EventEmitter = require('node:events');
const WebSocket = require('ws');
const { PUMP } = require('./config');

class Stream extends EventEmitter {
  constructor(config, store) {
    super(); this.config = config; this.store = store; this.running = false;
    this.connected = false; this.lastMessage = 0; this.attempt = 0; this.latestSlot = 0;
    this.traffic = new (require('./stream-traffic'))((type, data) => store.log(type, data));
  }
  budgetExceeded() {
    const used = this.store.data.streamDays[new Date().toISOString().slice(0, 10)] || 0;
    return this.config.maxBytesPerDay > 0 && used >= this.config.maxBytesPerDay;
  }
  start() {
    this.running = true;
    this.trafficTimer = setInterval(() => this.traffic.flush(), 60000);
    this.connect();
  }
  connect() {
    if (!this.running) return;
    if (this.budgetExceeded()) {
      this.connected = false;
      this.emit('connection', false);
      this.retry = setTimeout(() => this.connect(), 60000);
      return;
    }
    const ws = this.ws = new WebSocket(this.config.wsUrl, { perMessageDeflate: false, handshakeTimeout: 10000 });
    let alive = true;
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [
        { vote: false, failed: false, accountInclude: [PUMP] },
        { commitment: 'processed', encoding: 'base64', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 0 },
      ] }));
      this.heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false; ws.ping();
      }, 20000);
      this.ackTimeout = setTimeout(() => { if (!this.connected) ws.terminate(); }, 10000);
    });
    ws.on('pong', () => { alive = true; });
    ws.on('message', raw => {
      const receivedAt = Date.now();
      alive = true; this.lastMessage = receivedAt;
      const day = new Date().toISOString().slice(0, 10);
      this.store.data.streamDays[day] = (this.store.data.streamDays[day] || 0) + raw.length;
      if (this.budgetExceeded()) {
        this.traffic.record(raw.length, { category: 'budget_discarded' });
        this.connected = false; this.emit('connection', false);
        this.store.log('stream_budget_reached', { day }); this.store.save(); ws.close(); return;
      }
      let traffic = { category: 'control' };
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.error) {
          this.store.log('subscription_error', { code: msg.error.code }); ws.close(); return;
        }
        if (msg.id === 1 && msg.result !== undefined) {
          this.connected = true; this.attempt = 0; clearTimeout(this.ackTimeout);
          this.emit('connection', true);
          this.store.log('stream_connected'); return;
        }
        if (msg.method !== 'transactionNotification') return;
        const result = msg.params.result;
        this.latestSlot = Math.max(this.latestSlot, result.slot || 0);
        // Bound delayed/out-of-order data before parsing, no replay on reconnect.
        if (result.slot < this.latestSlot - 6) { traffic = { category: 'stale_slot' }; return; }
        const incoming = { ...result, receivedAt };
        this.emit('transaction', incoming);
        traffic = incoming.traffic || { category: 'unclassified_transaction' };
      } catch (err) {
        traffic = { category: 'parse_or_handler_error' };
        this.store.log('stream_parse_error', { error: err.message });
      } finally { this.traffic.record(raw.length, traffic); }
    });
    ws.on('error', () => this.store.log('stream_network_error'));
    ws.on('close', () => {
      this.connected = false; clearInterval(this.heartbeat); clearTimeout(this.ackTimeout);
      this.emit('connection', false);
      if (this.running) {
        const delay = Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6)) + Math.random() * 500;
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
  }
  stop() { this.running = false; this.connected = false; this.emit('connection', false); clearTimeout(this.retry); clearTimeout(this.ackTimeout); clearInterval(this.heartbeat); clearInterval(this.trafficTimer); this.traffic.flush(); this.ws?.terminate(); }
}
module.exports = Stream;
