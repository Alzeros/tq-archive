import { setupThemeToggle } from '/theme.js';
import { nodePicker } from '/picker.js';

// nodes / reports 只含已启用的节点及其报告，界面各处直接用；allNodes / allReports 供选择器搜索全部节点
const state = { nodes: [], reports: [], allNodes: [], allReports: [], pending: [], metricNames: {}, selectedNodeId: null, detail: null, insight: null, heatmap: { matrixId: null, metricId: null }, compare: { node: '', result: null }, trend: null };
// 选择器实例：预览导入的归属选择与详情页改绑各持一个，避免互相覆盖
let previewPicker = null;
let bindPicker = null;
const el = id => document.getElementById(id);
const sectionNames = { ipv4: 'IPv4 回程', large4: 'IPv4 大包回程', ipv6: 'IPv6 回程', cernet: '教育网回程', intl: '国际互联', speedtest: '单线程测速' };

function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}
async function api(path, options) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  // 会话过期时立即回登录页，避免后续请求连环报错
  if (response.status === 401 && path !== '/api/login') { location.replace('/login'); throw new Error('请先登录'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
const fmtTime = iso => new Date(iso).toLocaleString('zh-CN', { hour12: false });
// 标题里放完整秒数太碎，只到分钟即可
const fmtShort = iso => {
  const date = new Date(iso);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const nodeName = id => state.allNodes.find(node => node.id === id)?.name || id;
const metricLabel = key => state.metricNames[key] || key;
const metricText = measurement => {
  if (!measurement) return '—';
  if (measurement.status === 'unknown') return measurement.raw || '—';
  if (typeof measurement.value === 'number') return `${measurement.value}${measurement.unit || ''}`;
  return measurement.value ?? '—';
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const COLLAPSED_KEY = 'tq_collapsed_groups';
const collapsedGroups = new Set(readCollapsed());
// 同一轮渲染里 trends 会为已打开的详情重复请求 /api/reports/:id，
// 用 Map 做个会话级小缓存把往返压到每份报告一次
const detailCache = new Map();
function fetchDetail(id) {
  if (!detailCache.has(id)) {
    detailCache.set(id, api(`/api/reports/${id}`).catch(error => {
      detailCache.delete(id);
      throw error;
    }));
  }
  return detailCache.get(id);
}
function readCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); } catch { return []; }
}
function persistCollapsed() {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups])); } catch { /* 隐私模式下忽略 */ }
}
function toggleGroup(city, currentlyCollapsed) {
  // 三态记忆：city=手动折叠，!city=手动展开，都没有=默认（无数据组折叠）
  if (currentlyCollapsed) { collapsedGroups.add(`!${city}`); collapsedGroups.delete(city); }
  else { collapsedGroups.add(city); collapsedGroups.delete(`!${city}`); }
  persistCollapsed();
  renderNodes();
}

function reportsByNode(reports = state.reports) {
  const map = new Map();
  for (const report of reports) {
    if (!map.has(report.nodeId)) map.set(report.nodeId, []);
    map.get(report.nodeId).push(report);
  }
  return map;
}
// 活跃度排序：有数据的节点按最近一次测试时间排前，无数据保持探针顺序
function byActivity(list, reportsOf, lastTested) {
  return [...list].sort((a, b) => {
    const ta = lastTested(a.id), tb = lastTested(b.id);
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return (a.order || 0) - (b.order || 0);
  });
}

function renderNodes() {
  const filter = el('nodeFilter').value.trim().toLowerCase();
  const visible = state.nodes.filter(node => !filter || node.name.toLowerCase().includes(filter) || (node.region || '').toLowerCase().includes(filter));
  const reportsOf = reportsByNode();
  const lastTested = id => (reportsOf.get(id) || []).map(report => report.testedAt).sort().at(-1) || '';
  const groups = new Map();
  for (const node of visible) {
    const city = node.name.split('-')[0] || node.region || '其他';
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(node);
  }
  const list = el('nodeList');
  list.innerHTML = '';
  if (!state.allNodes.length) { list.innerHTML = '<p class="empty">还没有节点，先到 <a href="/nodes.html">节点管理</a> 从探针同步。</p>'; return; }
  if (!state.nodes.length) { list.innerHTML = '<p class="empty">还没有启用的节点，到 <a href="/nodes.html">节点管理</a> 打开要测试的节点。</p>'; return; }
  if (!visible.length) { list.innerHTML = '<p class="empty">没有匹配的节点。</p>'; return; }
  const ordered = [...groups.entries()].sort(([, aNodes], [, bNodes]) => {
    const latest = nodes => nodes.reduce((max, node) => { const t = lastTested(node.id); return t > max ? t : max; }, '');
    const ta = latest(aNodes), tb = latest(bNodes);
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return 0;
  });
  for (const [city, groupNodes] of ordered) {
    const nodes = byActivity(groupNodes, reportsOf, lastTested);
    const hasData = nodes.some(node => (reportsOf.get(node.id) || []).length);
    // 搜索时强制展开；未手动操作过的分组默认折叠「整组都无数据」的，避免淹没在空节点里
    const userCollapsed = collapsedGroups.has(city);
    const userExpanded = collapsedGroups.has(`!${city}`);
    const collapsed = !filter && (userCollapsed || (!userExpanded && !hasData));
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'node-group' + (collapsed ? ' collapsed' : '');
    label.setAttribute('aria-expanded', String(!collapsed));
    label.innerHTML = `<span class="caret"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg></span><span class="group-name">${escapeHtml(city)}</span><span class="group-count">${nodes.length}</span>`;
    label.addEventListener('click', () => toggleGroup(city, collapsed));
    list.append(label);
    if (collapsed) continue;
    for (const node of nodes) {
      const count = (reportsOf.get(node.id) || []).length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'node' + (node.id === state.selectedNodeId ? ' active' : '') + (count ? '' : ' idle');
      button.innerHTML = `<span class="node-title"><span class="node-dot ${count ? 'active' : 'idle'}"></span><span class="node-name-text">${escapeHtml(node.name)}</span></span><span class="count">${count ? `${count} 份` : ''}</span>`;
      button.addEventListener('click', () => selectNode(node.id));
      list.append(button);
    }
  }
}
function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  renderNodes();
  renderHistory();
  showView('history');
  // 收起详情后主区会留下大片空白，把视图拉回历史列表
  document.querySelector('.content').scrollTop = 0;
}
// 切换节点必须丢掉上一个节点的详情卡片：否则右侧继续显示别的节点的报告，
// 而标题与归属已经换成新节点，看起来就像"这份报告属于新节点"。
function dropForeignDetail() {
  if (!state.detail || state.detail.nodeId === state.selectedNodeId) return;
  state.detail = null;
  state.insight = null;
  bindPicker = null;
  el('detailCard').classList.add('hidden');
  el('bindPanel').classList.add('hidden');
}
// ============ 历史趋势：跨报告的时间轴视图 ============
// 历史列表按报告排列，看不出"这条路是不是越来越差"。把每份报告的
// 核心指标（延迟 p50 / 丢包数 / 回程速度）抽出来按测试时间连成三个
// 小图：线连数据走势，点的颜色按报告的档位（绿=好，黄=一般，红=差）。
// 点击任一点打开该报告的详情。首尾对比超过 8% 时给个箭头摘要。
const TREND_DEFS = [
  { key: 'latency', label: '国内回程延迟', note: 'p50 · 越低越好', lowerBetter: true },
  { key: 'loss', label: '丢包/重传', note: '严重优先 · 越低越好', lowerBetter: true },
  { key: 'speed', label: '回程速度', note: '回程 · 越高越好', lowerBetter: false }
];
let trendRequestToken = 0;
async function renderTrends(reports) {
  const panel = el('trendPanel');
  const token = ++trendRequestToken;
  if (reports.length < 2) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="trend-loading">载入趋势…</p>';
  state.trend = { mode: 'all', reports: [...reports].sort((left, right) => left.testedAt.localeCompare(right.testedAt)), carriers: null };
  try {
    const details = await Promise.all(state.trend.reports.map(report => fetchDetail(report.id)));
    if (token !== trendRequestToken) return;
    state.trend.details = [...details].sort((left, right) => left.testedAt.localeCompare(right.testedAt));
    drawTrendPanel();
    // 运营商口径是趋势最有价值的一维，默认就一起拉（一台机器的历史通常几份到几十份）
    loadCarrierTrend(token);
  } catch (error) {
    if (token !== trendRequestToken) return;
    panel.innerHTML = `<p class="empty">趋势加载失败：${escapeHtml(error.message)}</p>`;
  }
}
// 同一节点的历史：节点 + 报告集合没变就不重复请求（切换视图时要用同一份数据）
let carrierTrendKey = '';
async function loadCarrierTrend(token) {
  const trend = state.trend;
  if (!trend) return;
  const nodeId = trend.reports[0].nodeId;
  const key = `${nodeId}:${trend.reports.map(report => report.id).join(',')}`;
  if (carrierTrendKey !== key) {
    try {
      const data = await api(`/api/stats?group=report&node=${encodeURIComponent(nodeId)}&split=carrier`);
      if (token !== trendRequestToken || !state.trend) return;
      // 只要选中节点的那几份：接口按节点返回，可能还包含更早的报告
      const ids = new Set(trend.reports.map(report => report.id));
      state.trend.carriers = new Map(data.groups.filter(group => ids.has(group.key)).map(group => [group.key, group]));
      carrierTrendKey = key;
    } catch {
      // 拿不到运营商数据不该让整块趋势消失：整机视图仍然可用
      if (token === trendRequestToken && state.trend) state.trend.carriers = new Map();
    }
  }
  if (token === trendRequestToken) drawTrendPanel();
}
const CARRIER_COLORS = { 电信: 'var(--teal)', 联通: 'var(--amber, #d89614)', 移动: 'var(--red)' };
const CARRIER_ORDER = ['电信', '联通', '移动'];
// 趋势视图：全部（原有三条整机线）/ 运营商延迟 / 运营商丢包。
// 后两者回答的是存档最该回答的问题 —— "这台机器的移动是不是一直在绕"、
// "某家丢包从哪一份开始变" —— 整机口径会把三家的差异平均掉。
function trendCarrierSeries(trend, field) {
  return CARRIER_ORDER.filter(carrier => trend.reports.some((_, index) => {
    const stat = trend.carriers?.get(trend.reports[index].id);
    const value = stat?.carriers?.[carrier]?.[field];
    return typeof value === 'number';
  })).map(carrier => ({
    key: carrier,
    label: carrier,
    color: CARRIER_COLORS[carrier],
    unit: field === 'latency' ? 'ms' : '条',
    lowerBetter: true,
    values: trend.reports.map((_, index) => {
      const value = trend.carriers?.get(trend.reports[index].id)?.carriers?.[carrier]?.[field];
      return typeof value === 'number' ? value : null;
    })
  }));
}
function drawTrendPanel() {
  const panel = el('trendPanel');
  const trend = state.trend;
  if (!panel || !trend?.details) return;
  const modes = [
    ['all', '全部指标', ''],
    ['latency', '运营商延迟', '每家运营商的回程延迟 p50，看谁一直在绕路'],
    ['loss', '运营商丢包线路', '每家运营商有多少条线路在丢包，看问题从哪一份开始']
  ];
  const tabs = `<div class="trend-tabs">${modes.map(([id, label, title]) => `<button type="button" class="trend-tab${trend.mode === id ? ' active' : ''}" data-mode="${id}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`).join('')}</div>`;
  let body = '';
  if (trend.mode === 'all') {
    body = drawTrends(trend.details);
  } else {
    const field = trend.mode === 'latency' ? 'latency' : 'lines';
    const series = trendCarrierSeries(trend, field);
    if (!series.length) {
      body = `<p class="empty">${trend.carriers ? '这几份报告里没有可用的运营商数据。' : '正在载入运营商数据…'}</p>`;
    } else {
      const note = field === 'latency'
        ? '三家的 p50 分开画：整机口径会把绕路的那家平均掉'
        : '每条线是"该运营商有多少条线路丢包/重传"，0 是正常，抬头就是那家开始出问题';
      body = `<div class="trend-grid">${series.map(serie => svgForSeries(trend.reports, { ...serie, note })).join('')}</div>`;
    }
  }
  panel.innerHTML = `${tabs}<div class="trend-body">${body}</div>`;
  for (const button of panel.querySelectorAll('.trend-tab')) {
    button.addEventListener('click', () => { state.trend.mode = button.dataset.mode; drawTrendPanel(); });
  }
  for (const point of panel.querySelectorAll('button.tp')) {
    point.addEventListener('click', () => openDetail(point.dataset.id));
  }
}
// 原有三条整机走势。返回 HTML，由 drawTrendPanel 决定放不放进面板
function drawTrends(points) {
  // 每个图至少要有 2 个有数值的点才有"走势"可言。单线/全空时整格隐藏
  const series = TREND_DEFS.map(def => {
    const cardList = points.map(report => (report.insight?.cards || []).find(card => card.id === def.key));
    const values = cardList.map(card => (card && typeof card.value === 'number') ? card.value : null);
    const present = values.filter(value => value !== null);
    // 有 2 个及以上数据点就画，哪怕数值完全一样——长期平稳本身就是信息
    if (present.length < 2) return null;
    return {
      ...def,
      values,
      levels: cardList.map(card => card?.level || null),
      unit: cardList.find(card => card?.unit)?.unit || ''
    };
  }).filter(Boolean);
  if (!series.length) return '<p class="empty">还不够画出走势：至少需要两份含同类指标的报告。</p>';
  return `<div class="trend-grid">${series.map(serie => svgForSeries(points, serie)).join('')}</div>`;
}
function svgForSeries(points, serie) {
  const W = 320, H = 76, PAD = 10;
  const usableW = W - PAD * 2;
  const usableH = H - PAD * 2;
  const present = serie.values.filter(value => value !== null);
  const min = Math.min(...present), max = Math.max(...present);
  const spread = Math.max(1e-9, max - min);
  const total = Math.max(1, points.length - 1);
  const coords = serie.values.map((value, index) => {
    if (value === null) return null;
    const x = points.length === 1 ? W / 2 : PAD + (index / total) * usableW;
    const y = points.length === 1 ? H / 2 : H - PAD - ((value - min) / spread) * usableH;
    return { x, y, index, value };
  }).filter(Boolean);
  const path = coords.length >= 2 ? `M${coords.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')}` : '';
  const areaPath = coords.length >= 2 
    ? `M${coords[0].x.toFixed(1)},${H - PAD} L${coords.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')} L${coords.at(-1).x.toFixed(1)},${H - PAD} Z` 
    : '';
  const gradId = `trendGrad_${serie.key}_${Math.random().toString(36).slice(2, 8)}`;
  // 多序列（三家运营商）必须能分清谁是谁：颜色由 serie.color 给，缺省沿用原来的青色
  const color = serie.color || 'var(--teal)';

  let summary = '';
  if (coords.length >= 2) {
    const first = coords[0], last = coords.at(-1);
    const delta = last.value - first.value;
    if (Math.abs(delta) >= Math.max(spread * 0.08, 1)) {
      const worse = serie.lowerBetter ? delta > 0 : delta < 0;
      const arrow = delta > 0 ? '↑' : '↓';
      summary = `<span class="trend-delta ${worse ? 'bad' : 'good'}">${arrow} ${Math.abs(Math.round(delta))}${escapeHtml(serie.unit)}</span>`;
    }
  }
  const range = spread > 1 ? `${Math.round(min)}–${Math.round(max)}${serie.unit}` : `${Math.round(min)}${serie.unit}`;
  const dots = serie.values.map((value, index) => {
    const report = points[index];
    const title = `${fmtShort(report.testedAt)} · ${value === null ? '无数据' : `${value}${serie.unit}`}`;
    return `<button type="button" class="tp" data-id="${report.id}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></button>`;
  }).join('');
  return `<div class="trend-cell">
    <div class="trend-head">
      <span class="trend-label">${escapeHtml(serie.label)}</span>
      <span class="trend-note">${escapeHtml(serie.note)}</span>
    </div>
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${areaPath ? `<path class="trend-area" fill="url(#${gradId})" d="${areaPath}"/>` : ''}
      ${path ? `<path class="trend-line" style="stroke:${color}" d="${path}"/>` : ''}
      ${coords.map(point => `<circle class="tp l${serie.levels[point.index] || 'na'}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5"/>`).join('')}
    </svg>
    <div class="trend-dots">${dots}</div>
    <div class="trend-foot">
      <span class="trend-range">波动区间 ${escapeHtml(range)}</span>
      ${summary}
    </div>
  </div>`;
}
function renderHistory() {
  const list = el('historyList');
  dropForeignDetail();
  if (!state.selectedNodeId) {
    el('historyTitle').textContent = '请选择节点';
    list.innerHTML = '<p class="empty">从左侧选择一个节点，查看它历次的 TQ 评测历史与走势。</p>';
    el('detailCard').classList.add('hidden');
    el('trendPanel').classList.add('hidden');
    el('trendPanel').innerHTML = '';
    return;
  }
  const reports = state.reports.filter(report => report.nodeId === state.selectedNodeId).sort((left, right) => right.testedAt.localeCompare(left.testedAt));
  el('historyTitle').textContent = `${nodeName(state.selectedNodeId)} · ${reports.length} 份报告`;
  if (!reports.length) {
    list.innerHTML = '<p class="empty">该节点还没有报告，可前往“导入报告”粘贴链接进行初次归档。</p>';
    el('detailCard').classList.add('hidden');
    el('trendPanel').classList.add('hidden');
    el('trendPanel').innerHTML = '';
    return;
  }
  list.innerHTML = '';
  renderTrends(reports);
  for (const [index, report] of reports.entries()) {
    const warnCount = report.warnings?.length || 0;
    const item = document.createElement('div');
    item.className = 'item history-item';
    item.innerHTML = `<div class="history-main">
      <div class="title">
        <div class="history-title-row">
          <strong class="time-title">${fmtTime(report.testedAt)}</strong>
          ${report.sourceType === 'csv' ? '<span class="source-pill" title="服务器上用 run-with-hub.sh 直传的 CSV">直传</span>' : ''}
          ${report.identity ? `<span class="ident-pill">${escapeHtml(report.identity)}</span>` : ''}
          <span class="record-pill">${report.recordCount} 条指标</span>
          ${warnCount ? `<span class="warn-pill">${warnCount} 条提示</span>` : ''}
        </div>
      </div>
      <div class="metrics" data-report="${report.id}"><span class="metric pending">载入指标…</span></div>
    </div>
    <div class="actions history-actions">
      <button class="primary small open-btn" type="button">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        <span>查看数据</span>
      </button>
      ${report.sourceType === 'csv'
        ? `<a class="button ghost small" href="/api/reports/${report.id}/raw" download>
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>原始 CSV</span>
      </a>`
        : `<a class="button ghost small" href="${escapeHtml(report.sourceUrl)}" target="_blank" rel="noreferrer noopener">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        <span>原报告</span>
      </a>`}
      <button class="danger small del-btn" type="button" title="删除归档">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        <span>删除</span>
      </button>
    </div>`;
    const open = item.querySelector('.open-btn');
    open.addEventListener('click', () => openDetail(report.id));
    const remove = item.querySelector('.del-btn');
    remove.addEventListener('click', async () => {
      if (!confirm(`删除 ${fmtTime(report.testedAt)} 的归档？原始${report.sourceType === 'csv' ? ' CSV' : '报告 HTML'}也会一并删除，且无法恢复。`)) return;
      remove.disabled = true;
      try {
        await api(`/api/reports/${report.id}`, { method: 'DELETE' });
        detailCache.delete(report.id);
        if (state.detail?.id === report.id) { state.detail = null; el('detailCard').classList.add('hidden'); }
        toast('已删除该份归档');
        await refresh();
      } catch (error) { toast(error.message, true); remove.disabled = false; }
    });
    list.append(item);
    const metricsHost = item.querySelector('.metrics');
    fillMetrics(metricsHost, report.id);
  }
}
const BADGE_DEFS = [
  { key: 'latency', short: '延迟', icon: '⚡' },
  { key: 'loss', short: '丢包', icon: '📉' },
  { key: 'speed', short: '回程', icon: '🚀' }
];
async function fillMetrics(host, reportId) {
  if (!host) return;
  try {
    const detail = await fetchDetail(reportId);
    if (!host.isConnected) return;
    const cards = new Map((detail.insight?.cards || []).map(card => [card.id, card]));
    host.innerHTML = BADGE_DEFS.map(def => {
      const card = cards.get(def.key);
      if (!card || typeof card.value !== 'number') return `<span class="metric na"><span class="m-icon">${def.icon}</span>${def.short} —</span>`;
      return `<span class="metric l${card.level || 'na'}"><span class="m-icon">${def.icon}</span>${def.short} ${card.value}${escapeHtml(card.unit || '')}</span>`;
    }).join('');
  } catch {
    host.innerHTML = '<span class="metric na">指标暂不可用</span>';
  }
}
// ============ 洞察视图：把 278 行表格压缩成「结论」 ============
// 指标卡给客观数字，异常清单靠相对离群（不受机房地理位置影响），热力图按报告内分位着色（不设绝对阈值）
function renderInsight(insight) {
  if (!insight) { el('detailSummary').innerHTML = ''; return; }
  state.insight = insight;
  const levelNames = { good: '优秀', fair: '一般', bad: '异常', info: '正常' };
  const cards = insight.cards.map(card => `<div class="icard ${card.level || ''}">
    <div class="icard-header">
      <span class="label">${escapeHtml(card.label)}</span>
      <span class="icard-badge ${card.level || 'info'}">${levelNames[card.level] || '指标'}</span>
    </div>
    <div class="value">${escapeHtml(card.value ?? '—')}<span class="unit">${escapeHtml(card.unit || '')}</span></div>
    <div class="note">${escapeHtml(card.note || '')}</div>
  </div>`).join('');
  const levels = { danger: '异常', warn: '注意', info: '提示' };
  const levelIcons = {
    danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  const anomalies = insight.anomalies.length
    ? `<div class="insight-block"><h3 class="section-title">需要关注的点 · ${insight.anomalies.length} 条</h3>
        <div class="anomalies-list">${insight.anomalies.map(item => `<div class="anomaly ${item.level}">
          <span class="anomaly-icon">${levelIcons[item.level] || levelIcons.info}</span>
          <div class="anomaly-body"><span class="tag">${levels[item.level] || '提示'}</span><span class="text">${escapeHtml(item.text)}</span></div>
        </div>`).join('')}</div></div>`
    : '<div class="insight-block"><div class="ok"><svg class="inline-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>未检出丢包、重传、速度离群或骨干异常，网络表现平稳。</div></div>';
  const region = insight.region || { label: '未知区域', good: '', fair: '' };
  const regions = insight.regions.length
    ? `<div class="insight-block"><h3 class="section-title">大区聚合 · 看是区域性劣化还是个别省份</h3>
        <div class="region-row">${insight.regions.map(item => `<span class="region"><span class="name">${escapeHtml(item.name)}</span><span class="hm-cell l${item.level}">${item.p50}ms</span></span>`).join('')}</div></div>`
    : '';
  // 标出哪些区域是用真实报告校准过的：把估算值当实测值看，正是之前误判的根源
  const calibrated = new Set(insight.calibratedRegions || []);
  const bandRows = Object.entries(insight.latencyBands || {})
    .map(([code, item]) => `<tr${code === region.code ? ' class="current"' : ''}>
      <td>${escapeHtml(code)}</td><td>${escapeHtml(item.label)}</td><td>${item.good}</td><td>${item.fair}</td>
      <td class="${calibrated.has(code) ? 'yes' : 'no'}">${calibrated.has(code) ? '已校准' : '待校准'}</td>
    </tr>`).join('');
  const services = insight.services
    ? `<div class="insight-block"><h3 class="section-title">常用网站 / CDN 响应最慢的 5 个 · 共 ${insight.services.total} 个${insight.services.unreachable ? `，${insight.services.unreachable} 个不可达` : ''}</h3>
        <div class="svc-row">${insight.services.slowest.map(item => `<span class="svc"><span class="name">${escapeHtml(item.name)}</span><span class="lat">${item.latency ?? '—'}ms</span></span>`).join('')}</div></div>`
    : '';
  const tabs = insight.matrices.map((matrix, index) => `<button class="hm-tab${index === 0 ? ' active' : ''}" type="button" data-matrix="${matrix.id}">${escapeHtml(matrix.name)}</button>`).join('');
  el('detailSummary').innerHTML = `<div class="insight-block">
      <div class="card-grid">${cards}</div>
      <details class="basis-wrap">
        <summary>评级基准 · 延迟按机房区域分档（当前：${escapeHtml(region.label)}，好 ≤ ${region.good}ms / 一般 ≤ ${region.fair}ms${region.calibrated ? '' : ' · 待校准'}）</summary>
        <p class="hint">同一个绝对阈值判所有区域，会把"离得远"误判成"线路差"：香港 55ms 和法兰克福 175ms 都是各自区域的正常水平。改 <code>lib/thresholds.mjs</code> 即可调整。<strong>只有标「已校准」的区域是用实测报告推导的</strong>，其余是按地理位置的估算值，可能偏紧。</p>
        <div class="table-wrap"><table><thead><tr><th>区域</th><th>名称</th><th>好 ≤ (ms)</th><th>一般 ≤ (ms)</th><th>校准</th></tr></thead><tbody>${bandRows}</tbody></table></div>
      </details>
    </div>
    ${anomalies}${regions}
    <div class="insight-block">
      <div class="insight-head"><h3 class="section-title">省份 × 运营商</h3><div class="hm-tabs">${tabs}</div></div>
      <div id="heatmap"></div>
      <p class="hint">颜色按「${escapeHtml(region.label)}」基准判绝对档位：≤${region.good}ms 好、≤${region.fair}ms 一般、超过为差。健康的线路不会再因为"是这份报告里相对最差的一个"被染红。悬停查看去程线路。${insight.matrices.some(matrix => matrix.id === 'speedtest') && insight.speedRule ? `测速带宽反向判定：≥${insight.speedRule.good}Mbps 好、≥${insight.speedRule.fair}Mbps 一般、低于为差。` : ''}</p>
    </div>${services}`;
  state.heatmap = { matrixId: insight.matrices[0]?.id || null, metricId: null };
  for (const button of el('detailSummary').querySelectorAll('.hm-tab[data-matrix]')) {
    button.addEventListener('click', () => { state.heatmap = { matrixId: button.dataset.matrix, metricId: null }; syncMatrixTabs(); drawHeatmap(); });
  }
  drawHeatmap();
}
function syncMatrixTabs() {
  for (const button of el('detailSummary').querySelectorAll('.hm-tab[data-matrix]')) button.classList.toggle('active', button.dataset.matrix === state.heatmap.matrixId);
}
function drawHeatmap() {
  const matrices = state.insight?.matrices;
  if (!matrices?.length) return;
  const matrix = matrices.find(item => item.id === state.heatmap.matrixId) || matrices[0];
  const metric = matrix.metrics.find(item => item.id === state.heatmap.metricId) || matrix.metrics[0];
  const tabs = matrix.metrics.map(item => `<button class="hm-tab${item.id === metric.id ? ' active' : ''}" type="button" data-metric="${item.id}">${escapeHtml(item.name)}</button>`).join('');
  // 图例按档位而非"低/高"标注：颜色现在表示"好/一般/差"，不是报告内的排名
  const swatch = levels => levels.map(level => `<span class="hm-cell l${level} sw"></span>`).join('');
  const legend = metric.text ? '' : `<div class="hm-legend"><span>好</span>${swatch([0, 1])}<span>一般</span>${swatch([2, 3])}<span>差</span>${swatch([4])}</div>`;
  const body = matrix.rows.map((row, rowIndex) => {
    const cells = matrix.columns.map((column, columnIndex) => {
      const route = matrix.routes[rowIndex][columnIndex];
      if (metric.text) return `<span class="hm-cell text" title="去程线路">${escapeHtml(route || '—')}</span>`;
      const cell = metric.cells[rowIndex][columnIndex];
      const text = cell && cell.v !== null ? `${cell.v}${metric.unit}` : '—';
      // l=null 表示缺失或测量失败，画成中性样式，不能冒充"最优"
      const tone = cell && cell.l !== null ? `l${cell.l}` : 'na';
      return `<span class="hm-cell ${tone}" title="${escapeHtml(`${row}·${column} ${text}｜去程 ${route || '未知'}`)}">${escapeHtml(text)}</span>`;
    }).join('');
    return `<span class="hm-row-name">${escapeHtml(row)}</span>${cells}`;
  }).join('');
  const head = `<span class="hm-row-name"></span>${matrix.columns.map(column => `<span class="hm-col">${escapeHtml(column)}</span>`).join('')}`;
  el('heatmap').innerHTML = `<div class="hm-tabs">${tabs}</div><div class="hm-grid cols-${Math.min(3, matrix.columns.length)}">${head}${body}</div>${legend}`;
  for (const button of el('heatmap').querySelectorAll('.hm-tab[data-metric]')) {
    button.addEventListener('click', () => { state.heatmap.metricId = button.dataset.metric; drawHeatmap(); });
  }
}
// ============ 解析提示：按类归并 ============
// 一份双栈报告能产出几十条同类提示（31 个省份报同一个问题），
// 逐条铺开会把整块界面变成字墙，反而看不出"到底哪里出了问题"。
function renderWarnings(report) {
  const warnings = report.warnings || [];
  const box = el('detailWarnings');
  if (!warnings.length) { box.innerHTML = ''; return; }
  const summary = report.insight?.warningSummary;
  // 只有一两条时不必套归并的壳，直接说清楚更省事
  if (!summary || summary.total <= 2) {
    box.innerHTML = `<div class="warn">解析提示：${warnings.map(escapeHtml).join('；')}</div>`;
    return;
  }
  const rows = summary.groups.map(group => `<li class="warn-row ${group.level}">
      <span class="warn-scope">${escapeHtml(group.scope)}</span>
      <span class="warn-count">${group.count} 条</span>
      <span class="warn-title">${escapeHtml(group.title)}</span>
      ${group.samples.length ? `<span class="warn-samples">${escapeHtml(group.samples.join('、'))}${group.count > group.samples.length ? ' 等' : ''}</span>` : ''}
    </li>`).join('');
  const restRow = summary.rest.length
    ? `<li class="warn-row"><span class="warn-scope">其他</span><span class="warn-count">${summary.rest.length} 条</span></li>`
    : '';
  const kinds = summary.groups.length + (summary.rest.length ? 1 : 0);
  box.innerHTML = `<div class="warn warn-summary">
      <div class="warn-head">解析提示 · 共 ${summary.total} 条，归为 ${kinds} 类${kinds === 1 ? '（同一问题影响多处）' : ''}</div>
      <ul class="warn-list">${rows}${restRow}</ul>
      <details class="warn-all"><summary>展开全部 ${summary.total} 条原始提示</summary><ol>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ol></details>
    </div>`;
}
async function openDetail(reportId) {
  const report = await fetchDetail(reportId);
  state.detail = report;
  el('detailCard').classList.remove('hidden');
  el('detailTitle').textContent = `报告详情 · ${nodeName(report.nodeId)} · ${fmtShort(report.testedAt)}`;
  const isCsv = report.sourceType === 'csv';
  el('openOriginal').hidden = isCsv;
  if (!isCsv) el('openOriginal').href = report.sourceUrl;
  el('downloadJson').href = `/api/reports/${reportId}/export`;
  el('downloadRaw').href = `/api/reports/${reportId}/raw`;
  el('downloadRaw').querySelector('span').textContent = isCsv ? '原始 CSV' : '原始 HTML';
  renderWarnings(report);
  const bySection = new Map();
  for (const record of report.records) {
    if (!bySection.has(record.section)) bySection.set(record.section, []);
    bySection.get(record.section).push(record);
  }
  const parts = [];
  for (const [sectionId, records] of bySection) {
    const withCarrier = records.some(record => record.carrier);
    const metricKeys = [...new Set(records.flatMap(record => Object.keys(record.metrics)))];
    const head = ['分组', '对象', ...(withCarrier ? ['运营商'] : []), ...metricKeys.map(metricLabel)];
    const body = records.map(record => `<tr><td>${escapeHtml(record.group)}</td><td>${escapeHtml(record.target)}</td>${withCarrier ? `<td>${escapeHtml(record.carrier || '—')}</td>` : ''}${metricKeys.map(key => `<td>${escapeHtml(metricText(record.metrics[key]))}</td>`).join('')}</tr>`);
    parts.push(`<h3 class="section-title">${escapeHtml(sectionNames[sectionId] || sectionId)} · ${records.length} 条</h3>
      <table><thead><tr>${head.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`);
  }
  el('detailBody').innerHTML = parts.join('');
  el('rawCount').textContent = report.records.length;
  el('detailRaw').open = false;
  renderInsight(report.insight);
  el('bindCurrent').textContent = nodeName(report.nodeId);
  el('bindPanel').classList.add('hidden');
  bindPicker = null;
  el('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// 改绑：导入时选错节点不必删了重来，归属只是报告上的一个字段，直接搬走即可
function setupBind() {
  el('bindToggle').addEventListener('click', () => {
    if (!state.detail) return;
    const opening = el('bindPanel').classList.contains('hidden');
    if (!opening) { el('bindPanel').classList.add('hidden'); return; }
    el('bindPanel').classList.remove('hidden');
    bindPicker = nodePicker({
      container: el('bindPicker'),
      nodes: state.allNodes,
      reportsOf: reportsByNode(state.allReports),
      selectedId: state.detail.nodeId
    });
  });
  el('bindConfirm').addEventListener('click', async () => {
    if (!state.detail || !bindPicker) return;
    const nodeId = bindPicker.value;
    if (!nodeId) { toast('请选择一个节点', true); return; }
    const button = el('bindConfirm');
    button.disabled = true;
    try {
      await api(`/api/reports/${state.detail.id}/move`, { method: 'POST', body: JSON.stringify({ nodeId }) });
      toast(`已改绑到「${nodeName(nodeId)}」`);
      el('bindPanel').classList.add('hidden');
      bindPicker = null;
      state.selectedNodeId = nodeId;
      el('detailCard').classList.add('hidden');
      state.detail = null;
      await refresh();
    } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
  });
}
function renderRecent() {
  const recent = [...state.reports].sort((left, right) => right.importedAt.localeCompare(left.importedAt)).slice(0, 5);
  const host = el('recentImports');
  host.innerHTML = '';
  if (!recent.length) { host.innerHTML = '<p class="empty">还没有导入记录。</p>'; return; }
  for (const report of recent) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'title-link recent-item';
    item.innerHTML = `
      <div class="recent-main">
        <div class="recent-top">
          <span class="recent-node">${escapeHtml(nodeName(report.nodeId))}</span>
          <span class="recent-badge count-badge">${report.recordCount} 条指标</span>
          ${report.identity ? `<span class="recent-badge ident-badge">${escapeHtml(report.identity)}</span>` : ''}
        </div>
        <div class="recent-meta">
          <span>测速时间：${fmtTime(report.testedAt)}</span>
          <span class="meta-dot">·</span>
          <span>归档时间：${fmtShort(report.importedAt)}</span>
        </div>
      </div>
      <div class="recent-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    item.addEventListener('click', () => {
      state.selectedNodeId = report.nodeId;
      renderNodes();
      renderHistory();
      showView('history');
      openDetail(report.id);
    });
    host.append(item);
  }
}
// ============ 看板：一屏看全局 ============
// 数据全部来自现有：概览用 /api/state，告警和健康表用 insight.cards
// 并行获取指标，避免逐行串行加载
let dashRequestToken = 0;
async function renderDashboard() {
  const stats = el('dashStats');
  const alertsBox = el('dashAlerts');
  const alertCard = el('dashAlertCard');
  const healthBox = el('dashHealth');
  // 概览数字：全量、覆盖、最近一次测试时间
  const withReports = new Set(state.reports.map(report => report.nodeId));
  const latest = [...state.reports].sort((left, right) => right.testedAt.localeCompare(left.testedAt))[0];
  const activeNodesCount = state.nodes.filter(node => !node.archived).length;
  const coveragePercent = activeNodesCount > 0 ? ((withReports.size / activeNodesCount) * 100).toFixed(0) : '0';

  stats.innerHTML = `
    <div class="dash-stat">
      <div class="dash-stat-top">
        <span class="stat-icon-wrap stat-icon-server">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>
        </span>
        <span class="lbl">启用节点</span>
      </div>
      <div class="dash-stat-bottom">
        <span class="num">${activeNodesCount}</span>
        <span class="stat-sub">探针共同步 ${state.allNodes.filter(node => !node.archived).length} 个</span>
      </div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-top">
        <span class="stat-icon-wrap stat-icon-target">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </span>
        <span class="lbl">覆盖节点</span>
      </div>
      <div class="dash-stat-bottom">
        <span class="num">${withReports.size}</span>
        <span class="stat-sub">评测覆盖率 ${coveragePercent}%</span>
      </div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-top">
        <span class="stat-icon-wrap stat-icon-report">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </span>
        <span class="lbl">总报告数</span>
      </div>
      <div class="dash-stat-bottom">
        <span class="num">${state.reports.length}</span>
        <span class="stat-sub">份实测质量归档</span>
      </div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-top">
        <span class="stat-icon-wrap stat-icon-clock">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
        <span class="lbl">最新测试</span>
      </div>
      <div class="dash-stat-bottom">
        <span class="num num-time">${latest ? fmtShort(latest.testedAt) : '—'}</span>
        <span class="stat-sub">最近一次测试记录</span>
      </div>
    </div>
  `;

  // 按节点聚合出"每个节点最近的一份报告"，拉详情取 insight.cards
  const byNode = new Map();
  for (const report of state.reports) {
    if (!byNode.has(report.nodeId) || byNode.get(report.nodeId).testedAt < report.testedAt) byNode.set(report.nodeId, report);
  }
  const latestPerNode = [...byNode.values()].sort((left, right) => right.testedAt.localeCompare(left.testedAt));
  const idleNodes = state.nodes.filter(node => !node.archived && !withReports.has(node.id));
  const healthRows = [];
  healthBox.innerHTML = '';
  for (const report of latestPerNode) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dash-row';
    row.dataset.node = report.nodeId;
    row.dataset.report = report.id;
    row.innerHTML = `
      <div class="dash-cell name">
        <span class="cell-node-dot"></span>
        <span class="cell-node-name">${escapeHtml(nodeName(report.nodeId))}</span>
      </div>
      <div class="dash-cell time">${fmtShort(report.testedAt)}</div>
      <div class="dash-cell metrics"><span class="metric pending">载入…</span></div>
      <div class="dash-cell action">
        <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    row.addEventListener('click', () => {
      state.selectedNodeId = report.nodeId;
      renderNodes();
      renderHistory();
      showView('history');
    });
    healthBox.append(row);
    healthRows.push({ row, report });
  }
  if (idleNodes.length) {
    const idle = document.createElement('p');
    idle.className = 'empty dash-idle';
    idle.textContent = `另有 ${idleNodes.length} 个节点暂无 TQ 报告记录`;
    healthBox.append(idle);
  }

  // 并行获取所有节点的最近详情，大幅减少等待时间
  const token = ++dashRequestToken;
  const results = await Promise.all(
    healthRows.map(async ({ row, report }) => {
      try {
        const detail = await fetchDetail(report.id);
        return { row, report, detail };
      } catch {
        return { row, report, error: true };
      }
    })
  );
  if (token !== dashRequestToken) return;

  const alerts = [];
  for (const { row, report, detail, error } of results) {
    if (error || !detail) {
      row.querySelector('.metrics').innerHTML = '<span class="metric na">指标不可用</span>';
      continue;
    }
    const cards = new Map((detail.insight?.cards || []).map(card => [card.id, card]));
    const latency = cards.get('latency');
    const loss = cards.get('loss');
    const speed = cards.get('speed');
    row.querySelector('.metrics').innerHTML = `
      ${latency && typeof latency.value === 'number' ? `<span class="metric l${latency.level}"><span class="m-icon">⚡</span>延迟 ${latency.value}${latency.unit}</span>` : ''}
      ${loss && typeof loss.value === 'number' ? `<span class="metric l${loss.level}"><span class="m-icon">📉</span>丢包 ${loss.value}${loss.unit}</span>` : ''}
      ${speed && typeof speed.value === 'number' ? `<span class="metric l${speed.level}"><span class="m-icon">🚀</span>带宽 ${speed.value}${speed.unit}</span>` : ''}
    `;
    const worst = [latency, loss, speed].reduce((acc, card) => {
      if (!card || typeof card.value !== 'number') return acc;
      return Math.max(acc, card.level === 'bad' ? 2 : card.level === 'fair' ? 1 : 0);
    }, 0);
    if (worst > 0) alerts.push({ report, latency, loss, speed, worst });
  }

  // 需要关注的节点：最严重的排前面，同级再看时间
  alerts.sort((left, right) => right.worst - left.worst || right.report.testedAt.localeCompare(left.report.testedAt));
  if (!alerts.length) {
    alertCard.classList.add('hidden');
    return;
  }
  alertCard.classList.remove('hidden');
  alertsBox.innerHTML = '';
  for (const { report, latency, loss, speed } of alerts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'title-link dash-alert';
    item.innerHTML = `
      <div class="alert-left">
        <div class="title">
          <div class="alert-title-row">
            <strong>${escapeHtml(nodeName(report.nodeId))}</strong>
            <span class="alert-tag">注意</span>
          </div>
          <span class="meta">评测时间：${fmtTime(report.testedAt)}</span>
        </div>
        <div class="metrics">
          ${latency && typeof latency.value === 'number' ? `<span class="metric l${latency.level}"><span class="m-icon">⚡</span>延迟 ${latency.value}${latency.unit}</span>` : ''}
          ${loss && typeof loss.value === 'number' ? `<span class="metric l${loss.level}"><span class="m-icon">📉</span>丢包 ${loss.value}${loss.unit}</span>` : ''}
          ${speed && typeof speed.value === 'number' ? `<span class="metric l${speed.level}"><span class="m-icon">🚀</span>带宽 ${speed.value}${speed.unit}</span>` : ''}
        </div>
      </div>
      <div class="alert-arrow">
        <span>直达详情</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    item.addEventListener('click', () => {
      state.selectedNodeId = report.nodeId;
      renderNodes();
      renderHistory();
      showView('history');
      openDetail(report.id);
    });
    alertsBox.append(item);
  }
}
// 脚本直传、尚未绑定节点的报告。每份一个独立的选择器；没有"同一台机器"的记忆时不预选，必须明确选择
const CORE_SECTIONS = ['ipv4', 'large4', 'cernet', 'intl', 'speedtest'];
function renderPending() {
  const count = state.pending.length;
  el('pendingCount').textContent = `${count} 份`;
  el('pendingBadge').textContent = count;
  el('pendingBadge').hidden = !count;
  el('dashPendingText').textContent = `有 ${count} 份脚本直传的报告等待绑定节点`;
  el('dashPending').hidden = !count;
  const list = el('pendingList');
  // 一键接受全部推荐：只统计"有推荐"的条目。推荐来自同出口记忆（主机名 + 出口 IP
  // 在这台机器上绑定过一次），准确率已经很高，但多台机器每周一次仍是重复劳动。
  const recommended = state.pending.filter(entry => !entry.broken && entry.suggestion?.nodeId);
  const bulk = el('pendingBulk');
  bulk.classList.toggle('hidden', !recommended.length);
  if (recommended.length) {
    el('bindRecommended').textContent = `一键接受全部推荐（${recommended.length} 份）`;
    const names = [...new Set(recommended.map(entry => nodeName(entry.suggestion.nodeId)))];
    el('pendingBulkHint').textContent = `按同出口记忆归到：${names.join('、')}；没有推荐的条目不会被自动处理`;
  }
  if (!count) {
    list.innerHTML = '<p class="empty">暂无待绑定的报告。在服务器上执行 run-with-hub.sh，跑完会自动出现在这里。</p>';
    return;
  }
  list.innerHTML = '';
  const reportsOf = reportsByNode(state.allReports);
  for (const entry of [...state.pending].sort((left, right) => right.testedAt.localeCompare(left.testedAt))) {
    const counts = entry.sectionCounts || {};
    const present = new Set(entry.sections.map(section => section.id));
    const pills = entry.sections.map(section => counts[section.id]
      ? `<span class="record-pill">${escapeHtml(section.name)} ${counts[section.id]} 条</span>`
      : `<span class="record-pill muted" title="CSV 里有这部分数据，映射待真实样本核对，原始 CSV 已保留">${escapeHtml(section.name)} · 暂未解析</span>`).join('');
    const missing = CORE_SECTIONS.filter(id => !present.has(id)).map(id => sectionNames[id]);
    const { latency, loss } = entry.preview || {};
    const preview = [
      latency && `<span class="metric"><span class="m-icon">⚡</span>延迟 p50 ${latency.value}${latency.unit}</span>`,
      loss && `<span class="metric"><span class="m-icon">📉</span>丢包 ${loss.value}${loss.unit}</span>`
    ].filter(Boolean).join('');
    // "报告没有 X 维度" 已在上面单独成行，提示里只留其他信息
    const notes = (entry.warnings || []).filter(text => !text.startsWith('报告没有') && !text.includes('暂未解析'));
    const source = [entry.hostname, entry.sourceIp].filter(Boolean).map(escapeHtml).join(' · ') || '来源未知（旧版脚本上传）';
    const item = document.createElement('div');
    item.className = `pending-item${entry.error || entry.broken ? ' failed' : ''}`;
    item.innerHTML = `
      <div class="pending-main">
        <div class="pending-title-row">
          <strong class="time-title">${fmtTime(entry.testedAt)}</strong>
          ${entry.timeSource === 'upload' ? '<span class="warn-pill" title="上传时没有带测试时间，按服务器收到 CSV 的时间记录">按上传时间</span>' : ''}
          ${entry.keyName ? `<span class="record-pill">Key · ${escapeHtml(entry.keyName)}</span>` : ''}
        </div>
        <div class="pending-source">来源：${source}</div>
        ${entry.broken
          ? '<div class="warn">CSV 源文件已丢失（可能被清理或迁移不全），这份数据无法归档，也无法下载原文。请直接丢弃该条。</div>'
          : entry.error
            ? `<div class="warn">无法解析：${escapeHtml(entry.error)}。原始 CSV 已保留，可下载查看后丢弃。</div>`
            : `<div class="pending-sections">${pills}</div>
               ${missing.length ? `<div class="pending-missing">本次未包含：${missing.map(escapeHtml).join('、')}</div>` : ''}
               ${preview ? `<div class="metrics">${preview}</div>` : ''}
               ${notes.length ? `<details class="pending-notes"><summary>${notes.length} 条解析提示</summary><ul>${notes.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul></details>` : ''}`}
      </div>
      <div class="pending-actions">
        ${entry.error || entry.broken ? '' : '<div class="picker pending-picker"></div><button class="primary small bind-btn" type="button">绑定</button>'}
        ${entry.broken ? '' : `<a class="button ghost small" href="/api/pending/${entry.id}/raw" download title="下载原始 CSV">CSV</a>`}
        <button class="danger small discard-btn" type="button">丢弃</button>
      </div>`;
    if (!entry.error && !entry.broken) {
      const picker = nodePicker({ container: item.querySelector('.pending-picker'), nodes: state.allNodes, reportsOf, selectedId: null, suggestion: entry.suggestion, allowEmpty: true });
      const bind = item.querySelector('.bind-btn');
      bind.addEventListener('click', async () => {
        const nodeId = picker.value;
        if (!nodeId) { toast('请先选择要绑定的节点', true); return; }
        bind.disabled = true;
        try {
          await api(`/api/pending/${entry.id}/bind`, { method: 'POST', body: JSON.stringify({ nodeId }) });
          toast(`已绑定到「${nodeName(nodeId)}」`);
          await refresh();
        } catch (error) { toast(error.message, true); bind.disabled = false; }
      });
    }
    const discard = item.querySelector('.discard-btn');
    discard.addEventListener('click', async () => {
      if (!confirm(`丢弃 ${fmtTime(entry.testedAt)} 这份直传报告？原始 CSV 会一并删除，且无法恢复。`)) return;
      discard.disabled = true;
      try {
        await api(`/api/pending/${entry.id}`, { method: 'DELETE' });
        toast('已丢弃');
        await refresh();
      } catch (error) { toast(error.message, true); discard.disabled = false; }
    });
    list.append(item);
  }
}
// 一键接受全部推荐：只把"有推荐"的 id 交给服务端，没有推荐的条目仍由人决定归属
async function bindRecommended() {
  const ids = state.pending.filter(entry => !entry.broken && entry.suggestion?.nodeId).map(entry => entry.id);
  if (!ids.length) return;
  const button = el('bindRecommended');
  button.disabled = true;
  try {
    const result = await api('/api/pending/bind-recommended', { method: 'POST', body: JSON.stringify({ ids }) });
    const parts = [`已归档 ${result.bound.length} 份`];
    if (result.failed.length) parts.push(`${result.failed.length} 份失败`);
    if (result.skipped) parts.push(`${result.skipped} 份无推荐已跳过`);
    toast(parts.join('，'), result.failed.length > 0);
    // 失败原因逐条说清楚，否则用户只知道"有几份没成"却不知为什么
    for (const item of result.failed) toast(`${item.hostname || item.id.slice(0, 8)}：${item.error}`, true);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
function renderPreview(report, token, suggestion) {
  const counts = report.sectionCounts || {};
  const perSection = report.sections.map(section => `<div class="stat"><div class="label">${escapeHtml(section.name)}</div><div class="value">${counts[section.id] ?? 0} 条</div></div>`).join('');
  const box = el('previewResult');
  box.innerHTML = `<div class="preview-grid">
    <div class="stat"><div class="label">测试时间</div><div class="value">${fmtTime(report.testedAt)}</div></div>
    <div class="stat"><div class="label">出口信息</div><div class="value">${escapeHtml(report.identity || '未知')}</div></div>
    <div class="stat"><div class="label">指标总数</div><div class="value">${report.recordCount} 条</div></div>
    ${perSection}</div>
    ${report.warnings?.length ? `<div class="warn">解析提示：${report.warnings.map(escapeHtml).join('；')}</div>` : '<div class="ok">全部维度均已结构化解析，无异常提示。</div>'}
    <div class="row-form"><div id="previewPicker" class="picker"></div><button id="confirmImport" class="primary" type="button">绑定并归档</button></div>`;
  box.classList.remove('hidden');
  previewPicker = nodePicker({
    container: el('previewPicker'),
    nodes: state.allNodes,
    reportsOf: reportsByNode(state.allReports),
    selectedId: state.selectedNodeId,
    suggestion
  });
  el('confirmImport').addEventListener('click', async () => {
    const button = el('confirmImport');
    const nodeId = previewPicker.value;
    if (!nodeId) { toast('请选择一个归属节点', true); return; }
    button.disabled = true;
    try {
      await api('/api/import', { method: 'POST', body: JSON.stringify({ token, nodeId }) });
      toast(`已归档到「${nodeName(nodeId)}」`);
      box.classList.add('hidden');
      previewPicker = null;
      el('reportUrl').value = '';
      await refresh();
    } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
  });
}
function renderCompareSelectors() {
  const nodeSelect = el('compareNode');
  nodeSelect.innerHTML = state.nodes.map(node => `<option value="${node.id}">${escapeHtml(node.name)}</option>`).join('');
  const reportsOf = reportsByNode();
  const firstWithMultiple = state.nodes.find(n => (reportsOf.get(n.id) || []).length >= 2)?.id;
  const target = (state.selectedNodeId && (reportsOf.get(state.selectedNodeId) || []).length >= 2)
    ? state.selectedNodeId
    : (firstWithMultiple || state.selectedNodeId || state.nodes[0]?.id || '');
  nodeSelect.value = target;
  const reports = state.reports.filter(report => report.nodeId === target).sort((left, right) => right.testedAt.localeCompare(left.testedAt));
  const options = reports.map(report => `<option value="${report.id}">${fmtTime(report.testedAt)}</option>`).join('');
  el('compareBase').innerHTML = options;
  el('compareCurrent').innerHTML = options;
  if (reports.length > 1) {
    el('compareBase').selectedIndex = 1;
    el('compareCurrent').selectedIndex = 0;
  }
  el('compareResult').classList.toggle('hidden', reports.length < 2);
  if (reports.length >= 2) runCompare();
}
async function runCompare() {
  const base = el('compareBase').value;
  const current = el('compareCurrent').value;
  if (!base || !current || base === current) return;
  try {
    const result = await api(`/api/compare?base=${base}&current=${current}`);
    state.compare.result = result;
    el('compareTitle').textContent = `变化明细 · ${fmtShort(result.baseTestedAt)} → ${fmtShort(result.currentTestedAt)}`;
    el('changeFilter').innerHTML = '<option value="all">全部维度</option>' + Object.entries(sectionNames).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
    renderChanges();
  } catch (error) { toast(error.message, true); }
}
function renderChanges() {
  const result = state.compare.result;
  if (!result) return;
  const section = el('changeFilter').value;
  const direction = el('changeDirection').value;
  const onlyChanged = el('onlyChanged').checked;
  const onlySignificant = el('onlySignificant').checked;
  // significant 由服务端按 lib/thresholds.mjs 的门槛标好，这里只做筛选
  const matches = change => (section === 'all' || change.section === section) && (direction === 'all' || change.direction === direction);
  const pool = result.changes.filter(matches);
  const changed = onlyChanged ? pool.filter(change => change.delta !== 0) : pool;
  const significant = changed.filter(change => change.significant);
  const changes = onlySignificant ? significant : changed;
  // 过滤掉多少要明说：否则用户会以为"这次没什么变化"，而实际是被门槛藏起来了
  const hidden = changed.length - significant.length;
  const summary = !changed.length
    ? ''
    : onlySignificant && hidden > 0
      ? `共 ${changed.length} 项变化，其中 ${significant.length} 项显著；${hidden} 项在抖动范围内已折叠（取消勾选「只看显著变化」可查看）`
      : `共 ${changed.length} 项变化，全部显示`;
  el('changeSummary').textContent = summary;
  if (!changes.length) {
    el('changeBody').innerHTML = `<p class="empty">${changed.length ? '这些变化都还在抖动范围内，没有值得关注的项。' : '当前筛选下没有符合条件的指标。'}</p>`;
    return;
  }
  const rows = changes.map(change => {
    const sign = change.delta > 0 ? '+' : '';
    return `<tr><td>${escapeHtml(sectionNames[change.section] || change.section)}</td><td>${escapeHtml(change.target)}</td><td>${escapeHtml(change.carrier || '—')}</td><td>${escapeHtml(metricLabel(change.metric))}</td><td>${change.before}${change.unit}</td><td>${change.after}${change.unit}</td><td class="${change.direction}">${sign}${change.delta}${change.unit}</td><td>${change.significant ? '<span class="sig-mark">显著</span>' : '<span class="sig-noise">抖动</span>'}</td></tr>`;
  }).join('');
  el('changeBody').innerHTML = `<table><thead><tr><th>维度</th><th>对象</th><th>运营商</th><th>指标</th><th>基础报告</th><th>当前报告</th><th>变化</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function showView(view) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
}
async function refresh() {
  const data = await api('/api/state');
  state.allNodes = data.nodes;
  state.allReports = data.reports;
  // 停用的节点连同它的报告一起从界面隐藏（报告不删除，重新启用即恢复）
  state.nodes = data.nodes.filter(node => node.enabled !== false);
  const enabledIds = new Set(state.nodes.map(node => node.id));
  state.reports = data.reports.filter(report => enabledIds.has(report.nodeId));
  state.pending = data.pending || [];
  state.metricNames = data.metricNames;
  // 未启用认证时没有"登录"概念，退出按钮不应出现（否则登出会被登录页立即送回）
  el('logoutButton').hidden = !data.authEnabled;
  el('syncState').textContent = data.syncedAt ? `启用 ${state.nodes.length} / ${data.nodes.filter(node => !node.archived).length} 个节点` : '未同步节点';
  renderNodes();
  renderHistory();
  renderRecent();
  renderDashboard();
  renderPending();
  renderCompareSelectors();

  // 支持 URL 参数直达指定视图、节点或报告详情
  const params = new URLSearchParams(location.search);
  const targetNode = params.get('node');
  const targetReport = params.get('report');
  const targetView = params.get('view') || params.get('tab');
  if (targetNode) {
    const found = state.nodes.find(n => n.id === targetNode || n.name.includes(targetNode));
    if (found) selectNode(found.id);
  }
  if (targetReport) {
    const rep = state.reports.find(r => r.id === targetReport);
    if (rep) {
      state.selectedNodeId = rep.nodeId;
      renderNodes();
      renderHistory();
    }
    showView('history');
    openDetail(targetReport);
  }
  if (targetView && !targetReport) {
    showView(targetView);
  }
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));
el('dashPending').addEventListener('click', () => showView('import'));
el('bindRecommended').addEventListener('click', bindRecommended);
// 页面只在打开时加载一次数据。服务器上跑完脚本、切回浏览器时自动检查待绑定队列：
// 只在队列有变化时重绘这一块，不整页刷新，避免打断正在进行的选择或切走当前视图
let pendingCheckedAt = 0;
async function syncPending() {
  if (document.visibilityState !== 'visible' || Date.now() - pendingCheckedAt < 5000) return;
  pendingCheckedAt = Date.now();
  try {
    const data = await api('/api/state');
    const ids = list => list.map(item => item.id).sort().join(',');
    if (ids(data.pending || []) === ids(state.pending)) return;
    state.pending = data.pending || [];
    renderPending();
  } catch { /* 网络抖动时忽略，下次切回再查 */ }
}
document.addEventListener('visibilitychange', syncPending);
window.addEventListener('focus', syncPending);
el('nodeFilter').addEventListener('input', renderNodes);
el('previewForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  button.textContent = '解析中…';
  try {
    const data = await api('/api/preview', { method: 'POST', body: JSON.stringify({ url: el('reportUrl').value.trim() }) });
    renderPreview(data.report, data.token, data.suggestion);
    toast('解析完成，请确认归属节点');
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '解析'; }
});
el('compareNode').addEventListener('change', event => { state.selectedNodeId = event.target.value; renderNodes(); renderHistory(); renderCompareSelectors(); });
el('compareBase').addEventListener('change', runCompare);
el('compareCurrent').addEventListener('change', runCompare);
el('runCompare').addEventListener('click', runCompare);
for (const id of ['changeFilter', 'changeDirection', 'onlyChanged', 'onlySignificant']) el(id).addEventListener('change', renderChanges);
el('logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } finally { location.replace('/login'); }
});
setupThemeToggle(el('themeToggle'));
setupBind();
window.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== el('nodeFilter') && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    el('nodeFilter').focus();
    el('nodeFilter').select();
  }
});
refresh().catch(error => toast(error.message, true));
