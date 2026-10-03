// 节点管理：从探针同步节点、选择启用哪些节点。开关即时保存，不需要"保存"按钮。
// 站点 CSP 不允许行内事件处理器，开关与批量按钮都用事件委托绑定。
const $ = id => document.getElementById(id);
const state = { nodes: [], reports: [], syncedAt: null };

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

function render() {
  const enabled = state.nodes.filter(isEnabled).length;
  $('nodesSummary').textContent = state.nodes.length
    ? `已启用 ${enabled} / ${state.nodes.length} 个节点${state.syncedAt ? ` · 上次同步 ${fmtTime(state.syncedAt)}` : ''}`
    : '还没有节点，点右侧「从探针同步」拉取';
  const listed = listedNodes();
  // 有搜索词时批量操作只作用于搜索结果，提示里写清楚范围
  $('bulkScope').hidden = !keyword() || !listed.length;
  $('bulkScope').textContent = `批量操作只作用于当前搜索到的 ${listed.length} 个节点`;
  const stats = reportStats();
  const groups = new Map();
  for (const node of listed) {
    const city = cityOf(node);
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(node);
  }
  const host = $('nodeGroups');
  if (!groups.size) { host.innerHTML = `<p class="empty">${state.nodes.length ? '没有匹配的节点' : '还没有节点'}</p>`; return; }
  host.innerHTML = [...groups].map(([city, nodes]) => `
    <div class="nodes-group">
      <div class="nodes-group-head"><span>${escapeHtml(city)}</span><span class="nodes-group-count">${nodes.filter(isEnabled).length} / ${nodes.length} 已启用</span></div>
      ${nodes.map(node => {
        const stat = stats.get(node.id);
        return `<label class="node-row${isEnabled(node) ? ' on' : ''}">
          <input type="checkbox" class="switch" data-id="${escapeHtml(node.id)}"${isEnabled(node) ? ' checked' : ''}>
          <span class="node-row-name">${escapeHtml(node.name)}</span>
          ${node.archived ? '<span class="warn-pill" title="探针里已经没有这个节点，已有报告仍保留">探针已移除</span>' : ''}
          <span class="node-row-meta">${stat ? `${stat.count} 份报告 · 最近 ${fmtTime(stat.last)}` : '暂无报告'}</span>
        </label>`;
      }).join('')}
    </div>`).join('');
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
