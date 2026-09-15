'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PLATFORMS, LAUNCHLAB, CPMM, WINDOW_MS, normalize, migrations, active, swaps } = require('./protocol');
const { diagnostic } = require('./diagnostics');
function config(env = process.env) {
  const key = env.HELIUS_API_KEY;
  const rpcUrl = env.HELIUS_RPC_URL || (key && `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`);
  const wsUrl = env.HELIUS_WS_URL || (key && `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`);
  if (!rpcUrl || !wsUrl || (key === 'your-helius-api-key' && !(env.HELIUS_RPC_URL && env.HELIUS_WS_URL))) throw Error('Configure Helius URLs or API key');
  if (new URL(rpcUrl).protocol !== 'https:' || new URL(wsUrl).protocol !== 'wss:') throw Error('HTTPS/WSS required');
  const number = (name, fallback, min, max) => { const n = Number(env[name] ?? fallback); if (!Number.isFinite(n) || n < min || n > max) throw Error(`Invalid ${name}`); return n; };
  return { rpcUrl, wsUrl, dataDir: path.resolve(__dirname, '../..', env.STONK_DATA_DIR || 'data/stonk'),
    dumpPct: number('STONK_DUMP_PCT', 10, 0.01, 100), maxRpc: number('STONK_MAX_RPC_PER_DAY', 20000, 1, 1e7),
    maxBytes: number('STONK_MAX_STREAM_BYTES_PER_DAY', 1e9, 1, 1e12), historyPages: number('STONK_HISTORY_PAGES', 10, 1, 100),
    batchHistory: env.STONK_BATCH_HISTORY !== 'false' };
}
class Monitor {
  constructor(config, { rpc, socketFactory, now = Date.now, onPool, onSwap, onExpired, onConnection, onGap, shouldSubscribe = () => true } = {}) {
    this.config = config; this.now = now; this.rpcOverride = rpc;
    this.socketFactory = socketFactory || (url => new WebSocket(url));
    this.pools = new Map(); this.seen = new Map(); this.blockTimes = new Map(); this.cursors = {}; this.usage = {}; this.stats = { trades: 0, dumps: 0 };
    this.subscriptions = new Map(); this.pending = new Map(); this.nextId = 0; this.queue = Promise.resolve(); this.running = false;
    this.health = { lastDiscoveryAt: null, discoveryComplete: false, discoveryError: null };
    this.callbacks = { onPool, onSwap, onExpired, onConnection, onGap };
    this.shouldSubscribe = shouldSubscribe;
    this.historyScans = {}; this.historyHeads = {};
    this.totalRpc = 0; this.abort = new AbortController();
  }
  log(type, data = {}) {
    const row = { time: new Date(this.now()).toISOString(), type, ...data };
    fs.appendFileSync(path.join(this.config.dataDir, `${row.time.slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n');
    if (type !== 'trade') console.log(JSON.stringify(row));
  }
  save() {
    const state = { version: 1, savedAt: this.now(), mode: this.callbacks.onSwap ? 'stonk-paper-shadow' : 'stonk-monitor-only', windowMs: WINDOW_MS,
      pools: [...this.pools.values()], cursors: this.cursors, historyScans: this.historyScans, historyHeads: this.historyHeads, usage: this.usage, stats: this.stats,
      health: { ...this.health, streamConnected: this.ws?.readyState === 1 && this.subscriptions.has('discovery'),
        subscribedPools: [...this.subscriptions.keys()].filter(k => k !== 'discovery').length } };
    const file = path.join(this.config.dataDir, 'state.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(file + '.tmp', file);
  }
  dayUsage() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    for (const d of Object.keys(this.usage)) if (d !== day) delete this.usage[d];
    return this.usage[day] ||= { rpc: 0, bytes: 0 };
  }
  async rpc(method, params, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.stopping) throw Error('Monitor stopping');
    if (this.dayUsage().rpc >= this.config.maxRpc) throw Error('RPC daily budget exhausted');
    this.dayUsage().rpc++; this.totalRpc++;
    if (this.rpcOverride) return this.rpcOverride(method, params, { signal });
    const response = await fetch(this.config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.any([AbortSignal.timeout(15000), this.abort.signal, ...(signal ? [signal] : [])]) });
    if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
    const result = await response.json(); if (result.error) throw Error(`RPC code ${result.error.code}`);
    return result.result;
  }
  expire() {
    for (const [id, p] of this.pools) if (!active(p, this.now())) { this.pools.delete(id); this.log('expired', { pool: id, graduatedAt: p.graduatedAt }); this.callbacks.onExpired?.(id); }
    for (const [id, time] of this.seen) if (this.now() - time > WINDOW_MS) this.seen.delete(id);
  }
  async process(raw, signature, discoveryOnly = false) {
    const receivedAt = raw.receivedAt || this.now();
    if (!signature || this.seen.has(signature)) return;
    if (this.stopping) return;
    const tx = normalize(raw); if (!tx) return;
    const found = migrations(tx);
    // Discovery subscriptions include curve trades; do not spend RPC resolving their timestamps.
    const relevant = tx.instructions.some(ix => this.pools.has(ix.accounts[3]));
    if (!found.length && (discoveryOnly || !relevant)) { this.seen.set(signature, this.now()); return; }
    if (!Number.isSafeInteger(tx.blockTime)) {
      tx.blockTime = this.blockTimes.get(tx.slot);
      if (!Number.isSafeInteger(tx.blockTime)) {
        try { tx.blockTime = await this.rpc('getBlockTime', [tx.slot]); }
        catch (e) {
          if (e.message !== 'RPC code -32004') throw e;
          // Recent confirmed slots may not yet be available from the block-time endpoint.
          const confirmed = await this.rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
          if (confirmed?.slot !== tx.slot || confirmed?.meta?.err !== null ||
              !confirmed.transaction?.signatures?.includes(signature)) throw Error('Missing chain block time');
          tx.blockTime = confirmed.blockTime;
        }
      }
    }
    if (!Number.isSafeInteger(tx.blockTime)) throw Error('Missing chain block time');
    this.blockTimes.set(tx.slot, tx.blockTime);
    if (this.blockTimes.size > 10000) this.blockTimes.delete(this.blockTimes.keys().next().value);
    if (this.seen.has(signature) || this.stopping) return;
    for (const p of found) {
      const record = { ...p, graduatedAt: tx.blockTime * 1000, signature, slot: tx.slot };
      if (!active(record, this.now()) || this.pools.has(p.pool)) continue;
      this.pools.set(p.pool, record); this.log('graduated', record); this.save(); this.syncSubscriptions(); this.callbacks.onPool?.(record);
    }
    if (!discoveryOnly) for (const trade of swaps(tx, this.pools, this.now())) {
      this.stats.trades++; this.log('trade', { ...trade, signature });
      await this.callbacks.onSwap?.({ ...trade, signature }, receivedAt);
      if (trade.side === 'sell' && trade.vaultRatioChangePct <= -this.config.dumpPct) {
        this.stats.dumps++; this.log('dump', { ...trade, signature });
      }
    }
    this.seen.set(signature, this.now());
  }
  async discover() {
    if (this.config.batchHistory) return this.discoverBatch();
    if (this.discovering) return;
    this.discovering = true;
    let completeScan = true;
    try {
      for (const platform of PLATFORMS) {
        if (this.stopping) return;
        const rows = []; let before, complete = false, head;
        for (let page = 0; page < this.config.historyPages; page++) {
          const batch = await this.rpc('getSignaturesForAddress', [platform, { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) }]);
          head ||= batch[0]?.signature;
          for (const row of batch) {
            if (row.signature === this.cursors[platform] || (Number.isSafeInteger(row.blockTime) && row.blockTime * 1000 < this.now() - WINDOW_MS)) { complete = true; break; }
            if (!row.err) rows.push(row);
          }
          if (complete || batch.length < 100) { complete = true; break; }
          before = batch.at(-1).signature;
        }
        for (const row of rows.reverse()) {
          if (this.stopping) return;
          if (this.seen.has(row.signature)) continue;
          const tx = await this.rpc('getTransaction', [row.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
          if (!tx) throw Error('History transaction temporarily unavailable');
          await this.process(tx, row.signature, true);
        }
        if (complete && head) this.cursors[platform] = head;
        else if (!complete) { completeScan = false; this.log('discovery_incomplete', { platform, reason: 'history_page_limit', scanned: rows.length }); }
      }
      this.health = { lastDiscoveryAt: this.now(), discoveryComplete: completeScan, discoveryError: completeScan ? null : 'history_page_limit' };
    } finally { this.discovering = false; this.save(); }
  }
  async discoverBatch() {
    if (this.discovering) return;
    this.discovering = true;
    let complete = true;
    try {
      for (const platform of PLATFORMS) {
        let scan = this.historyScans[platform];
        const end = Math.floor(this.now() / 1000) - 2;
        if (!scan) scan = this.historyScans[platform] = {
          start: Math.max(end - WINDOW_MS / 1000, (this.historyHeads[platform] ?? -Infinity) - 2), end, token: null };
        let finished = false;
        for (let page = 0; page < this.config.historyPages; page++) {
          if (this.stopping) return;
          const r = await this.rpc('getTransactionsForAddress', [platform, { transactionDetails: 'full', limit: 100,
            sortOrder: 'desc', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
            filters: { status: 'succeeded', blockTime: { gte: scan.start, lte: scan.end } },
            ...(scan.token ? { paginationToken: scan.token } : {}) }]);
          if (!Array.isArray(r?.data) || (r.paginationToken != null && typeof r.paginationToken !== 'string')) throw Error('Invalid history response');
          for (const tx of [...r.data].reverse()) {
            const signature = tx.transaction?.signatures?.[0];
            if (!signature) throw Error('Invalid history transaction');
            await this.process(tx, signature, true);
          }
          if (!r.paginationToken) {
            this.historyHeads[platform] = scan.end; delete this.historyScans[platform]; finished = true; this.save(); break;
          }
          if (r.paginationToken === scan.token) throw Error('History cursor did not advance');
          scan.token = r.paginationToken; this.save();
        }
        if (!finished || end - this.historyHeads[platform] > 60) complete = false;
      }
      this.health = { lastDiscoveryAt: this.now(), discoveryComplete: complete, discoveryError: complete ? null : 'history_catching_up' };
    } finally { this.discovering = false; this.save(); }
  }
  enqueue(work) {
    this.queued = (this.queued || 0) + 1;
    if (this.queued > 2000) { this.queued--; this.log('stream_gap', { reason: 'processing_queue_full' }); this.callbacks.onGap?.('processing_queue_full'); this.ws?.close(); return; }
    this.queue = this.queue.then(() => this.stopping ? undefined : work()).catch(e => {
      this.stats.processingErrors = (this.stats.processingErrors || 0) + 1;
      this.log('processing_error', { stage: 'realtime_transaction', ...diagnostic(e) });
      this.callbacks.onGap?.('transaction_processing_failed');
    })
      .finally(() => { this.queued--; });
  }
  send(method, params, key) {
    const id = ++this.nextId; this.pending.set(id, { method, key, at: this.now() });
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }
  syncSubscriptions() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const desired = new Set(['discovery', ...[...this.pools.keys()].filter(pool => this.shouldSubscribe(pool))]);
    for (const [key, id] of this.subscriptions) if (!desired.has(key)) {
      this.send('transactionUnsubscribe', [id], key); this.subscriptions.delete(key);
    }
    for (const key of desired) {
      if (this.subscriptions.has(key) || [...this.pending.values()].some(p => p.key === key && p.method === 'transactionSubscribe')) continue;
      this.send('transactionSubscribe', [{ vote: false, failed: false, accountInclude: key === 'discovery' ? PLATFORMS : [key],
        ...(key === 'discovery' ? { accountRequired: [LAUNCHLAB, CPMM] } : {}) },
        { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 0 }], key);
    }
  }
  connect() {
    if (!this.running || this.dayUsage().bytes >= this.config.maxBytes) return;
    if (this.ws && [0, 1, 2].includes(this.ws.readyState)) return;
    const ws = this.ws = this.socketFactory(this.config.wsUrl);
    this.connectAt = this.now();
    ws.addEventListener('open', () => { this.lastMessage = this.now(); this.log('connected'); this.send('slotSubscribe', [], 'heartbeat'); this.syncSubscriptions(); this.recover(); });
    ws.addEventListener('message', event => {
      this.lastMessage = this.now();
      this.dayUsage().bytes += Buffer.byteLength(String(event.data));
      if (this.dayUsage().bytes >= this.config.maxBytes) { this.log('stream_budget_exhausted'); ws.close(); return; }
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (msg.error) { this.log('subscription_error', { code: msg.error.code }); ws.close(); return; }
          if (pending?.method === 'transactionSubscribe') { this.attempt = 0; this.subscriptions.set(pending.key, msg.result); this.syncSubscriptions(); if (pending.key === 'discovery') this.callbacks.onConnection?.(true); }
          return;
        }
        if (msg.method !== 'transactionNotification') return;
        const r = msg.params.result;
        const incoming = { ...r.transaction, slot: r.slot, blockTime: r.blockTime ?? r.transaction.blockTime, receivedAt: this.now() };
        this.enqueue(() => this.process(incoming, r.signature));
      } catch { this.log('invalid_notification'); }
    });
    ws.addEventListener('error', () => { this.log('stream_network_error'); ws.close(); });
    ws.addEventListener('close', () => {
      this.subscriptions.clear(); this.pending.clear(); this.log('disconnected'); this.callbacks.onConnection?.(false);
      if (this.running) this.retry = setTimeout(() => this.connect(), Math.min(60000, 1000 * 2 ** Math.min(this.attempt = (this.attempt || 0) + 1, 6)));
    });
  }
  start() {
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    const lockPath = path.join(this.config.dataDir, 'monitor.lock');
    try { this.lock = fs.openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lockPath, 'utf8')); if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid monitor lock; inspect before removing');
      try { process.kill(pid, 0); throw Error('Monitor already running'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      fs.unlinkSync(lockPath); this.lock = fs.openSync(lockPath, 'wx');
    }
    fs.writeFileSync(this.lock, String(process.pid));
    const file = path.join(this.config.dataDir, 'state.json');
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !['stonk-monitor-only', 'stonk-paper-shadow'].includes(state.mode)) throw Error('Incompatible Stonk state');
      this.pools = new Map(state.pools.filter(p => PLATFORMS.includes(p.platform) && active(p, this.now())).map(p => [p.pool, p]));
      this.cursors = state.cursors || {}; this.usage = state.usage || {}; this.stats = state.stats || this.stats;
      this.historyScans = state.historyScans || {}; this.historyHeads = state.historyHeads || {};
    }
    for (const p of this.pools.values()) this.callbacks.onPool?.(p);
    this.running = true; this.log('starting', { mode: 'stonk-paper-shadow', windowMinutes: 30 }); this.connect();
    this.tick = setInterval(() => {
      this.expire(); this.syncSubscriptions(); this.save();
      if (this.ws?.readyState === 0 && this.now() - this.connectAt > 20000) this.ws.close();
      if (this.ws?.readyState === 1 && this.now() - this.lastMessage > 30000) { this.log('stream_heartbeat_timeout'); this.ws.close(); }
      if ([...this.pending.values()].some(p => this.now() - p.at > 15000)) this.ws?.close();
    }, 1000);
    this.recovery = setInterval(() => {
      if (this.dayUsage().bytes < this.config.maxBytes && (!this.ws || this.ws.readyState === 3)) this.connect();
      this.recover();
    }, 60000);
  }
  async stop() {
    this.stopping = true; this.abort.abort(); this.running = false; clearInterval(this.tick); clearInterval(this.recovery); clearTimeout(this.retry); this.ws?.close();
    await this.queue; await this.recoveryWork; this.save();
    if (this.lock !== undefined) { fs.closeSync(this.lock); fs.unlinkSync(path.join(this.config.dataDir, 'monitor.lock')); }
  }
  recover() {
    if (this.discovering) return;
    this.recoveryWork = this.discover().catch(e => {
      this.health.discoveryComplete = false; this.health.discoveryError = 'rpc_or_transaction_unavailable';
      this.log('discovery_error', { stage: 'history_discovery', ...diagnostic(e) }); this.save();
    });
  }
}
module.exports = { Monitor, config };
