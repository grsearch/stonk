'use strict';
const EventEmitter = require('node:events');
const WebSocket = require('ws');

class Stream extends EventEmitter {
  constructor(config, store) {
    super(); this.config = config; this.store = store; this.running = false;
    this.connected = false; this.lastMessage = 0; this.attempt = 0; this.latestSlot = 0;
    this.traffic = new (require('./stream-traffic'))((type, data) => store.log(type, data));
    this.fresh = new (require('./fresh-pools').FreshPools)(store);
    this.channelBytes = { discovery: 0, pools: 0, control: 0 };
  }
  budgetExceeded() {
    const used = this.store.data.streamDays[new Date().toISOString().slice(0, 10)] || 0;
    return this.config.maxBytesPerDay > 0 && used >= this.config.maxBytesPerDay;
  }
  start() {
    this.running = true;
    this.trafficTimer = setInterval(() => {
      this.traffic.flush();
      const pools = Object.values(this.fresh.pools);
      this.store.log('fresh_subscription_health', { version: 1, channelBytes: this.channelBytes,
        active: pools.filter(p=>!p.closedReason).length, reserveUnknown: pools.filter(p=>!p.closedReason && p.reserveSol==null).length,
        closed: pools.filter(p=>p.closedReason).length, subscribedPools: this.subscriptions?.activeKey?.split(',').filter(Boolean).length || 0 });
      this.channelBytes = { discovery: 0, pools: 0, control: 0 };
    }, 60000);
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
      const { PoolSubscriptions } = require('./pool-subscriptions');
      this.subscriptions = new PoolSubscriptions(msg => ws.send(JSON.stringify(msg)), () => ws.terminate(), (type,data) => this.store.log(type,data));
      this.subscriptions.start();
      this.poolTimer = setInterval(() => {
        this.fresh.prune(); this.subscriptions.update(this.fresh.addresses());
      }, 1000);
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
        if (this.subscriptions.ack(msg)) {
          this.channelBytes.control += raw.length;
          const addresses = this.fresh.addresses(); this.subscriptions.update(addresses);
          if (!this.connected && this.subscriptions.ready(addresses)) {
            this.connected = true; this.attempt = 0; clearTimeout(this.ackTimeout);
            this.emit('connection', true); this.store.log('stream_connected', { freshSubscriptionVersion: 1 });
          }
          return;
        }
        if (msg.method !== 'transactionNotification') return;
        const channel = this.subscriptions.roles.get(msg.params.subscription);
        if (!channel) return;
        this.channelBytes[channel] += raw.length;
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
      clearInterval(this.poolTimer);
      this.emit('connection', false);
      if (this.running) {
        const delay = Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6)) + Math.random() * 500;
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
  }
  stop() { this.running = false; this.connected = false; this.emit('connection', false); clearInterval(this.poolTimer); clearTimeout(this.retry); clearTimeout(this.ackTimeout); clearInterval(this.heartbeat); clearInterval(this.trafficTimer); this.traffic.flush(); this.ws?.terminate(); }
}
module.exports = Stream;
