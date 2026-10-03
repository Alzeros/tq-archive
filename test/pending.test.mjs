import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { parseTqCsv, csvFingerprint } from '../lib/csv-parser.mjs';

const csv = readFileSync(new URL('./fixtures/tq-ipv4.csv', import.meta.url), 'utf8');
const node = id => ({ id, name: `节点-${id}`, region: '', order: 0 });
const ID = '0b5c3a3e-1111-4222-8333-944455556666';
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tq-pending-'));
  const store = createStore(directory);
  store.sync([node('a'), node('b')]);
  return { directory, store };
}
const entry = (id = ID, identity = 'vps · 203.0.113.7') => ({ id, identity, testedAt: '2026-10-04T01:02:27+08:00', fingerprint: csvFingerprint(csv) });
const parsed = (id = ID, identity = 'vps · 203.0.113.7') => parseTqCsv(csv, { sourceUrl: `csv:${id}`, testedAt: '2026-10-04T01:02:27+08:00', identity });

test('入队后原始 CSV 落在池目录，队列登记在索引里', () => {
  const { directory, store } = setup();
  store.addPending(entry(), csv);
  assert.equal(store.database.pending.length, 1);
  assert.equal(store.pendingCsv(ID), csv);
  assert.ok(existsSync(join(directory, 'csv-pool', `${ID}.csv`)));
});

test('同一份数据在队列中或已归档时都能被识别为重复', () => {
  const { store } = setup();
  store.addPending(entry(), csv);
  assert.equal(store.duplicateOf(csvFingerprint(csv)).kind, 'pending');
  store.bindPending(ID, 'a', parsed(), csv);
  const duplicate = store.duplicateOf(csvFingerprint(csv));
  assert.equal(duplicate.kind, 'report');
  assert.equal(duplicate.nodeName, '节点-a');
});

test('绑定生成正式报告：原始文件是 CSV，队列与池文件一并清理', () => {
  const { directory, store } = setup();
  store.addPending(entry(), csv);
  const report = store.bindPending(ID, 'a', parsed(), csv);
  assert.equal(store.database.pending.length, 0);
  assert.equal(existsSync(join(directory, 'csv-pool', `${ID}.csv`)), false);
  const index = store.database.reports[0];
  assert.equal(index.nodeId, 'a');
  assert.equal(index.sourceType, 'csv');
  assert.equal(index.rawExt, 'csv');
  assert.equal(index.recordCount, 93);
  assert.deepEqual(store.raw(report.id), { content: csv, ext: 'csv' });
  assert.equal(store.detail(report.id).records.length, 93);
});

test('绑定到不存在的节点时报错，队列保持原样', () => {
  const { store } = setup();
  store.addPending(entry(), csv);
  assert.throws(() => store.bindPending(ID, 'missing', parsed(), csv), /节点不存在/);
  assert.equal(store.database.pending.length, 1);
  assert.equal(store.database.reports.length, 0);
});

test('丢弃待绑定报告会删除池文件', () => {
  const { directory, store } = setup();
  store.addPending(entry(), csv);
  store.removePending(ID);
  assert.equal(store.database.pending.length, 0);
  assert.equal(existsSync(join(directory, 'csv-pool', `${ID}.csv`)), false);
  assert.throws(() => store.removePending(ID), /不存在/);
});

test('池目录里未登记的文件会被识别为孤儿，已登记的不会', () => {
  const { directory, store } = setup();
  store.addPending(entry(), csv);
  const orphan = '1c6d4b4f-2222-4333-8444-a55566667777';
  writeFileSync(join(directory, 'csv-pool', `${orphan}.csv`), csv);
  writeFileSync(join(directory, 'csv-pool', 'not-a-uuid.csv'), csv);
  assert.deepEqual(store.orphanPoolFiles().map(item => item.id), [orphan]);
});

test('删除直传报告时连同原始 CSV 一起删除', () => {
  const { directory, store } = setup();
  store.addPending(entry(), csv);
  const report = store.bindPending(ID, 'a', parsed(), csv);
  store.remove(report.id);
  assert.equal(existsSync(join(directory, 'raw', `${report.id}.csv`)), false);
  assert.equal(existsSync(join(directory, 'reports', `${report.id}.json`)), false);
});

test('只按同一台机器推荐归属，不回落到"最近导入的节点"', () => {
  const { store } = setup();
  store.addPending(entry(), csv);
  store.bindPending(ID, 'b', parsed(), csv);
  assert.deepEqual(store.rememberedNode('vps · 203.0.113.7'), { nodeId: 'b', reason: 'same-exit' });
  assert.equal(store.rememberedNode('另一台 · 198.51.100.1'), null);
  assert.equal(store.rememberedNode(''), null);
});

test('旧数据库没有队列字段时自动补齐，不影响已有报告', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-pending-'));
  writeFileSync(join(directory, 'database.json'), JSON.stringify({ version: 2, nodes: [node('a')], reports: [], syncedAt: null }));
  const store = createStore(directory);
  assert.deepEqual(store.database.pending, []);
  store.addPending(entry(), csv);
  assert.equal(JSON.parse(readFileSync(join(directory, 'database.json'), 'utf8')).pending.length, 1);
});

test('解析规则升级后可批量替换报告明细与待绑定条目，索引同步更新', () => {
  const { store } = setup();
  store.addPending(entry(), csv);
  const report = store.bindPending(ID, 'a', parsed(), csv);
  const upgraded = { ...store.detail(report.id), csvParserVersion: 99, records: store.detail(report.id).records.slice(0, 10) };
  store.refreshReports([upgraded]);
  assert.equal(store.database.reports[0].csvParserVersion, 99);
  assert.equal(store.database.reports[0].recordCount, 10);
  assert.equal(store.detail(report.id).records.length, 10);
  assert.equal(store.database.reports[0].nodeId, 'a', '归属不能因重新解析丢失');

  const other = '1c6d4b4f-2222-4333-8444-a55566667777';
  store.addPending({ ...entry(other), fingerprint: 'x' }, csv);
  store.refreshPending([{ ...entry(other), fingerprint: 'x', recordCount: 7 }]);
  assert.equal(store.database.pending[0].recordCount, 7);
});
