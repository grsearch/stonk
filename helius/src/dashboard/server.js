'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { publicConfig } = require('../reporting/archive');
const { Ledger } = require('./ledger');
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
function options(env = process.env) {
  const host = env.DASHBOARD_HOST || '127.0.0.1', port = Number(env.DASHBOARD_PORT || 8787), token = env.DASHBOARD_TOKEN || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dashboard port');
  if (!LOOPBACK.has(host) && token.length < 24) throw new Error('Non-loopback dashboard requires token of at least 24 characters');
  const publicOrigin = env.DASHBOARD_PUBLIC_ORIGIN ? new URL(env.DASHBOARD_PUBLIC_ORIGIN) : null;
  if (publicOrigin && (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash || token.length < 24)) throw new Error('Public origin requires HTTPS and dashboard token');
  return { host, port, token, publicOrigin: publicOrigin?.origin };
}
async function tail(file, limit = 2 * 1024 * 1024) {
  const fd = await fs.open(file, 'r');
  try {
    const stat = await fd.stat(), start = Math.max(0, stat.size - limit), buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8'); if (start) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n'); lines.pop(); const rows = []; let invalid = 0;
    for (const line of lines) { try { rows.push(JSON.parse(line)); } catch (_) { invalid++; } }
    return { rows, truncated: start > 0, invalid };
  } finally { await fd.close(); }
}
async function snapshot(c, exportDirectory, now = Date.now()) {
  const warnings = []; let state = {}, mtime = null, logs = { rows: [] };
  try {
    const stat = await fs.stat(c.stateFile); if (stat.size > 16 * 1024 * 1024) throw new Error();
    state = JSON.parse(await fs.readFile(c.stateFile, 'utf8')); mtime = stat.mtimeMs;
  } catch (_) { warnings.push('持仓状态暂不可读；不代表空仓。'); }
  try { logs = await tail(`${c.stateFile}.jsonl`); } catch (_) { warnings.push('运行日志暂不可读。'); }
  if (logs.truncated) warnings.push('健康图表读取日志末尾 2 MB；24 小时盈亏与分页另行读取完整日志。');
  if (logs.invalid) warnings.push('日志中有无法解析的行。');
  const last = type => logs.rows.findLast(r => r.type === type);
  const starting = last('starting'), startAt = Date.parse(starting?.time) || 0;
  const current = logs.rows.filter(r => Date.parse(r.time) >= startAt);
  const health = current.findLast(r => r.type === 'health'), shadow = current.findLast(r => r.type === 'shadow_health');
  const healthAgeMs = health ? now - Date.parse(health.time) : null;
  const positions = Object.entries(state.positions || {}).map(([mint, p]) => ({ mint,
    ...pick(p, ['pool', 'rawAmount', 'entrySol', 'entryPrice', 'lastPrice', 'lastPriceAt', 'openedAt', 'buySignature']),
    spotPnlPct: p.entryPrice > 0 && Number.isFinite(p.lastPrice) ? (p.lastPrice / p.entryPrice - 1) * 100 : null }));
  const trades = logs.rows.filter(r => /^(paper_buy|paper_sell|buy_confirmed|sell_confirmed|buy_submitted|sell_submitted|transaction_failed|account_closed)$/.test(r.type)).slice(-60).reverse().map(r => pick(r,
    ['time', 'type', 'mint', 'pool', 'signature', 'positionId', 'reason', 'entrySol', 'quoteSol', 'rawAmount', 'netPnlSol', 'grossPnlSol', 'spotPnlPct', 'confirmMs', 'receiveToSendMs', 'networkFeeSol', 'assumedTipSol', 'heldMs']));
  let upload = null;
  try {
    const cursor = JSON.parse(await fs.readFile(path.join(exportDirectory, 'upload-state.json'), 'utf8'));
    upload = pick(cursor, ['lastSuccessEnd', 'nextEnd']);
  } catch (_) { warnings.push('尚无 COS 上传进度，或上传任务尚未配置。'); }
  return { at: now, mode: state.mode || (c.dryRun ? 'paper' : 'live'), stateUpdatedAt: mtime,
    status: healthAgeMs === null || healthAgeMs > 120000 ? 'unknown_or_stale' : health.connected ? 'connected' : 'disconnected', healthAgeMs,
    configured: publicConfig(c), runningConfig: starting?.strategyConfig ? publicConfig(starting.strategyConfig) : null,
    startedAt: startAt || null, health: pick(health, ['time', 'connected', 'transactions', 'parsedSwaps', 'rpcRequests', 'positions', 'pending', 'streamMBToday', 'estimatedStreamCreditsToday']),
    shadow: pick(shadow, ['time', 'status', 'samples', 'outcomes', 'censored', 'active', 'queueDepth', 'dropped', 'model']),
    positions, pending: Object.values(state.pending || {}).map(p => pick(p, ['side', 'mint', 'signature', 'submittedAt'])),
    cleanup: Object.values(state.cleanup || {}).map(p => pick(p, ['mint', 'soldAt', 'dueAt'])), trades, upload, warnings,
    history: current.filter(r => r.type === 'health').slice(-120).map(r => pick(r, ['time', 'positions', 'streamMBToday', 'transactions'])) };
}
function createServer(c, opts, exportDirectory) {
  let cache, cacheAt = 0, loading;
  const ledger = new Ledger(`${c.stateFile}.jsonl`);
  const tokenHash = crypto.createHash('sha256').update(opts.token).digest();
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    try {
      if (req.method !== 'GET') return send(405, '{"error":"read_only"}');
      const url = new URL(req.url, 'http://localhost');
      if (LOOPBACK.has(opts.host) && !LOOPBACK.has(new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '')) && req.headers.host !== (opts.publicOrigin && new URL(opts.publicOrigin).host)) return send(403, '{"error":"host"}');
      if (url.pathname === '/api/status') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host && req.headers.origin !== opts.publicOrigin) return send(403, '{"error":"origin"}');
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (opts.token && !crypto.timingSafeEqual(tokenHash, crypto.createHash('sha256').update(bearer).digest())) return send(401, '{"error":"unauthorized"}');
        const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 20);
        if (!Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) return send(400, '{"error":"invalid_page"}');
        if (!cache || Date.now() - cacheAt > 4000) {
          loading ||= snapshot(c, exportDirectory).then(async value => {
            try { await ledger.update(value.at); value.ledgerAvailable = true; }
            catch (_) { value.ledgerAvailable = false; value.warnings.push('24 小时交易日志读取失败，盈亏和分页暂不可用。'); }
            cache = value; cacheAt = Date.now();
          }).finally(() => { loading = null; });
          await loading;
        }
        return send(200, JSON.stringify({ ...cache, trades: [], ...(cache.ledgerAvailable ? ledger.view(cache.mode, cache.at, page, pageSize) : { pnl24h: null, pagination: null }) }));
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (!assets[url.pathname]) return send(404, '{"error":"not_found"}');
      const [file, type] = assets[url.pathname]; return send(200, await fs.readFile(path.join(__dirname, file)), `${type}; charset=utf-8`);
    } catch (_) { send(503, '{"error":"dashboard_unavailable"}'); }
  });
}
module.exports = { options, tail, snapshot, createServer };
