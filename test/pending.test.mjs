import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

// 一键接受全部推荐：多台机器 × 每周一次，逐台点"绑定"是纯重复劳动。
// 但批量操作最容易出的事就是替用户猜归属，所以没有记忆的条目必须原地不动。
test('批量接受推荐只动有同出口记忆的条目，没记忆的留给人决定', () => {
  const { store } = setup();
  const known = '11111111-1111-4111-8111-111111111111';
  const unknown = '22222222-2222-4222-8222-222222222222';
  // 先让 'a' 记住 vps 这个出口
  store.addPending(entry(ID), csv);
  store.bindPending(ID, 'a', parsed(), csv);

  store.addPending({ ...entry(known), fingerprint: 'fk' }, csv);
  store.addPending({ ...entry(unknown, '另一台 · 198.51.100.1'), fingerprint: 'fu' }, csv);
  const bound = [];
  const skipped = [];
  for (const item of store.database.pending) {
    const suggestion = store.rememberedNode(item.identity);
    if (!suggestion) { skipped.push(item.id); continue; }
    store.bindPending(item.id, suggestion.nodeId, { ...parsed(item.id, item.identity), fingerprint: `bound-${item.id}` }, store.pendingCsv(item.id));
    bound.push(item.id);
  }
  assert.deepEqual(bound, [known], '只有有记忆的那份被自动归档');
  assert.deepEqual(skipped, [unknown], '没记忆的必须留给人决定：批量猜错会成批绑错');
  assert.equal(store.database.pending.length, 1);
  assert.equal(store.database.pending[0].id, unknown);
  assert.equal(store.database.reports.find(report => report.sourceUrl === `csv:${known}`).nodeId, 'a');
});

test('批量绑定中一条失败不影响其余条目', () => {
  const { directory, store } = setup();
  store.addPending(entry(ID), csv);
  store.bindPending(ID, 'a', parsed(), csv);
  const brokenId = '33333333-3333-4333-8333-333333333333';
  const goodId = '44444444-4444-4444-8444-444444444444';
  store.addPending({ ...entry(brokenId), fingerprint: 'fb' }, csv);
  store.addPending({ ...entry(goodId), fingerprint: 'fg' }, csv);
  // 第一份的源文件丢了：这一条会失败，但不能让后面那条也卡住
  rmSync(join(directory, 'csv-pool', `${brokenId}.csv`), { force: true });
  assert.equal(store.pendingCsv(brokenId), null);

  const failed = [];
  const bound = [];
  for (const item of store.database.pending) {
    const suggestion = store.rememberedNode(item.identity);
    if (!suggestion) continue;
    const source = store.pendingCsv(item.id);
    if (source === null) { failed.push(item.id); continue; } // 与 server 的 bindOne 同分支
    store.bindPending(item.id, suggestion.nodeId, { ...parsed(item.id, item.identity), fingerprint: `bound-${item.id}` }, source);
    bound.push(item.id);
  }
  assert.deepEqual(bound, [goodId], '坏的那条不能拖住好的那条');
  assert.deepEqual(failed, [brokenId]);
  assert.equal(store.database.pending.length, 1, '失败的条目仍留在队列里，等用户丢弃');
  assert.equal(store.database.pending[0].id, brokenId);
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
