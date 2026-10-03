// 可搜索节点选择器：input 过滤 + 下拉列表，推荐节点置顶并高亮说明理由。
// 原生 select 在几十个节点时无法搜索，且无法表达"推荐"语义。
// allowEmpty：没有可信推荐时保持未选。待绑定列表一次可能好几份，默认选中第一个节点就会成批绑错
export function nodePicker({ container, nodes, reportsOf, selectedId, suggestion, allowEmpty = false }) {
  container.innerHTML = '';
  const state = { nodes, selectedId: null };
  const nodeName = id => nodes.find(node => node.id === id)?.name || id;

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'picker-input';
  input.placeholder = '搜索节点…';
  input.autocomplete = 'off';

  const list = document.createElement('div');
  list.className = 'picker-list hidden';

  const hint = document.createElement('div');
  hint.className = 'picker-hint hidden';

  container.append(input, hint, list);

  function lastUsedAt(id) {
    const times = (reportsOf.get(id) || []).map(report => report.testedAt);
    return times.length ? times.sort().at(-1) : '';
  }
  function sortNodes(list0) {
    // 有数据的节点按最近报告时间排前，无数据保持探针顺序排后
    return [...list0].sort((a, b) => {
      const ta = lastUsedAt(a.id), tb = lastUsedAt(b.id);
      if (ta && tb) return tb.localeCompare(ta);
      if (ta) return -1;
      if (tb) return 1;
      return (a.order || 0) - (b.order || 0);
    });
  }
  function match(node, keyword) {
    if (!keyword) return true;
    return node.name.toLowerCase().includes(keyword) || (node.region || '').toLowerCase().includes(keyword);
  }
  function renderList(keyword) {
    list.innerHTML = '';
    const pool = sortNodes(nodes).filter(node => match(node, keyword));
    if (!pool.length) { list.innerHTML = '<p class="picker-empty">没有匹配的节点</p>'; return; }
    for (const node of pool) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'picker-item' + (node.id === state.selectedId ? ' active' : '');
      const isSuggested = suggestion && node.id === suggestion.nodeId;
      const count = (reportsOf.get(node.id) || []).length;
      item.innerHTML = `<span>${escape(node.name)}${isSuggested ? ' <em class="picker-badge">推荐</em>' : ''}</span><span class="picker-meta">${count ? `${count} 份` : '无数据'}</span>`;
      item.addEventListener('click', () => {
        state.selectedId = node.id;
        input.value = node.name;
        list.classList.add('hidden');
        renderHint();
      });
      list.append(item);
    }
  }
  function renderHint() {
    hint.classList.add('hidden');
    if (!state.selectedId) return;
    if (suggestion?.reason === 'same-exit' && suggestion.nodeId === state.selectedId) {
      hint.textContent = allowEmpty ? '已按同一台机器上次的归属自动选择' : '已按出口记录自动选择上次归档的节点';
      hint.className = 'picker-hint ok';
    } else if (suggestion?.reason === 'recent' && suggestion.nodeId === state.selectedId) {
      hint.textContent = '已默认选择最近导入的节点';
      hint.className = 'picker-hint';
    }
  }
  // 聚焦时输入框里是"已选节点名"，若直接拿它当关键词会把列表过滤成只剩一项，
  // 等于没法改选。此处：已选中→展示全量并全选文本（打字即替换）；未选中→沿用已输入的查询。
  input.addEventListener('focus', () => {
    const selectedName = state.selectedId ? nodeName(state.selectedId) : '';
    const keepQuery = input.value !== selectedName;
    renderList(keepQuery ? input.value.trim().toLowerCase() : '');
    list.classList.remove('hidden');
    if (!keepQuery) input.select();
  });
  input.addEventListener('input', () => {
    state.selectedId = null;
    hint.className = 'picker-hint hidden';
    renderList(input.value.trim().toLowerCase());
    list.classList.remove('hidden');
  });
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));

  // 初始选中：推荐节点（来自出口记忆，比"上次浏览的节点"更贴近这份报告的归属）> 侧边栏当前选中 > 第一个
  state.selectedId = suggestion?.nodeId || selectedId || (allowEmpty ? null : nodes[0]?.id) || null;
  input.value = state.selectedId ? nodeName(state.selectedId) : '';
  renderHint();

  return {
    get value() { return state.selectedId; }
  };
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
