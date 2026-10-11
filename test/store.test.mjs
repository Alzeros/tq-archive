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
  assert.deepEqual(store.raw(report.id), { content: html, ext: 'html' });
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
  assert.equal(migrated.raw(report.id).content, html, '迁移不应影响原始 HTML');
  const again = createStore(directory);
  assert.equal(again.database.reports.length, 1, '重复启动不应产生重复报告');
  assert.equal(again.detail(report.id).records.length, report.records.length);
});

// 归属建议只依赖 identity 与归档顺序，用轻量合成报告即可，避免两份 fixture 因内容相同被判重复
const synthetic = identity => ({ sourceUrl: `https://tcpquality.ibsgss.uk/r/${Math.random().toString(36).slice(2, 10)}`, testedAt: '2026-01-01T00:00:00.000Z', importedAt: '2026-01-01T00:00:00.000Z', fingerprint: Math.random().toString(36).slice(2), identity, sections: [], records: [], rawRows: {}, warnings: [] });

test('导入建议优先沿用同出口报告上次归属的节点', () => {
  const store = freshStore();
  store.sync([node('a'), node('b')]);
  assert.equal(store.suggestNode(null), null, '没有任何历史时不给出建议');
  const exit = parseReport(html, 'https://tcpquality.ibsgss.uk/r/s1').identity || 'AS4134 电信出口';
  store.insert('a', synthetic(exit), html);
  assert.deepEqual(store.suggestNode(exit), { nodeId: 'a', reason: 'same-exit' });
  // 换一个节点导入后，"最近一次"会变，但同出口记忆应仍然胜出
  store.insert('b', synthetic('AS4837 联通出口'), html);
  assert.deepEqual(store.suggestNode(exit), { nodeId: 'a', reason: 'same-exit' }, '同出口优先于最近导入');
  assert.deepEqual(store.suggestNode('AS0 未知出口'), { nodeId: 'b', reason: 'recent' }, '无同出口历史时退回最近导入');
});

test('改绑只改变归属，不动报告内容', () => {
  const store = freshStore();
  store.sync([node('a'), node('b')]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/mv'), html);
  const before = store.detail(report.id).records.length;
  store.move(report.id, 'b');
  assert.equal(store.database.reports.find(item => item.id === report.id).nodeId, 'b', '索引归属应更新');
  const detail = store.detail(report.id);
  assert.equal(detail.nodeId, 'b', '明细归属应更新');
  assert.equal(detail.records.length, before, '改绑不应影响记录');
  assert.equal(detail.sourceUrl, report.sourceUrl, '改绑不应影响来源');
  // 改绑后同出口记忆随之更新：下一次导入同一出口应建议新节点
  assert.deepEqual(store.suggestNode(report.identity), { nodeId: 'b', reason: 'same-exit' });
});

test('改绑拒绝不存在的报告、节点与缺失明细', () => {
  const store = freshStore();
  store.sync([node('a')]);
  const report = store.insert('a', parseReport(html, 'https://tcpquality.ibsgss.uk/r/mv2'), html);
  assert.throws(() => store.move(report.id, 'ghost'), /节点不存在/);
  assert.throws(() => store.move('ghost', 'a'), /报告不存在/);
  assert.equal(store.move(report.id, 'a').nodeId, 'a', '改绑到当前节点是空操作');
  // 空操作必须回明细而不是索引条目：索引里没有 records，
  // server 的 summary() 会按明细算 sectionCounts，拿到索引就抛。
  // 只断言 nodeId 守不住这条 —— 索引条目同样有 nodeId，曾经就是这么漏过去的。
  const noop = store.move(report.id, 'a');
  assert.ok(Array.isArray(noop.records) && noop.records.length, '空操作也要带回完整明细');
  assert.ok(Array.isArray(noop.sections), '明细的 sections 必须一并返回，summary() 依赖它');
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

test('派生索引与全表扫描始终一致，且随每次写入重建', () => {
  const store = freshStore();
  const parsed = (url, testedAt, fingerprint) => {
    const report = parseReport(html, url);
    report.testedAt = testedAt;
    report.fingerprint = fingerprint;
    return report;
  };
  const nodeId = report => store.database.nodes.find(item => item.id === report.nodeId);
  // 索引是 store.detail 的快路径：一旦与全表漂移，看板、导入建议、归属记忆会各说各话。
  // 每一次写索引的操作之后都要重新核对，所以这个检查贯穿 sync/insert/move/remove。
  const consistent = () => {
    for (const node of store.database.nodes) {
      // 比的是集合而非顺序：reportsOfNode 按测试时间倒序（看板取最近几份靠它），
      // 全表 filter 则是插入顺序，两者顺序本来就不同。
      assert.deepEqual(
        [...store.reportsOfNode(node.id)].map(item => item.id).sort(),
        store.database.reports.filter(item => item.nodeId === node.id).map(item => item.id).sort(),
        `${node.id} 的报告索引应与全表一致`
      );
      assert.equal(store.node(node.id)?.name, node.name, '节点索引应能按 id 取到');
    }
  };
  store.sync([node('a'), node('b')]);
  consistent();
  const early = store.insert('a', parsed('https://tcpquality.ibsgss.uk/r/ix1', '2026-10-01T08:00:00+08:00', 'ix1'), html);
  const late = store.insert('a', parsed('https://tcpquality.ibsgss.uk/r/ix2', '2026-10-03T08:00:00+08:00', 'ix2'), html);
  const other = store.insert('b', parsed('https://tcpquality.ibsgss.uk/r/ix3', '2026-10-02T08:00:00+08:00', 'ix3'), html);
  consistent();
  store.move(early.id, 'b');
  consistent();
  // b 现在有 10-01(early) 与 10-02(other) 两份，正好能验倒序；删掉 other 只剩一份就验不了顺序
  store.remove(late.id);
  consistent();
  store.sync([node('a'), node('b'), node('c')]);
  consistent();
  // reportsOfNode 按测试时间倒序，看板与历史页都靠这个顺序取最近几份
  // （b 上是 10-02 的 other 与 10-01 的 early，所以 other 必须在前）
  const times = store.reportsOfNode('b').map(item => item.testedAt);
  assert.deepEqual(times, ['2026-10-02T08:00:00+08:00', '2026-10-01T08:00:00+08:00'], '同一节点内应按测试时间倒序');
  assert.deepEqual(store.reportsOfNode('b').map(item => item.id), [other.id, early.id]);
  assert.equal(store.node(other.nodeId)?.name, '节点-b', '索引条目应仍带着可解析的节点');
  assert.equal(store.reportsOfNode('c').length, 0, '没有报告的节点返回空表而不是 undefined');
});

test('previousOf 返回同节点时间严格更早的最近一份，与全表扫描结果一致', () => {
  const store = freshStore();
  store.sync([node('a'), node('b')]);
  const at = (url, testedAt, fingerprint, node) => {
    const report = parseReport(html, url);
    report.testedAt = testedAt;
    report.fingerprint = fingerprint;
    return store.insert(node, report, html);
  };
  const early = at('https://tcpquality.ibsgss.uk/r/pv1', '2026-10-01T08:00:00+08:00', 'pv1', 'a');
  const mid = at('https://tcpquality.ibsgss.uk/r/pv2', '2026-10-02T08:00:00+08:00', 'pv2', 'a');
  const late = at('https://tcpquality.ibsgss.uk/r/pv3', '2026-10-03T08:00:00+08:00', 'pv3', 'a');
  // 另一节点、时间夹在中间的报告不能串进本机的历史
  at('https://tcpquality.ibsgss.uk/r/pv4', '2026-10-02T12:00:00+08:00', 'pv4', 'b');
  assert.equal(store.previousOf(late).id, mid.id);
  assert.equal(store.previousOf(mid).id, early.id);
  assert.equal(store.previousOf(early), null, '最早一份没有上一份');
  // 与原来的全表 filter+sort 逐份比对：口径变了却看不出来是最难查的一类回归
  const scan = report => store.database.reports
    .filter(item => item.nodeId === report.nodeId && item.id !== report.id && Date.parse(item.testedAt) < Date.parse(report.testedAt))
    .sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt))[0];
  for (const report of store.database.reports) {
    assert.equal(store.previousOf(report)?.id ?? null, scan(report)?.id ?? null);
  }
});
