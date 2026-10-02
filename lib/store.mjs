import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(directory) {
  mkdirSync(join(directory, 'raw'), { recursive: true });
  const filename = join(directory, 'database.json');
  let database = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : { version: 1, nodes: [], reports: [], syncedAt: null };
  function persist(next) {
    writeFileSync(`${filename}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${filename}.tmp`, filename);
    database = next;
  }
  return {
    get database() { return database; },
    sync(nodes) {
      const incoming = new Set(nodes.map(node => node.id));
      persist({ ...database, syncedAt: new Date().toISOString(), nodes: [...nodes.map(node => ({ ...node, archived: false })), ...database.nodes.filter(node => !incoming.has(node.id)).map(node => ({ ...node, archived: true }))] });
    },
    insert(nodeId, parsed, html) {
      if (!database.nodes.some(node => node.id === nodeId)) throw new Error('节点不存在，请重新选择');
      const existing = database.reports.find(report => report.sourceUrl === parsed.sourceUrl || report.fingerprint === parsed.fingerprint);
      if (existing) throw new Error(`报告已导入到「${database.nodes.find(node => node.id === existing.nodeId)?.name || existing.nodeId}」，请勿重复导入`);
      const report = { ...parsed, id: randomUUID(), nodeId };
      writeFileSync(join(directory, 'raw', `${report.id}.html`), html);
      persist({ ...database, reports: [...database.reports, report] });
      return report;
    },
    raw(id) { return readFileSync(join(directory, 'raw', `${id}.html`), 'utf8'); }
  };
}
