// 节点管理：从探针同步节点、选择启用哪些节点。开关即时保存，不需要"保存"按钮。
// 站点 CSP 不允许行内事件处理器，开关与批量按钮都用事件委托绑定。
const $ = id => document.getElementById(id);
const state = { nodes: [], reports: [], syncedAt: null };
let pendingAction = null;

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (response.status === 401) { location.replace('/login'); throw new Error('请先登录'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pad = value => String(value).padStart(2, '0');
const fmtTime = iso => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const isEnabled = node => node.enabled !== false;
// 与侧边栏一致：节点名「城市-商家」的城市部分作为分组
const cityOf = node => node.name.split('-')[0] || node.region || '其他';

function reportStats() {
  const stats = new Map();
  for (const report of state.reports) {
    const item = stats.get(report.nodeId) || { count: 0, last: '' };
    item.count += 1;
    if (report.testedAt > item.last) item.last = report.testedAt;
    stats.set(report.nodeId, item);
  }
  return stats;
}
function keyword() { return $('nodeSearch').value.trim().toLowerCase(); }
function listedNodes() {
  const query = keyword();
  return state.nodes.filter(node => !query || node.name.toLowerCase().includes(query) || (node.region || '').toLowerCase().includes(query));
}

function renderNodeRow(node, stats) {
  const stat = stats.get(node.id);
  const metaText = stat ? `${stat.count} 份报告 · 最近 ${fmtTime(stat.last)}` : '暂无报告';
  const delTitle = stat
    ? `彻底删除节点「${node.name}」及其 ${stat.count} 份历史报告`
    : `删除已从探针移除的节点「${node.name}」`;
  return `<div class="node-row${isEnabled(node) ? ' on' : ''}${node.archived ? ' archived' : ''}">
    <label class="node-row-main">
      <input type="checkbox" class="switch" data-id="${escapeHtml(node.id)}"${isEnabled(node) ? ' checked' : ''}>
      <span class="node-row-name">${escapeHtml(node.name)}</span>
    </label>
    <div class="node-row-side">
      ${node.archived ? '<span class="warn-pill" title="探针里已经没有这个节点，已有报告仍保留">探针已移除</span>' : ''}
      <span class="node-row-meta">${escapeHtml(metaText)}</span>
      ${node.archived ? `<button type="button" class="sub-btn danger node-del-btn" data-delete-id="${escapeHtml(node.id)}" title="${escapeHtml(delTitle)}">删除</button>` : ''}
    </div>
  </div>`;
}

function render() {
  const activeNodes = state.nodes.filter(node => !node.archived);
  const archivedNodes = state.nodes.filter(node => node.archived);
  const enabledActive = activeNodes.filter(isEnabled).length;
  const archivedText = archivedNodes.length ? ` · ${archivedNodes.length} 个探针已移除` : '';
  $('nodesSummary').textContent = state.nodes.length
    ? `已启用 ${enabledActive} / ${activeNodes.length} 个节点${archivedText}${state.syncedAt ? ` · 上次同步 ${fmtTime(state.syncedAt)}` : ''}`
    : '还没有节点，点右侧「从探针同步」拉取';
  const listed = listedNodes();
  // 有搜索词时批量操作只作用于搜索结果，提示里写清楚范围
  $('bulkScope').hidden = !keyword() || !listed.length;
  $('bulkScope').textContent = `批量操作只作用于当前搜索到的 ${listed.length} 个节点`;
  const stats = reportStats();
  const activeListed = listed.filter(node => !node.archived);
  const archivedListed = listed.filter(node => node.archived);
  const groups = new Map();
  for (const node of activeListed) {
    const city = cityOf(node);
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(node);
  }
  const host = $('nodeGroups');
  if (!groups.size && !archivedListed.length) {
    host.innerHTML = `<p class="empty">${state.nodes.length ? '没有匹配的节点' : '还没有节点'}</p>`;
    return;
  }
  const activeHtml = [...groups].map(([city, nodes]) => `
    <div class="nodes-group">
      <div class="nodes-group-head"><span>${escapeHtml(city)}</span><span class="nodes-group-count">${nodes.filter(isEnabled).length} / ${nodes.length} 已启用</span></div>
      ${nodes.map(node => renderNodeRow(node, stats)).join('')}
    </div>`).join('');

  let archivedHtml = '';
  if (archivedListed.length) {
    const sortedArchived = archivedListed.slice().sort((left, right) => {
      const ca = stats.get(left.id)?.count || 0;
      const cb = stats.get(right.id)?.count || 0;
      return cb - ca || left.name.localeCompare(right.name, 'zh-CN');
    });
    const emptyArchived = sortedArchived.filter(node => !stats.has(node.id));
    archivedHtml = `
      <div class="nodes-group nodes-group-archived">
        <div class="nodes-group-head">
          <span class="nodes-archived-title">探针已移除（可手动清理）</span>
          <div class="nodes-archived-actions">
            <span class="nodes-group-count">${archivedListed.length} 个 · 不自动删除</span>
            ${emptyArchived.length ? `<button type="button" class="sub-btn danger" id="pruneArchivedBtn">清理无报告节点 (${emptyArchived.length})</button>` : ''}
          </div>
        </div>
        ${sortedArchived.map(node => renderNodeRow(node, stats)).join('')}
      </div>`;
  }
  host.innerHTML = activeHtml + archivedHtml;
}

async function load() {
  const data = await api('/api/state');
  state.nodes = data.nodes;
  state.reports = data.reports;
  state.syncedAt = data.syncedAt;
  render();
}
async function setEnabled(ids, enabled) {
  const data = await api('/api/nodes', { method: 'PATCH', body: JSON.stringify({ ids, enabled }) });
  state.nodes = data.nodes;
  render();
}

function closeDeleteDialog() {
  pendingAction = null;
  const dialog = $('deleteNodeDialog');
  if (dialog?.open) dialog.close();
}

function updateDialogConfirmState() {
  const confirmBtn = $('delDialogConfirm');
  if (!pendingAction) { confirmBtn.disabled = true; return; }
  if (pendingAction.requireName) {
    confirmBtn.disabled = $('delConfirmInput').value.trim() !== pendingAction.requireName;
  } else {
    confirmBtn.disabled = false;
  }
}

function openSingleDeleteDialog(node) {
  const stats = reportStats();
  const stat = stats.get(node.id);
  const count = stat?.count || 0;
  pendingAction = {
    type: 'single',
    node,
    count,
    requireName: count > 0 ? node.name : ''
  };
  $('delDialogTitle').textContent = count > 0 ? `彻底删除「${node.name}」及历史数据？` : `删除已移除节点「${node.name}」？`;
  $('delDialogDesc').textContent = count > 0
    ? `该节点已从探针移除，目前名下保留有 ${count} 份历史测试报告（最近一份为 ${fmtTime(stat.last)}）。`
    : '该节点已从探针移除，且名下暂无任何历史报告。删除后节点列表将不再显示它。';
  $('delDialogWarn').hidden = count === 0;
  $('delDialogWarn').textContent = count > 0
    ? `确认后将永久删除该节点及其全部 ${count} 份历史报告、结构化明细和原始 HTML/CSV 文件，操作不可撤销。如需保留报告，请先取消并到首页改绑节点或去「API Key › 数据备份」导出归档。`
    : '';
  $('delDialogVerify').hidden = count === 0;
  $('delExpectedName').textContent = node.name;
  $('delConfirmInput').value = '';
  $('delDialogConfirm').textContent = count > 0 ? `永久删除（含 ${count} 份报告）` : '确认删除';
  updateDialogConfirmState();
  $('deleteNodeDialog').showModal();
  if (count > 0) $('delConfirmInput').focus();
  else $('delDialogCancel').focus();
}

function openPruneDialog(emptyNodes) {
  const previewNames = emptyNodes.slice(0, 8).map(n => n.name).join('、');
  const suffix = emptyNodes.length > 8 ? ` 等共 ${emptyNodes.length} 个` : '';
  pendingAction = {
    type: 'prune',
    nodes: emptyNodes,
    requireName: ''
  };
  $('delDialogTitle').textContent = `清理 ${emptyNodes.length} 个无报告的已移除节点？`;
  $('delDialogDesc').textContent = `将删除：${previewNames}${suffix}。这些节点均已从探针移除且没有任何历史报告，不会影响已有报告数据。`;
  $('delDialogWarn').hidden = true;
  $('delDialogWarn').textContent = '';
  $('delDialogVerify').hidden = true;
  $('delExpectedName').textContent = '';
  $('delConfirmInput').value = '';
  $('delDialogConfirm').textContent = `确认清理 (${emptyNodes.length})`;
  updateDialogConfirmState();
  $('deleteNodeDialog').showModal();
  $('delDialogCancel').focus();
}

$('nodeGroups').addEventListener('change', async event => {
  const input = event.target.closest('input.switch');
  if (!input) return;
  input.disabled = true;
  try {
    await setEnabled([input.dataset.id], input.checked);
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    toast(error.message, true);
  }
});

$('nodeGroups').addEventListener('click', event => {
  const delBtn = event.target.closest('button[data-delete-id]');
  if (delBtn) {
    const node = state.nodes.find(item => item.id === delBtn.dataset.deleteId);
    if (!node || !node.archived) return;
    openSingleDeleteDialog(node);
    return;
  }
  if (event.target.closest('#pruneArchivedBtn')) {
    const stats = reportStats();
    const emptyNodes = listedNodes().filter(node => node.archived && !stats.has(node.id));
    if (!emptyNodes.length) return;
    openPruneDialog(emptyNodes);
  }
});

$('delConfirmInput').addEventListener('input', updateDialogConfirmState);
$('delDialogCancel').addEventListener('click', closeDeleteDialog);
$('deleteNodeDialog').addEventListener('cancel', () => { pendingAction = null; });

$('delDialogForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingAction) return;
  if (pendingAction.requireName && $('delConfirmInput').value.trim() !== pendingAction.requireName) return;
  const action = pendingAction;
  const confirmBtn = $('delDialogConfirm');
  const cancelBtn = $('delDialogCancel');
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  const origLabel = confirmBtn.textContent;
  confirmBtn.textContent = '删除中…';
  try {
    if (action.type === 'single') {
      const qs = action.count > 0 ? '?cascade=1' : '';
      const data = await api(`/api/nodes/${encodeURIComponent(action.node.id)}${qs}`, { method: 'DELETE' });
      state.nodes = data.nodes;
      state.reports = data.reports || state.reports.filter(r => r.nodeId !== action.node.id);
      closeDeleteDialog();
      render();
      toast(data.removedReports ? `已彻底删除「${action.node.name}」及其 ${data.removedReports} 份历史报告` : `已删除节点「${action.node.name}」`);
    } else if (action.type === 'prune') {
      const bodyPayload = keyword() ? { ids: action.nodes.map(n => n.id) } : {};
      const data = await api('/api/nodes/prune-archived', { method: 'POST', body: JSON.stringify(bodyPayload) });
      state.nodes = data.nodes;
      closeDeleteDialog();
      render();
      toast(data.removedCount ? `已清理 ${data.removedCount} 个无报告的已移除节点` : '没有可清理的无报告已移除节点');
    }
  } catch (error) {
    toast(error.message, true);
    updateDialogConfirmState();
  } finally {
    cancelBtn.disabled = false;
    if (confirmBtn.textContent === '删除中…') confirmBtn.textContent = origLabel;
  }
});

document.querySelector('.nodes-bulk').addEventListener('click', async event => {
  const button = event.target.closest('button[data-bulk]');
  if (!button) return;
  const targets = listedNodes();
  if (!targets.length) return;
  const mode = button.dataset.bulk;
  const scope = keyword() ? `搜索到的 ${targets.length} 个节点` : `全部 ${targets.length} 个节点`;
  if (mode === 'off' && !confirm(`停用${scope}？停用只是隐藏，已有报告不会删除。`)) return;
  const stats = reportStats();
  const tested = targets.filter(node => stats.has(node.id)).map(node => node.id);
  const untested = targets.filter(node => !stats.has(node.id)).map(node => node.id);
  const steps = mode === 'tested' ? [[tested, true], [untested, false]] : [[targets.map(node => node.id), mode === 'on']];
  for (const item of document.querySelectorAll('.nodes-bulk button')) item.disabled = true;
  try {
    for (const [ids, enabled] of steps) if (ids.length) await setEnabled(ids, enabled);
    toast(mode === 'tested' ? `已启用 ${tested.length} 个有报告的节点，停用 ${untested.length} 个` : `已${mode === 'on' ? '启用' : '停用'}${scope}`);
  } catch (error) { toast(error.message, true); } finally {
    for (const item of document.querySelectorAll('.nodes-bulk button')) item.disabled = false;
  }
});

$('syncButton').addEventListener('click', async () => {
  const button = $('syncButton');
  const label = button.querySelector('span');
  const known = new Set(state.nodes.map(node => node.id));
  button.disabled = true;
  label.textContent = '同步中…';
  try {
    const data = await api('/api/sync', { method: 'POST' });
    await load();
    const added = known.size ? state.nodes.filter(node => !known.has(node.id)).length : 0;
    toast(`已同步 ${data.count} 个节点${added ? `，新增 ${added} 个（默认停用）` : ''}`);
  } catch (error) { toast(error.message, true); } finally {
    button.disabled = false;
    label.textContent = '从探针同步';
  }
});

$('nodeSearch').addEventListener('input', render);
load().catch(error => toast(error.message, true));
