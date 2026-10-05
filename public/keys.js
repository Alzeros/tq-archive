// API Key 管理逻辑
// 注意：不使用行内 onclick。站点 CSP 是 script-src 'self'，会拦截行内事件处理器，
// 因此表格按钮统一用事件委托绑定。

const $ = id => document.getElementById(id);

function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3000);
}

// 与 app.js / nodes.js 必须是同一份实现：三处各有一份副本，改一处漏两处就会出现
// 属性注入（textContent→innerHTML 不转义 " 和 '，data-name="..." 这类写法会被一个引号 breakout）。
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// clipboard API 只在安全上下文可用（https / localhost）；http 裸 IP 访问时退回 execCommand
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.className = 'keys-copy-fallback';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
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
      $('keysList').innerHTML = '<tr><td colspan="7" class="keys-empty">加载失败，请刷新重试</td></tr>';
    }
  }
}

function renderKeys(keys) {
  const tbody = $('keysList');
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="keys-empty">还没有 API Key，点击上方「生成」创建第一个</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(k => `
    <tr data-id="${k.id}" data-name="${escapeHtml(k.name)}">
      <td data-label="名称"><span class="keys-name">${escapeHtml(k.name)}</span></td>
      <td data-label="权限"><span class="keys-badge ${k.scope === 'read' ? 'read' : 'up'}">${k.scope === 'read' ? '只读' : '上传'}</span></td>
      <td data-label="密钥" class="keys-secret-cell"><div class="keys-secret-content"><code>${escapeHtml(k.secret)}</code><button type="button" class="sub-btn" data-act="copy" data-secret="${escapeHtml(k.secret)}">复制</button></div></td>
      <td data-label="状态"><span class="keys-badge ${k.enabled ? 'on' : 'off'}">${k.enabled ? '已启用' : '已禁用'}</span></td>
      <td data-label="创建时间" class="keys-meta">${formatDate(k.createdAt)}</td>
      <td data-label="最后使用" class="keys-meta">${k.lastUsedAt ? formatDate(k.lastUsedAt) : '从未使用'}</td>
      <td data-label="操作" class="keys-actions"><div class="keys-action-buttons">
        <button type="button" class="sub-btn" data-act="toggle" data-enabled="${k.enabled}">${k.enabled ? '禁用' : '启用'}</button>
        <button type="button" class="sub-btn danger" data-act="delete">删除</button>
      </div></td>
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

  if (btn.dataset.act === 'copy') {
    const ok = await copyText(btn.dataset.secret);
    showToast(ok ? '密钥已复制' : '复制失败，请手动选择复制', ok ? 'success' : 'error');
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
      body: JSON.stringify({ name, scope: $('keyScope').value })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '生成失败');
    }
    const data = await res.json();

    // 生成后给醒目反馈；secret 长期保存在列表里，随时可看
    $('secretValue').textContent = data.secret || '';
    const display = $('secretDisplay');
    display.hidden = false;
    input.value = '';
    $('keyScope').value = 'upload';
    loadKeys();
    display.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showToast(`Key 已生成（${data.scope === 'read' ? '只读' : '上传'}）`, 'success');
  } catch (err) {
    if (err.message !== '未登录') showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

$('generateBtn').addEventListener('click', generateKey);
$('keyName').addEventListener('keypress', e => { if (e.key === 'Enter') generateKey(); });

// 整库备份：直接走浏览器下载，服务端一次性打好包（数据量在几十 MB 级，不必分片）。
// 用 <a download> 而不是 window.open，避免被拦截成弹窗。
async function exportBackup() {
  const btn = $('exportBtn');
  const state = $('exportState');
  btn.disabled = true;
  state.textContent = '正在打包…';
  try {
    const response = await fetch('/api/export');
    if (response.status === 401) { location.replace('/login'); return; }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `导出失败 (${response.status})`);
    }
    const blob = await response.blob();
    // 文件名由服务端带在 Content-Disposition 里，含导出时间戳，便于同一天导出多份
    const disposition = response.headers.get('Content-Disposition') || '';
    const name = disposition.match(/filename="([^"]+)"/)?.[1] || 'tq-hub-backup.tar.gz';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    // 立刻 revoke 会让部分浏览器来不及取数据，留一点时间再释放
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    state.textContent = `已导出 ${name}（${(blob.size / 1024 / 1024).toFixed(2)} MB）`;
    showToast('备份已开始下载，请存放到可信位置');
  } catch (err) {
    state.textContent = '';
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('exportBtn').addEventListener('click', exportBackup);

loadKeys();
