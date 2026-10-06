import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPriorityInput, rateDamage, rateSeverity, classifyCarrier, recordState } from '../lib/priority-input.mjs';
import { completeReport, deepFreeze } from './fixtures/priority/factory.mjs';

const input = report => buildPriorityInput(report, { region: 'US' });

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
