// API Key 管理逻辑
// 注意：不使用行内 onclick。server 会注入 data-theme，浏览器据此把本脚本
// 视为模块（顶层函数不进全局作用域），行内 onclick 会找不到函数。
// 因此统一用事件委托 + 显式暴露。

const $ = id => document.getElementById(id);

function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  return res;
}

async function loadKeys() {
  try {
    const res = await api('/api/keys');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderKeys(data.keys || []);
  } catch (err) {
    if (err.message !== '未登录') {
      console.error('加载 keys 失败:', err);
      $('keysList').innerHTML = '<tr><td colspan="5" class="keys-empty">加载失败，请刷新重试</td></tr>';
    }
  }
}

function renderKeys(keys) {
  const tbody = $('keysList');
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="keys-empty">还没有 API Key，点击上方「生成」创建第一个</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(k => `
    <tr data-id="${k.id}" data-name="${escapeHtml(k.name)}">
      <td><span class="keys-name">${escapeHtml(k.name)}</span></td>
      <td><span class="keys-badge ${k.enabled ? 'on' : 'off'}">${k.enabled ? '已启用' : '已禁用'}</span></td>
      <td class="keys-meta">${formatDate(k.createdAt)}</td>
      <td class="keys-meta">${k.lastUsedAt ? formatDate(k.lastUsedAt) : '从未使用'}</td>
      <td class="keys-actions">
        <button type="button" class="keys-btn" data-act="toggle" data-enabled="${k.enabled}">${k.enabled ? '禁用' : '启用'}</button>
        <button type="button" class="keys-btn danger" data-act="delete">删除</button>
      </td>
    </tr>
  `).join('');
}

// 事件委托：一个监听器处理所有行内按钮，不依赖全局函数
$('keysList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr?.dataset.id;
  const name = tr?.dataset.name || '';
  if (!id) return;

  if (btn.dataset.act === 'toggle') {
    const wantEnabled = btn.dataset.enabled !== 'true'; // 取反
    try {
      const res = await api(`/api/keys/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: wantEnabled })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '操作失败');
      }
      showToast(wantEnabled ? 'Key 已启用' : 'Key 已禁用', 'success');
      loadKeys();
    } catch (err) {
      if (err.message !== '未登录') showToast(err.message, 'error');
    }
  }

  if (btn.dataset.act === 'delete') {
    if (!confirm(`确定删除 Key「${name}」吗？删除后无法恢复。`)) return;
    try {
      const res = await api(`/api/keys/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '删除失败');
      }
      showToast('Key 已删除', 'success');
      loadKeys();
    } catch (err) {
      if (err.message !== '未登录') showToast(err.message, 'error');
    }
  }
});

async function generateKey() {
  const input = $('keyName');
  const name = input.value.trim();
  if (!name) { showToast('请填写 Key 名称', 'error'); return; }
  const btn = $('generateBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '生成失败');
    }
    const data = await res.json();

    // 显示 secret（仅此一次）
    $('secretValue').textContent = data.secret || '';
    const display = $('secretDisplay');
    display.hidden = false;
    input.value = '';
    loadKeys();
    display.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showToast('Key 已生成，请立即复制下方密钥', 'success');
  } catch (err) {
    if (err.message !== '未登录') showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

$('generateBtn').addEventListener('click', generateKey);
$('keyName').addEventListener('keypress', e => { if (e.key === 'Enter') generateKey(); });

loadKeys();
