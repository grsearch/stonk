'use strict';
const $ = id => document.getElementById(id); let token = '', loading = false, page = 1, pageSize = 20;
const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const date = t => t ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const short = v => v ? `${v.slice(0, 5)}…${v.slice(-5)}` : '—';
const text = (id, value) => { $(id).textContent = value; };
function cell(row, value, cls) { const c = document.createElement('td'); c.textContent = value; if (cls) c.className = cls; row.append(c); return c; }
function empty(id, columns) { const row = document.createElement('tr'), c = cell(row, '暂无可展示记录'); c.colSpan = columns; $(id).append(row); }
function mintCell(row, mint) {
  const c = cell(row, short(mint)); c.title = mint || '';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || '')) {
    const a = document.createElement('a'); a.href = `https://gmgn.ai/sol/token/${mint}`; a.textContent = `${short(mint)} ↗`;
    a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = mint; c.replaceChildren(a);
  }
  return c;
}
function render(s) {
  text('mode', s.mode === 'live' ? '实盘' : '模拟交易'); text('connection', { connected: '行情已连接', degraded: '已连接 · 覆盖未完整', blocked: '已连接 · 处理受阻', disconnected: '行情已断开', unknown_or_stale: '状态未知 / 已过期' }[s.status]);
  text('updated', `面板读取：${date(s.at)}`); const running = s.runningConfig;
  text('size', `${fmt(running?.sizeSol ?? s.configured.sizeSol)} SOL`);
  text('config-note', running ? `启动记录 · 文件配置 ${fmt(s.configured.sizeSol)} SOL` : '仅文件配置，尚无启动记录确认');
  text('positions', `${s.stateUpdatedAt === null ? '—' : s.positions.length} / ${running?.maxPositions ?? s.configured.maxPositions}`);
  text('state-age', `状态落盘：${date(s.stateUpdatedAt)}`); text('samples', fmt(s.shadow.samples, 0));
  text('sample-note', `活跃 ${fmt(s.shadow.active, 0)} · 丢弃 ${fmt(s.shadow.dropped, 0)}`);
  text('traffic', `${fmt(s.health.streamMBToday)} MB`); text('credits', `流量估算 ${fmt(s.health.estimatedStreamCreditsToday)} credits · UTC 日`);
  const pnl = s.pnl24h;
  text('pnl-title', s.mode === 'live' ? '最近 24 小时 · 已平仓净收益估计' : '最近 24 小时 · 模拟已平仓账面收益');
  text('pnl-total', pnl ? `${fmt(pnl.totalSol, 6)} SOL` : '—'); $('pnl-total').className = pnl?.totalSol < 0 ? 'negative' : 'positive';
  text('pnl-closed', pnl ? `${pnl.closed} 笔` : '—'); text('pnl-winrate', pnl ? `${fmt(pnl.winRatePct)}${pnl.winRatePct === null ? '' : '%'}` : '—');
  text('pnl-counts', pnl ? `盈利 ${pnl.wins} · 亏损 ${pnl.losses} · 持平 ${pnl.flat} · 金额缺失 ${pnl.unknown}` : '等待完整交易日志');
  text('pnl-window', pnl ? `${date(pnl.start)} — ${date(pnl.end)}` : '暂不可用');
  text('pnl-note', pnl ? `${pnl.fullWindowAvailable ? '已扫描完整保留日志，不保证中间无断流。' : '日志不足完整 24 小时，按现有记录统计。'}${pnl.unknown ? ' 金额缺失的平仓未计入总额和胜率。' : ''}${pnl.invalidLines ? ' 存在损坏日志，结果可能不完整。' : ''} ${s.mode === 'live' ? '不含未平仓浮盈亏、退租及其他失败交易成本。' : '未扣除完整滑点和费用；不含未平仓浮盈亏。'}` : '日志不可读不代表盈亏为零。');
  $('warnings').replaceChildren(); for (const w of s.warnings) { const p = document.createElement('p'); p.className = 'warning'; p.textContent = w; $('warnings').append(p); }
  if (s.status === 'unknown_or_stale') { const p = document.createElement('p'); p.className = 'warning'; p.textContent = '超过 2 分钟没有新健康记录，或程序仍在启动。请勿把历史数据当作当前连接状态。'; $('warnings').append(p); }
  $('observation').replaceChildren();
  for (const [k, v] of [['模型状态', s.shadow.model || '暂无模型状态'], ['累计结果 / 缺失结果', `${fmt(s.shadow.outcomes, 0)} / ${fmt(s.shadow.censored, 0)}`], ['RPC 累计请求', fmt(s.health.rpcRequests, 0)], ['最近上传窗口截止', date(s.upload?.lastSuccessEnd)], ['下次待传窗口截止', date(s.upload?.nextEnd)], ['等待账户回收', `${s.cleanup.length} 个`]]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; $('observation').append(dt, dd); }
  text('pending', `${s.pending.length} 笔待确认 · 行情健康记录 ${s.healthAgeMs === null ? '未知' : Math.max(0, Math.floor(s.healthAgeMs / 1000)) + ' 秒前'}`);
  $('position-rows').replaceChildren(); for (const p of s.positions) { const r = document.createElement('tr'); mintCell(r, p.mint); cell(r, `${fmt(p.entrySol, 6)} SOL`); cell(r, p.spotPnlPct === null ? '—' : `${fmt(p.spotPnlPct)}%`, p.spotPnlPct >= 0 ? 'positive' : 'negative'); cell(r, p.openedAt ? `${fmt((s.at - p.openedAt) / 60000, 1)} 分钟` : '—'); cell(r, date(p.lastPriceAt)); $('position-rows').append(r); } if (!s.positions.length) empty('position-rows', 5);
  const labels = { paper_censored: '观察到期／结果未知', paper_buy: '模拟买入', paper_sell: '模拟卖出', buy_submitted: '买入已提交', sell_submitted: '卖出已提交', buy_confirmed: '买入已确认', sell_confirmed: '卖出已确认', transaction_failed: '交易失败', account_closed: '账户已关闭' };
  $('trade-rows').replaceChildren(); for (const t of s.trades) { const r = document.createElement('tr'); cell(r, date(t.time)); cell(r, labels[t.type] || t.type); mintCell(r, t.mint); const value = t.netPnlSol ?? t.grossPnlSol ?? t.quoteSol ?? t.entrySol; cell(r, value === undefined ? '—' : `${fmt(value, 6)} SOL${t.netPnlSol !== undefined ? ' 净收益估计' : t.grossPnlSol !== undefined ? ' 账面收益' : ''}`); cell(r, (t.reason === 'quote_timeout' ? '行情超时退出' : t.reason) || (t.receiveToSendMs !== undefined ? `${fmt(t.receiveToSendMs)} ms 发送前` : t.confirmMs !== undefined ? `${fmt(t.confirmMs)} ms 确认` : '—')); const link = cell(r, '—'); if (/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(t.signature || '')) { const a = document.createElement('a'); a.href = `https://solscan.io/tx/${t.signature}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '链上 ↗'; link.replaceChildren(a); } $('trade-rows').append(r); } if (!s.trades.length) empty('trade-rows', 6);
  const pages = s.pagination; page = pages?.page || 1;
  text('page-info', pages ? `第 ${page} / ${pages.totalPages} 页 · 共 ${pages.total} 条` : '分页暂不可用');
  $('prev-page').disabled = !pages || page <= 1; $('next-page').disabled = !pages || page >= pages.totalPages;
  const svg = $('chart'); svg.replaceChildren(); const history = s.history.filter(h => Number.isFinite(h.positions));
  if (history.length > 1) { const max = Math.max(1, ...history.map(h => h.positions)); const points = history.map((h, i) => `${10 + i * 700 / (history.length - 1)},${140 - h.positions / max * 120}`).join(' '); const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); line.setAttribute('points', points); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#76e4bd'); line.setAttribute('stroke-width', '2'); svg.append(line); text('chart-range', `${date(history[0].time)} — ${date(history.at(-1).time)} · 最高 ${max} 仓`); } else text('chart-range', '至少两条健康日志后展示趋势');
}
async function refresh() { if (loading) return; loading = true;
  try { const response = await fetch(`/api/status?page=${page}&pageSize=${pageSize}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000) }); if (response.status === 401) { $('auth').classList.remove('hidden'); throw new Error('需要有效的 dashboard 访问令牌。'); } if (!response.ok) throw new Error('面板暂时不可用，请检查服务。'); render(await response.json()); $('auth').classList.add('hidden'); $('error').classList.add('hidden'); }
  catch (e) { text('error', e.name === 'TimeoutError' ? '读取超时。当前显示的数据可能已过期。' : e.message); $('error').classList.remove('hidden'); text('connection', '面板连接中断 / 未认证'); }
  finally { loading = false; }
}
$('refresh').addEventListener('click', refresh); $('unlock').addEventListener('click', () => { token = $('token').value; $('token').value = ''; refresh(); }); refresh(); setInterval(refresh, 5000);
$('prev-page').addEventListener('click', () => { if (!loading && page > 1) { page--; refresh(); } });
$('next-page').addEventListener('click', () => { if (!loading) { page++; refresh(); } });
$('page-size').addEventListener('change', () => { pageSize = Number($('page-size').value); page = 1; refresh(); });
