import { setupThemeToggle } from '/theme.js';
import { nodePicker } from '/picker.js';
import { previousReport, staleNodes } from '/archive.js';

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
// 脚本没带 x-report-epoch 时，报告时间只能按"服务器收到 CSV 的时间"估算
// （旧版 wrapper 就是这样）。这种时间点在历史与趋势里会与真实测试序列错位，
// 所以凡是要显示时间的地方都得把来源标出来，不能让人以为是实测时间。
// 注意待绑定条目把 timeSource 放在顶层，归档后嵌在 upload 里 —— 两处都要认，
// 只看顶层的话归档之后就再也标不出来了。
const timeIsEstimated = report => (report?.timeSource || report?.upload?.timeSource) === 'upload';
const timeNote = report => (timeIsEstimated(report) ? '（按上传时间估算）' : '');
// 带标记的时间文本：估算值后面跟一个上标警告，鼠标悬停说明原因
const estTitle = '上传时没有带测试时间（旧版脚本），这里是服务器收到 CSV 的时间，可能与真实测试时间有偏差';
const timeCell = report => `${fmtTime(report.testedAt)}${timeIsEstimated(report) ? `<span class="warn-pill est-pill" title="${estTitle}">按上传时间</span>` : ''}`;
// 紧凑位置（看板行、图表 tooltip）放不下整块标签，用带星号的短时间 + title 说明
const shortTimeCell = report => `${fmtShort(report.testedAt)}${timeIsEstimated(report) ? '*' : ''}`;
// 迷你走势：看板上每台机器最近几份的延迟。只摆一个时点数字看不出"在变好还是变差"，
// 而这一列正是健康总览区别于"需要关注"那张卡的信息。
// 少于两个点就没有走势可画，直接不占位置。
function svgSparkline(values) {
  if (values.length < 2) return '';
  const W = 64, H = 20, PAD = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(1e-9, max - min);
  const total = Math.max(1, values.length - 1);
  const points = values.map((value, index) => [
    PAD + (index / total) * (W - PAD * 2),
    H - PAD - ((value - min) / span) * (H - PAD * 2)
  ]);
  const path = `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}`;
  const rising = values.at(-1) > values[0];
  // 延迟升高是坏事：用红色提示，降低用绿色。这与徽章的档位色是两套语义
  // （那是"绝对水平"，这是"方向"），所以单独一个类名。
  return `<svg class="dash-spark ${rising ? 'worse' : 'better'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="最近 ${values.length} 份报告延迟走势"><path d="${path}"/></svg>`;
}
const nodeName = id => state.allNodes.find(node => node.id === id)?.name || id;
const metricLabel = key => state.metricNames[key] || key;
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
// ===== 关注视角（只作用于视图层）=====
// 视角影响看板的排序分与次序；报告详情、热力图、异常列表是事实层，一律不读这里。
const VIEW_KEY = 'tq_priority_view';
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
const defaultView = () => Object.fromEntries(Object.entries(VIEW_AXES).map(([axis, keys]) => [axis, Object.fromEntries(keys.map(key => [key, 1]))]));
function normalizeView(input) {
  const view = defaultView();
  for (const [axis, keys] of Object.entries(VIEW_AXES)) for (const key of keys) {
    const value = Number(input?.[axis]?.[key]);
    if (Number.isFinite(value)) view[axis][key] = Math.min(MAX_VIEW_WEIGHT, Math.max(MIN_VIEW_WEIGHT, value));
  }
  return view;
}
const readView = () => {
  try { return normalizeView(JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')); } catch { return defaultView(); }
};
const viewIsDefault = () => Object.values(state.view).every(values => new Set(Object.values(values)).size === 1);
// 默认视角不带参数：请求与加视角能力之前完全一致，便于比对与缓存。
const viewQuery = () => viewIsDefault() ? '' : `?${Object.entries(state.view).map(([axis, values]) => `${axis}=${Object.entries(values).map(([key, value]) => `${key}:${Number(value.toPrecision(12))}`).join(',')}`).join('&')}`;

// 优先级主因的文案：候选算法只输出数字通道，这里拼成能读的一行。
function prioritySignalText(contribution) {
  const channel = contribution?.primary;
  if (!channel) return '';
  const name = leafLabel(contribution.leaf);
  const cover = leafCoverageFor(contribution.leaf);
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
// 每渲染一台机器前会把这台机器各叶子的覆盖情况放进来，供主因文案取执行失败条数等。
let leafCoverageMap = {};
const leafCoverageFor = leaf => leafCoverageMap[leaf] || null;
const priorityBadge = priority => {
  if (!priority?.level) return '';
  const reasons = (priority.reasons || []).slice(0, 3).map(prioritySignalText).filter(Boolean);
  // 被探针整族跳过的不算扣分项，但要在悬停里说清"这段没执行"，否则用户会以为数据丢了
  const skipped = (priority.coverage?.skippedFamilies || []).map(item => leafLabel(item.leaf));
  const title = [reasons.join('；') || '当前视角下无扣分项', skipped.length ? `未执行（探针跳过）：${skipped.join('、')}` : '', `口径：${priority.algorithmVersion || '候选'}（${priority.calibration || 'candidate'}，未标定）`].filter(Boolean).join('｜');
  return `<span class="archive-status ${escapeHtml(priority.level)}" title="${escapeHtml(title)}">${escapeHtml(priority.label)}${Number.isFinite(priority.score) ? ` · ${priority.score}` : ''}</span>`;
};
// 关注卡的行内理由：只取有扣分的贡献，按叶子单独成句。
const priorityReasonLine = priority => (priority?.reasons || [])
  .filter(item => item.contribution > 0)
  .slice(0, 2)
  .map(prioritySignalText)
  .filter(Boolean)
  .join('；');
const priorityPrimaryBadge = priority => {
  const top = priority?.primary;
  if (!top) return '';
  const reasons = (priority.reasons || []).slice(0, 3).map(prioritySignalText).filter(Boolean);
  return `<span class="primary-signal ${escapeHtml(priority.level || '')}" title="${escapeHtml(reasons.join('；'))}">主因：${escapeHtml(leafLabel(top.leaf))}</span>`;
};
state.view = readView();
function renderViewBar() {
  const isDefault = viewIsDefault();
  for (const button of document.querySelectorAll('.view-chip')) {
    const weight = state.view[button.dataset.axis][button.dataset.key];
    button.setAttribute('aria-pressed', String(weight > MIN_VIEW_WEIGHT));
  }
  for (const input of document.querySelectorAll('#viewTune input')) input.value = state.view[input.dataset.axis][input.dataset.key];
  el('viewSummary').textContent = isDefault ? '默认视角（各维度等权，与不分视角时一致）' : `当前视角：${Object.entries(state.view).flatMap(([axis, values]) => Object.entries(values).filter(([, value]) => value !== 1).map(([key, value]) => `${chipLabel(axis, key)}×${value}`)).join(' ') || '自定义'}`;
  el('viewAlgorithm').textContent = state.dashboard?.algorithm
    ? `排序分口径：${state.dashboard.algorithm.version}（${state.dashboard.algorithm.calibration}，档位未标定）；与旧版看板分数不是同一尺度，数值下降不代表线路变差。`
    : '排序分口径：候选（未标定）；与旧版看板分数不是同一尺度，数值下降不代表线路变差。';
}
const chipLabel = (axis, key) => document.querySelector(`.view-chip[data-axis="${axis}"][data-key="${key}"]`)?.textContent?.trim() || key;
async function applyView() {
  if (!viewIsDefault()) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(state.view)); } catch {} } else { try { localStorage.removeItem(VIEW_KEY); } catch {} }
  renderViewBar();
  await renderDashboard();
}
function primarySignalBadge(assessment) {
  const signal = assessment?.primary;
  if (!signal) return '';
  const value = Number.isFinite(signal.value) ? ` ${signal.value}${signal.unit || ''}` : '';
  return `<span class="primary-signal ${escapeHtml(assessment.level)}" title="${escapeHtml(signal.text)}">主因：${escapeHtml(signal.label + value)}</span>`;
}
function renderFreshness() {
  const days = Number(el('freshnessDays').value);
  const items = staleNodes(state.nodes, state.reports, days);
  el('dashFreshness').innerHTML = items.length ? items.map(({ node, latest, age }) => `<button type="button" data-node="${escapeHtml(node.id)}"><strong>${escapeHtml(node.name)}</strong><span>${!latest ? '尚未测试' : !Number.isFinite(age) ? '时间待核实' : `${age} 天未测`}${latest && timeIsEstimated(latest) ? '（估算）' : ''}</span></button>`).join('') : `<p class="empty">启用节点均在最近 ${days} 天内有测试记录。</p>`;
  for (const button of el('dashFreshness').querySelectorAll('button')) button.addEventListener('click', () => selectNode(button.dataset.node));
  el('probeSyncNote').textContent = `探针节点清单上次同步：${state.syncedAt ? fmtTime(state.syncedAt) : '尚未同步'}；这不是最近测试或上传时间。`;
}
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
const CARRIER_COLORS = { 电信: 'var(--teal)', 联通: 'var(--yellow)', 移动: 'var(--red)' };
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
    const title = `${shortTimeCell(report)} · ${value === null ? '无数据' : `${value}${serie.unit}`}${timeIsEstimated(report) ? '（时间按上传估算）' : ''}`;
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
  const reports = state.reports.filter(report => report.nodeId === state.selectedNodeId).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
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
          <strong class="time-title">${timeCell(report)}</strong>
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
      ${previousReport(state.reports, report) ? '<button class="secondary small previous-btn" type="button">对比上一份</button>' : ''}
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
    const oldWarning = host.closest('.history-item')?.querySelector('.history-title-row > .warn-pill');
    if (oldWarning && detail.coverage) oldWarning.hidden = true;
    const cards = new Map((detail.insight?.cards || []).map(card => [card.id, card]));
    host.innerHTML = BADGE_DEFS.map(def => {
      const card = cards.get(def.key);
      if (!card || typeof card.value !== 'number') return `<span class="metric na"><span class="m-icon">${def.icon}</span>${def.short} —</span>`;
      return `<span class="metric l${card.level || 'na'}"><span class="m-icon">${def.icon}</span>${def.short} ${card.value}${escapeHtml(card.unit || '')}</span>`;
    }).join('') + coverageBadge(detail.coverage);
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
  const urgentAnomalies = insight.anomalies.filter(item => item.level !== 'info').sort((left, right) => (left.level === 'danger' ? -1 : 0) - (right.level === 'danger' ? -1 : 0));
  const infoAnomalies = insight.anomalies.filter(item => item.level === 'info');
  const anomalyItem = item => `<div class="anomaly ${item.level}"><span class="anomaly-icon">${levelIcons[item.level] || levelIcons.info}</span><div class="anomaly-body"><span class="tag">${item.kind === 'speed-outlier' ? '留意 · 测速点离群' : levels[item.level] || '提示'}</span><span class="text">${escapeHtml(item.text)}</span></div></div>`;
  const anomalies = insight.anomalies.length
    ? `<div class="insight-block"><h3 class="section-title">需要关注的点 · ${insight.anomalies.length} 条</h3>
        <div class="anomalies-list">${urgentAnomalies.map(anomalyItem).join('')}</div>
        ${infoAnomalies.length ? `<details class="anomaly-info"><summary>线路说明 · ${infoAnomalies.length} 条（不计故障）</summary><div class="anomalies-list">${infoAnomalies.map(anomalyItem).join('')}</div></details>` : ''}</div>`
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
      <p class="hint">颜色按「${escapeHtml(region.label)}」基准判绝对档位：≤${region.good}ms 好、≤${region.fair}ms 一般、超过为差。悬停查看去程线路。${insight.matrices.some(matrix => matrix.id === 'speedtest') && insight.speedRule ? `测速色阶仅为参考：≥${insight.speedRule.good}Mbps 高速、≥${insight.speedRule.fair}Mbps 中速、低于为低速，不代表故障，也不参与看板绝对带宽告警。` : ''}</p>
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
  const warningIssues = report.coverage?.issues.filter(issue => issue.type === 'warning' && issue.severity !== 'neutral');
  const warnings = warningIssues ? warningIssues.map(issue => Number.isFinite(issue.reportedMetrics) ? `指标统计：${issue.failedMetrics || 0} 项明确失败、${issue.unknownMetrics || 0} 项未知格式、${Math.max(0, (issue.missingMetrics || 0) - (issue.expectedMissingMetrics || 0))} 项缺测；另有 ${issue.expectedMissingMetrics || 0} 项单栈 IPv6 预期未测。` : issue.message) : report.warnings || [];
  const box = el('detailWarnings');
  if (!warnings.length) { box.innerHTML = ''; return; }
  const summary = warnings.length === report.warnings?.length && !warningIssues ? report.insight?.warningSummary : null;
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
  el('comparePrevious').hidden = !previousReport(state.reports, report);
  el('comparePrevious').onclick = () => comparePreviousReport(report);
  el('detailCard').classList.remove('hidden');
  el('detailTitle').textContent = `报告详情 · ${nodeName(report.nodeId)} · ${shortTimeCell(report)}`;
  const isCsv = report.sourceType === 'csv';
  el('openOriginal').hidden = isCsv;
  if (!isCsv) el('openOriginal').href = report.sourceUrl;
  el('downloadJson').href = `/api/reports/${reportId}/export`;
  el('downloadRaw').href = `/api/reports/${reportId}/raw`;
  el('downloadRaw').querySelector('span').textContent = isCsv ? '原始 CSV' : '原始 HTML';
  renderWarnings(report);
  el('detailWarnings').insertAdjacentHTML('afterbegin', `<div class="coverage-result">${coverageBadge(report.coverage)}<p>${escapeHtml(report.coverage.coverageHint || '')}</p><p>覆盖：${report.coverage.sections.map(section => `${escapeHtml(section.name)} ${section.records} 条记录`).join(' · ')}；${report.coverage.validMetrics} 项有效数值。</p><p>单栈未测与测试失败分开；仅测部分维度不等于导入失败，完整测试缺少维度时请核对原始报告并重传。</p></div>`);
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
          <span>测速时间：${timeCell(report)}</span>
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
  renderFreshness();
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
    if (!byNode.has(report.nodeId) || Date.parse(byNode.get(report.nodeId).testedAt) < Date.parse(report.testedAt)) byNode.set(report.nodeId, report);
  }
  const latestPerNode = [...byNode.values()].sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
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
      <div class="dash-cell time"${timeIsEstimated(report) ? ` title="${estTitle}"` : ''}>${shortTimeCell(report)}</div>
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
  // 每个节点取最近 5 份报告：够了画迷你走势，又不至于把整个历史拉下来。
  // 详情有会话级缓存，切换视图不会重复请求。
  let dashboard;
  try { dashboard = await api(`/api/dashboard${viewQuery()}`); } catch {
    if (token !== dashRequestToken) return;
    healthBox.querySelectorAll('.metrics').forEach(host => { host.textContent = '摘要暂不可用'; });
    alertsBox.textContent = '关注摘要暂不可用，请稍后重试';
    alertCard.classList.remove('hidden');
    return;
  }
  state.dashboard = { algorithm: dashboard.priorityAlgorithm || null };
  renderViewBar();
  const entries = new Map(dashboard.entries.map(entry => [entry.nodeId, entry]));
  const results = healthRows.map(({ row, report }) => ({ row, report, entry: entries.get(report.nodeId) }));
  if (token !== dashRequestToken) return;

  const alerts = [];
  for (const { row, report, entry } of results) {
    if (!entry?.cards || entry.error) {
      row.querySelector('.metrics').innerHTML = '<span class="metric na">指标不可用</span>';
      continue;
    }
    const cards = new Map(entry.cards.map(card => [card.id, card]));
    const latency = cards.get('latency');
    const loss = cards.get('loss');
    const speed = cards.get('speed');
    // 视图层：排序分与主因来自候选优先级算法；没有 priority 时退回旧的 assessment，
    // 这样接口灰度期间页面仍然可用。
    const priority = entry.priority || null;
    leafCoverageMap = Object.fromEntries((priority?.coverage?.leaves || []).map(item => [item.id, item]));
    // 健康表与"需要关注"两张卡以前展示的是同一批徽章。关注卡只列有问题的节点，
    // 这里则是全量索引，所以补一样它独有的信息：最近几份的延迟走势 + 与上一份的差值。
    // 只摆一个时点数字看不出"在变好还是在变差"。
    const series = entry.trend.map(item => item.latency).filter(value => typeof value === 'number');
    // 差值用 series 的最后两点而不是"最新一份的值"：series 已经滤掉了无效读数，
    // 混用会出现"上一份 175ms → 这一份 没数据"却算出差值的错位
    const previous = series.length >= 2 ? series.at(-2) : null;
    const latestValue = series.length ? series.at(-1) : null;
    const delta = previous !== null && latestValue !== null ? latestValue - previous : null;
    const deltaText = delta === null || Math.abs(delta) < 1
      ? ''
      : `<span class="dash-delta ${delta > 0 ? 'worse' : 'better'}" title="与上一份有读数的报告相比（${previous}ms → ${latestValue}ms）">${delta > 0 ? '↑' : '↓'}${Math.abs(Math.round(delta))}ms</span>`;
    row.querySelector('.metrics').innerHTML = `
      ${priority ? priorityPrimaryBadge(priority) : primarySignalBadge(entry.assessment)}
      ${svgSparkline(series)}
      ${latency && typeof latency.value === 'number' ? `<span class="metric l${latency.level}"><span class="m-icon">⚡</span>延迟 ${latency.value}${latency.unit}</span>` : ''}
      ${loss && typeof loss.value === 'number' ? `<span class="metric l${loss.level}"><span class="m-icon">📉</span>丢包 ${loss.value}${loss.unit}</span>` : ''}
      ${speed && typeof speed.value === 'number' ? `<span class="metric l${speed.level}"><span class="m-icon">🚀</span>带宽 ${speed.value}${speed.unit}</span>` : ''}
      ${deltaText}
      ${coverageBadge(entry.coverage)}
      ${priority ? priorityBadge(priority) : `<span class="archive-status ${escapeHtml(entry.assessment.level)}" title="${escapeHtml(entry.assessment.reasons.join('；') || entry.assessment.basis)}">${escapeHtml(entry.assessment.label)}${entry.assessment.score > 0 ? ` · ${entry.assessment.score}` : ''}</span>`}
    `;
    const notable = priority
      ? priority.status === 'ready' && priority.level !== 'none'
      : ['severe', 'warn', 'observe'].includes(entry.assessment.level);
    if (notable) alerts.push({ report, latency, loss, speed, worst: priority ? priority.score : entry.assessment.score, priority, assessment: entry.assessment });
  }

  // 需要关注的节点：最严重的排前面，同级再看时间。
  // 只列前几条，其余用一句提示收口 —— 关注卡的职责是"现在该看哪台"，
  // 全量节点在下面的健康总览里已经有了。
  alerts.sort((left, right) => right.worst - left.worst || right.report.testedAt.localeCompare(left.report.testedAt));
  if (!alerts.length) {
    alertCard.classList.add('hidden');
    return;
  }
  alertCard.classList.remove('hidden');
  alertsBox.innerHTML = '';
  const shown = alerts.slice(0, 6);
  const rest = alerts.length - shown.length;
  for (const { report, latency, loss, speed, priority } of shown) {
    leafCoverageMap = Object.fromEntries((priority?.coverage?.leaves || []).map(item => [item.id, item]));
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'title-link dash-alert';
    item.innerHTML = `
      <div class="alert-left">
        <div class="title">
          <div class="alert-title-row">
            <strong>${escapeHtml(nodeName(report.nodeId))}</strong>
            ${priorityBadge(priority)}
          </div>
          <span class="meta">评测时间：${timeCell(report)}</span>
          <p class="alert-reason">${escapeHtml(priorityReasonLine(priority))}</p>
        </div>
        <div class="metrics">
          ${priorityPrimaryBadge(priority)}
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
  if (rest > 0) {
    const more = document.createElement('p');
    more.className = 'empty dash-idle';
    more.textContent = `另有 ${rest} 个节点在当前视角下有扣分项，具体档位已在下方总览中标出`;
    alertsBox.append(more);
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
// 结果区：批量操作的失败原因必须**全部**留在屏幕上，不能靠 toast 逐条弹 ——
// 页面只有一个 toast 元素，连续调用会互相覆盖，多条失败时用户只看得到最后一条。
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
// 一键接受全部推荐：只把"有推荐"的 id 交给服务端，没有推荐的条目仍由人决定归属
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
    // 成功也用一句话点一下即可；失败则整块列在下面，不随后续渲染消失
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
  state.selectedNodeId = current.nodeId;
  renderNodes();
  const reports = state.reports.filter(report => report.nodeId === current.nodeId).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
  el('compareNode').value = current.nodeId;
  const options = reports.map(report => `<option value="${escapeHtml(report.id)}">${escapeHtml(fmtTime(report.testedAt) + timeNote(report))}</option>`).join('');
  el('compareBase').innerHTML = options;
  el('compareCurrent').innerHTML = options;
  el('compareBase').value = previous.id;
  el('compareCurrent').value = current.id;
  showView('compare', false);
  await runCompare();
  document.querySelector('.content').scrollTop = 0;
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
    el('compareTitle').textContent = `变化明细 · ${fmtShort(result.baseTestedAt)} → ${fmtShort(result.currentTestedAt)}`;
    el('changeFilter').innerHTML = '<option value="all">全部维度</option>' + Object.entries(sectionNames).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
    renderChanges();
  } catch (error) { if (token === compareRequestToken) toast(error.message, true); }
}
function renderChanges() {
  const result = state.compare.result;
  if (!result) return;
  renderComparisonCoverage(result);
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
    const direction = /speed/i.test(change.metric) ? ({ up: 'down', down: 'up', same: 'same' }[change.direction]) : change.direction;
    return `<tr><td>${escapeHtml(sectionNames[change.section] || change.section)}<br><small>${escapeHtml(change.group || '')}</small></td><td>${escapeHtml(change.target)}</td><td>${escapeHtml(change.carrier || '—')}</td><td>${escapeHtml(metricLabel(change.metric))}</td><td>${change.before}${escapeHtml(change.unit)}</td><td>${change.after}${escapeHtml(change.unit)}</td><td class="${direction}">${sign}${change.delta}${escapeHtml(change.unit)}</td><td>${change.significant ? '<span class="sig-mark">显著</span>' : '<span class="sig-noise">抖动</span>'}</td></tr>`;
  }).join('');
  el('changeBody').innerHTML = `<table><thead><tr><th>维度</th><th>对象</th><th>运营商</th><th>指标</th><th>基础报告</th><th>当前报告</th><th>变化</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function renderComparisonCoverage(result) {
  const coverage = result.coverage;
  const conclusionData = result.conclusion || {};
  const headline = `<p class="comparison-headline"><span class="comparison-improved">${conclusionData.improvedMetrics || 0} 项显著改善</span><span aria-hidden="true">·</span><span class="comparison-worsened">${conclusionData.worsenedMetrics || 0} 项显著恶化</span></p>`;
  const focus = conclusionData.focus || (conclusionData.worseningBySection?.length ? `恶化集中在${conclusionData.worseningBySection.slice(0, 2).map(item => item.label).join('和')}。` : '没有可判定优劣的显著恶化，不代表两份报告完全一致。');
  const carrierDetail = conclusionData.worseningByCarrier?.length ? `<details class="conclusion-detail"><summary>查看恶化的运营商分布</summary><p>${conclusionData.worseningByCarrier.map(item => `${escapeHtml(item.label)} ${item.count} 项`).join(' · ')}</p></details>` : '';
  const conclusion = `${headline}<p>${escapeHtml(focus)}</p><p class="hint">仅反映共同可比指标${conclusionData.improvedMetrics && conclusionData.worsenedMetrics ? '；改善与恶化并存，不作整体优劣断言' : ''}${conclusionData.neutralMetrics ? `；另有 ${conclusionData.neutralMetrics} 项显著变化无优劣语义` : ''}。</p>${carrierDetail}`;
  if (!coverage) { el('compareCoverage').innerHTML = conclusion; return; }
  const differences = coverage.sections.flatMap(section => section.groups.filter(group => group.records.added || group.records.missing || group.metrics.incomparable || group.metrics.added || group.metrics.missing).map(group => `${section.name} / ${group.group || '默认分组'}：新增 ${group.records.added}、缺失 ${group.records.missing} 条记录，新增 ${group.metrics.added}、缺失 ${group.metrics.missing} 项数值指标，${group.metrics.incomparable} 项不可比${group.metrics.expectedMissingIncomparable ? `（其中 ${group.metrics.expectedMissingIncomparable} 项为单栈预期未测）` : ''}`));
  const expected = coverage.metrics.expectedMissingIncomparable || 0;
  const unexpected = Math.max(0, coverage.metrics.incomparable - expected);
  const coverageChanged = coverage.records.added || coverage.records.missing || coverage.metrics.added || coverage.metrics.missing || unexpected;
  const reasonLabel = { unit: '单位不同', status: '读数不可用', 'duplicate-key': '记录标识重复', 'expected-missing': '单栈 IPv6 预期未测' };
  const list = (label, entries, metric = false) => entries.length ? `<details><summary>${label} · ${entries.length} ${metric ? '项指标' : '条记录'}</summary><ul>${entries.slice(0, 100).map(item => `<li>${escapeHtml([sectionNames[item.section] || item.section, item.group, item.target, item.carrier, metric ? metricLabel(item.metric) : ''].filter(Boolean).join(' / '))}${item.reasons ? `：${escapeHtml(item.reasons.map(reason => reasonLabel[reason] || reason).join('、'))}` : ''}</li>`).join('')}</ul>${entries.length > 100 ? '<p>仅展开前 100 项；完整数量见上方。</p>' : ''}</details>` : '';
  el('compareCoverage').innerHTML = `${conclusion}<p>共同可比：${coverage.metrics.comparable} 项数值指标。新增 ${coverage.records.added}、缺失 ${coverage.records.missing} 条记录；${unexpected} 项因状态、单位或重复记录不可比${expected ? `，另有 ${expected} 项为单栈 IPv6 预期未测，不代表测试失败` : ''}。</p>${differences.length ? `<p class="${coverageChanged ? 'warn' : 'hint'}">${coverageChanged ? '覆盖不同或存在不可比读数，以下变化不代表整份报告全貌。' : '单栈 IPv6 未测属于预期覆盖，不参与对比，不判为故障。'}</p><ul>${differences.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>` : '<p>两份报告的数值指标覆盖一致；相同覆盖不代表测试环境完全一致。</p>'}${list('新增记录', coverage.addedRecords)}${list('缺失记录', coverage.missingRecords)}${list('新增指标', coverage.addedMetrics, true)}${list('缺失指标', coverage.missingMetrics, true)}${list('不可比指标', coverage.incomparableMetrics, true)}`;
}
function showView(view, compare = true) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
  if (view === 'compare' && compare) runCompare();
}
async function refresh() {
  const data = await api('/api/state');
  state.allNodes = data.nodes;
  state.allReports = data.reports;
  state.syncedAt = data.syncedAt;
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
  renderDashboard().catch(error => toast(error.message, true));
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
try { el('freshnessDays').value = localStorage.getItem('tq_freshness_days') || '7'; } catch {}
if (!el('freshnessDays').value) el('freshnessDays').value = '7';
el('freshnessDays').addEventListener('change', () => {
  try { localStorage.setItem('tq_freshness_days', el('freshnessDays').value); } catch {}
  renderFreshness();
});
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
// 视角条：chip 是多选，未勾选落到下限 0.25（保留 1/4 权重，不会完全忽略）；精调可写 0.25–4。
// 改一下要重算整块看板，所以做 300ms 防抖，避免每敲一个数字都打一次接口。
let viewDebounce = 0;
const scheduleView = () => {
  clearTimeout(viewDebounce);
  viewDebounce = setTimeout(() => { applyView().catch(error => toast(error.message, true)); }, 300);
};
for (const button of document.querySelectorAll('.view-chip')) button.addEventListener('click', () => {
  const { axis, key } = button.dataset;
  const next = state.view[axis][key] > MIN_VIEW_WEIGHT ? MIN_VIEW_WEIGHT : 1;
  state.view = normalizeView({ ...state.view, [axis]: { ...state.view[axis], [key]: next } });
  scheduleView();
});
for (const input of document.querySelectorAll('#viewTune input')) input.addEventListener('change', () => {
  const { axis, key } = input.dataset;
  state.view = normalizeView({ ...state.view, [axis]: { ...state.view[axis], [key]: input.value } });
  input.value = state.view[axis][key];
  scheduleView();
});
el('viewTuneToggle').addEventListener('click', () => {
  const tune = el('viewTune');
  tune.classList.toggle('hidden');
  el('viewTuneToggle').setAttribute('aria-expanded', String(!tune.classList.contains('hidden')));
});
el('viewReset').addEventListener('click', () => { state.view = defaultView(); scheduleView(); });
refresh().catch(error => toast(error.message, true));
