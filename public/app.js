import { setupThemeToggle } from '/theme.js';
import { nodePicker } from '/picker.js';

const state = { nodes: [], reports: [], metricNames: {}, selectedNodeId: null, detail: null, insight: null, heatmap: { matrixId: null, metricId: null }, compare: { node: '', result: null } };
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
const nodeName = id => state.nodes.find(node => node.id === id)?.name || id;
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

function reportsByNode() {
  const map = new Map();
  for (const report of state.reports) {
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
  if (!state.nodes.length) { list.innerHTML = '<p class="empty">先同步探针节点。</p>'; return; }
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
    label.innerHTML = `<span class="caret">▾</span><span>${escapeHtml(city)}</span><span class="group-count">${nodes.length}</span>`;
    label.addEventListener('click', () => toggleGroup(city, collapsed));
    list.append(label);
    if (collapsed) continue;
    for (const node of nodes) {
      const count = (reportsOf.get(node.id) || []).length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'node' + (node.id === state.selectedNodeId ? ' active' : '') + (count ? '' : ' idle');
      button.innerHTML = `<span>${escapeHtml(node.name)}</span><span class="count">${count ? `${count} 份` : ''}</span>`;
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
  try {
    const details = await Promise.all(reports.map(report => fetchDetail(report.id)));
    if (token !== trendRequestToken) return;
    drawTrends([...details].sort((left, right) => left.testedAt.localeCompare(right.testedAt)));
  } catch (error) {
    if (token !== trendRequestToken) return;
    panel.innerHTML = `<p class="empty">趋势加载失败：${escapeHtml(error.message)}</p>`;
  }
}
function drawTrends(points) {
  const panel = el('trendPanel');
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
  if (!series.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.innerHTML = series.map(serie => svgForSeries(points, serie)).join('');
  for (const button of panel.querySelectorAll('button.tp')) {
    button.addEventListener('click', () => openDetail(button.dataset.id));
  }
}
function svgForSeries(points, serie) {
  // viewBox 定死 320×72，配合 preserveAspectRatio=none 自动伸缩填满格子；
  // 因为图形本身全靠百分比坐标，拉伸是纯视觉的，不影响真值
  const W = 320, H = 72, PAD = 8;
  const usableW = W - PAD * 2;
  const usableH = H - PAD * 2;
  const present = serie.values.filter(value => value !== null);
  const min = Math.min(...present), max = Math.max(...present);
  const spread = Math.max(1e-9, max - min);
  const total = Math.max(1, points.length - 1);
  const coords = serie.values.map((value, index) => {
    if (value === null) return null;
    const x = points.length === 1 ? W / 2 : PAD + (index / total) * usableW;
    // 纵向按比例铺满整个图区，让"波动大"和"波动小"一眼可分
    const y = points.length === 1 ? H / 2 : H - PAD - ((value - min) / spread) * usableH;
    return { x, y, index, value };
  }).filter(Boolean);
  const path = coords.length >= 2 ? `M${coords.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' L')}` : '';
  // 首尾对比：起终两点的相对变化足够醒目时给一个摘要箭头，否则省略省得分散注意力。
  // 阈值 8% 足够大，只有"变了一截"才值得报；低于这个幅度就算不上趋势
  let summary = '';
  if (coords.length >= 2) {
    const first = coords[0], last = coords.at(-1);
    const delta = last.value - first.value;
    if (Math.abs(delta) >= Math.max(spread * 0.08, 1)) {
      const worse = serie.lowerBetter ? delta > 0 : delta < 0;
      const arrow = delta > 0 ? '↑' : '↓';
      summary = `<span class="trend-delta ${worse ? 'bad' : 'good'}">${arrow}${Math.abs(Math.round(delta))}${escapeHtml(serie.unit)}</span>`;
    }
  }
  const range = spread > 1 ? `${Math.round(min)}–${Math.round(max)}${serie.unit}` : '—';
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
      ${path ? `<path class="trend-line" d="${path}"/>` : ''}
      ${coords.map(point => `<circle class="tp l${serie.levels[point.index] || 'na'}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"/>`).join('')}
    </svg>
    <div class="trend-dots">${dots}</div>
    <div class="trend-foot">
      <span class="trend-range">${escapeHtml(range)}</span>
      ${summary}
    </div>
  </div>`;
}
function renderHistory() {
  const list = el('historyList');
  dropForeignDetail();
  if (!state.selectedNodeId) {
    el('historyTitle').textContent = '请选择节点';
    list.innerHTML = '<p class="empty">从左侧选择一个节点，查看它历次的 TQ 报告。</p>';
    el('detailCard').classList.add('hidden');
    el('trendPanel').classList.add('hidden');
    el('trendPanel').innerHTML = '';
    return;
  }
  const reports = state.reports.filter(report => report.nodeId === state.selectedNodeId).sort((left, right) => right.testedAt.localeCompare(left.testedAt));
  el('historyTitle').textContent = `${nodeName(state.selectedNodeId)} · ${reports.length} 份报告`;
  if (!reports.length) {
    list.innerHTML = '<p class="empty">该节点还没有报告，去“导入报告”粘贴链接。</p>';
    el('detailCard').classList.add('hidden');
    el('trendPanel').classList.add('hidden');
    el('trendPanel').innerHTML = '';
    return;
  }
  list.innerHTML = '';
  renderTrends(reports);
  // 指标徽标：每份报告单独异步填充，拉到数据后原地刷新。失败就保持占位
  for (const [index, report] of reports.entries()) {
    const warnCount = report.warnings?.length || 0;
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<div class="title"><strong>${fmtTime(report.testedAt)}</strong>
      <span class="meta">${report.recordCount} 条指标 · ${escapeHtml(report.identity || '未知线路')}${warnCount ? ` · ${warnCount} 条解析提示` : ''}</span></div>
      <span class="metrics" data-report="${report.id}"><span class="metric pending">载入指标…</span></span>`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = '查看数据';
    open.addEventListener('click', () => openDetail(report.id));
    const raw = document.createElement('a');
    raw.className = 'button ghost';
    raw.href = report.sourceUrl;
    raw.target = '_blank';
    raw.rel = 'noreferrer noopener';
    raw.textContent = '原报告';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      if (!confirm(`删除 ${fmtTime(report.testedAt)} 的归档？原始报告 HTML 也会一并删除，且无法恢复。`)) return;
      remove.disabled = true;
      try {
        await api(`/api/reports/${report.id}`, { method: 'DELETE' });
        detailCache.delete(report.id);
        if (state.detail?.id === report.id) { state.detail = null; el('detailCard').classList.add('hidden'); }
        toast('已删除该份归档');
        await refresh();
      } catch (error) { toast(error.message, true); remove.disabled = false; }
    });
    actions.append(open, raw, remove);
    item.append(actions);
    list.append(item);
    fillMetrics(report, index, reports.length);
  }
}
// 徽标行：把这份报告的核心档位压缩成一行彩色标签，扫一眼就知道好坏。
// 颜色档位复用 insight 卡片的 level（good/fair/bad），与详情视图同源。
const BADGE_DEFS = [
  { key: 'latency', short: '延迟' },
  { key: 'loss', short: '丢包' },
  { key: 'speed', short: '回程' }
];
async function fillMetrics(report, index, total) {
  const host = document.querySelector(`[data-report="${report.id}"]`);
  if (!host) return;
  try {
    const detail = await fetchDetail(report.id);
    if (!host.isConnected) return;
    const cards = new Map((detail.insight?.cards || []).map(card => [card.id, card]));
    host.innerHTML = BADGE_DEFS.map(def => {
      const card = cards.get(def.key);
      if (!card || typeof card.value !== 'number') return `<span class="metric na">${def.short} —</span>`;
      return `<span class="metric l${card.level || 'na'}">${def.short} ${card.value}${escapeHtml(card.unit || '')}</span>`;
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
  const cards = insight.cards.map(card => `<div class="icard ${card.level || ''}">
    <div class="label">${escapeHtml(card.label)}</div>
    <div class="value">${escapeHtml(card.value ?? '—')}<span class="unit">${escapeHtml(card.unit || '')}</span></div>
    <div class="note">${escapeHtml(card.note || '')}</div>
  </div>`).join('');
  const levels = { danger: '异常', warn: '注意', info: '提示' };
  const anomalies = insight.anomalies.length
    ? `<div class="insight-block"><h3 class="section-title">需要关注的点 · ${insight.anomalies.length} 条</h3>
        ${insight.anomalies.map(item => `<div class="anomaly ${item.level}"><span class="tag">${levels[item.level] || '提示'}</span><span>${escapeHtml(item.text)}</span></div>`).join('')}</div>`
    : '<div class="insight-block"><div class="ok">未检出丢包、重传、速度离群或骨干异常。</div></div>';
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
      <p class="hint">颜色按「${escapeHtml(region.label)}」基准判绝对档位：≤${region.good}ms 好、≤${region.fair}ms 一般、超过为差。健康的线路不会再因为"是这份报告里相对最差的一个"被染红。悬停查看去程线路。</p>
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
  el('openOriginal').href = report.sourceUrl;
  el('downloadJson').href = `/api/reports/${reportId}/export`;
  el('downloadRaw').href = `/api/reports/${reportId}/raw`;
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
      nodes: state.nodes,
      reportsOf: reportsByNode(),
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
    item.className = 'title-link';
    item.innerHTML = `<div class="title"><strong>${escapeHtml(nodeName(report.nodeId))}</strong>
      <span class="meta">测试于 ${fmtTime(report.testedAt)} · ${report.recordCount} 条指标</span></div>
      <span class="meta">导入于 ${fmtTime(report.importedAt)}</span>`;
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
// （与详情页同源，避免维护两套口径）。异步逐个填充，不阻塞页面。
let dashRequestToken = 0;
async function renderDashboard() {
  const stats = el('dashStats');
  const alertsBox = el('dashAlerts');
  const alertCard = el('dashAlertCard');
  const healthBox = el('dashHealth');
  // 概览数字：全量、覆盖、最近一次测试时间
  const withReports = new Set(state.reports.map(report => report.nodeId));
  const latest = [...state.reports].sort((left, right) => right.testedAt.localeCompare(left.testedAt))[0];
  stats.innerHTML = `
    <div class="dash-stat"><span class="num">${state.nodes.filter(node => !node.archived).length}</span><span class="lbl">探针节点</span></div>
    <div class="dash-stat"><span class="num">${withReports.size}</span><span class="lbl">有报告的节点</span></div>
    <div class="dash-stat"><span class="num">${state.reports.length}</span><span class="lbl">总报告数</span></div>
    <div class="dash-stat"><span class="num">${latest ? fmtShort(latest.testedAt) : '—'}</span><span class="lbl">最近一次测试</span></div>
  `;
  // 按节点聚合出"每个节点最近的一份报告"，拉详情取 insight.cards
  const byNode = new Map();
  for (const report of state.reports) {
    if (!byNode.has(report.nodeId) || byNode.get(report.nodeId).testedAt < report.testedAt) byNode.set(report.nodeId, report);
  }
  const latestPerNode = [...byNode.values()].sort((left, right) => right.testedAt.localeCompare(left.testedAt));
  // 没有报告的节点先给个提示行
  const idleNodes = state.nodes.filter(node => !node.archived && !withReports.has(node.id));
  const healthRows = [];
  healthBox.innerHTML = '';
  for (const report of latestPerNode) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dash-row';
    row.dataset.node = report.nodeId;
    row.dataset.report = report.id;
    row.innerHTML = `<span class="dash-cell name">${escapeHtml(nodeName(report.nodeId))}</span>
      <span class="dash-cell time">${fmtShort(report.testedAt)}</span>
      <span class="dash-cell metrics"><span class="metric pending">载入…</span></span>`;
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
    idle.textContent = `另有 ${idleNodes.length} 个节点还没有 TQ 报告`;
    healthBox.append(idle);
  }
  // 逐行异步填徽标，与详情页同源，避免复制 insight 算法到前端
  const token = ++dashRequestToken;
  const alerts = [];
  for (const { row, report } of healthRows) {
    try {
      const detail = await fetchDetail(report.id);
      if (token !== dashRequestToken) return;
      const cards = new Map((detail.insight?.cards || []).map(card => [card.id, card]));
      const latency = cards.get('latency');
      const loss = cards.get('loss');
      const speed = cards.get('speed');
      row.querySelector('.metrics').innerHTML = `
        ${latency && typeof latency.value === 'number' ? `<span class="metric l${latency.level}">延迟 ${latency.value}${latency.unit}</span>` : ''}
        ${loss && typeof loss.value === 'number' ? `<span class="metric l${loss.level}">丢包 ${loss.value}${loss.unit}</span>` : ''}
        ${speed && typeof speed.value === 'number' ? `<span class="metric l${speed.level}">回程 ${speed.value}${speed.unit}</span>` : ''}
      `;
      // "需要关注"标准：延迟/丢包任一到了 bad 档（最严重），或两者都是 fair
      const worst = [latency, loss, speed].reduce((acc, card) => {
        if (!card || typeof card.value !== 'number') return acc;
        return Math.max(acc, card.level === 'bad' ? 2 : card.level === 'fair' ? 1 : 0);
      }, 0);
      if (worst > 0) alerts.push({ report, latency, loss, speed, worst });
    } catch {
      row.querySelector('.metrics').innerHTML = '<span class="metric na">指标不可用</span>';
    }
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
    item.innerHTML = `<div class="title"><strong>${escapeHtml(nodeName(report.nodeId))}</strong>
      <span class="meta">测试于 ${fmtTime(report.testedAt)}</span></div>
      <div class="metrics">
        ${latency && typeof latency.value === 'number' ? `<span class="metric l${latency.level}">延迟 ${latency.value}${latency.unit}</span>` : ''}
        ${loss && typeof loss.value === 'number' ? `<span class="metric l${loss.level}">丢包 ${loss.value}${loss.unit}</span>` : ''}
        ${speed && typeof speed.value === 'number' ? `<span class="metric l${speed.level}">回程 ${speed.value}${speed.unit}</span>` : ''}
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
    nodes: state.nodes,
    reportsOf: reportsByNode(),
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
  const target = state.selectedNodeId || state.nodes[0]?.id || '';
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
  const changes = result.changes.filter(change => (section === 'all' || change.section === section) && (direction === 'all' || change.direction === direction) && (!onlyChanged || change.delta !== 0));
  if (!changes.length) { el('changeBody').innerHTML = '<p class="empty">当前筛选下没有符合条件的指标。</p>'; return; }
  const rows = changes.map(change => {
    const sign = change.delta > 0 ? '+' : '';
    return `<tr><td>${escapeHtml(sectionNames[change.section] || change.section)}</td><td>${escapeHtml(change.target)}</td><td>${escapeHtml(change.carrier || '—')}</td><td>${escapeHtml(metricLabel(change.metric))}</td><td>${change.before}${change.unit}</td><td>${change.after}${change.unit}</td><td class="${change.direction}">${sign}${change.delta}${change.unit}</td></tr>`;
  }).join('');
  el('changeBody').innerHTML = `<table><thead><tr><th>维度</th><th>对象</th><th>运营商</th><th>指标</th><th>基础报告</th><th>当前报告</th><th>变化</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function showView(view) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
}
async function refresh() {
  const data = await api('/api/state');
  state.nodes = data.nodes;
  state.reports = data.reports;
  state.metricNames = data.metricNames;
  // 未启用认证时没有"登录"概念，退出按钮不应出现（否则登出会被登录页立即送回）
  el('logoutButton').hidden = !data.authEnabled;
  el('syncState').textContent = data.syncedAt ? `已同步 ${data.nodes.filter(node => !node.archived).length} 个节点 · ${fmtTime(data.syncedAt)}` : '未同步节点';
  renderNodes();
  renderHistory();
  renderRecent();
  renderDashboard();
  renderCompareSelectors();
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));
el('nodeFilter').addEventListener('input', renderNodes);
el('syncButton').addEventListener('click', async () => {
  const button = el('syncButton');
  button.disabled = true;
  button.textContent = '同步中…';
  try {
    const data = await api('/api/sync', { method: 'POST' });
    toast(`已同步 ${data.count} 个节点`);
    await refresh();
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '从探针同步节点'; }
});
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
for (const id of ['changeFilter', 'changeDirection', 'onlyChanged']) el(id).addEventListener('change', renderChanges);
el('logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } finally { location.replace('/login'); }
});
setupThemeToggle(el('themeToggle'));
setupBind();
refresh().catch(error => toast(error.message, true));
