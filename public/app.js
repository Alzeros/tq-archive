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
}
function renderHistory() {
  const list = el('historyList');
  if (!state.selectedNodeId) {
    el('historyTitle').textContent = '请选择节点';
    list.innerHTML = '<p class="empty">从左侧选择一个节点，查看它历次的 TQ 报告。</p>';
    el('detailCard').classList.add('hidden');
    return;
  }
  const reports = state.reports.filter(report => report.nodeId === state.selectedNodeId).sort((left, right) => right.testedAt.localeCompare(left.testedAt));
  el('historyTitle').textContent = `${nodeName(state.selectedNodeId)} · ${reports.length} 份报告`;
  if (!reports.length) {
    list.innerHTML = '<p class="empty">该节点还没有报告，去“导入报告”粘贴链接。</p>';
    el('detailCard').classList.add('hidden');
    return;
  }
  list.innerHTML = '';
  for (const report of reports) {
    const warnCount = report.warnings?.length || 0;
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<div class="title"><strong>${fmtTime(report.testedAt)}</strong>
      <span class="meta">${report.recordCount} 条指标 · ${escapeHtml(report.identity || '未知线路')}${warnCount ? ` · ${warnCount} 条解析提示` : ''}</span></div>`;
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
        if (state.detail?.id === report.id) { state.detail = null; el('detailCard').classList.add('hidden'); }
        toast('已删除该份归档');
        await refresh();
      } catch (error) { toast(error.message, true); remove.disabled = false; }
    });
    actions.append(open, raw, remove);
    item.append(actions);
    list.append(item);
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
  const bandRows = Object.entries(insight.latencyBands || {})
    .map(([code, item]) => `<tr${code === region.code ? ' class="current"' : ''}><td>${escapeHtml(code)}</td><td>${escapeHtml(item.label)}</td><td>${item.good}</td><td>${item.fair}</td></tr>`).join('');
  const services = insight.services
    ? `<div class="insight-block"><h3 class="section-title">常用网站 / CDN 响应最慢的 5 个 · 共 ${insight.services.total} 个${insight.services.unreachable ? `，${insight.services.unreachable} 个不可达` : ''}</h3>
        <div class="svc-row">${insight.services.slowest.map(item => `<span class="svc"><span class="name">${escapeHtml(item.name)}</span><span class="lat">${item.latency ?? '—'}ms</span></span>`).join('')}</div></div>`
    : '';
  const tabs = insight.matrices.map((matrix, index) => `<button class="hm-tab${index === 0 ? ' active' : ''}" type="button" data-matrix="${matrix.id}">${escapeHtml(matrix.name)}</button>`).join('');
  el('detailSummary').innerHTML = `<div class="insight-block">
      <div class="card-grid">${cards}</div>
      <details class="basis-wrap">
        <summary>评级基准 · 延迟按机房区域分档（当前：${escapeHtml(region.label)}，好 ≤ ${region.good}ms / 一般 ≤ ${region.fair}ms）</summary>
        <p class="hint">同一个绝对阈值判所有区域，会把"离得远"误判成"线路差"：香港 25ms 和法兰克福 175ms 都是各自区域的正常水平。下表为延迟基准，改 <code>lib/thresholds.mjs</code> 即可调整。</p>
        <div class="table-wrap"><table><thead><tr><th>区域</th><th>名称</th><th>好 ≤ (ms)</th><th>一般 ≤ (ms)</th></tr></thead><tbody>${bandRows}</tbody></table></div>
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
      return `<span class="hm-cell l${cell ? cell.l : 0}" title="${escapeHtml(`${row}·${column} ${text}｜去程 ${route || '未知'}`)}">${escapeHtml(text)}</span>`;
    }).join('');
    return `<span class="hm-row-name">${escapeHtml(row)}</span>${cells}`;
  }).join('');
  const head = `<span class="hm-row-name"></span>${matrix.columns.map(column => `<span class="hm-col">${escapeHtml(column)}</span>`).join('')}`;
  el('heatmap').innerHTML = `<div class="hm-tabs">${tabs}</div><div class="hm-grid cols-${Math.min(3, matrix.columns.length)}">${head}${body}</div>${legend}`;
  for (const button of el('heatmap').querySelectorAll('.hm-tab[data-metric]')) {
    button.addEventListener('click', () => { state.heatmap.metricId = button.dataset.metric; drawHeatmap(); });
  }
}
async function openDetail(reportId) {
  const report = await api(`/api/reports/${reportId}`);
  state.detail = report;
  el('detailCard').classList.remove('hidden');
  el('detailTitle').textContent = `报告详情 · ${nodeName(report.nodeId)} · ${fmtShort(report.testedAt)}`;
  el('openOriginal').href = report.sourceUrl;
  el('downloadJson').href = `/api/reports/${reportId}/export`;
  el('downloadRaw').href = `/api/reports/${reportId}/raw`;
  el('detailWarnings').innerHTML = report.warnings?.length
    ? `<div class="warn">解析提示：${report.warnings.map(escapeHtml).join('；')}</div>`
    : '';
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
  el('recentImports').innerHTML = recent.length
    ? recent.map(report => `<div class="item"><div class="title"><strong>${escapeHtml(nodeName(report.nodeId))}</strong><span class="meta">测试于 ${fmtTime(report.testedAt)} · ${report.recordCount} 条指标</span></div><span class="meta">导入于 ${fmtTime(report.importedAt)}</span></div>`).join('')
    : '<p class="empty">还没有导入记录。</p>';
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
