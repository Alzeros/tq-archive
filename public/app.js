const state = { nodes: [], reports: [], metricNames: {}, selectedNodeId: null, detail: null, compare: { node: '', result: null } };
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
const nodeName = id => state.nodes.find(node => node.id === id)?.name || id;
const metricLabel = key => state.metricNames[key] || key;
const metricText = measurement => {
  if (!measurement) return '—';
  if (measurement.status === 'unknown') return measurement.raw || '—';
  if (typeof measurement.value === 'number') return `${measurement.value}${measurement.unit || ''}`;
  return measurement.value ?? '—';
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function renderNodes() {
  const filter = el('nodeFilter').value.trim().toLowerCase();
  const visible = state.nodes.filter(node => !filter || node.name.toLowerCase().includes(filter) || (node.region || '').toLowerCase().includes(filter));
  const groups = new Map();
  for (const node of visible) {
    const city = node.name.split('-')[0] || node.region || '其他';
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(node);
  }
  const list = el('nodeList');
  list.innerHTML = '';
  if (!state.nodes.length) { list.innerHTML = '<p class="empty">先同步探针节点。</p>'; return; }
  for (const [city, nodes] of groups) {
    const label = document.createElement('div');
    label.className = 'node-group';
    label.textContent = `${city} · ${nodes.length}`;
    list.append(label);
    for (const node of nodes) {
      const count = state.reports.filter(report => report.nodeId === node.id).length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'node' + (node.id === state.selectedNodeId ? ' active' : '');
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
async function openDetail(reportId) {
  const report = await api(`/api/reports/${reportId}`);
  state.detail = report;
  el('detailCard').classList.remove('hidden');
  el('detailTitle').textContent = `报告详情 · ${fmtTime(report.testedAt)}`;
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
  el('detailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderRecent() {
  const recent = [...state.reports].sort((left, right) => right.importedAt.localeCompare(left.importedAt)).slice(0, 5);
  el('recentImports').innerHTML = recent.length
    ? recent.map(report => `<div class="item"><div class="title"><strong>${escapeHtml(nodeName(report.nodeId))}</strong><span class="meta">测试于 ${fmtTime(report.testedAt)} · ${report.recordCount} 条指标</span></div><span class="meta">导入于 ${fmtTime(report.importedAt)}</span></div>`).join('')
    : '<p class="empty">还没有导入记录。</p>';
}
function renderPreview(report, token) {
  const counts = report.sectionCounts || {};
  const perSection = report.sections.map(section => `<div class="stat"><div class="label">${escapeHtml(section.name)}</div><div class="value">${counts[section.id] ?? 0} 条</div></div>`).join('');
  const options = state.nodes.map(node => `<option value="${node.id}"${node.id === state.selectedNodeId ? ' selected' : ''}>${escapeHtml(node.name)}</option>`).join('');
  const box = el('previewResult');
  box.innerHTML = `<div class="preview-grid">
    <div class="stat"><div class="label">测试时间</div><div class="value">${fmtTime(report.testedAt)}</div></div>
    <div class="stat"><div class="label">出口信息</div><div class="value">${escapeHtml(report.identity || '未知')}</div></div>
    <div class="stat"><div class="label">指标总数</div><div class="value">${report.recordCount} 条</div></div>
    ${perSection}</div>
    ${report.warnings?.length ? `<div class="warn">解析提示：${report.warnings.map(escapeHtml).join('；')}</div>` : '<div class="ok">全部维度均已结构化解析，无异常提示。</div>'}
    <div class="row-form"><select id="previewNode">${options}</select><button id="confirmImport" class="primary" type="button">绑定并归档</button></div>`;
  box.classList.remove('hidden');
  el('confirmImport').addEventListener('click', async () => {
    const button = el('confirmImport');
    button.disabled = true;
    try {
      const nodeId = el('previewNode').value;
      await api('/api/import', { method: 'POST', body: JSON.stringify({ token, nodeId }) });
      toast(`已归档到「${nodeName(nodeId)}」`);
      box.classList.add('hidden');
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
    el('compareTitle').textContent = `变化明细 · ${fmtTime(result.baseTestedAt)} → ${fmtTime(result.currentTestedAt)}`;
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
    renderPreview(data.report, data.token);
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
refresh().catch(error => toast(error.message, true));
