import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPriorityInput, rateDamage, rateSeverity, classifyCarrier, recordState } from '../lib/priority-input.mjs';
import { completeReport, dualStackReport, deepFreeze } from './fixtures/priority/factory.mjs';

const input = report => buildPriorityInput(report, { region: 'US' });

test('verified template registers only mobile domestic IPv6 without excluding other IPv6 families', () => {
  const result = input(deepFreeze(dualStackReport()));
  assert.equal(result.status, 'ready');
  assert.equal(result.coverage.singleStack, false);
  assert.ok(result.leaves.some(leaf => leaf.id === 'D.cm.v6'));
  assert.ok(!result.leaves.some(leaf => ['D.ct.v6', 'D.cu.v6'].includes(leaf.id)));
  assert.deepEqual(result.coverage.templateExclusions.map(item => item.leaf), ['D.ct.v6', 'D.cu.v6']);
  assert.ok(result.coverage.templateExclusions.every(item => item.state === 'not-in-template'));
  assert.equal(result.coverage.conditionalTests[0].state, 'present');
  for (const id of ['A.ct.v6', 'A.cu.v6', 'A.cm.v6', 'A.cernet.v6', 'I.nodes.v6']) assert.ok(result.leaves.some(leaf => leaf.id === id && leaf.status === 'ready'));
});

test('missing required IPv6, malformed optional readings and unexpected carriers remain insufficient', () => {
  for (const mutate of [
    report => { report.records = report.records.filter(record => !(record.section === 'ipv6' && record.carrier === '电信')); },
    report => { report.records = report.records.filter(record => !(record.section === 'intl' && record.carrier === 'IPv6')); },
    report => { delete report.records.find(record => record.section === 'speedtest' && record.group === 'IPv6').metrics.returnSpeed; },
    report => { report.records.find(record => record.section === 'speedtest' && record.group === 'IPv6').carrier = '未知'; },
    report => { const record = report.records.find(record => record.section === 'speedtest' && record.group === 'IPv6'); record.target = '新增电信'; record.carrier = '电信'; record.key = 'unexpected-v6-carrier'; }
  ]) {
    const report = dualStackReport();
    mutate(report);
    assert.equal(input(report).status, 'insufficient');
  }
});

test('conditional group absence is visible and explicit mobile IPv6 failure is retained', () => {
  const report = dualStackReport();
  const mobile = report.records.filter(record => record.section === 'speedtest' && record.group === 'IPv6');
  for (const record of mobile) record.metrics = { route: { value: 'failed', unit: '', status: 'text' } };
  const failed = input(report);
  assert.equal(failed.status, 'ready');
  const leaf = failed.leaves.find(item => item.id === 'D.cm.v6');
  assert.equal(leaf.score, 90);
  assert.equal(leaf.coverage.failed, mobile.length);
  report.records = report.records.filter(record => !mobile.includes(record));
  const absent = input(report);
  assert.equal(absent.status, 'ready');
  assert.equal(absent.coverage.conditionalTests[0].state, 'not-declared');
  assert.ok(!absent.leaves.some(item => item.id === 'D.cm.v6'));
});

test('continuous rate anchors, monotonicity and magnitude/breadth boundaries', () => {
  for (const [value, expected] of [[0, 0], [0.2, 1], [1, 5], [5, 20], [10, 40], [20, 65], [50, 85], [100, 100]]) assert.equal(rateDamage(value), expected);
  for (let index = 1; index <= 10000; index++) assert.ok(rateDamage(index / 100) >= rateDamage((index - 1) / 100));
  assert.ok(Math.abs(rateSeverity(Array(31).fill(0.19)) - 0.95) < 1e-10);
  assert.equal(rateSeverity(Array(31).fill(10)), 40);
  assert.equal(rateSeverity(Array(31).fill(100)), 100);
  assert.ok(Math.abs(rateSeverity([100, ...Array(30).fill(0)]) - (80 / 31 + 20)) < 1e-10);
  for (const values of [[], [null], [-1], [101], [NaN], [Infinity]]) assert.equal(rateSeverity(values), null);
  assert.throws(() => rateSeverity([0], 1.1));
});

test('carrier suffix classification and conflicts are explicit', () => {
  assert.deepEqual(classifyCarrier({ carrier: '', target: '北京电信' }), { carrier: 'ct', carrierSource: 'target-suffix', conflict: false });
  assert.equal(classifyCarrier({ carrier: '移动', target: '普通目标' }).carrierSource, 'carrier');
  assert.equal(classifyCarrier({ carrier: '移动', target: '北京电信' }).carrier, null);
  assert.equal(classifyCarrier({ carrier: 'IPv4', target: '北京电信' }).carrier, null);
});

test('normal single stack, zero values and count-only facts are not missing', () => {
  const report = completeReport();
  report.records.find(record => record.group === '国际节点').metrics.downloadRetrans.value = 99999;
  const result = input(deepFreeze(report));
  assert.equal(result.status, 'ready');
  assert.equal(result.coverage.singleStack, true);
  assert.ok(result.leaves.every(leaf => leaf.score === 0));
  assert.ok(result.facts.some(fact => fact.kind === 'count' && fact.value === 99999));
});

test('explicit route failure precedes empty numeric values; valid 100% remains a fact', () => {
  const report = completeReport();
  const record = report.records.find(record => record.section === 'large4');
  record.metrics = { route: { value: 'failed', raw: 'failed', status: 'text', unit: '' }, latency: { value: '-', unit: 'ms', status: 'unknown' }, retrans: { value: '-', unit: '%', status: 'unknown' } };
  assert.equal(recordState(record), 'test-failed');
  let result = input(report);
  let leaf = result.leaves.find(leaf => leaf.id === 'B.ct.v4');
  assert.equal(result.status, 'ready');
  assert.equal(leaf.score, 30);
  assert.equal(leaf.breadth.valid, 2);
  record.metrics.retrans = { value: 100, unit: '%', status: 'ok' };
  result = input(report);
  leaf = result.leaves.find(leaf => leaf.id === 'B.ct.v4');
  assert.equal(leaf.breadth.heavy, 1);
  assert.ok(result.facts.some(fact => fact.kind === 'rate' && fact.value === 100));
});

test('unrelated missing metrics are not swallowed by a partial failure', () => {
  const report = completeReport();
  const record = report.records.find(record => record.section === 'speedtest');
  record.metrics.returnSpeed = { value: 'failed', status: 'unknown', unit: 'Mbps' };
  delete record.metrics.outboundLatency;
  assert.equal(input(report).status, 'insufficient');
});

test('IPv6 failure is not hidden by single-stack inference', () => {
  const report = completeReport();
  const record = structuredClone(report.records.find(record => record.group === '国际节点'));
  record.carrier = 'IPv6';
  record.key = 'v6-failure';
  record.metrics.downloadLatency = { value: 'failed', unit: 'ms', status: 'unknown' };
  report.records.push(record);
  const result = input(report);
  assert.equal(result.coverage.singleStack, false);
  assert.equal(result.status, 'insufficient');
  assert.ok(result.facts.some(fact => fact.key === 'v6-failure' && fact.kind === 'test-failed'));
});

test('empty IPv6 international placeholders are expected-unmeasured', () => {
  const report = completeReport();
  const record = structuredClone(report.records.find(record => record.group === '国际节点'));
  record.carrier = 'IPv6';
  record.key = 'v6-placeholder';
  for (const metric of Object.values(record.metrics)) Object.assign(metric, { value: '-', status: 'unknown' });
  report.records.push(record);
  const result = input(report);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.coverage.expectedUnmeasured, ['v6-placeholder']);
});

test('wrong units, duplicate identities, unknown region and missing branches block coverage', () => {
  for (const mutate of [
    report => { report.records[0].metrics.loss.unit = '次'; },
    report => { report.records[0].metrics.loss.value = 101; },
    report => { report.records.push(structuredClone(report.records[0])); },
    report => { report.records.push({ ...structuredClone(report.records[0]), key: 'different-key' }); },
    report => { report.records = report.records.filter(record => record.section !== 'large4'); },
    report => { report.records[0].carrier = '未知'; }
  ]) {
    const report = completeReport();
    mutate(report);
    assert.equal(input(report).status, 'insufficient');
  }
  assert.equal(buildPriorityInput(completeReport(), { region: 'unknown' }).status, 'insufficient');
});

test('multiple rate fields take a per-record maximum, not extra denominator seats', () => {
  const report = completeReport();
  report.records[0].metrics.retrans = { value: 100, unit: '%', status: 'ok' };
  const leaf = input(report).leaves.find(leaf => leaf.id === 'A.ct.v4');
  assert.equal(leaf.breadth.valid, 3);
  assert.equal(leaf.breadth.heavy, 1);
  assert.ok(Math.abs(leaf.score - rateSeverity([100, 0, 0])) < 1e-10);
});

test('service unreachable supports HTML and CSV symbols without invented packet loss', () => {
  for (const symbol of ['x', '✗']) {
    const report = completeReport();
    const record = report.records.find(record => record.group === '常用网站');
    record.metrics.reachable.value = symbol;
    delete record.metrics.latency;
    delete record.metrics.retrans;
    const result = input(report);
    assert.equal(result.status, 'ready');
    assert.equal(result.leaves.find(leaf => leaf.id === 'I.web.v4').score, 90);
    assert.ok(!result.facts.some(fact => fact.kind === 'rate'));
  }
});

test('整族被探针跳过时不算依据不足，只把该族退出计分并如实标注', () => {
  // 真实案例：大包回程整段状态 SKIP。它既不是失败也不是漏传，
  // 所以不能拖累整份报告变成"依据不足"，也不该产生"必需读数缺失"这类 issue。
  const report = dualStackReport();
  for (const record of report.records.filter(record => record.section === 'large4')) {
    record.status = 'skipped';
    for (const metric of Object.values(record.metrics)) metric.status = 'skipped';
  }
  const result = input(report);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.coverage.skippedFamilies.map(item => item.leaf), ['B.ct.v4', 'B.cu.v4', 'B.cm.v4']);
  for (const leaf of result.leaves.filter(leaf => leaf.branch === 'B')) {
    assert.equal(leaf.status, 'skipped');
    assert.equal(leaf.score, null);
    assert.equal(leaf.coverage.skipped, leaf.coverage.records);
  }
  assert.equal(result.issues.filter(issue => String(issue.leaf ?? '').startsWith('B.')).length, 0);
  // 其他分支照常评分，没有被顺带放过
  assert.ok(result.leaves.filter(leaf => leaf.branch === 'A').every(leaf => leaf.status === 'ready'));
});

test('历史速度：相对跌幅够大就报，不被绝对 Mbps 门槛挡住', () => {
  const speeds = (before, after) => {
    const report = completeReport();
    const previous = structuredClone(report);
    previous.testedAt = '2026-10-05T00:00:00Z';
    for (const record of previous.records.filter(record => record.section === 'speedtest' && record.group === 'IPv4')) record.metrics.returnSpeed.value = before;
    for (const record of report.records.filter(record => record.section === 'speedtest' && record.group === 'IPv4')) record.metrics.returnSpeed.value = after;
    return buildPriorityInput(report, { region: 'US' }, previous).leaves.find(leaf => leaf.id === 'D.ct.v4').channels.find(channel => channel.kind === 'speed-change');
  };
  // 腰斩：34 → 16Mbps，绝对降幅只有 18（不到 historyDrop=20），比例已经腰斩
  const halved = speeds(34, 16);
  assert.ok(halved.score > 0, '腰斩应被判为历史下降');
  assert.equal(halved.channels.find(channel => channel.metric === 'returnSpeed').drop, 18);
  // 轻微波动 100 → 90：两个门槛都没到，仍然不报
  assert.equal(speeds(100, 90).score, 0);
});

test('history matches same node, earlier time, carrier, family, units and at least three points', () => {
  const report = completeReport();
  const previous = structuredClone(report);
  previous.testedAt = '2026-10-05T00:00:00Z';
  for (const record of report.records.filter(record => record.section === 'speedtest' && record.target.endsWith('电信'))) record.metrics.returnSpeed.value = 150;
  const result = buildPriorityInput(report, { region: 'US' }, previous);
  assert.equal(result.leaves.find(leaf => leaf.id === 'D.ct.v4').channels.find(channel => channel.kind === 'speed-change').score, 40);
  assert.equal(result.leaves.find(leaf => leaf.id === 'D.cm.v4').score, 0);
  for (const mutate of [prior => { prior.nodeId = 'another'; }, prior => { prior.testedAt = report.testedAt; }, prior => { prior.records = prior.records.filter(record => !record.target.startsWith('地点0')); }]) {
    const prior = structuredClone(previous);
    mutate(prior);
    const leaf = buildPriorityInput(report, { region: 'US' }, prior).leaves.find(leaf => leaf.id === 'D.ct.v4');
    assert.equal(leaf.channels.find(channel => channel.kind === 'speed-change').score, null);
  }
});
