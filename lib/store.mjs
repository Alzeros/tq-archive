import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

export function createStore(directory) {
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

  function persist(next) {
    writeFileSync(`${filename}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${filename}.tmp`, filename);
    database = next;
  }
  const detailPath = id => join(detailDirectory, `${id}.json`);
  const rawPath = (id, ext) => join(rawDirectory, `${id}.${ext}`);
  const poolPath = id => join(poolDirectory, `${id}.csv`);
  const nodeName = id => database.nodes.find(node => node.id === id)?.name || id;
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

  return {
    get database() { return database; },
    sync(nodes) {
      // 已归档节点可能已从探针消失，或本次读不到 metadata。
      // 此时沿用上次同步到的名称，避免节点在界面上退化成裸 uuid。
      const retained = new Map(database.nodes.map(node => [node.id, node]));
      const merged = nodes.map(node => {
        const previous = retained.get(node.id);
        if (!previous) return { ...node, archived: false };
        retained.delete(node.id);
        const name = node.name && node.name !== node.id ? node.name : previous.name;
        return { ...previous, ...node, name, region: node.region || previous.region, order: node.order || previous.order, archived: false };
      });
      persist({ ...database, syncedAt: new Date().toISOString(), nodes: [...merged, ...[...retained.values()].map(node => ({ ...node, archived: true }))] });
    },
    insert(nodeId, parsed, html) {
      if (!database.nodes.some(node => node.id === nodeId)) throw new Error('节点不存在，请重新选择');
      const existing = database.reports.find(report => report.sourceUrl === parsed.sourceUrl || report.fingerprint === parsed.fingerprint);
      if (existing) throw new Error(`报告已导入到「${nodeName(existing.nodeId)}」，请勿重复导入`);
      const report = { ...parsed, id: randomUUID(), nodeId };
      writeFileSync(rawPath(report.id, 'html'), html);
      writeAtomic(detailPath(report.id), JSON.stringify(report));
      persist({ ...database, reports: [...database.reports, toIndex(report)] });
      return report;
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
    pendingCsv(id) {
      if (!database.pending.some(item => item.id === id)) return null;
      return readFileSync(poolPath(id), 'utf8');
    },
    // 绑定 = 新增报告 + 移出队列，合并成一次索引写入：中途崩溃也不会出现"两边都有"或"两边都没有"
    bindPending(id, nodeId, parsed, csv) {
      if (!database.pending.some(item => item.id === id)) throw new Error('待绑定记录不存在，可能已被处理');
      if (!database.nodes.some(node => node.id === nodeId)) throw new Error('节点不存在，请重新选择');
      const existing = database.reports.find(report => report.fingerprint === parsed.fingerprint);
      if (existing) throw new Error(`这份数据已归档到「${nodeName(existing.nodeId)}」，可直接丢弃`);
      const report = { ...parsed, id: randomUUID(), nodeId, rawExt: 'csv' };
      writeFileSync(rawPath(report.id, 'csv'), csv);
      writeAtomic(detailPath(report.id), JSON.stringify(report));
      persist({ ...database, reports: [...database.reports, toIndex(report)], pending: database.pending.filter(item => item.id !== id) });
      try { unlinkSync(poolPath(id)); } catch { /* 已移入 raw/，残留文件下次启动会被当作孤儿重新排队，这里尽量删干净 */ }
      return report;
    },
    removePending(id) {
      if (!database.pending.some(item => item.id === id)) throw new Error('待绑定记录不存在，可能已被处理');
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
      const hit = [...database.reports].reverse().find(report => report.identity === identity);
      return hit ? { nodeId: hit.nodeId, reason: 'same-exit' } : null;
    },
    detail(id) {
      if (!database.reports.some(report => report.id === id)) return null;
      const path = detailPath(id);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    // 导入时的归属建议：优先沿用「同出口报告上次归到的节点」（出口记忆），
    // 其次沿用最近一次导入的节点。探针 metadata 无节点 IP/ASN 可匹配，
    // 只能靠用户自己的归档历史学习。
    suggestNode(identity) {
      if (identity) {
        const hit = [...database.reports].reverse().find(report => report.identity && report.identity === identity);
        if (hit) return { nodeId: hit.nodeId, reason: 'same-exit' };
      }
      const last = database.reports[database.reports.length - 1];
      if (last) return { nodeId: last.nodeId, reason: 'recent' };
      return null;
    },
    // 改绑：只动归属，报告内容与历史关系保持不变
    move(id, nodeId) {
      if (!database.reports.some(report => report.id === id)) throw new Error('报告不存在');
      if (!database.nodes.some(node => node.id === nodeId)) throw new Error('节点不存在，请重新选择');
      const detail = this.detail(id);
      if (!detail) throw new Error('报告明细缺失，无法改绑');
      if (detail.nodeId === nodeId) return this.database.reports.find(report => report.id === id);
      detail.nodeId = nodeId;
      writeFileSync(`${detailPath(id)}.tmp`, JSON.stringify(detail));
      renameSync(`${detailPath(id)}.tmp`, detailPath(id));
      persist({ ...database, reports: database.reports.map(report => report.id === id ? { ...report, nodeId } : report) });
      return detail;
    },
    // 解析规则升级后批量替换已归档报告的明细（归属、来源信息由调用方带回），索引只写一次
    refreshReports(reports) {
      const byId = new Map(reports.map(report => [report.id, report]));
      for (const report of reports) writeAtomic(detailPath(report.id), JSON.stringify(report));
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
    // 明细与原始文件分离后，删除必须一并清理附属文件，否则会留下无法回收的孤儿文件。
    remove(id) {
      if (!database.reports.some(report => report.id === id)) throw new Error('报告不存在');
      for (const path of [detailPath(id), rawPath(id, 'html'), rawPath(id, 'csv')]) {
        try { unlinkSync(path); } catch { /* 文件可能已不存在，忽略 */ }
      }
      persist({ ...database, reports: database.reports.filter(report => report.id !== id) });
    }
  };
}
