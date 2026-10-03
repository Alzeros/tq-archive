import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
