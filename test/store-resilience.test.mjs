import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync, truncateSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';

// 这一组测的都是"存储层出问题时不把整个应用带下水"：
// 附属文件被删、被截断、写到一半断电，都不该让服务起不来或让接口 500。

const makeStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tq-resilience-'));
  return { dir, store: createStore(dir) };
};
const sampleReport = {
  sourceUrl: 'https://example.test/r/abc', testedAt: '2026-10-01T10:00:00+08:00', importedAt: '2026-10-01T02:00:00.000Z',
  fingerprint: 'fp1', sections: [{ id: 'ipv4', name: 'IPv4 回程' }], warnings: [], rawRows: { ipv4: [['x']] },
  records: [{ key: 'k1', section: 'ipv4', group: 'g', target: '河北', carrier: '电信', metrics: { latency: { value: 30, unit: 'ms', status: 'ok', raw: '30ms' } } }]
};

test('池文件丢失时 pendingCsv 返回 null，不抛异常', () => {
  const { dir, store } = makeStore();
  store.addPending({ id: '11111111-1111-4111-8111-111111111111', receivedAt: '2026-10-01T00:00:00.000Z', testedAt: '2026-10-01T08:00:00+08:00' }, '网络,IP版本\n');
  rmSync(join(dir, 'csv-pool', '11111111-1111-4111-8111-111111111111.csv'));
  // 抛出去的话，server 启动流程（模块加载期）会直接退出，且条目还在库里，
  // 导致之后每次重启都同样崩掉，只能手工改 database.json
  assert.equal(store.pendingCsv('11111111-1111-4111-8111-111111111111'), null);
  assert.equal(store.pendingCsv('22222222-2222-4222-8222-222222222222'), null, '记录不存在也是 null');
});

test('可以标记源文件已丢失的待绑定条目', () => {
  const { store } = makeStore();
  const id = '33333333-3333-4333-8333-333333333333';
  store.addPending({ id, receivedAt: '2026-10-01T00:00:00.000Z' }, 'x');
  store.markPendingBroken([id]);
  assert.equal(store.database.pending[0].broken, true);
  assert.equal(store.database.pending.length, 1, '标记不等于删除，仍然能在界面上看到并丢弃');
});

test('明细被截断时 detail 返回 null 而不是抛错，detailError 说明原因', () => {
  const { dir, store } = makeStore();
  const node = { id: 'n1', name: '甲', region: 'HK', enabled: true };
  store.sync([node]);
  const report = store.insert('n1', sampleReport, '<html></html>');
  const path = join(dir, 'reports', `${report.id}.json`);
  truncateSync(path, 20);
  // 直接抛的话，/api/stats 会对着所有 key 返回 400：一份坏文件瘫痪整个聚合接口
  assert.equal(store.detail(report.id), null);
  assert.notEqual(store.detailError(report.id), '', '要能区分"文件坏了"与"记录不存在"');
  assert.equal(store.detailError('44444444-4444-4444-8444-444444444444'), 'missing-index');
});

test('明细文件被删时 detailError 报 missing-file', () => {
  const { dir, store } = makeStore();
  store.sync([{ id: 'n1', name: '甲', region: 'HK', enabled: true }]);
  const report = store.insert('n1', sampleReport, '<html></html>');
  rmSync(join(dir, 'reports', `${report.id}.json`));
  assert.equal(store.detail(report.id), null);
  assert.equal(store.detailError(report.id), 'missing-file');
});

test('删除报告先摘索引再删文件：不会留下指向已删内容的僵尸条目', () => {
  const { dir, store } = makeStore();
  store.sync([{ id: 'n1', name: '甲', region: 'HK', enabled: true }]);
  const report = store.insert('n1', sampleReport, '<html></html>');
  store.remove(report.id);
  assert.equal(store.database.reports.length, 0, '索引里必须已经不在了');
  assert.equal(store.detail(report.id), null);
});

test('v1 库升级时缺明细文件不会让 createStore 抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tq-resilience-v1-'));
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'database.json'), JSON.stringify({
    version: 1,
    nodes: [{ id: 'n1', name: '甲', region: 'HK' }],
    reports: [{ ...sampleReport, id: '55555555-5555-4555-8555-555555555555', nodeId: 'n1', parserVersion: 1 }],
    syncedAt: null
  }));
  const store = createStore(dir);
  assert.equal(store.database.version, 2);
  assert.equal(store.database.reports[0].recordCount, 1, '内联明细应被拆到独立文件并重建索引');
  assert.ok(store.detail('55555555-5555-4555-8555-555555555555'), '升级后明细应可读');
});

test('写到一半的临时文件不会被当成明细读出来', () => {
  const { dir, store } = makeStore();
  store.sync([{ id: 'n1', name: '甲', region: 'HK', enabled: true }]);
  const report = store.insert('n1', sampleReport, '<html></html>');
  // writeAtomic 的中间态：.tmp 存在而正式文件缺失
  renameSync(join(dir, 'reports', `${report.id}.json`), join(dir, 'reports', `${report.id}.json.tmp`));
  assert.equal(store.detail(report.id), null);
  assert.equal(store.detailError(report.id), 'missing-file');
});
