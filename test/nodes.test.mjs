import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { parseReport } from '../lib/parser.mjs';
import { parseTqCsv, csvFingerprint } from '../lib/csv-parser.mjs';

const html = readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8');
const csv = readFileSync(new URL('./fixtures/tq-ipv4.csv', import.meta.url), 'utf8');
const node = id => ({ id, name: `城市-${id}`, region: '', order: 0 });
const directory = () => mkdtempSync(join(tmpdir(), 'tq-nodes-'));
const enabledOf = store => Object.fromEntries(store.database.nodes.map(item => [item.id, item.enabled]));

test('旧库没有启用字段：有报告的节点默认启用，其余停用并落盘', () => {
  const dir = directory();
  const report = { ...parseReport(html, 'https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM'), id: 'r1', nodeId: 'a' };
  const { records, rawRows, ...index } = report;
  writeFileSync(join(dir, 'database.json'), JSON.stringify({ version: 2, nodes: [node('a'), node('b')], reports: [{ ...index, recordCount: records.length, sectionCounts: {} }], syncedAt: null }));
  const store = createStore(dir);
  assert.deepEqual(enabledOf(store), { a: true, b: false });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'database.json'), 'utf8')).nodes.map(item => item.enabled), [true, false]);
});

test('首次同步全部启用；之后探针新增的节点默认停用，已有节点保留原状态', () => {
  const store = createStore(directory());
  store.sync([node('a'), node('b')]);
  assert.deepEqual(enabledOf(store), { a: true, b: true });
  store.setNodesEnabled(['b'], false);
  store.sync([node('a'), node('b'), node('c')]);
  assert.deepEqual(enabledOf(store), { a: true, b: false, c: false });
});

test('批量设置启用状态；包含不存在的节点时整体拒绝', () => {
  const store = createStore(directory());
  store.sync([node('a'), node('b')]);
  store.setNodesEnabled(['a', 'b'], false);
  assert.deepEqual(enabledOf(store), { a: false, b: false });
  assert.throws(() => store.setNodesEnabled(['a', 'missing'], true), /节点不存在/);
  assert.deepEqual(enabledOf(store), { a: false, b: false }, '失败时不应部分生效');
});

test('往停用的节点导入、绑定或改绑报告时自动启用它', () => {
  const store = createStore(directory());
  store.sync([node('a'), node('b'), node('c')]);
  store.setNodesEnabled(['a', 'b', 'c'], false);
  // 链接导入
  const linked = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM'), html);
  // 直传绑定
  const id = '0b5c3a3e-1111-4222-8333-944455556666';
  store.addPending({ id, identity: '', testedAt: '2026-10-04T01:02:27+08:00', fingerprint: csvFingerprint(csv) }, csv);
  store.bindPending(id, 'b', parseTqCsv(csv, { sourceUrl: `csv:${id}`, testedAt: '2026-10-04T01:02:27+08:00' }), csv);
  assert.deepEqual(enabledOf(store), { a: true, b: true, c: false });
  // 改绑
  store.move(linked.id, 'c');
  assert.equal(enabledOf(store).c, true);
});

test('removeNode 仅允许删除探针已移除节点，且有报告时必须传 cascade 才级联删除索引、缓存与磁盘文件', () => {
  const dir = directory();
  const store = createStore(dir);
  store.sync([node('active'), node('dead-empty'), node('dead-with-data')]);
  const r1 = store.insert('active', parseReport(html, 'https://tcpquality.ibsgss.uk/r/node-act-1'), html);
  const deadHtml = { ...parseReport(html, 'https://tcpquality.ibsgss.uk/r/node-dead-1'), fingerprint: 'dead-html-fp', testedAt: '2026-10-05T08:00:00+08:00', identity: 'AS999 Dead Node IP: 9.9.9.9' };
  const r2 = store.insert('dead-with-data', deadHtml, html);
  const pid = '0b5c3a3e-2222-4222-8333-944455557777';
  store.addPending({ id: pid, identity: 'AS999 Dead Node IP: 9.9.9.9', testedAt: '2026-10-06T08:00:00+08:00', fingerprint: csvFingerprint(csv) }, csv);
  const r3 = store.bindPending(pid, 'dead-with-data', { ...parseTqCsv(csv, { sourceUrl: `csv:${pid}`, testedAt: '2026-10-06T08:00:00+08:00' }), identity: 'AS999 Dead Node IP: 9.9.9.9' }, csv);

  // 预热缓存并确认磁盘文件存在
  assert.ok(store.detail(r2.id));
  assert.ok(store.detail(r3.id));
  assert.ok(existsSync(join(dir, 'reports', `${r2.id}.json`)));
  assert.ok(existsSync(join(dir, 'raw', `${r2.id}.html`)));
  assert.ok(existsSync(join(dir, 'reports', `${r3.id}.json`)));
  assert.ok(existsSync(join(dir, 'raw', `${r3.id}.csv`)));
  assert.equal(store.rememberedNode('AS999 Dead Node IP: 9.9.9.9')?.nodeId, 'dead-with-data');

  // 仅同步保留 active，另外两台变为探针已移除（archived: true），但历史报告仍保留
  store.sync([node('active')]);
  assert.equal(store.node('active').archived, false);
  assert.equal(store.node('dead-empty').archived, true);
  assert.equal(store.node('dead-with-data').archived, true);
  assert.equal(store.reportsOfNode('dead-with-data').length, 2);

  // 拒绝不存在的节点与仍在探针中的活跃节点
  assert.throws(() => store.removeNode('missing'), /节点不存在/);
  assert.throws(() => store.removeNode('active', { cascade: true }), /仍在探针列表中/);

  // 删除无报告的已移除节点成功
  const resEmpty = store.removeNode('dead-empty');
  assert.equal(resEmpty.removedReports, 0);
  assert.equal(store.node('dead-empty'), null);

  // 删除有报告的已移除节点：未传 cascade 拒绝且数据完好
  assert.throws(() => store.removeNode('dead-with-data'), /还有 2 份历史报告/);
  assert.equal(store.node('dead-with-data').archived, true);
  assert.equal(store.reportsOfNode('dead-with-data').length, 2);

  // 传入 cascade: true 彻底级联清理节点、索引、缓存、磁盘文件和出口记忆
  const resCascade = store.removeNode('dead-with-data', { cascade: true });
  assert.equal(resCascade.removedReports, 2);
  assert.equal(store.node('dead-with-data'), null);
  assert.equal(store.reportsOfNode('dead-with-data').length, 0);
  assert.equal(store.detail(r2.id), null);
  assert.equal(store.detail(r3.id), null);
  assert.equal(existsSync(join(dir, 'reports', `${r2.id}.json`)), false);
  assert.equal(existsSync(join(dir, 'raw', `${r2.id}.html`)), false);
  assert.equal(existsSync(join(dir, 'reports', `${r3.id}.json`)), false);
  assert.equal(existsSync(join(dir, 'raw', `${r3.id}.csv`)), false);
  assert.equal(store.rememberedNode('AS999 Dead Node IP: 9.9.9.9'), null);

  // 不影响其他节点及其报告，重新加载落盘一致
  assert.ok(store.detail(r1.id));
  const reloaded = createStore(dir);
  assert.deepEqual(reloaded.database.nodes.map(n => n.id), ['active']);
  assert.deepEqual(reloaded.database.reports.map(r => r.id), [r1.id]);
});

test('removeEmptyArchivedNodes 只清理无报告的已移除节点，保留活跃空节点与有数据已移除节点', () => {
  const dir = directory();
  const store = createStore(dir);
  store.sync([node('act-empty'), node('arch-empty-1'), node('arch-empty-2'), node('arch-data')]);
  store.insert('arch-data', parseReport(html, 'https://tcpquality.ibsgss.uk/r/keep-arch-data'), html);
  store.sync([node('act-empty')]);

  // 按指定范围先清理其中一个
  const partial = store.removeEmptyArchivedNodes(['arch-empty-1', 'arch-data', 'act-empty']);
  assert.deepEqual(partial.removedIds, ['arch-empty-1']);
  assert.equal(partial.removedCount, 1);
  assert.ok(store.node('act-empty'), '活跃空节点绝不能删');
  assert.ok(store.node('arch-data'), '有报告的已移除节点绝不能当空壳删');
  assert.ok(store.node('arch-empty-2'), '范围外的先不动');

  // 全部清理剩余无报告的已移除节点
  const rest = store.removeEmptyArchivedNodes();
  assert.deepEqual(rest.removedIds, ['arch-empty-2']);
  assert.deepEqual(store.database.nodes.map(n => n.id), ['act-empty', 'arch-data']);
});
