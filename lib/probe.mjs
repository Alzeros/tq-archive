function flag(raw) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  return !['false', '0', 'no', 'off', ''].includes(String(raw).trim().toLowerCase());
}

export async function loadProbeNodes() {  const response = await fetch('https://node.cnsr.site/config.json', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`探针配置读取失败 (${response.status})`);
  const config = await response.json();
  const entry = config.site_tokens?.find(item => item.backend_url === 'wss://dash.cnsr.site');
  if (!entry) throw new Error('探针公开配置发生变化');
  const socket = new WebSocket(entry.backend_url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(String(event.data)); } catch { return; }
    const request = pending.get(String(data.id));
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(String(data.id));
    data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = String(++nextId);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('探针请求超时')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { token: entry.token, ...params } }));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('探针连接超时')), 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接探针')); }, { once: true });
    });
    const { uuids = [] } = await call('nodeget-server_list_all_agent_uuid', {});
    const keys = ['metadata_name', 'metadata_region', 'metadata_hidden', 'metadata_order'];
    const rows = await call('kv_get_multi_value', { namespace_key: uuids.flatMap(uuid => keys.map(key => ({ namespace: uuid, key }))) });
    return uuids.map(uuid => {
      const meta = Object.fromEntries(rows.filter(row => row.namespace === uuid).map(row => [row.key, row.value]));
      return { id: uuid, name: meta.metadata_name || uuid, region: meta.metadata_region || '', hidden: flag(meta.metadata_hidden), order: Number(meta.metadata_order) || 0 };
    }).filter(node => !node.hidden).sort((left, right) => left.order - right.order);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    socket.close();
  }
}
