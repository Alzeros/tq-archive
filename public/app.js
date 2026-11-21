import { setupThemeToggle } from '/theme.js';
import { nodePicker } from '/picker.js';
import { previousReport, staleNodes } from '/archive.js';
import { renderSparkline, renderInteractiveTrendChart, renderCompareVisuals } from '/charts.js';

// nodes / reports 只含已启用的节点及其报告，界面各处直接用；allNodes / allReports 供选择器搜索全部节点
const state = {
  nodes: [],
  reports: [],
  allNodes: [],
  allReports: [],
  pending: [],
  metricNames: {},
  selectedNodeId: null,
  detail: null,
  insight: null,
  heatmap: { matrixId: null, metricId: null },
  compare: { node: '', result: null },
  compareVisual: { matrixId: null, metricId: null },
  trend: null,
  trendUi: null,
  dashRegion: 'all',
  dashSort: 'region',
  dashboard: null
};

let previewPicker = null;
let bindPicker = null;
const el = id => document.getElementById(id);
const sectionNames = { ipv4: 'IPv4 回程', large4: 'IPv4 大包回程', ipv6: 'IPv6 回程', cernet: '教育网回程', intl: '国际互联', speedtest: '单线程测速' };

const REGION_LABELS = {
  CN: '中国大陆', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国',
  VN: '越南', PH: '菲律宾', ID: '印度尼西亚', IN: '印度', AE: '阿联酋',
  TR: '土耳其', RU: '俄罗斯', AU: '澳大利亚', NZ: '新西兰', US: '美国',
  CA: '加拿大', MX: '墨西哥', BR: '巴西', GB: '英国', DE: '德国',
  NL: '荷兰', FR: '法国', ES: '西班牙', IT: '意大利', SE: '瑞典',
  FI: '芬兰', PL: '波兰', CH: '瑞士', IE: '爱尔兰', RO: '罗马尼亚',
  IS: '冰岛', ZA: '南非', EG: '埃及'
};

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
  if (response.status === 401 && path !== '/api/login') { location.replace('/login'); throw new Error('请先登录'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

const fmtTime = iso => new Date(iso).toLocaleString('zh-CN', { hour12: false });
const fmtShort = iso => {
  const date = new Date(iso);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fmtRelativeAge = iso => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diffHours = Math.max(0, (Date.now() - ms) / 3600e3);
  if (diffHours < 1) return '刚刚';
  if (diffHours < 24) return `${Math.floor(diffHours)}小时前`;
  const days = Math.floor(diffHours / 24);
  return `${days}天前`;
};

const timeIsEstimated = report => (report?.timeSource || report?.upload?.timeSource) === 'upload';
const timeNote = report => (timeIsEstimated(report) ? '（按上传时间估算）' : '');
const estTitle = '上传时没有带测试时间（旧版脚本），这里是服务器收到 CSV 的时间，可能与真实测试时间有偏差';
const timeCell = report => `${fmtTime(report.testedAt)}${timeIsEstimated(report) ? `<span class="warn-pill est-pill" title="${estTitle}">按上传时间</span>` : ''}`;
const shortTimeCell = report => `${fmtShort(report.testedAt)}${timeIsEstimated(report) ? '*' : ''}`;

const nodeName = id => state.allNodes.find(node => node.id === id)?.name || id;
const metricLabel = key => state.metricNames[key] || key;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const metricText = measurement => {
  if (!measurement) return '—';
  if (measurement.status === 'unknown') return measurement.raw || '—';
  if (typeof measurement.value === 'number') return `${measurement.value}${measurement.unit || ''}`;
  return measurement.value ?? '—';
};

function coverageBadge(coverage) {
  if (!coverage) return '';
  let label = '';
  let warning = false;
  if (coverage.badgeStatus === 'failure') { label = `测试失败 · ${coverage.failedMetrics} 项`; warning = true; }
  else if (coverage.importIncomplete) { label = '导入不完整'; warning = true; }
  else if (coverage.badgeStatus === 'warning') { label = '解析提示'; warning = true; }
  else if (coverage.coverageStatus === 'insufficient') label = '覆盖不足';
  else if (coverage.coverageStatus === 'empty') label = '无可用记录';
  else if ((coverage.missingMetrics || 0) > (coverage.expectedMissingMetrics || 0)) label = '存在缺测';
  if (!label) return '';
  const skipped = (coverage.skippedMetrics || 0) > 0 ? `；其中 ${coverage.skippedMetrics} 项被探针跳过（状态 SKIP，未执行）` : '';
  return `<span class="archive-status ${warning ? 'warn' : ''}" title="${escapeHtml(`${coverage.coverageHint || ''} ${coverage.validMetrics} 项有效数值；${coverage.failedMetrics} 项明确失败；${coverage.expectedMissingMetrics || 0} 项预期内单栈未测${skipped}。`)}">${escapeHtml(label)}</span>`;
}

// ===== 关注视角（默认：三网 + 国际优先，弱化教育网）=====
const VIEW_KEY = 'tq_priority_view_v2';
const VIEW_AXES = { access: ['ct', 'cu', 'cm', 'cernet'], usage: ['intl', 'domesticSpeed', 'bulk'] };
const MIN_VIEW_WEIGHT = 0.25;
const MAX_VIEW_WEIGHT = 4;
const LEAF_LABELS = {
  'A.ct.v4': '电信·IPv4 回程', 'A.ct.v6': '电信·IPv6 回程', 'A.cu.v4': '联通·IPv4 回程', 'A.cu.v6': '联通·IPv6 回程',
  'A.cm.v4': '移动·IPv4 回程', 'A.cm.v6': '移动·IPv6 回程', 'A.cernet.v4': '教育网·IPv4 回程', 'A.cernet.v6': '教育网·IPv6 回程',
  'B.ct.v4': '电信·IPv4 大包回程', 'B.cu.v4': '联通·IPv4 大包回程', 'B.cm.v4': '移动·IPv4 大包回程',
  'D.ct.v4': '电信·国内测速', 'D.cu.v4': '联通·国内测速', 'D.cm.v4': '移动·国内测速', 'D.cm.v6': '移动·IPv6 国内测速',
  'I.nodes.v4': '国际节点·IPv4', 'I.nodes.v6': '国际节点·IPv6', 'I.web.v4': '常用网站', 'I.cdn.v4': '常用 CDN', 'I.speed.v4': '国际方向测速'
};
const leafLabel = leaf => LEAF_LABELS[leaf] || leaf;

const defaultView = () => ({
  access: { ct: 1, cu: 1, cm: 1, cernet: MIN_VIEW_WEIGHT },
  usage: { intl: 1, domesticSpeed: 1, bulk: 1 }
});

function normalizeView(input) {
  const view = defaultView();
  for (const [axis, keys] of Object.entries(VIEW_AXES)) {
    for (const key of keys) {
      const value = Number(input?.[axis]?.[key]);
      if (Number.isFinite(value)) view[axis][key] = Math.min(MAX_VIEW_WEIGHT, Math.max(MIN_VIEW_WEIGHT, value));
    }
  }
  return view;
}

const readView = () => {
  try { return normalizeView(JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')); } catch { return defaultView(); }
};

const viewIsEqual = () => Object.values(state.view).every(values => new Set(Object.values(values)).size === 1);
const viewIsRecommended = () => {
  const def = defaultView();
  return Object.entries(VIEW_AXES).every(([axis, keys]) => keys.every(key => state.view[axis][key] === def[axis][key]));
};
// 服务端不传参时是全等权（1,1,1,1），所以只要当前视角不是全等权就带参数，确保默认“弱化教育网”在后端生效
const viewQuery = () => viewIsEqual()
  ? ''
  : `?${Object.entries(state.view).map(([axis, values]) => `${axis}=${Object.entries(values).map(([key, value]) => `${key}:${Number(value.toPrecision(12))}`).join(',')}`).join('&')}`;

function coverageOf(priority) {
  const leaves = priority?.coverage?.leaves || [];
  return leaf => leaves.find(item => item.id === leaf) || null;
}

function prioritySignalText(contribution, cover) {
  const channel = contribution?.primary;
  if (!channel) return '';
  const name = leafLabel(contribution.leaf);
  const breadth = contribution.breadth || {};
  if (channel.kind === 'rate') return `${name}：重度 ${breadth.heavy ?? 0}/${breadth.valid ?? 0} 条，最高 ${breadth.worst ?? '—'}%`;
  if (channel.kind === 'test-failed') return `${name}：${cover?.failed ?? '—'}/${cover?.knownExecutions ?? '—'} 条执行失败或超时`;
  if (channel.kind === 'unreachable') return `${name}：${cover?.failed ?? 0} 条不可达`;
  if (channel.kind === 'latency') {
    const worst = (channel.details || []).slice().sort((left, right) => right.score - left.score)[0];
    return worst ? `${name}：${metricLabel(worst.metric)} p50 ${worst.value}${worst.unit}，超出区域参考` : `${name}：延迟超出区域参考`;
  }
  if (channel.kind === 'speed-outlier') return `${name}：测速点相对同组明显偏低（离群）`;
  if (channel.kind === 'speed-change') {
    const worst = (channel.channels || []).slice().sort((left, right) => right.score - left.score)[0];
    return worst ? `${name}：相对上一份下降约 ${Math.round((1 - worst.ratio) * 100)}%（${worst.points} 个共同测速点）` : `${name}：相对上一份明显下降`;
  }
  return name;
}

const signalTexts = (priority, limit = 3) => {
  const cover = coverageOf(priority);
  return (priority?.reasons || []).slice(0, limit).map(item => prioritySignalText(item, cover(item.leaf))).filter(Boolean);
};

const priorityBadge = priority => {
  if (!priority?.level) return '';
  const reasons = signalTexts(priority);
  const skipped = (priority.coverage?.skippedFamilies || []).map(item => leafLabel(item.leaf));
  const title = [reasons.join('；') || '当前视角下无扣分项', skipped.length ? `未执行（探针跳过）：${skipped.join('、')}` : '', `口径：${priority.algorithmVersion || '候选'}（${priority.calibration || 'candidate'}）`].filter(Boolean).join('｜');
  return `<span class="archive-status ${escapeHtml(priority.level)}" title="${escapeHtml(title)}">${escapeHtml(priority.label)}${Number.isFinite(priority.score) ? ` · ${priority.score}` : ''}</span>`;
};

const priorityReasonLine = priority => {
  const cover = coverageOf(priority);
  return (priority?.reasons || [])
    .filter(item => item.contribution > 0)
    .slice(0, 2)
    .map(item => prioritySignalText(item, cover(item.leaf)))
    .filter(Boolean)
    .join('；');
};

const priorityPrimaryBadge = priority => {
  const top = priority?.primary;
  if (!top) return '';
  return `<span class="primary-signal ${escapeHtml(priority.level || '')}" title="${escapeHtml(signalTexts(priority).join('；'))}">主因：${escapeHtml(leafLabel(top.leaf))}</span>`;
};

function primarySignalBadge(assessment) {
  const signal = assessment?.primary;
  if (!signal) return '';
  const value = Number.isFinite(signal.value) ? ` ${signal.value}${signal.unit || ''}` : '';
  return `<span class="primary-signal ${escapeHtml(assessment.level)}" title="${escapeHtml(signal.text)}">主因：${escapeHtml(signal.label + value)}</span>`;
}

const oneMetric = (card, icon, label) => card && typeof card.value === 'number'
  ? `<span class="metric l${card.level}"><span class="m-icon">${icon}</span>${label} ${card.value}${card.unit}</span>`
  : '';
const metricBadges = ({ latency, loss, speed }) =>
  oneMetric(latency, '⚡', '延迟') + oneMetric(loss, '📉', '丢包') + oneMetric(speed, '🚀', '带宽');

state.view = readView();
const chipLabel = (axis, key) => document.querySelector(`.view-chip[data-axis="${axis}"][data-key="${key}"]`)?.textContent?.trim() || key;

function renderViewBar() {
  for (const button of document.querySelectorAll('.view-chip')) {
    const weight = state.view[button.dataset.axis][button.dataset.key];
    button.setAttribute('aria-pressed', String(weight > MIN_VIEW_WEIGHT));
  }
  for (const input of document.querySelectorAll('#viewTune input')) input.value = state.view[input.dataset.axis][input.dataset.key];
  if (viewIsRecommended()) {
    el('viewSummary').textContent = '三网 + 国际优先（弱化教育网）';
  } else if (viewIsEqual()) {
    el('viewSummary').textContent = '全维度等权';
  } else {
    const changed = Object.entries(state.view).flatMap(([axis, values]) => Object.entries(values).filter(([, value]) => value !== 1).map(([key, value]) => `${chipLabel(axis, key)}×${value}`));
    el('viewSummary').textContent = `视角：${changed.slice(0, 3).join(' ')}${changed.length > 3 ? '…' : ''}`;
  }
  if (el('viewAlgorithm')) {
    el('viewAlgorithm').textContent = state.dashboard?.algorithm
      ? `排序分口径：${state.dashboard.algorithm.version}（${state.dashboard.algorithm.calibration}）；默认将教育网权重设为 0.25，避免教育网局部丢包淹没三网问题。`
      : '排序分口径：默认将教育网权重设为 0.25，优先突出三网与国际互联表现。';
  }
}

async function applyView() {
  if (!viewIsRecommended()) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(state.view)); } catch {} }
  else { try { localStorage.removeItem(VIEW_KEY); } catch {} }
  renderViewBar();
  await renderDashboard();
}

const COLLAPSED_KEY = 'tq_collapsed_groups';
const collapsedGroups = new Set(readCollapsed());
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
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups])); } catch {}
}
function toggleGroup(city, currentlyCollapsed) {
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

const sideNarrow = matchMedia('(max-width: 640px)');
function setSideOpen(open) {
  document.querySelector('.sidebar').classList.toggle('collapsed', !open);
  el('sideToggle').setAttribute('aria-expanded', String(open));
}
const sideIsOpen = () => !document.querySelector('.sidebar').classList.contains('collapsed');
setSideOpen(!sideNarrow.matches);
sideNarrow.addEventListener('change', event => setSideOpen(!event.matches));
el('sideToggle').addEventListener('click', () => setSideOpen(!sideIsOpen()));

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  renderNodes();
  renderHistory();
  showView('history');
  if (sideNarrow.matches) setSideOpen(false);
  document.querySelector('.content').scrollTop = 0;
}

function dropForeignDetail() {
  if (!state.detail || state.detail.nodeId === state.selectedNodeId) return;
  state.detail = null;
  state.insight = null;
  bindPicker = null;
  el('detailCard').classList.add('hidden');
  el('bindPanel').classList.add('hidden');
}

// ============ 统一跳转至变化对比 ============
async function openComparePair(nodeId, baseId, currentId) {
  if (!nodeId || !baseId || !currentId || baseId === currentId) {
    toast('需要两份不同时间的报告才能对比');
    return;
  }
  state.selectedNodeId = nodeId;
  renderNodes();
  renderHistory();
  const reports = state.reports.filter(report => report.nodeId === nodeId).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
  el('compareNode').value = nodeId;
  const options = reports.map(report => `<option value="${escapeHtml(report.id)}">${escapeHtml(fmtTime(report.testedAt) + timeNote(report))}</option>`).join('');
  el('compareBase').innerHTML = options;
  el('compareCurrent').innerHTML = options;
  el('compareBase').value = baseId;
  el('compareCurrent').value = currentId;
  showView('compare', false);
  await runCompare();
  document.querySelector('.content').scrollTop = 0;
}

// ============ 历史趋势：同坐标系多线图 ============
let seriesCache = { key: '', data: null, pending: null };
const seriesKeyOf = reports => `${reports[0].nodeId}|${reports.map(report => report.id).sort().join(',')}`;

function loadSeries(reports) {
  const key = seriesKeyOf(reports);
  if (seriesCache.key !== key) seriesCache = { key, data: null, pending: null };
  if (seriesCache.data) return Promise.resolve(seriesCache.data);
  if (seriesCache.pending) return seriesCache.pending;
  const ids = new Set(reports.map(report => report.id));
  seriesCache.pending = api(`/api/stats?group=report&node=${encodeURIComponent(reports[0].nodeId)}&split=carrier`)
    .then(response => {
      const groups = response.groups.filter(group => ids.has(group.key));
      const node = state.allNodes.find(n => n.id === reports[0].nodeId);
      const band = (node?.region && response.regionBands?.[node.region.toUpperCase()]) || groups.find(g => g.regionBand)?.regionBand || { label: '当前区域', good: 160, fair: 215 };
      const data = {
        byId: new Map(groups.map(group => [group.key, { cards: group.series || [], coverage: group.coverage || null }])),
        carriers: new Map(groups.map(group => [group.key, group])),
        regionBand: band
      };
      seriesCache.data = data;
      seriesCache.pending = null;
      return data;
    })
    .catch(error => {
      if (seriesCache.key === key) seriesCache.pending = null;
      throw error;
    });
  return seriesCache.pending;
}

let trendRequestToken = 0;
async function renderTrends(reports) {
  const panel = el('trendPanel');
  const token = ++trendRequestToken;
  if (reports.length < 2) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="trend-loading">载入同坐标系走势…</p>';
  const sorted = [...reports].sort((left, right) => Date.parse(left.testedAt) - Date.parse(right.testedAt));
  state.trend = { reports: sorted, data: null };
  try {
    const data = await loadSeries(sorted);
    if (token !== trendRequestToken) return;
    state.trend.data = data;
    if (el('historyMeta') && data.regionBand) {
      const latestIp = data.carriers.get(sorted.at(-1).id)?.sourceIp;
      el('historyMeta').textContent = `${data.regionBand.label}基准：好 ≤${data.regionBand.good}ms / 一般 ≤${data.regionBand.fair}ms${latestIp ? ` · 最新出口 IP ${latestIp}` : ''}`;
    }
    state.trendUi = renderInteractiveTrendChart(panel, {
      reports: sorted,
      seriesData: data,
      regionBand: data.regionBand,
      state: state.trendUi && state.trendUi.nodeId === sorted[0].nodeId ? state.trendUi : (state.trendUi = { nodeId: sorted[0].nodeId, mode: 'carriers', spacing: 'time', hidden: new Set(), compareMode: false, baseId: null, activeIndex: sorted.length - 1 }),
      onOpenReport: id => openDetail(id),
      onCompare: (baseId, currentId) => openComparePair(sorted[0].nodeId, baseId, currentId)
    });
  } catch (error) {
    if (token !== trendRequestToken) return;
    panel.innerHTML = `<p class="empty">趋势加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderHistory() {
  const list = el('historyList');
  dropForeignDetail();
  if (!state.selectedNodeId) {
    el('historyTitle').textContent = '请选择节点';
    if (el('historyMeta')) el('historyMeta').textContent = '点击左侧节点列表查看该节点历次评测报告走势及详情';
    list.innerHTML = '<p class="empty">从左侧选择一个节点，查看它历次的 TQ 评测历史与走势。</p>';
    el('detailCard').classList.add('hidden');
    el('trendPanel').classList.add('hidden');
    el('trendPanel').innerHTML = '';
    return;
  }
  const node = state.allNodes.find(n => n.id === state.selectedNodeId);
  const reports = state.reports.filter(report => report.nodeId === state.selectedNodeId).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
  el('historyTitle').textContent = `${nodeName(state.selectedNodeId)} · ${reports.length} 份报告`;
  if (el('historyMeta')) {
    const rCode = String(node?.region || '').toUpperCase();
    el('historyMeta').textContent = rCode ? `区域：${REGION_LABELS[rCode] || rCode}` : '历次评测报告时间线';
  }
  if (!reports.length) {
    list.innerHTML = '<p class="empty">该节点还没有报告，可前往“导入报告”粘贴链接进行初次归档。</p>';
    el('detailCard').classList.add('hidden');
    el('trendPanel').classList.add('hidden');
    el('trendPanel').innerHTML = '';
    return;
  }
  list.innerHTML = '';
  renderTrends(reports);
  const metricHosts = [];
  for (const report of reports) {
    const prev = previousReport(state.reports, report);
    const item = document.createElement('div');
    item.className = 'item history-item';
    item.innerHTML = `<div class="history-main">
      <div class="title">
        <div class="history-title-row">
          <strong class="time-title">${timeCell(report)}</strong>
          ${report.sourceType === 'csv' ? '<span class="source-pill" title="服务器上用 run-with-hub.sh 直传的 CSV">直传</span>' : ''}
          ${report.identity ? `<span class="ident-pill">${escapeHtml(report.identity)}</span>` : ''}
          <span class="record-pill">${report.recordCount} 条指标</span>
        </div>
      </div>
      <div class="metrics" data-report="${report.id}"><span class="metric pending">载入指标…</span></div>
      <div class="history-diff-row" data-diff-for="${report.id}"></div>
    </div>
    <div class="actions history-actions">
      <button class="primary small open-btn" type="button">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        <span>查看详情</span>
      </button>
      ${prev ? '<button class="secondary small previous-btn" type="button">对比上一份</button>' : ''}
      ${report.sourceType === 'csv'
        ? `<a class="button ghost small" href="/api/reports/${report.id}/raw" download>原始 CSV</a>`
        : `<a class="button ghost small" href="${escapeHtml(report.sourceUrl)}" target="_blank" rel="noreferrer noopener">原报告</a>`}
      <button class="danger small del-btn" type="button" title="删除归档">删除</button>
    </div>`;
    item.querySelector('.open-btn').addEventListener('click', () => openDetail(report.id));
    item.querySelector('.previous-btn')?.addEventListener('click', () => comparePreviousReport(report));
    const remove = item.querySelector('.del-btn');
    remove.addEventListener('click', async () => {
      if (!confirm(`删除 ${fmtTime(report.testedAt)}${timeNote(report)} 的归档？原始${report.sourceType === 'csv' ? ' CSV' : '报告 HTML'}也会一并删除，且无法恢复。`)) return;
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
    metricHosts.push({ host: item.querySelector('.metrics'), diffHost: item.querySelector('.history-diff-row'), id: report.id });
  }
  fillHistoryMetrics(reports, metricHosts);
}

const BADGE_DEFS = [
  { key: 'latency', short: '延迟', icon: '⚡' },
  { key: 'loss', short: '丢包', icon: '📉' },
  { key: 'speed', short: '回程', icon: '🚀' }
];

function diffTagHtml(tag) {
  return `<span class="diff-tag ${escapeHtml(tag.tone || 'neutral')}">${escapeHtml(tag.text)}</span>`;
}

async function fillHistoryMetrics(reports, hosts) {
  let data;
  try { data = await loadSeries(reports); }
  catch {
    for (const { host } of hosts) if (host?.isConnected) host.innerHTML = '<span class="metric na">指标暂不可用</span>';
    return;
  }
  await Promise.all(hosts.map(async ({ host, diffHost, id }) => {
    if (!host?.isConnected) return;
    let entry = data.byId.get(id);
    const stat = data.carriers.get(id);
    if (!entry) {
      const detail = await fetchDetail(id).catch(() => null);
      if (!detail || !host.isConnected) return;
      entry = { cards: detail.insight?.cards || [], coverage: detail.coverage || null };
    }
    const cards = new Map(entry.cards.map(card => [card.id, card]));
    // 优先呈现分三网小胶囊 + 国际 + 丢包 + 带宽
    const cPills = ['电信', '联通', '移动'].map(c => {
      const v = stat?.carriers?.[c]?.latency;
      return typeof v === 'number' ? `<span class="metric carrier-mini">${c} ${v}ms</span>` : '';
    }).filter(Boolean).join('');
    const intlVal = stat?.intl?.latency ?? cards.get('intl')?.value;
    const intlPill = typeof intlVal === 'number' ? `<span class="metric l${stat?.intl?.level || 'info'}">国际 ${intlVal}ms</span>` : '';
    const lossCard = cards.get('loss');
    const speedCard = cards.get('speed');
    const summaryBadges = (cPills || oneMetric(cards.get('latency'), '⚡', '延迟'))
      + intlPill
      + oneMetric(lossCard, '📉', '丢包')
      + oneMetric(speedCard, '🚀', '回程')
      + coverageBadge(entry.coverage);
    host.innerHTML = summaryBadges || BADGE_DEFS.map(def => `<span class="metric na">${def.short} —</span>`).join('');
    if (diffHost?.isConnected && stat?.diffFromPrev?.tags?.length) {
      diffHost.innerHTML = `<span class="history-diff-lbl">较上份：</span>${stat.diffFromPrev.tags.map(diffTagHtml).join('')}`;
    }
  }));
}

// ============ 洞察视图：三网 + 国际首屏卡 + 降噪折叠 ============
function renderInsight(insight, snapshot = null) {
  if (!insight) { el('detailSummary').innerHTML = ''; return; }
  state.insight = insight;
  const levelNames = { good: '优秀', fair: '一般', bad: '异常', info: '正常' };
  const region = insight.region || { label: '未知区域', good: '', fair: '' };

  let heroHtml = '';
  if (snapshot?.carriers) {
    const carrierCards = ['电信', '联通', '移动'].map(c => {
      const data = snapshot.carriers[c] || {};
      const lvl = data.latencyLevel || 'info';
      const lossCount = (data.lossLines || 0) + (data.retransLines || 0);
      const lossBadge = lossCount > 0
        ? `<span class="hero-sub-bad">丢包${data.lossLines} · 重传${data.retransLines}条</span>`
        : '<span class="hero-sub-ok">零丢包</span>';
      return `<div class="icard hero-carrier ${lvl}">
        <div class="icard-header">
          <span class="label">${c} · 回程</span>
          <span class="icard-badge ${lvl}">${data.latencyP50 !== null ? (levelNames[lvl] || '指标') : '无数据'}</span>
        </div>
        <div class="value">${data.latencyP50 ?? '—'}<span class="unit">ms</span></div>
        <div class="note">p90 ${data.latencyP90 ?? '—'}ms${data.route ? ` · ${escapeHtml(data.route)}` : ''}</div>
        <div class="hero-card-foot">${lossBadge}${data.returnSpeed !== null ? `<span>· ${data.returnSpeed} Mbps</span>` : ''}</div>
      </div>`;
    }).join('');
    const intl = snapshot.intl || {};
    const intlLvl = intl.level || 'info';
    const intlBadge = intl.unreachableCount > 0
      ? `<span class="hero-sub-bad">${intl.unreachableCount} 个服务不可达</span>`
      : `<span class="hero-sub-ok">${intl.servicesTotal || 0} 项服务全可达</span>`;
    const intlCard = `<div class="icard hero-carrier ${intlLvl}">
      <div class="icard-header">
        <span class="label">国际互联</span>
        <span class="icard-badge ${intlLvl}">${intl.latencyP50 !== null ? (levelNames[intlLvl] || '指标') : '无数据'}</span>
      </div>
      <div class="value">${intl.latencyP50 ?? '—'}<span class="unit">ms</span></div>
      <div class="note">${intl.nodeCount || 0} 个国际节点 p50${intl.speedDown !== null ? ` · 下载 ${intl.speedDown}Mbps` : ''}</div>
      <div class="hero-card-foot">${intlBadge}</div>
    </div>`;
    heroHtml = `<div class="card-grid hero-grid">${carrierCards}${intlCard}</div>`;
  }

  const cards = insight.cards.filter(c => !snapshot?.carriers || !['intl', 'cernet', 'carrier'].includes(c.id)).map(card => `<div class="icard compact-icard ${card.level || ''}">
      <div class="icard-header">
      <span class="label">${escapeHtml(card.label)}</span>
      <span class="icard-badge ${card.level || 'info'}">${card.id === 'speed' ? '实测参考' : levelNames[card.level] || '指标'}</span>
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
  const isCernetNotice = item => /教育网/.test(item.text || '');
  const coreAnomalies = insight.anomalies.filter(item => item.level !== 'info' && !isCernetNotice(item)).sort((left, right) => (left.level === 'danger' ? -1 : 0) - (right.level === 'danger' ? -1 : 0));
  const secondaryAnomalies = insight.anomalies.filter(item => item.level === 'info' || isCernetNotice(item));
  const anomalyItem = item => `<div class="anomaly ${item.level}"><span class="anomaly-icon">${levelIcons[item.level] || levelIcons.info}</span><div class="anomaly-body"><span class="tag">${item.kind === 'speed-outlier' ? '留意 · 测速点离群' : levels[item.level] || '提示'}</span><span class="text">${escapeHtml(item.text)}</span></div></div>`;

  const anomalies = (coreAnomalies.length || secondaryAnomalies.length)
    ? `<div class="insight-block"><h3 class="section-title">核心异常与留意项 · ${coreAnomalies.length} 条</h3>
        ${coreAnomalies.length ? `<div class="anomalies-list">${coreAnomalies.map(anomalyItem).join('')}</div>` : '<div class="ok">三网与国际核心维度未检出丢包、重传或异常。</div>'}
        ${secondaryAnomalies.length ? `<details class="anomaly-info"><summary>次要维度（教育网）与线路说明 · ${secondaryAnomalies.length} 条</summary><div class="anomalies-list">${secondaryAnomalies.map(anomalyItem).join('')}</div></details>` : ''}</div>`
    : '<div class="insight-block"><div class="ok"><svg class="inline-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>未检出丢包、重传、速度离群或骨干异常，网络表现平稳。</div></div>';

  const regions = insight.regions.length
    ? `<div class="insight-block"><h3 class="section-title">国内大区聚合 · 判断是区域性劣化还是个别省份</h3>
        <div class="region-row">${insight.regions.map(item => `<span class="region"><span class="name">${escapeHtml(item.name)}</span><span class="hm-cell l${item.level}">${item.p50}ms</span></span>`).join('')}</div></div>`
    : '';

  const calibrated = new Set(insight.calibratedRegions || []);
  const bandRows = Object.entries(insight.latencyBands || {})
    .map(([code, item]) => `<tr${code === region.code ? ' class="current"' : ''}>
      <td>${escapeHtml(code)}</td><td>${escapeHtml(item.label)}</td><td>${item.good}</td><td>${item.fair}</td>
      <td class="${calibrated.has(code) ? 'yes' : 'no'}">${calibrated.has(code) ? '已校准' : '待校准'}</td>
    </tr>`).join('');

  // 12 国际节点延迟网格
  const intlNodes = snapshot?.intl?.nodes || [];
  const intlGridHtml = intlNodes.length
    ? `<div class="insight-block"><h3 class="section-title">国际节点延迟分布 · ${intlNodes.length} 个全球方向</h3>
        <div class="intl-node-grid">${intlNodes.map(n => `<div class="intl-node-card l${n.level || 'na'}">
          <div class="intl-node-name">${escapeHtml(n.target)}</div>
          <div class="intl-node-val">${n.downloadLatency !== null ? `${n.downloadLatency}ms` : '—'}</div>
          <div class="intl-node-sub">上传 ${n.uploadLatency !== null ? `${n.uploadLatency}ms` : '—'}${n.downloadRetrans ? ` · 重传${n.downloadRetrans}次` : ''}</div>
        </div>`).join('')}</div></div>`
    : '';

  const services = insight.services
    ? `<div class="insight-block"><h3 class="section-title">常用网站 / CDN · 共 ${insight.services.total} 个${insight.services.unreachable ? `（${insight.services.unreachable} 个不可达）` : '（全部可达）'}</h3>
        <div class="svc-row">${insight.services.slowest.map(item => `<span class="svc"><span class="name">${escapeHtml(item.name)}</span><span class="lat">${item.latency ?? '—'}ms</span></span>`).join('')}</div></div>`
    : '';

  // 矩阵排序：ipv4 / large4 / speedtest / ipv6 / cernet(置后标次要)
  const matrixOrder = ['ipv4', 'large4', 'speedtest', 'ipv6', 'cernet'];
  const orderedMatrices = [...insight.matrices].sort((a, b) => {
    const ia = matrixOrder.indexOf(a.id);
    const ib = matrixOrder.indexOf(b.id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  state.orderedMatrices = orderedMatrices;
  const tabs = orderedMatrices.map((matrix, index) => `<button class="hm-tab${index === 0 ? ' active' : ''}" type="button" data-matrix="${matrix.id}">${escapeHtml(matrix.name)}${matrix.id === 'cernet' ? ' · 次要' : ''}</button>`).join('');

  el('detailSummary').innerHTML = `<div class="insight-block">
      ${heroHtml}
      ${cards ? `<div class="card-grid secondary-cards">${cards}</div>` : ''}
      <details class="basis-wrap">
        <summary>评级基准 · 当前区域：${escapeHtml(region.label)}（好 ≤ ${region.good}ms / 一般 ≤ ${region.fair}ms${region.calibrated ? '' : ' · 待校准'}）</summary>
        <p class="hint">按机房所在区域基准分档，避免把物理距离误判成线路问题；<strong>已校准</strong>区域由实测报告推导。</p>
        <div class="table-wrap"><table><thead><tr><th>区域</th><th>名称</th><th>好 ≤ (ms)</th><th>一般 ≤ (ms)</th><th>校准</th></tr></thead><tbody>${bandRows}</tbody></table></div>
      </details>
    </div>
    ${anomalies}${regions}
    <div class="insight-block">
      <div class="insight-head"><h3 class="section-title">省份 × 运营商</h3><div class="hm-tabs">${tabs}</div></div>
      <div id="heatmap"></div>
      <p class="hint">颜色按「${escapeHtml(region.label)}」基准判档：≤${region.good}ms 好、≤${region.fair}ms 一般、超过为差；点击格子可查看去程线路。</p>
    </div>
    ${intlGridHtml}${services}`;

  state.heatmap = { matrixId: orderedMatrices[0]?.id || null, metricId: null };
  for (const button of el('detailSummary').querySelectorAll('.hm-tab[data-matrix]')) {
    button.addEventListener('click', () => { state.heatmap = { matrixId: button.dataset.matrix, metricId: null }; syncMatrixTabs(); drawHeatmap(); });
  }
  drawHeatmap();
}

function syncMatrixTabs() {
  for (const button of el('detailSummary').querySelectorAll('.hm-tab[data-matrix]')) button.classList.toggle('active', button.dataset.matrix === state.heatmap.matrixId);
}

function drawHeatmap() {
  const matrices = state.orderedMatrices || state.insight?.matrices;
  if (!matrices?.length) return;
  const matrix = matrices.find(item => item.id === state.heatmap.matrixId) || matrices[0];
  const metric = matrix.metrics.find(item => item.id === state.heatmap.metricId) || matrix.metrics[0];
  const tabs = matrix.metrics.map(item => `<button class="hm-tab${item.id === metric.id ? ' active' : ''}" type="button" data-metric="${item.id}">${escapeHtml(item.name)}</button>`).join('');
  const swatch = levels => levels.map(level => `<span class="hm-cell l${level} sw"></span>`).join('');
  const legend = metric.text ? '' : `<div class="hm-legend"><span>好</span>${swatch([0, 1])}<span>一般</span>${swatch([2, 3])}<span>差</span>${swatch([4])}</div>`;
  const body = matrix.rows.map((row, rowIndex) => {
    const cells = matrix.columns.map((column, columnIndex) => {
      const route = matrix.routes[rowIndex][columnIndex];
      if (metric.text) return `<span class="hm-cell text" title="去程线路">${escapeHtml(route || '—')}</span>`;
      const cell = metric.cells[rowIndex][columnIndex];
      const text = cell && cell.v !== null ? `${cell.v}${metric.unit}` : '—';
      const tone = cell && cell.l !== null ? `l${cell.l}` : 'na';
      const detailText = `${row} · ${column} ${text}｜去程 ${route || '未知'}`;
      return `<button type="button" class="hm-cell ${tone}" data-detail="${escapeHtml(detailText)}" title="${escapeHtml(detailText)}" aria-label="${escapeHtml(detailText)}">${escapeHtml(text)}</button>`;
    }).join('');
    return `<span class="hm-row-name">${escapeHtml(row)}</span>${cells}`;
  }).join('');
  const head = `<span class="hm-row-name"></span>${matrix.columns.map(column => `<span class="hm-col">${escapeHtml(column)}</span>`).join('')}`;
  el('heatmap').innerHTML = `<div class="hm-tabs">${tabs}</div><div class="hm-grid cols-${Math.min(3, matrix.columns.length)}">${head}${body}</div><p class="hm-detail" id="hmDetail" aria-live="polite" hidden></p>${legend}`;
  for (const button of el('heatmap').querySelectorAll('.hm-tab[data-metric]')) {
    button.addEventListener('click', () => { state.heatmap.metricId = button.dataset.metric; drawHeatmap(); });
  }
  for (const cell of el('heatmap').querySelectorAll('.hm-cell[data-detail]')) {
    cell.addEventListener('click', () => {
      const box = el('hmDetail');
      if (!box.hidden && box.textContent === cell.dataset.detail) { box.hidden = true; return; }
      box.textContent = cell.dataset.detail;
      box.hidden = false;
    });
  }
}

function renderWarnings(report) {
  const warningIssues = report.coverage?.issues.filter(issue => issue.type === 'warning' && issue.severity !== 'neutral');
  const warnings = warningIssues ? warningIssues.map(issue => Number.isFinite(issue.reportedMetrics) ? `指标统计：${issue.failedMetrics || 0} 项明确失败、${issue.unknownMetrics || 0} 项未知格式、${Math.max(0, (issue.missingMetrics || 0) - (issue.expectedMissingMetrics || 0))} 项缺测；另有 ${issue.expectedMissingMetrics || 0} 项单栈 IPv6 预期未测。` : issue.message) : report.warnings || [];
  const box = el('detailWarnings');
  if (!warnings.length) { box.innerHTML = ''; return 0; }
  const summary = warnings.length === report.warnings?.length && !warningIssues ? report.insight?.warningSummary : null;
  if (!summary || summary.total <= 2) {
    box.innerHTML = `<div class="warn">解析提示：${warnings.map(escapeHtml).join('；')}</div>`;
    return warnings.length;
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
      <div class="warn-head">解析提示 · 共 ${summary.total} 条，归为 ${kinds} 类</div>
      <ul class="warn-list">${rows}${restRow}</ul>
      <details class="warn-all"><summary>展开全部 ${summary.total} 条原始提示</summary><ol>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ol></details>
    </div>`;
  return summary.total;
}

async function openDetail(reportId) {
  let report;
  try { report = await fetchDetail(reportId); }
  catch (error) { toast(`打开报告失败：${error.message}`, true); return; }
  state.detail = report;
  const prev = previousReport(state.reports, report);
  el('comparePrevious').hidden = !prev;
  el('comparePrevious').onclick = () => comparePreviousReport(report);
  el('detailCard').classList.remove('hidden');
  el('detailTitle').textContent = `${nodeName(report.nodeId)} · ${shortTimeCell(report)}`;
  const isCsv = report.sourceType === 'csv';
  el('openOriginal').hidden = isCsv;
  if (!isCsv) el('openOriginal').href = report.sourceUrl;
  el('downloadJson').href = `/api/reports/${reportId}/export`;
  el('downloadRaw').href = `/api/reports/${reportId}/raw`;
  el('downloadRaw').querySelector('span').textContent = isCsv ? '原始 CSV' : '原始 HTML';

  const warnCount = renderWarnings(report);
  el('detailWarnings').insertAdjacentHTML('afterbegin', `<div class="coverage-result"><p>${escapeHtml(report.coverage.coverageHint || '')}</p><p>覆盖：${report.coverage.sections.map(section => `${escapeHtml(section.name)} ${section.records} 条`).join(' · ')}；${report.coverage.validMetrics} 项有效数值。</p><p>单栈未测与测试失败分开统计；仅测部分维度不等于导入失败。</p></div>`);

  el('detailCoverageBadges').innerHTML = `${coverageBadge(report.coverage)}<span class="record-pill">${report.records.length} 条记录</span>${report.snapshot?.sourceIp ? `<span class="ident-pill">IP ${escapeHtml(report.snapshot.sourceIp)}</span>` : ''}`;
  const fold = el('detailNoticesFold');
  fold.open = false;
  el('detailNoticesSummary').textContent = warnCount ? `覆盖与解析说明（${warnCount} 条提示）` : '覆盖与口径说明';

  const diffStrip = el('detailDiffStrip');
  const diff = report.previousDiff;
  if (diff) {
    diffStrip.classList.remove('hidden');
    diffStrip.innerHTML = `
      <div class="detail-diff-main">
        <span class="detail-diff-lbl">较上一份 (${escapeHtml(fmtShort(diff.baseTestedAt))})：</span>
        <div class="diff-tags-wrap">${diff.tags.map(diffTagHtml).join('')}</div>
      </div>
      <button type="button" class="secondary small" id="detailGoCompare">查看完整对比 →</button>`;
    diffStrip.querySelector('#detailGoCompare').addEventListener('click', () => openComparePair(report.nodeId, diff.baseId, report.id));
  } else {
    diffStrip.classList.add('hidden');
    diffStrip.innerHTML = '';
  }

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
  renderInsight(report.insight, report.snapshot);
  el('bindCurrent').textContent = nodeName(report.nodeId);
  el('bindPanel').classList.add('hidden');
  bindPicker = null;
  el('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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
      detailCache.delete(state.detail.id);
      state.selectedNodeId = nodeId;
      el('detailCard').classList.add('hidden');
      state.detail = null;
      await refresh();
    } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
  });
}

// ============ 看板：更新动态 + 关注节点 + 区域三网健康矩阵 ============
function regionInfoOf(node, entry) {
  const fromSnap = entry?.snapshot?.region;
  if (fromSnap?.code) return fromSnap;
  const code = String(node?.region || '').toUpperCase() || 'OTHER';
  return { code, label: REGION_LABELS[code] || code, good: null, fair: null };
}

function renderRegionFilter(nodes, entryMap) {
  const host = el('dashRegionFilter');
  if (!host) return;
  const seen = new Map();
  for (const node of nodes) {
    const info = regionInfoOf(node, entryMap.get(node.id));
    if (!seen.has(info.code)) seen.set(info.code, { code: info.code, label: info.label, count: 0 });
    seen.get(info.code).count += 1;
  }
  const regions = [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'));
  if (state.dashRegion !== 'all' && !seen.has(state.dashRegion)) state.dashRegion = 'all';
  host.innerHTML = [
    `<button type="button" class="filter-chip${state.dashRegion === 'all' ? ' active' : ''}" data-region="all">全部 (${nodes.length})</button>`,
    ...regions.map(r => `<button type="button" class="filter-chip${state.dashRegion === r.code ? ' active' : ''}" data-region="${escapeHtml(r.code)}">${escapeHtml(r.label)} (${r.count})</button>`)
  ].join('');
  for (const btn of host.querySelectorAll('.filter-chip')) {
    btn.addEventListener('click', () => {
      state.dashRegion = btn.dataset.region;
      drawDashboardPanels();
    });
  }
}

function renderRecentChanges(recentChanges = []) {
  const host = el('recentChanges');
  if (!host) return;
  const list = state.dashRegion === 'all'
    ? recentChanges
    : recentChanges.filter(item => (item.snapshot?.region?.code || String(item.region || '').toUpperCase() || 'OTHER') === state.dashRegion);
  if (!list.length) {
    host.innerHTML = '<p class="empty">当前筛选下暂无最近上报记录。</p>';
    return;
  }
  host.innerHTML = '';
  for (const item of list.slice(0, 6)) {
    const snap = item.snapshot;
    const carriers = snap?.carriers || {};
    const cHtml = ['电信', '联通', '移动'].map(c => {
      const info = carriers[c];
      if (!info || info.latencyP50 === null) return `<span class="mini-kv"><span class="k">${c}</span><span class="v na">—</span></span>`;
      return `<span class="mini-kv"><span class="k">${c}</span><span class="v l${info.latencyLevel || 'info'}">${info.latencyP50}ms</span></span>`;
    }).join('');
    const intlVal = snap?.intl?.latencyP50;
    const intlHtml = intlVal !== null && intlVal !== undefined
      ? `<span class="mini-kv"><span class="k">国际</span><span class="v l${snap.intl.level || 'info'}">${intlVal}ms</span></span>`
      : '';
    const lossLines = snap?.overall?.lossLines ?? 0;
    const speedVal = snap?.overall?.returnSpeed;
    const diffTags = item.diff?.tags?.length
      ? item.diff.tags.map(diffTagHtml).join('')
      : '<span class="diff-tag neutral">首次记录</span>';

    const card = document.createElement('div');
    card.className = `recent-change-card verdict-${escapeHtml(item.diff?.verdict || 'steady')}`;
    card.innerHTML = `
      <div class="rc-top">
        <div class="rc-title">
          <strong>${escapeHtml(item.nodeName)}</strong>
          <span class="rc-age" title="${escapeHtml(fmtTime(item.testedAt))}">${escapeHtml(fmtRelativeAge(item.testedAt))}</span>
          <span class="rc-time">${escapeHtml(shortTimeCell(item))}</span>
          ${item.sourceIp ? `<span class="rc-ip">${escapeHtml(item.sourceIp)}</span>` : ''}
        </div>
        <div class="rc-actions">
          ${item.previousId ? `<button type="button" class="secondary small rc-compare-btn">对比变化</button>` : ''}
          <button type="button" class="ghost small rc-detail-btn">详情</button>
        </div>
      </div>
      <div class="rc-bottom">
        <div class="rc-diffs">${diffTags}</div>
        <div class="rc-metrics">
          ${cHtml}${intlHtml}
          <span class="mini-kv"><span class="k">丢包/重传</span><span class="v ${lossLines ? 'lbad' : 'lgood'}">${lossLines ? `${lossLines}条` : '0'}</span></span>
          ${speedVal !== null && speedVal !== undefined ? `<span class="mini-kv"><span class="k">带宽</span><span class="v">${speedVal}M</span></span>` : ''}
        </div>
      </div>`;
    card.querySelector('.rc-compare-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openComparePair(item.nodeId, item.previousId, item.reportId);
    });
    const openThis = () => {
      state.selectedNodeId = item.nodeId;
      renderNodes();
      renderHistory();
      showView('history');
      openDetail(item.reportId);
    };
    card.querySelector('.rc-detail-btn').addEventListener('click', openThis);
    card.addEventListener('click', openThis);
    host.append(card);
  }
}

function matrixRowHtml(node, entry) {
  const snap = entry?.snapshot;
  const carriers = snap?.carriers || {};
  const series = (entry?.trend || []).map(t => t.latency).filter(v => typeof v === 'number');
  const testedAt = entry?.testedAt;
  const ageText = testedAt ? fmtRelativeAge(testedAt) : '未测';
  const ageMs = testedAt ? Date.now() - Date.parse(testedAt) : Infinity;
  const ageCls = !testedAt ? 'stale' : ageMs > 14 * 86400e3 ? 'stale' : ageMs > 7 * 86400e3 ? 'old' : 'fresh';

  const carrierCell = name => {
    const c = carriers[name];
    if (!c || c.latencyP50 === null) return '<div class="mx-cell na">—</div>';
    const route = c.route ? `<span class="mx-sub">${escapeHtml(c.route)}</span>` : '';
    return `<div class="mx-cell"><span class="mx-lat l${c.latencyLevel || 'info'}">${c.latencyP50}ms</span>${route}</div>`;
  };

  const intl = snap?.intl;
  const intlCell = (!intl || intl.latencyP50 === null)
    ? '<div class="mx-cell na">—</div>'
    : `<div class="mx-cell"><span class="mx-lat l${intl.level || 'info'}">${intl.latencyP50}ms</span>${intl.unreachableCount ? `<span class="mx-sub bad">${intl.unreachableCount}不可达</span>` : '<span class="mx-sub ok">全可达</span>'}</div>`;

  const ov = snap?.overall;
  const lossCell = !ov
    ? '<div class="mx-cell na">—</div>'
    : ov.lossLines === 0
      ? '<div class="mx-cell"><span class="mx-pill lgood">全零</span></div>'
      : `<div class="mx-cell"><span class="mx-pill l${ov.lossLevel || 'fair'}">${ov.lossLines}条</span><span class="mx-sub">高${ov.lossMax}%</span></div>`;

  const speedCell = (!ov || ov.returnSpeed === null)
    ? '<div class="mx-cell na">—</div>'
    : `<div class="mx-cell"><span class="mx-lat l${ov.speedLevel || 'info'}">${ov.returnSpeed}M</span></div>`;

  const sparkCell = `<div class="mx-cell mx-spark">${renderSparkline(series) || '<span class="na">—</span>'}</div>`;

  const diff = entry?.diff;
  const diffCell = diff?.tags?.length
    ? `<div class="mx-cell mx-diff"><button type="button" class="mx-diff-btn" data-node="${escapeHtml(node.id)}" data-base="${escapeHtml(diff.baseId)}" data-cur="${escapeHtml(diff.currentId)}" title="点击查看此次变化对比">${diff.tags.slice(0, 2).map(diffTagHtml).join('')}</button></div>`
    : `<div class="mx-cell mx-diff"><span class="na">${testedAt ? '仅1份' : '无报告'}</span></div>`;

  const prioTag = entry?.priority && ['now', 'soon'].includes(entry.priority.level)
    ? `<span class="mx-prio ${escapeHtml(entry.priority.level)}">${escapeHtml(entry.priority.label)}</span>`
    : '';

  return `
    <div class="mx-row${testedAt ? '' : ' idle'}" data-node="${escapeHtml(node.id)}" role="button" tabindex="0">
      <div class="mx-cell mx-node">
        <div class="mx-node-top">
          <span class="cell-node-dot${testedAt ? '' : ' idle'}"></span>
          <strong class="mx-node-name">${escapeHtml(node.name)}</strong>
          ${prioTag}
        </div>
        <div class="mx-node-meta">
          <span class="mx-age ${ageCls}">${escapeHtml(ageText)}</span>
          ${testedAt ? `<span>${escapeHtml(fmtShort(testedAt))}</span>` : ''}
        </div>
      </div>
      ${carrierCell('电信')}
      ${carrierCell('联通')}
      ${carrierCell('移动')}
      ${intlCell}
      ${lossCell}
      ${speedCell}
      ${sparkCell}
      ${diffCell}
    </div>`;
}

function renderMatrix() {
  const host = el('dashMatrix');
  if (!host || !state.dashboard) return;
  const activeNodes = state.nodes.filter(n => !n.archived);
  const entryMap = new Map((state.dashboard.entries || []).map(e => [e.nodeId, e]));
  renderRegionFilter(activeNodes, entryMap);

  const filtered = activeNodes.filter(n => state.dashRegion === 'all' || regionInfoOf(n, entryMap.get(n.id)).code === state.dashRegion);
  if (!filtered.length) {
    host.innerHTML = '<p class="empty">当前区域暂无启用节点。</p>';
    return;
  }

  const headerHtml = `
    <div class="mx-head">
      <span>节点</span>
      <span>电信 p50</span>
      <span>联通 p50</span>
      <span>移动 p50</span>
      <span>国际 p50</span>
      <span>丢包/重传</span>
      <span>回程带宽</span>
      <span>走势</span>
      <span>较上次变化</span>
    </div>`;

  const avgCarrierLat = node => {
    const snap = entryMap.get(node.id)?.snapshot;
    if (!snap?.carriers) return Infinity;
    const vals = ['电信', '联通', '移动'].map(c => snap.carriers[c]?.latencyP50).filter(v => typeof v === 'number');
    if (!vals.length) return Infinity;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const priorityOrder = new Map((state.dashboard.entries || []).map((e, i) => [e.nodeId, i]));

  const bindMatrixEvents = () => {
    for (const btn of host.querySelectorAll('.mx-diff-btn')) {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const { node, base, cur } = btn.dataset;
        openComparePair(node, base, cur);
      });
    }
    for (const row of host.querySelectorAll('.mx-row')) {
      const open = () => selectNode(row.dataset.node);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    }
  };

  if (state.dashSort === 'region') {
    const groups = new Map();
    for (const node of filtered) {
      const info = regionInfoOf(node, entryMap.get(node.id));
      if (!groups.has(info.code)) groups.set(info.code, { info, nodes: [] });
      groups.get(info.code).nodes.push(node);
    }
    const orderedGroups = [...groups.values()].sort((a, b) => {
      const aTested = a.nodes.some(n => entryMap.get(n.id)?.reportId);
      const bTested = b.nodes.some(n => entryMap.get(n.id)?.reportId);
      if (aTested !== bTested) return aTested ? -1 : 1;
      return b.nodes.length - a.nodes.length || a.info.label.localeCompare(b.info.label, 'zh-CN');
    });
    host.innerHTML = orderedGroups.map(({ info, nodes }) => {
      const sortedNodes = [...nodes].sort((a, b) => {
        const la = avgCarrierLat(a), lb = avgCarrierLat(b);
        if (la !== lb) return la - lb;
        return (a.order || 0) - (b.order || 0);
      });
      const bandTxt = info.good ? `好 ≤${info.good}ms · 一般 ≤${info.fair}ms` : '';
      return `
        <div class="mx-group">
          <div class="mx-group-head">
            <div class="mx-group-title">
              <strong>${escapeHtml(info.label)}</strong>
              <span class="record-pill">${nodes.length} 台</span>
            </div>
            ${bandTxt ? `<span class="hint">${escapeHtml(bandTxt)}</span>` : ''}
          </div>
          <div class="mx-scroll">${headerHtml}${sortedNodes.map(n => matrixRowHtml(n, entryMap.get(n.id))).join('')}</div>
        </div>`;
    }).join('');
    bindMatrixEvents();
    return;
  }

  const sortedFlat = [...filtered].sort((a, b) => {
    if (state.dashSort === 'priority') return (priorityOrder.get(a.id) ?? 9999) - (priorityOrder.get(b.id) ?? 9999);
    if (state.dashSort === 'latency') return avgCarrierLat(a) - avgCarrierLat(b);
    const ta = entryMap.get(a.id)?.testedAt || '';
    const tb = entryMap.get(b.id)?.testedAt || '';
    return tb.localeCompare(ta);
  });
  host.innerHTML = `<div class="mx-scroll">${headerHtml}${sortedFlat.map(n => matrixRowHtml(n, entryMap.get(n.id))).join('')}</div>`;
  bindMatrixEvents();
}

function renderAlerts() {
  const alertsBox = el('dashAlerts');
  const alertCard = el('dashAlertCard');
  if (!state.dashboard) { alertCard.classList.add('hidden'); return; }
  const activeMap = new Map(state.nodes.filter(n => !n.archived).map(n => [n.id, n]));
  const alerts = (state.dashboard.entries || [])
    .filter(e => e.reportId && !e.error && e.priority?.status === 'ready' && e.priority?.level !== 'none')
    .filter(e => state.dashRegion === 'all' || regionInfoOf(activeMap.get(e.nodeId), e).code === state.dashRegion)
    .sort((a, b) => (b.priority.score || 0) - (a.priority.score || 0) || String(b.testedAt).localeCompare(String(a.testedAt)));

  if (!alerts.length) {
    alertCard.classList.add('hidden');
    return;
  }
  alertCard.classList.remove('hidden');
  alertsBox.innerHTML = '';
  const shown = alerts.slice(0, 5);
  const rest = alerts.length - shown.length;
  for (const entry of shown) {
    const cards = new Map((entry.cards || []).map(c => [c.id, c]));
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'title-link dash-alert';
    item.innerHTML = `
      <div class="alert-left">
        <div class="title">
          <div class="alert-title-row">
            <strong>${escapeHtml(nodeName(entry.nodeId))}</strong>
            ${priorityBadge(entry.priority)}
            <span class="meta">${escapeHtml(fmtRelativeAge(entry.testedAt))} · ${escapeHtml(fmtShort(entry.testedAt))}</span>
          </div>
          <p class="alert-reason">${escapeHtml(priorityReasonLine(entry.priority))}</p>
        </div>
        <div class="metrics">
          ${priorityPrimaryBadge(entry.priority)}
          ${metricBadges({ latency: cards.get('latency'), loss: cards.get('loss'), speed: cards.get('speed') })}
        </div>
      </div>
      <div class="alert-arrow">
        <span>直达详情</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    item.addEventListener('click', () => {
      state.selectedNodeId = entry.nodeId;
      renderNodes();
      renderHistory();
      showView('history');
      openDetail(entry.reportId);
    });
    alertsBox.append(item);
  }
  if (rest > 0) {
    const more = document.createElement('p');
    more.className = 'empty dash-idle';
    more.textContent = `另有 ${rest} 个节点在当前视角下有扣分项，详见下方健康矩阵`;
    alertsBox.append(more);
  }
}

function drawDashboardPanels() {
  if (!state.dashboard) return;
  renderRecentChanges(state.dashboard.recentChanges || []);
  renderAlerts();
  renderMatrix();
}

let dashRequestToken = 0;
async function renderDashboard() {
  const stats = el('dashStats');
  const withReports = new Set(state.reports.map(report => report.nodeId));
  const latest = [...state.reports].sort((left, right) => right.testedAt.localeCompare(left.testedAt))[0];
  const activeNodesCount = state.nodes.filter(node => !node.archived).length;
  const coveragePercent = activeNodesCount > 0 ? ((withReports.size / activeNodesCount) * 100).toFixed(0) : '0';

  stats.innerHTML = `
    <span class="strip-item"><b>${activeNodesCount}</b> 启用节点</span>
    <span class="strip-sep" aria-hidden="true">·</span>
    <span class="strip-item">覆盖 <b>${withReports.size}/${activeNodesCount}</b> (${coveragePercent}%)</span>
    <span class="strip-sep" aria-hidden="true">·</span>
    <span class="strip-item"><b>${state.reports.length}</b> 份报告</span>
    <span class="strip-sep" aria-hidden="true">·</span>
    <span class="strip-item">最新 <b>${latest ? escapeHtml(fmtShort(latest.testedAt)) : '—'}</b></span>`;

  if (el('probeSyncNote')) {
    el('probeSyncNote').textContent = `探针节点清单上次同步：${state.syncedAt ? fmtTime(state.syncedAt) : '尚未同步'}`;
  }

  // 先用占位渲染区域筛选，避免等待
  renderRegionFilter(state.nodes.filter(n => !n.archived), new Map());
  el('recentChanges').innerHTML = '<p class="trend-loading">载入最近变化…</p>';
  el('dashMatrix').innerHTML = '<p class="trend-loading">载入节点矩阵…</p>';

  const token = ++dashRequestToken;
  let dashboard;
  try { dashboard = await api(`/api/dashboard${viewQuery()}`); } catch {
    if (token !== dashRequestToken) return;
    el('recentChanges').innerHTML = '<p class="empty">最近动态加载失败，请稍后重试。</p>';
    el('dashMatrix').innerHTML = '<p class="empty">健康矩阵暂不可用，请稍后重试。</p>';
    return;
  }
  if (token !== dashRequestToken) return;
  state.dashboard = { ...dashboard, algorithm: dashboard.priorityAlgorithm || null };
  renderViewBar();
  drawDashboardPanels();
}

// ============ 脚本直传待绑定与导入 ============
const CORE_SECTIONS = ['ipv4', 'large4', 'cernet', 'intl', 'speedtest'];
function renderPending() {
  const count = state.pending.length;
  el('pendingCount').textContent = `${count} 份`;
  el('pendingBadge').textContent = count;
  el('pendingBadge').hidden = !count;
  el('dashPendingText').textContent = `${count} 份待绑定`;
  el('dashPending').hidden = !count;
  const list = el('pendingList');
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

function showBulkResult(result) {
  const box = el('pendingBulkResult');
  const lines = [`已归档 ${result.bound.length} 份`];
  if (result.skipped) lines.push(`${result.skipped} 份没有归属记忆，仍留在队列里等你手动选择`);
  const failed = result.failed || [];
  box.hidden = false;
  box.classList.toggle('error', failed.length > 0);
  box.innerHTML = `
    <div class="pending-bulk-head">${failed.length ? '⚠ ' : '✔ '}${escapeHtml(lines.join('；'))}</div>
    ${failed.length ? `<ul class="pending-bulk-fails">${failed.map(item => `<li><strong>${escapeHtml(item.hostname || item.id.slice(0, 8))}</strong>：${escapeHtml(item.error)}</li>`).join('')}</ul>` : ''}`;
}

async function bindRecommended() {
  const ids = state.pending.filter(entry => !entry.broken && entry.suggestion?.nodeId).map(entry => entry.id);
  if (!ids.length) return;
  const button = el('bindRecommended');
  const box = el('pendingBulkResult');
  button.disabled = true;
  box.hidden = true;
  try {
    const result = await api('/api/pending/bind-recommended', { method: 'POST', body: JSON.stringify({ ids }) });
    const failed = result.failed || [];
    toast(failed.length ? `已归档 ${result.bound.length} 份，${failed.length} 份失败（原因见下方）` : `已归档 ${result.bound.length} 份`, failed.length > 0);
    showBulkResult({ ...result, failed });
    await refresh();
  } catch (error) {
    toast(error.message, true);
    box.hidden = false;
    box.classList.add('error');
    box.innerHTML = `<div class="pending-bulk-head">⚠ 批量归档失败：${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

function renderPreview(report, token, suggestion) {
  const counts = report.sectionCounts || {};
  const perSection = report.sections.map(section => `<div class="stat"><div class="label">${escapeHtml(section.name)}</div><div class="value">${counts[section.id] ?? 0} 条</div></div>`).join('');
  const box = el('previewResult');
  box.innerHTML = `<div class="preview-grid">
    <div class="stat"><div class="label">测试时间</div><div class="value">${fmtTime(report.testedAt)}${report.timeSource === 'upload' ? '（按上传时间估算）' : ''}</div></div>
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

// ============ 变化对比 ============
function renderCompareSelectors() {
  const nodeSelect = el('compareNode');
  nodeSelect.innerHTML = state.nodes.map(node => `<option value="${node.id}">${escapeHtml(node.name)}</option>`).join('');
  const reportsOf = reportsByNode();
  const firstWithMultiple = state.nodes.find(n => (reportsOf.get(n.id) || []).length >= 2)?.id;
  const target = (state.selectedNodeId && (reportsOf.get(state.selectedNodeId) || []).length >= 2)
    ? state.selectedNodeId
    : (firstWithMultiple || state.selectedNodeId || state.nodes[0]?.id || '');
  nodeSelect.value = target;
  const reports = state.reports.filter(report => report.nodeId === target).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
  const options = reports.map(report => `<option value="${report.id}">${fmtTime(report.testedAt)}${timeNote(report)}</option>`).join('');
  el('compareBase').innerHTML = options;
  el('compareCurrent').innerHTML = options;
  if (reports.length > 1) {
    el('compareBase').selectedIndex = 1;
    el('compareCurrent').selectedIndex = 0;
  }
  el('compareResult').classList.toggle('hidden', reports.length < 2);
  if (reports.length >= 2 && el('view-compare').classList.contains('active')) runCompare();
}

async function comparePreviousReport(current) {
  const previous = previousReport(state.reports, current);
  if (!previous) { toast('没有测试时间更早的报告'); return; }
  await openComparePair(current.nodeId, previous.id, current.id);
}

function setComparePane(pane) {
  for (const btn of document.querySelectorAll('#compareTabs .compare-tab')) {
    btn.classList.toggle('active', btn.dataset.pane === pane);
  }
  el('compareVisualPane').classList.toggle('hidden', pane !== 'visual');
  el('compareVisualPane').classList.toggle('active', pane === 'visual');
  el('compareTablePane').classList.toggle('hidden', pane !== 'table');
  el('compareTablePane').classList.toggle('active', pane === 'table');
}

function renderCompareBanner(result) {
  const ctx = result.analysis?.context;
  const verdict = result.analysis?.verdict || 'steady';
  const verdictLabels = { improved: '整体改善', worsened: '明显恶化', mixed: '改善与恶化并存', steady: '整体平稳' };
  const verdictBadge = el('compareVerdictBadge');
  if (verdictBadge) {
    verdictBadge.className = `verdict-pill ${verdict}`;
    verdictBadge.textContent = verdictLabels[verdict] || '变化对比';
  }
  const banner = el('compareBanner');
  if (!banner) return;
  if (!ctx) { banner.innerHTML = ''; return; }
  const pills = [];
  if (ctx.gapLabel) pills.push(`<span class="ctx-pill">间隔 ${escapeHtml(ctx.gapLabel)}</span>`);
  if (ctx.timeOfDayShift) {
    const s = ctx.timeOfDayShift;
    pills.push(`<span class="ctx-pill${s.changed ? ' warn' : ''}">${escapeHtml(s.beforeLabel)} ${escapeHtml(s.beforeClock)} → ${escapeHtml(s.afterLabel)} ${escapeHtml(s.afterClock)}${s.changed ? '（时段差异）' : ''}</span>`);
  }
  if (ctx.beforeIp || ctx.afterIp) {
    pills.push(ctx.ipChanged
      ? `<span class="ctx-pill info">出口 IP 变更：${escapeHtml(ctx.beforeIp || '—')} → ${escapeHtml(ctx.afterIp || '—')}</span>`
      : `<span class="ctx-pill">同出口 IP：${escapeHtml(ctx.afterIp || ctx.beforeIp)}</span>`);
  }
  for (const rc of (ctx.routeChanges || [])) {
    pills.push(`<span class="ctx-pill info">${escapeHtml(rc.carrier)}主路由：${escapeHtml(rc.before)} → ${escapeHtml(rc.after)}</span>`);
  }
  banner.innerHTML = pills.join('');
}

let compareRequestToken = 0;
async function runCompare() {
  const base = el('compareBase').value;
  const current = el('compareCurrent').value;
  const token = ++compareRequestToken;
  if (!base || !current || base === current) { state.compare.result = null; el('compareResult').classList.add('hidden'); return; }
  state.compare.result = null;
  el('compareResult').classList.add('hidden');
  try {
    const result = await api(`/api/compare?base=${base}&current=${current}`);
    if (token !== compareRequestToken) return;
    state.compare.result = result;
    el('compareResult').classList.remove('hidden');
    el('compareTitle').textContent = `${nodeName(el('compareNode').value)} · ${fmtShort(result.baseTestedAt)} → ${fmtShort(result.currentTestedAt)}`;
    el('changeFilter').innerHTML = '<option value="all">全部维度</option>' + Object.entries(sectionNames).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
    renderCompareBanner(result);
    renderComparisonCoverage(result);
    renderCompareVisuals(el('compareVisualHost'), result.analysis, state);
    renderChanges();
  } catch (error) { if (token === compareRequestToken) toast(error.message, true); }
}

function renderChanges() {
  const result = state.compare.result;
  if (!result) return;
  const section = el('changeFilter').value;
  const direction = el('changeDirection').value;
  const onlyChanged = el('onlyChanged').checked;
  const onlySignificant = el('onlySignificant').checked;
  const matches = change => (section === 'all' || change.section === section) && (direction === 'all' || change.direction === direction);
  const pool = result.changes.filter(matches);
  const changed = onlyChanged ? pool.filter(change => change.delta !== 0) : pool;
  const significant = changed.filter(change => change.significant);
  const changes = onlySignificant ? significant : changed;
  const tableCount = el('compareTableCount');
  if (tableCount) tableCount.textContent = result.changes.filter(c => c.significant).length;
  const hidden = changed.length - significant.length;
  const summary = !changed.length
    ? ''
    : onlySignificant && hidden > 0
      ? `共 ${changed.length} 项变化，其中 ${significant.length} 项显著；${hidden} 项在抖动范围内已折叠`
      : `共 ${changed.length} 项变化，全部显示`;
  el('changeSummary').textContent = summary;
  if (!changes.length) {
    el('changeBody').innerHTML = `<p class="empty">${changed.length ? '这些变化都还在抖动范围内，没有值得关注的项。' : '当前筛选下没有符合条件的指标。'}</p>`;
    return;
  }
  const rows = changes.map(change => {
    const sign = change.delta > 0 ? '+' : '';
    const dir = /speed/i.test(change.metric) ? ({ up: 'down', down: 'up', same: 'same' }[change.direction]) : change.direction;
    return `<tr><td>${escapeHtml(sectionNames[change.section] || change.section)}<br><small>${escapeHtml(change.group || '')}</small></td><td>${escapeHtml(change.target)}</td><td>${escapeHtml(change.carrier || '—')}</td><td>${escapeHtml(metricLabel(change.metric))}</td><td>${change.before}${escapeHtml(change.unit)}</td><td>${change.after}${escapeHtml(change.unit)}</td><td class="${dir}">${sign}${change.delta}${escapeHtml(change.unit)}</td><td>${change.significant ? '<span class="sig-mark">显著</span>' : '<span class="sig-noise">抖动</span>'}</td></tr>`;
  }).join('');
  el('changeBody').innerHTML = `<table><thead><tr><th>维度</th><th>对象</th><th>运营商</th><th>指标</th><th>基础报告</th><th>当前报告</th><th>变化</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderComparisonCoverage(result) {
  const coverage = result.coverage;
  const conclusionData = result.conclusion || {};
  const covSummary = el('compareCoverageSummary');
  if (covSummary) {
    const comparableCount = coverage?.metrics?.comparable ?? 0;
    covSummary.textContent = `覆盖与项数明细 · ${comparableCount} 项共同可比（${conclusionData.improvedMetrics || 0} 项显著改善 · ${conclusionData.worsenedMetrics || 0} 项显著恶化）`;
  }
  const headline = `<p class="comparison-headline"><span class="comparison-improved">${conclusionData.improvedMetrics || 0} 项显著改善</span><span aria-hidden="true">·</span><span class="comparison-worsened">${conclusionData.worsenedMetrics || 0} 项显著恶化</span></p>`;
  const focus = conclusionData.focus || (conclusionData.worseningBySection?.length ? `恶化集中在${conclusionData.worseningBySection.slice(0, 2).map(item => item.label).join('和')}。` : '没有可判定优劣的显著恶化，不代表两份报告完全一致。');
  const carrierDetail = conclusionData.worseningByCarrier?.length ? `<p class="hint">恶化分布：${conclusionData.worseningByCarrier.map(item => `${escapeHtml(item.label)} ${item.count} 项`).join(' · ')}</p>` : '';
  const conclusion = `${headline}<p>${escapeHtml(focus)}</p><p class="hint">仅反映共同可比指标${conclusionData.improvedMetrics && conclusionData.worsenedMetrics ? '；改善与恶化并存，不作整体优劣断言' : ''}${conclusionData.neutralMetrics ? `；另有 ${conclusionData.neutralMetrics} 项显著变化无优劣语义` : ''}。</p>${carrierDetail}`;
  if (!coverage) { el('compareCoverage').innerHTML = conclusion; return; }
  const differences = coverage.sections.flatMap(section => section.groups.filter(group => group.records.added || group.records.missing || group.metrics.incomparable || group.metrics.added || group.metrics.missing).map(group => `${section.name} / ${group.group || '默认分组'}：新增 ${group.records.added}、缺失 ${group.records.missing} 条记录，新增 ${group.metrics.added}、缺失 ${group.metrics.missing} 项数值指标，${group.metrics.incomparable} 项不可比${group.metrics.expectedMissingIncomparable ? `（其中 ${group.metrics.expectedMissingIncomparable} 项为单栈预期未测）` : ''}`));
  const expected = coverage.metrics.expectedMissingIncomparable || 0;
  const unexpected = Math.max(0, coverage.metrics.incomparable - expected);
  const coverageChanged = coverage.records.added || coverage.records.missing || coverage.metrics.added || coverage.metrics.missing || unexpected;
  const reasonLabel = { unit: '单位不同', status: '读数不可用', 'duplicate-key': '记录标识重复', 'expected-missing': '单栈 IPv6 预期未测' };
  const list = (label, entries, metric = false) => entries.length ? `<details><summary>${label} · ${entries.length} ${metric ? '项指标' : '条记录'}</summary><ul>${entries.slice(0, 100).map(item => `<li>${escapeHtml([sectionNames[item.section] || item.section, item.group, item.target, item.carrier, metric ? metricLabel(item.metric) : ''].filter(Boolean).join(' / '))}${item.reasons ? `：${escapeHtml(item.reasons.map(reason => reasonLabel[reason] || reason).join('、'))}` : ''}</li>`).join('')}</ul>${entries.length > 100 ? '<p>仅展开前 100 项；完整数量见上方。</p>' : ''}</details>` : '';
  el('compareCoverage').innerHTML = `${conclusion}<p>共同可比：${coverage.metrics.comparable} 项数值指标。新增 ${coverage.records.added}、缺失 ${coverage.records.missing} 条记录；${unexpected} 项不可比${expected ? `，另有 ${expected} 项为单栈 IPv6 预期未测` : ''}。</p>${differences.length ? `<p class="${coverageChanged ? 'warn' : 'hint'}">${coverageChanged ? '覆盖不同或存在不可比读数，以下变化不代表整份报告全貌。' : '单栈 IPv6 未测属于预期覆盖，不参与对比。'}</p><ul>${differences.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>` : '<p>两份报告的数值指标覆盖一致。</p>'}${list('新增记录', coverage.addedRecords)}${list('缺失记录', coverage.missingRecords)}${list('新增指标', coverage.addedMetrics, true)}${list('缺失指标', coverage.missingMetrics, true)}${list('不可比指标', coverage.incomparableMetrics, true)}`;
}

function showView(view, compare = true) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
  if (view === 'history' && state.selectedNodeId && !el('historyList').children.length) renderHistory();
  if (view === 'compare' && compare) runCompare();
}

async function refresh() {
  const data = await api('/api/state');
  state.allNodes = data.nodes;
  state.allReports = data.reports;
  state.syncedAt = data.syncedAt;
  state.nodes = data.nodes.filter(node => node.enabled !== false);
  const enabledIds = new Set(state.nodes.map(node => node.id));
  state.reports = data.reports.filter(report => enabledIds.has(report.nodeId));
  state.pending = data.pending || [];
  state.metricNames = data.metricNames;
  el('logoutButton').hidden = !data.authEnabled;
  el('syncState').textContent = data.syncedAt ? `启用 ${state.nodes.length} / ${data.nodes.filter(node => !node.archived).length} 个节点` : '未同步节点';
  renderNodes();
  renderHistory();
  renderDashboard().catch(error => toast(error.message, true));
  renderPending();
  renderCompareSelectors();

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
  } catch {}
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
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '解析报告'; }
});

el('compareNode').addEventListener('change', event => { state.selectedNodeId = event.target.value; renderNodes(); renderHistory(); renderCompareSelectors(); });
el('compareBase').addEventListener('change', runCompare);
el('compareCurrent').addEventListener('change', runCompare);
el('runCompare').addEventListener('click', runCompare);
el('swapCompare')?.addEventListener('click', () => {
  const b = el('compareBase').value;
  const c = el('compareCurrent').value;
  if (!b || !c || b === c) return;
  el('compareBase').value = c;
  el('compareCurrent').value = b;
  runCompare();
});
for (const btn of document.querySelectorAll('#compareTabs .compare-tab')) {
  btn.addEventListener('click', () => setComparePane(btn.dataset.pane));
}
for (const id of ['changeFilter', 'changeDirection', 'onlyChanged', 'onlySignificant']) el(id).addEventListener('change', renderChanges);

el('dashSort')?.addEventListener('change', event => {
  state.dashSort = event.target.value;
  drawDashboardPanels();
});

el('viewBarToggle')?.addEventListener('click', () => {
  const drawer = el('viewBarDrawer');
  if (!drawer) return;
  const opening = drawer.classList.contains('hidden');
  drawer.classList.toggle('hidden', !opening);
  el('viewBarToggle').setAttribute('aria-expanded', String(opening));
});

el('logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } finally { location.replace('/login'); }
});

setupThemeToggle(el('themeToggle'));
setupBind();
renderViewBar();

window.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== el('nodeFilter') && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    setSideOpen(true);
    el('nodeFilter').focus();
    el('nodeFilter').select();
  }
});

let viewDebounce = 0;
const scheduleView = () => {
  clearTimeout(viewDebounce);
  viewDebounce = setTimeout(() => { applyView().catch(error => toast(error.message, true)); }, 300);
};
for (const button of document.querySelectorAll('.view-chip')) button.addEventListener('click', () => {
  const { axis, key } = button.dataset;
  const next = state.view[axis][key] > MIN_VIEW_WEIGHT ? MIN_VIEW_WEIGHT : 1;
  state.view = normalizeView({ ...state.view, [axis]: { ...state.view[axis], [key]: next } });
  renderViewBar();
  scheduleView();
});
for (const input of document.querySelectorAll('#viewTune input')) input.addEventListener('change', () => {
  const { axis, key } = input.dataset;
  state.view = normalizeView({ ...state.view, [axis]: { ...state.view[axis], [key]: input.value } });
  input.value = state.view[axis][key];
  renderViewBar();
  scheduleView();
});
el('viewTuneToggle').addEventListener('click', () => {
  const tune = el('viewTune');
  tune.classList.toggle('hidden');
  el('viewTuneToggle').setAttribute('aria-expanded', String(!tune.classList.contains('hidden')));
});
el('viewReset').addEventListener('click', () => {
  state.view = defaultView();
  renderViewBar();
  scheduleView();
});

// 保留 staleNodes 的引入兼容旧工具函数，避免未引用警告
void staleNodes;

refresh().catch(error => toast(error.message, true));
