// API Key 管理逻辑

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

async function loadKeys() {
  try {
    const res = await fetch('/api/keys', { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    renderKeys(data.keys);
  } catch (err) {
    console.error('加载 keys 失败:', err);
    document.getElementById('keysList').innerHTML = '<tr><td colspan="5" class="keys-empty">加载失败，请刷新重试</td></tr>';
  }
}

function renderKeys(keys) {
  const tbody = document.getElementById('keysList');
  if (keys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="keys-empty">还没有 API Key，点击上方「生成」创建第一个</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(k => `
    <tr>
      <td><span class="keys-name">${escapeHtml(k.name)}</span></td>
      <td><span class="keys-badge ${k.enabled ? 'on' : 'off'}">${k.enabled ? '已启用' : '已禁用'}</span></td>
      <td class="keys-meta">${formatDate(k.createdAt)}</td>
      <td class="keys-meta">${k.lastUsedAt ? formatDate(k.lastUsedAt) : '从未使用'}</td>
      <td class="keys-actions">
        <button class="keys-btn" onclick="toggleKey('${k.id}', ${!k.enabled})">${k.enabled ? '禁用' : '启用'}</button>
        <button class="keys-btn danger" onclick="deleteKey('${k.id}', '${escapeHtml(k.name)}')">删除</button>
      </td>
    </tr>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function generateKey() {
  const input = document.getElementById('keyName');
  const name = input.value.trim();
  if (!name) {
    showToast('请填写 Key 名称', 'error');
    return;
  }

  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const err = await res.json();
      throw new Error(err.error || '生成失败');
    }
    const data = await res.json();

    // 显示 secret（仅此一次）：用 hidden 属性控制，而非 class
    document.getElementById('secretValue').textContent = data.secret;
    const display = document.getElementById('secretDisplay');
    display.hidden = false;
    display.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // 清空输入框并刷新列表
    input.value = '';
    loadKeys();

    showToast('Key 已生成', 'success');
  } catch (err) {
    console.error('生成 key 失败:', err);
    showToast(err.message || '生成失败', 'error');
  }
}

async function toggleKey(id, enabled) {
  try {
    const res = await fetch(`/api/keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      throw new Error('操作失败');
    }
    showToast(enabled ? 'Key 已启用' : 'Key 已禁用', 'success');
    loadKeys();
  } catch (err) {
    console.error('切换 key 状态失败:', err);
    showToast(err.message || '操作失败', 'error');
  }
}

async function deleteKey(id, name) {
  if (!confirm(`确定要删除 Key"${name}"吗？删除后无法恢复。`)) return;

  try {
    const res = await fetch(`/api/keys/${id}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      throw new Error('删除失败');
    }
    showToast('Key 已删除', 'success');
    loadKeys();
  } catch (err) {
    console.error('删除 key 失败:', err);
    showToast(err.message || '删除失败', 'error');
  }
}

// 初始化
document.getElementById('generateBtn').addEventListener('click', generateKey);
document.getElementById('keyName').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') generateKey();
});
loadKeys();
