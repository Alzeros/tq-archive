import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { parseReport } from '../lib/parser.mjs';

const html = readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8');
const freshStore = () => createStore(mkdtempSync(join(tmpdir(), 'tq-store-')));
const node = (id, extra = {}) => ({ id, name: `节点-${id}`, region: '', hidden: false, order: 0, ...extra });

test('索引只存元数据，明细与原始 HTML 单独落盘', () => {
  const store = freshStore();
  store.sync([node('a')]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM'), html);
  const index = store.database.reports[0];
  assert.equal(index.id, report.id);
  assert.equal(index.records, undefined, '索引不应包含 records');
  assert.equal(index.rawRows, undefined, '索引不应包含 rawRows');
  assert.ok(index.recordCount > 0);
  assert.ok(index.sectionCounts.ipv4 > 0, '索引应保留各维度条数供列表展示');
  const detail = store.detail(report.id);
  assert.equal(detail.records.length, report.records.length);
  assert.ok(detail.rawRows.ipv4);
});

test('detail 可还原完整记录，供详情页与对比使用', () => {
  const store = freshStore();
  store.sync([node('a')]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/x1'), html);
  const detail = store.detail(report.id);
  assert.ok(detail.records.find(record => record.section === 'ipv4' && record.target === '江苏' && record.carrier === '电信'));
  assert.equal(store.raw(report.id), html);
});

test('同一链接或同一内容重复导入被拒绝', () => {
  const store = freshStore();
  store.sync([node('a')]);
  store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/dup'), html);
  assert.throws(() => store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/dup'), html), /请勿重复导入/);
  assert.throws(() => store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/other'), html), /请勿重复导入/, '内容相同即视为重复');
});

test('导入到不存在的节点被拒绝', () => {
  const store = freshStore();
  store.sync([node('a')]);
  assert.throws(() => store.insert('ghost', parseReport(html, 'https://tcpquality.ibsgss.uk/r/x'), html), /节点不存在/);
});

test('同步保留已归档节点的名称，不退化成 uuid', () => {
  const store = freshStore();
  store.sync([node('a'), node('b')]);
  store.sync([node('a', { name: 'a' })]);
  const a = store.database.nodes.find(item => item.id === 'a');
  const b = store.database.nodes.find(item => item.id === 'b');
  assert.equal(a.name, '节点-a', '应沿用上次同步到的名称');
  assert.equal(a.archived, false);
  assert.equal(b.name, '节点-b');
  assert.equal(b.archived, true, '本次未返回的节点应标记为已归档');
});

test('删除报告同时清理索引与附属文件', () => {
  const store = freshStore();
  store.sync([node('a')]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/del'), html);
  store.remove(report.id);
  assert.equal(store.database.reports.length, 0);
  assert.equal(store.detail(report.id), null);
  assert.throws(() => store.raw(report.id), /ENOENT/);
  assert.throws(() => store.remove(report.id), /报告不存在/);
});

test('已归档节点仍可作为导入归属', () => {
  const store = freshStore();
  store.sync([node('a')]);
  store.sync([]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/arch'), html);
  assert.equal(store.detail(report.id).nodeId, 'a');
});

test('空目录首次创建即可用', () => {
  const store = freshStore();
  assert.deepEqual(store.database.reports, []);
  assert.deepEqual(store.database.nodes, []);
  assert.equal(store.database.syncedAt, null);
});

test('v1 内联索引自动迁移为明细文件，且可重复启动', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-migrate-'));
  const legacy = { version: 1, nodes: [node('a')], reports: [], syncedAt: null };
  const report = { ...parseReport(html, 'https://tcpquality.ibsgss.uk/r/legacy'), id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nodeId: 'a' };
  legacy.reports.push(report);
  writeFileSync(join(directory, 'database.json'), JSON.stringify(legacy));
  // raw/ 由 createStore 创建，需在其后写入
  const migrated = createStore(directory);
  writeFileSync(join(directory, 'raw', `${report.id}.html`), html);

  assert.equal(migrated.database.version, 2);
  assert.equal(migrated.database.reports[0].records, undefined, '迁移后索引不应再内联 records');
  assert.equal(migrated.detail(report.id).records.length, report.records.length, '明细应完整可取');
  assert.equal(migrated.raw(report.id), html, '迁移不应影响原始 HTML');
  const again = createStore(directory);
  assert.equal(again.database.reports.length, 1, '重复启动不应产生重复报告');
  assert.equal(again.detail(report.id).records.length, report.records.length);
});

test('索引体积远小于明细，避免写入随报告数膨胀', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-size-'));
  const store = createStore(directory);
  store.sync([node('a')]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/size'), html);
  const indexSize = statSync(join(directory, 'database.json')).size;
  const detailSize = statSync(join(directory, 'reports', `${report.id}.json`)).size;
  assert.ok(detailSize > indexSize * 5, `索引应远小于明细，实测 index=${indexSize} detail=${detailSize}`);
});
