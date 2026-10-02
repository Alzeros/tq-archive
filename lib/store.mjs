import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function emptyDatabase() {
  return { version: 2, nodes: [], reports: [], syncedAt: null };
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
  mkdirSync(rawDirectory, { recursive: true });
  mkdirSync(detailDirectory, { recursive: true });
  const filename = join(directory, 'database.json');
  let database = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : emptyDatabase();
  if (!Array.isArray(database.reports) || !Array.isArray(database.nodes)) database = emptyDatabase();

  function persist(next) {
    writeFileSync(`${filename}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${filename}.tmp`, filename);
    database = next;
  }
  const detailPath = id => join(detailDirectory, `${id}.json`);

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
      if (existing) throw new Error(`报告已导入到「${database.nodes.find(node => node.id === existing.nodeId)?.name || existing.nodeId}」，请勿重复导入`);
      const report = { ...parsed, id: randomUUID(), nodeId };
      writeFileSync(join(rawDirectory, `${report.id}.html`), html);
      writeFileSync(`${detailPath(report.id)}.tmp`, JSON.stringify(report));
      renameSync(`${detailPath(report.id)}.tmp`, detailPath(report.id));
      persist({ ...database, reports: [...database.reports, toIndex(report)] });
      return report;
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
    raw(id) { return readFileSync(join(rawDirectory, `${id}.html`), 'utf8'); },
    // 明细与原始 HTML 分离后，删除必须一并清理附属文件，否则会留下无法回收的孤儿文件。
    remove(id) {
      if (!database.reports.some(report => report.id === id)) throw new Error('报告不存在');
      for (const path of [detailPath(id), join(rawDirectory, `${id}.html`)]) {
        try { unlinkSync(path); } catch { /* 文件可能已不存在，忽略 */ }
      }
      persist({ ...database, reports: database.reports.filter(report => report.id !== id) });
    }
  };
}
