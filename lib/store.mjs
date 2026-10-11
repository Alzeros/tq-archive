import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { businessError } from './business-error.mjs';

function emptyDatabase() {
  return { version: 2, nodes: [], reports: [], pending: [], syncedAt: null };
}

// 索引只保留列表与去重所需的元数据：records / rawRows 体积约为元数据的 20 倍，
// 全量塞进 database.json 会让每次写入都随报告数线性变慢，因此明细单独落盘。
function toIndex(report) {
  const { records, rawRows, ...metadata } = report;
  return {
    ...metadata,
    recordCount: records.length,
    sectionCounts: Object.fromEntries(report.sections.map(section => [section.id, records.filter(record => record.section === section.id).length]))
  };
}

export function createStore(directory, { rebuild } = {}) {
  const rawDirectory = join(directory, 'raw');
  const detailDirectory = join(directory, 'reports');
  // 脚本直传、尚未绑定节点的 CSV。绑定后移入 raw/，这里只剩待处理的文件
  const poolDirectory = join(directory, 'csv-pool');
  mkdirSync(rawDirectory, { recursive: true });
  mkdirSync(detailDirectory, { recursive: true });
  mkdirSync(poolDirectory, { recursive: true });
  const filename = join(directory, 'database.json');
  let database = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : emptyDatabase();
  if (!Array.isArray(database.reports) || !Array.isArray(database.nodes)) database = emptyDatabase();
  // 旧数据库没有待绑定队列；补上即可，下次任意写入时随之落盘
  if (!Array.isArray(database.pending)) database = { ...database, pending: [] };

  // 派生索引。存盘是全量替换（database 每次都是新对象），所以索引也整体重建 ——
  // 不做增量维护，少一类「写入了却忘了更新索引」的 bug。
  //
  // 要解决的是每次请求都在 store.database 上线性扫描：看板对每个节点扫一遍全部报告，
  // 聚合接口对每份报告做两次 nodes.find()，insightFor 每次找"上一份"再全表排一次。
  // 4 份报告时无所谓，几百份时是每请求 O(节点 × 报告 log 报告)。
  let nodeIndex = new Map();
  let reportsByNode = new Map();
  let identityIndex = new Map();
  // 明细缓存的容量上限（份）。见 detail() 里的说明：解析后约 260KB/份，
  // 256 份约 65MB —— 相对 Node 默认堆上限（约 2GB）很宽裕。
  //
  // 这个数字是按「看板的工作集必须装得下」定的，不是随手取的：缓存一旦装不下工作集，
  // 就会退化成 100% miss 且每次插入都白做一次淘汰，比没有缓存还慢（实测 200 份时
  // 上限 64 只有 1.09×，而工作集装得下时是 2000×）。看板读「每个启用节点的最近 5 份」，
  // 20 节点 = 100 份；/api/stats 无过滤时会读全部，所以留了 256 的余量。
  const detailCache = new Map();
  const detailCacheLimit = 256;
  let reindex = () => {
    nodeIndex = new Map(database.nodes.map(node => [node.id, node]));
    reportsByNode = new Map();
    // 每台机器的报告按测试时间倒序（新的在前）。归并用，
    // 「取时间严格早于某份报告的最近一份」就变成一次二分/一次线性查。
    for (const report of database.reports) {
      if (!reportsByNode.has(report.nodeId)) reportsByNode.set(report.nodeId, []);
      reportsByNode.get(report.nodeId).push(report);
    }
    for (const list of reportsByNode.values()) list.sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
    // 出口记忆要的是"最近一次归档到该节点的同出口报告"。用 Map 存下标最大的那条，
    // 免得每次都 [...reports].reverse() 复制整个数组再线性找（现在是 O(总报告数)）。
    identityIndex = new Map();
    for (const report of database.reports) if (report.identity) identityIndex.set(report.identity, report);
  };
  reindex();

  function persist(next) {
    writeFileSync(`${filename}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${filename}.tmp`, filename);
    database = next;
    reindex();
  }
  const detailPath = id => join(detailDirectory, `${id}.json`);
  const rawPath = (id, ext) => join(rawDirectory, `${id}.${ext}`);
  const poolPath = id => join(poolDirectory, `${id}.csv`);
  const nodeName = id => nodeIndex.get(id)?.name || id;
  function writeAtomic(path, content) {
    writeFileSync(`${path}.tmp`, content);
    renameSync(`${path}.tmp`, path);
  }

  // v1 把 records / rawRows 内联在索引里。启动时把它们拆到独立文件并重建索引，
  // 避免升级后旧报告的详情与对比因取不到明细而报错。
  function migrate() {
    if (database.version === 2) return;
    const migrated = [];
    for (const report of database.reports) {
      if (report.records && !existsSync(detailPath(report.id))) {
        writeFileSync(`${detailPath(report.id)}.tmp`, JSON.stringify(report));
        renameSync(`${detailPath(report.id)}.tmp`, detailPath(report.id));
      }
      migrated.push(toIndex(report));
    }
    persist({ ...database, version: 2, reports: migrated });
  }
  migrate();
  // 启用开关：只有启用的节点出现在界面列表里。旧库没有该字段——有报告的默认启用，其余停用，
  // 升级后侧边栏只剩实际在测的节点，不必手动关掉几十个
  if (!database.nodes.every(node => typeof node.enabled === 'boolean')) {
    const tested = new Set(database.reports.map(report => report.nodeId));
    persist({ ...database, nodes: database.nodes.map(node => typeof node.enabled === 'boolean' ? node : { ...node, enabled: tested.has(node.id) }) });
  }
  // 往节点归档报告时顺带启用它：给新服务器绑定第一份报告不必先去设置页打开开关
  const enableNode = nodeId => database.nodes.map(node => node.id === nodeId && node.enabled !== true ? { ...node, enabled: true } : node);

  return {
    get database() { return database; },
    // 节点按 id 查、报告按 nodeId 查，都走派生索引而不是线性扫。
    // 返回的数组/对象是索引里的引用：只读用途可以直接用，要改必须先拷贝。
    node(id) { return nodeIndex.get(id) || null; },
    reportsOfNode(nodeId) { return reportsByNode.get(nodeId) || []; },
    // 某份报告之前的最近一份（同节点、时间严格更早），按倒序表找第一个即可。
    // insightFor / 历史对比都要用这个，此前是全表 filter + sort。
    previousOf(report) {
      const list = reportsByNode.get(report.nodeId);
      if (!list) return null;
      const at = Date.parse(report.testedAt);
      return list.find(item => item.id !== report.id && Date.parse(item.testedAt) < at) || null;
    },
    sync(nodes) {
      // 已归档节点可能已从探针消失，或本次读不到 metadata。
      // 此时沿用上次同步到的名称，避免节点在界面上退化成裸 uuid。
      const retained = new Map(database.nodes.map(node => [node.id, node]));
      // 首次同步全部启用，免得新装后列表是空的；之后探针新增的节点默认停用，由用户按需打开
      const firstSync = !database.nodes.length;
      const merged = nodes.map(node => {
        const previous = retained.get(node.id);
        if (!previous) return { ...node, archived: false, enabled: firstSync };
        retained.delete(node.id);
        const name = node.name && node.name !== node.id ? node.name : previous.name;
        return { ...previous, ...node, name, region: node.region || previous.region, order: node.order || previous.order, archived: false };
      });
      persist({ ...database, syncedAt: new Date().toISOString(), nodes: [...merged, ...[...retained.values()].map(node => ({ ...node, archived: true }))] });
    },
    insert(nodeId, parsed, html) {
      if (!database.nodes.some(node => node.id === nodeId)) throw businessError('节点不存在，请重新选择');
      const existing = database.reports.find(report => report.sourceUrl === parsed.sourceUrl || report.fingerprint === parsed.fingerprint);
      if (existing) throw businessError(`报告已导入到「${nodeName(existing.nodeId)}」，请勿重复导入`);
      const report = { ...parsed, id: randomUUID(), nodeId };
      writeFileSync(rawPath(report.id, 'html'), html);
      writeAtomic(detailPath(report.id), JSON.stringify(report));
      persist({ ...database, nodes: enableNode(nodeId), reports: [...database.reports, toIndex(report)] });
      return report;
    },
    setNodesEnabled(ids, enabled) {
      const targets = new Set(ids);
      if (![...targets].every(id => database.nodes.some(node => node.id === id))) throw businessError('节点不存在，请刷新后重试');
      persist({ ...database, nodes: database.nodes.map(node => targets.has(node.id) ? { ...node, enabled: Boolean(enabled) } : node) });
      return database.nodes;
    },
    // 同一份数据（相同指纹）无论走链接还是直传，都只归档一次；待绑定队列里也不重复排队
    duplicateOf(fingerprint) {
      const report = database.reports.find(item => item.fingerprint === fingerprint);
      if (report) return { kind: 'report', id: report.id, nodeId: report.nodeId, nodeName: nodeName(report.nodeId) };
      const pending = database.pending.find(item => item.fingerprint === fingerprint);
      if (pending) return { kind: 'pending', id: pending.id };
      return null;
    },
    addPending(entry, csv) {
      writeAtomic(poolPath(entry.id), csv);
      persist({ ...database, pending: [...database.pending, entry] });
      return entry;
    },
    // 缺文件不是"记录不存在"以外的正常状态，但也不能让调用方拿到异常：
    // 启动时的重解析循环在模块加载期跑，抛出去就是进程直接退出（且条目还在库里，
    // 之后每次重启都崩，只能手工改 database.json）。这里统一返回 null，由调用方决定怎么办。
    pendingCsv(id) {
      if (!database.pending.some(item => item.id === id)) return null;
      try {
        return readFileSync(poolPath(id), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    // 池文件丢失的条目：源数据没了，绑不了也下载不了。标出来让界面说清楚，
    // 而不是留一条点了必然报错的记录。
    markPendingBroken(ids) {
      const targets = new Set(ids);
      persist({ ...database, pending: database.pending.map(item => targets.has(item.id) ? { ...item, broken: true } : item) });
    },
    // 绑定 = 新增报告 + 移出队列，合并成一次索引写入：中途崩溃也不会出现"两边都有"或"两边都没有"
    bindPending(id, nodeId, parsed, csv) {
      if (!database.pending.some(item => item.id === id)) throw businessError('待绑定记录不存在，可能已被处理');
      if (!database.nodes.some(node => node.id === nodeId)) throw businessError('节点不存在，请重新选择');
      const existing = database.reports.find(report => report.fingerprint === parsed.fingerprint);
      if (existing) throw businessError(`这份数据已归档到「${nodeName(existing.nodeId)}」，可直接丢弃`);
      const report = { ...parsed, id: randomUUID(), nodeId, rawExt: 'csv' };
      // 索引先落盘、附属文件后删：反过来的话，删文件成功而写索引失败会留下
      // "列表里还在、点开就报错"的僵尸报告。剩下孤儿文件是可回收的，僵尸条目不是。
      writeFileSync(rawPath(report.id, 'csv'), csv);
      writeAtomic(detailPath(report.id), JSON.stringify(report));
      persist({ ...database, nodes: enableNode(nodeId), reports: [...database.reports, toIndex(report)], pending: database.pending.filter(item => item.id !== id) });
      try { unlinkSync(poolPath(id)); } catch { /* 已移入 raw/，残留文件下次启动会被当作孤儿重新排队，这里尽量删干净 */ }
      return report;
    },
    removePending(id) {
      if (!database.pending.some(item => item.id === id)) throw businessError('待绑定记录不存在，可能已被处理');
      persist({ ...database, pending: database.pending.filter(item => item.id !== id) });
      try { unlinkSync(poolPath(id)); } catch { /* 文件可能已不存在，忽略 */ }
    },
    // 队列索引之外的池文件：旧版本只落盘不登记，或登记前进程中断。交给调用方解析后重新排队
    orphanPoolFiles() {
      const known = new Set(database.pending.map(item => item.id));
      return readdirSync(poolDirectory)
        .filter(name => /^[a-f\d-]{36}\.csv$/.test(name) && !known.has(name.slice(0, -4)))
        .map(name => ({ id: name.slice(0, -4), csv: readFileSync(join(poolDirectory, name), 'utf8'), mtimeMs: statSync(join(poolDirectory, name)).mtimeMs }));
    },
    // 直传报告只按"同一台机器"记忆归属，不回落到"最近导入"：待绑定可能一次有好几份，默认值猜错就会成批绑错
    rememberedNode(identity) {
      if (!identity) return null;
      const hit = identityIndex.get(identity);
      return hit ? { nodeId: hit.nodeId, reason: 'same-exit' } : null;
    },
    // 读明细。读不出来（文件缺失、被截断、JSON 坏）一律返回 null，不抛：
    // 抛出去会顺着调用方一路上浮，一份坏文件就能让整个聚合接口瘫痪，
    // 而调用方本来就得处理"取不到明细"这种正常情况。
    //
    // 自愈必须在这一层，不能只在某一条 HTTP 路由里做：只要还有一个调用方忘了走那个
    // 包装，"同一份坏文件、脚本机能读、网页改绑不动"这类不一致就会重新出现。
    // 回调在 createStore 时注入（原始 HTML/CSV 的解析器由 server 选，store 不依赖任何解析器），
    // 内部所有读明细的地方都用它；调用方仍可临时传别的重建逻辑覆盖。
    // 显式传 null 表示"只做纯读取"：启动期的重解析循环靠这个避免读的时候顺手改写，
    // 反而掩盖了接下来要报的解析失败。
    detail(id, rebuilder = rebuild || null) {
      if (!database.reports.some(report => report.id === id)) return null;
      // 明细缓存。/api/stats 要逐份读盘并在此之上跑 summarize / reportCoverage /
      // assessPriority，单份约 1.4ms 读盘 + 2.7ms 计算；而看板每次请求对每个启用节点
      // 读最近 5 份。报告多起来之后，同一份明细会被反复读、反复算。
      // 这里只缓存"读盘 + JSON.parse"这一层（纯函数，1.4ms/份），
      // 上层的计算结果不放进来 —— summarize 的产物比明细本身还大，内存换不来多少。
      //
      // 上限是必需的：实测解析后的明细约占磁盘的 2 倍（磁盘 138KB → 堆 258KB），
      // 不设限的话报告越多堆吃得越多。满了按最久未用淘汰。
      //
      // 注意上限必须容得下典型工作集，否则 LRU 会 100% miss 且每次插入都白淘汰一次，
      // 比不开缓存更慢。
      const cached = detailCache.get(id);
      if (cached) {
        // 命中最新的那份要刷新顺序（Map 保留插入序，重插即挪到末尾）
        detailCache.delete(id);
        detailCache.set(id, cached);
        return cached;
      }
      let result;
      try {
        result = JSON.parse(readFileSync(detailPath(id), 'utf8'));
      } catch {
        if (typeof rebuilder !== 'function') return null;
        let healed;
        try {
          healed = rebuilder(database.reports.find(report => report.id === id));
        } catch {
          return null;
        }
        if (!healed) return null;
        try {
          writeAtomic(detailPath(id), JSON.stringify(healed));
          persist({ ...database, reports: database.reports.map(report => report.id === id ? toIndex(healed) : report) });
        } catch {
          // 落盘失败不该让这次读取失败：内存里这份是好的，先返回给调用方
        }
        result = healed;
      }
      detailCache.set(id, result);
      while (detailCache.size > detailCacheLimit) detailCache.delete(detailCache.keys().next().value);
      return result;
    },
    // 明细变了就丢缓存。move / refreshReports 会改写落盘的文件，
    // 但如果不清缓存，下一次 detail() 会把改之前的对象原样返回 ——
    // 调用方（改绑接口）读到的 nodeId 与库里对不上。
    invalidateDetail(id) { detailCache.delete(id); },
    // 缓存里放的是**共享对象**，返回给多个调用方。约定：拿到 detail() 的结果一律只读，
    // 需要改动就走 move / refreshReports（它们负责同步更新缓存）。
    // 这条约定目前成立：summarize / reportCoverage / aggregate / compareReports /
    // assessPriority 都只读取，唯一原地改写的是 move 自己（改完同步写回缓存）。
    // 哪天出现新的原地修改者，必须在这里一并更新缓存，否则缓存会变成脏读来源。
    cachedDetailCount() { return detailCache.size; },
    // 明细取不到时，是"文件没了"还是"内容坏了"——前者可能是误删/迁移不全，后者要重新解析。
    // detail 加了自愈之后服务端不再需要它来分流，保留给排障与测试用。
    detailError(id) {
      if (!database.reports.some(report => report.id === id)) return 'missing-index';
      try {
        JSON.parse(readFileSync(detailPath(id), 'utf8'));
        return '';
      } catch (error) {
        return error.code === 'ENOENT' ? 'missing-file' : error.message;
      }
    },
    // 导入时的归属建议：优先沿用「同出口报告上次归到的节点」（出口记忆），
    // 其次沿用最近一次导入的节点。探针 metadata 无节点 IP/ASN 可匹配，
    // 只能靠用户自己的归档历史学习。
    suggestNode(identity) {
      if (identity) {
        const hit = identityIndex.get(identity);
        if (hit) return { nodeId: hit.nodeId, reason: 'same-exit' };
      }
      const last = database.reports[database.reports.length - 1];
      if (last) return { nodeId: last.nodeId, reason: 'recent' };
      return null;
    },
    // 改绑：只动归属，报告内容与历史关系保持不变
    move(id, nodeId) {
      if (!database.reports.some(report => report.id === id)) throw businessError('报告不存在');
      if (!database.nodes.some(node => node.id === nodeId)) throw businessError('节点不存在，请重新选择');
      // 用注入的重建回调而不是纯读取：明细坏掉时，改绑不该因为「自愈是网页读详情那条路的事」
      // 而失败 —— 否则同一份数据点开能看、改绑却说读不出来
      const detail = this.detail(id, rebuild || null);
      if (!detail) throw businessError('报告明细缺失，无法改绑');
      // 空操作也要回明细，不能回索引条目：索引里没有 records / sections，
      // server 的 summary() 会按明细算 sectionCounts，拿到索引直接抛
      // （曾经就是这样：改绑到当前节点必崩，只是被顶层「一律 400」的 catch 盖住了）
      if (detail.nodeId === nodeId) return detail;
      detail.nodeId = nodeId;
      writeFileSync(`${detailPath(id)}.tmp`, JSON.stringify(detail));
      renameSync(`${detailPath(id)}.tmp`, detailPath(id));
      // 缓存里那份是刚才 detail() 返回的同一个对象，改的就是它；
      // 这里再写一次是防御性的：万一将来 move 换成不走缓存的读法，也不会留下过期项
      detailCache.set(id, detail);
      persist({ ...database, nodes: enableNode(nodeId), reports: database.reports.map(report => report.id === id ? { ...report, nodeId } : report) });
      return detail;
    },
    // 解析规则升级后批量替换已归档报告的明细（归属、来源信息由调用方带回），索引只写一次
    refreshReports(reports) {
      const byId = new Map(reports.map(report => [report.id, report]));
      // 换的是解析结果，缓存里的旧对象必须逐份替换，否则重解析后读到的还是旧规则的结果
      for (const report of reports) { writeAtomic(detailPath(report.id), JSON.stringify(report)); detailCache.set(report.id, report); }
      persist({ ...database, reports: database.reports.map(item => byId.has(item.id) ? toIndex(byId.get(item.id)) : item) });
    },
    refreshPending(entries) {
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      persist({ ...database, pending: database.pending.map(item => byId.get(item.id) || item) });
    },
    // 原始文件：链接导入的是 HTML，脚本直传的是 CSV（rawExt 记在报告里）
    raw(id) {
      const ext = database.reports.find(report => report.id === id)?.rawExt || 'html';
      return { content: readFileSync(rawPath(id, ext), 'utf8'), ext };
    },
    // 顺序与新增相反：先把条目从索引里摘掉，再删附属文件。
    // 先删文件的话，删成功而写索引失败会留下"列表里还在、点开就 404"的僵尸报告，
    // 内容已经不可恢复；反过来最多留几个没人引用的孤儿文件，可以回收。
    remove(id) {
      if (!database.reports.some(report => report.id === id)) throw businessError('报告不存在');
      // 先摘缓存再删文件：留下的条目会占着内存，而它的内容已经不可恢复
      detailCache.delete(id);
      persist({ ...database, reports: database.reports.filter(report => report.id !== id) });
      for (const path of [detailPath(id), rawPath(id, 'html'), rawPath(id, 'csv')]) {
        try { unlinkSync(path); } catch { /* 可能本来就不存在，忽略 */ }
      }
    }
  };
}
