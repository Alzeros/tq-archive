import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReport, compareReports } from '../lib/parser.mjs';
import { parseTqCsv } from '../lib/csv-parser.mjs';
import { isSignificantChange } from '../lib/thresholds.mjs';
import { reportCoverage, compareCoverage, comparisonConclusion } from '../lib/report-quality.mjs';

const measurement = (value, unit = 'ms', status = 'ok') => ({ value, unit, status });
const record = (target = '北京', metrics = { latency: measurement(20) }, section = 'ipv4', carrier = '电信', group = '国内三网') => ({ key: JSON.stringify([section, group, target, carrier]), section, group, target, carrier, metrics });
const report = (records = [], extra = {}) => ({ records, sections: [], warnings: [], ...extra });

test('空报告与缺省输入安全返回，不把无数据认作完整覆盖', () => {
  for (const input of [undefined, null, {}, report()]) {
    const coverage = reportCoverage(input);
    assert.equal(coverage.status, 'empty');
    assert.equal(coverage.records, 0);
    assert.equal(coverage.validMetrics, 0);
    assert.equal(coverage.partial, true);
    assert.deepEqual(coverage.issues, []);
  }
  assert.equal(compareCoverage(null, undefined).metrics.comparable, 0);
  assert.equal(comparisonConclusion(null).status, 'no-significant-change');
});

test('按 section/group 汇总记录和数值指标；文本指标与记录数分开', () => {
  const coverage = reportCoverage(report([
    record('北京', { latency: measurement(0), loss: measurement(0, '%'), route: measurement('4837', '', 'text') }),
    record('上海', { latency: measurement(30) }),
    record('东京', { downloadSpeed: measurement(100, 'Mbps'), reachable: measurement('是', '', 'text') }, 'speedtest', '', '国际方向')
  ]));
  assert.equal(coverage.records, 3);
  assert.equal(coverage.numericMetrics, 4);
  assert.equal(coverage.validMetrics, 4);
  assert.equal(coverage.sections[0].records, 2);
  assert.equal(coverage.sections[0].groups[0].validMetrics, 3);
  assert.equal(coverage.sections[1].groups[0].group, '国际方向');
  assert.equal(coverage.status, 'partial');
  assert.deepEqual(coverage.issues, []);
  assert.match(coverage.label, /不代表导入残缺/);
});

test('维度缺省告警属于 partial；解析告警、失败、未知格式属于 issues', () => {
  const partial = reportCoverage(report([record()], { warnings: ['报告没有 IPv4 大包回程 维度'] }));
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.issues, []);
  const coverage = reportCoverage(report([record('北京', {
    latency: measurement(12, 'ms', 'failed'),
    loss: measurement(null, '%', 'unknown'),
    retrans: { ...measurement('-1ms', 'ms', 'unknown'), raw: '-1ms' },
    uploadLatency: measurement('??', 'ms', 'unknown'),
    downloadLatency: measurement(Infinity),
    outboundLatency: measurement(NaN)
  })], { warnings: ['列数不匹配，未猜测数据'] }));
  assert.equal(coverage.status, 'issues');
  assert.equal(coverage.failedMetrics, 2);
  assert.equal(coverage.missingMetrics, 1);
  assert.equal(coverage.unknownMetrics, 3);
  assert.equal(coverage.unavailableMetrics, 6);
  assert.equal(coverage.validMetrics, 0);
  assert.ok(coverage.issues.some(issue => issue.type === 'warning'));
});

test('缺测不当零或失败，声明维度无记录则是明确解析问题', () => {
  const missing = reportCoverage(report([record('北京', { latency: null, loss: measurement(null, '%', 'missing') })]));
  assert.equal(missing.missingMetrics, 2);
  assert.equal(missing.status, 'partial');
  assert.deepEqual(missing.issues, []);
  const empty = reportCoverage(report([], { sections: [{ id: 'ipv4', name: 'IPv4 回程' }] }));
  assert.equal(empty.status, 'issues');
  assert.equal(empty.sections[0].records, 0);
  assert.ok(empty.issues.some(issue => issue.type === 'empty-section'));
});

test('不猜测省份、记录和指标的预期总数，不宣称采样完整', () => {
  const sections = ['ipv4', 'large4', 'ipv6', 'cernet', 'intl', 'speedtest'];
  const coverage = reportCoverage(report(sections.map(section => record('仅一个对象', { latency: measurement(20) }, section))));
  assert.equal(coverage.status, 'ok');
  assert.equal(coverage.records, 6);
  assert.equal(coverage.numericMetrics, 6);
  assert.equal(coverage.label, '已覆盖已知维度');
  const noMeasurements = reportCoverage(report(sections.map(section => record('仅文本', { route: measurement('4837', '', 'text') }, section))));
  assert.equal(noMeasurements.status, 'partial');
  assert.equal(noMeasurements.numericMetrics, 0);
});

test('覆盖对比包含共同、新增、缺失记录与指标及可展示明细', () => {
  const before = report([record('北京', { latency: measurement(20), loss: measurement(1, '%') }), record('上海')]);
  const after = report([record('北京', { latency: measurement(25), returnSpeed: measurement(50, 'Mbps') }), record('东京', { uploadSpeed: measurement(80, 'Mbps') }, 'speedtest', '', '国际方向')]);
  const result = compareCoverage(after, before);
  assert.deepEqual(result.records, { current: 2, previous: 2, common: 1, added: 1, missing: 1 });
  assert.equal(result.metrics.current, 3);
  assert.equal(result.metrics.previous, 3);
  assert.equal(result.metrics.common, 1);
  assert.equal(result.metrics.comparable, 1);
  assert.equal(result.metrics.added, 2);
  assert.equal(result.metrics.missing, 2);
  assert.deepEqual(result.addedRecords[0], { key: after.records[1].key, section: 'speedtest', group: '国际方向', target: '东京', carrier: '' });
  assert.equal(result.missingRecords[0].target, '上海');
  assert.ok(result.addedMetrics.some(item => item.metric === 'returnSpeed' && item.target === '北京'));
  assert.equal(result.sections.find(section => section.id === 'ipv4').groups[0].records.missing, 1);
  assert.equal(result.sections.find(section => section.id === 'speedtest').metrics.added, 1);
});

test('单位和状态不可比按指标计数，原因可重叠但总数不重复', () => {
  const before = report([record('北京', { latency: measurement(20), loss: measurement(0, '%'), retrans: measurement(1, '%') })]);
  const after = report([record('北京', { latency: measurement(0.02, 's'), loss: measurement(100, '%', 'failed'), retrans: measurement(null, '次', 'unknown') })]);
  const result = compareCoverage(after, before);
  assert.equal(result.records.common, 1);
  assert.equal(result.metrics.common, 3);
  assert.equal(result.metrics.comparable, 0);
  assert.equal(result.metrics.incomparable, 3);
  assert.equal(result.metrics.unitIncomparable, 2);
  assert.equal(result.metrics.statusIncomparable, 2);
  assert.deepEqual(result.incomparableMetrics.find(item => item.metric === 'retrans').reasons, ['unit', 'status']);
  assert.equal(result.metrics.added, 0);
  assert.equal(result.metrics.missing, 0);
});

test('重复 key 不膨胀覆盖数，也不任意选择一份进行数值比较', () => {
  const original = record();
  const duplicate = record('北京', { latency: measurement(999) });
  for (const records of [[original, duplicate], [duplicate, original]]) {
    const input = report(records);
    const coverage = reportCoverage(input);
    assert.equal(coverage.records, 1);
    assert.equal(coverage.duplicateRecords, 1);
    assert.equal(coverage.status, 'issues');
    const result = compareCoverage(input, report([original]));
    assert.equal(result.metrics.comparable, 0);
    assert.equal(result.metrics.duplicateIncomparable, 1);
    assert.equal(result.metrics.incomparable, 1);
  }
  assert.equal(compareCoverage(report([original]), report([original, duplicate])).metrics.duplicateIncomparable, 1);
});

test('无 key 的模型记录按维度身份回退，record failed 不能参与比较', () => {
  const current = { ...record(), status: 'failed' };
  const previous = { ...record() };
  delete current.key;
  delete previous.key;
  const result = compareCoverage(report([current]), report([previous]));
  assert.equal(result.records.common, 1);
  assert.equal(result.metrics.statusIncomparable, 1);
  assert.equal(result.current.failedMetrics, 1);
});

test('真实 HTML/CSV 来源不同仍可比，缺失差异从实际 key 计算', () => {
  const html = parseReport(readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8'), 'https://example.test/report');
  const csv = parseTqCsv(readFileSync(new URL('./fixtures/tq-full.csv', import.meta.url), 'utf8'), { sourceUrl: 'csv:test', testedAt: '2026-01-01T00:00:00Z' });
  const result = compareCoverage(csv, html);
  assert.equal(result.records.added, result.addedRecords.length);
  assert.ok(result.addedRecords.every(item => !html.records.some(record => record.key === item.key)));
  assert.equal(result.metrics.comparable, compareReports(csv, html).length);
  const same = compareCoverage(report([record()], { sourceType: 'csv' }), report([record()], { sourceType: 'html' }));
  assert.equal(same.metrics.comparable, 1);
  assert.equal(same.metrics.incomparable, 0);
});

test('结论复用 significant/direction，速度升高好，延迟/丢包/重传降低好', () => {
  const changes = [
    { ...record('北京'), metric: 'latency', before: 60, after: 40, delta: -20, direction: 'down' },
    { ...record('上海'), metric: 'loss', before: 0, after: 10, delta: 10, direction: 'up' },
    { ...record('东京', {}, 'speedtest', '移动'), metric: 'downloadSpeed', before: 100, after: 200, delta: 100, direction: 'up' },
    { ...record('广州', {}, 'large4', '移动'), metric: 'retrans', before: 0, after: 2, delta: 2, direction: 'up' }
  ].map(change => ({ ...change, significant: isSignificantChange(change.metric, change.delta, change.before, change.after) }));
  const result = comparisonConclusion(changes);
  assert.equal(result.status, 'mixed');
  assert.equal(result.improvedMetrics, 2);
  assert.equal(result.worsenedMetrics, 2);
  assert.equal(result.worseningBySection.length, 2);
  assert.equal(result.worseningByCarrier.length, 2);
  assert.match(result.summary, /延迟/);
  assert.match(result.summary, /IPv4 回程/);
  assert.match(result.summary, /电信/);
  assert.match(result.summary, /不作整体优劣结论/);
});

test('指标语义覆盖各族，其他指标不判优劣；噪声和重复项不计', () => {
  const change = (metric, direction, target = metric) => ({ ...record(target), metric, direction, significant: true });
  const changes = [change('returnSpeed', 'down'), change('uploadSpeed', 'up'), change('downloadLatency', 'up'), change('downloadRetransRate', 'down'), change('outboundLatency', 'down'), change('customScore', 'up'), change('route', 'down')];
  const result = comparisonConclusion([...changes, changes[0], { ...change('loss', 'up'), significant: false }, change('latency', 'same'), { ...change('retrans', 'up'), delta: Infinity }]);
  assert.equal(result.improvedMetrics, 3);
  assert.equal(result.worsenedMetrics, 2);
  assert.equal(result.neutralMetrics, 2);
  assert.equal(result.worseningByCarrier[0].count, 2);
  assert.equal(comparisonConclusion([change('customScore', 'up')]).status, 'neutral');
  assert.match(comparisonConclusion([change('latency', 'down')]).summary, /不作整份报告优劣结论/);
  assert.equal(comparisonConclusion([{ ...change('latency', 'up'), significant: undefined }]).status, 'no-significant-change');
});

test('纯函数不修改输入报告或 changes', () => {
  const input = report([record()]);
  const frozen = structuredClone(input);
  Object.freeze(input.records[0].metrics.latency);
  Object.freeze(input.records[0].metrics);
  Object.freeze(input.records[0]);
  Object.freeze(input.records);
  Object.freeze(input);
  reportCoverage(input);
  compareCoverage(input, input);
  const changes = Object.freeze([Object.freeze({ ...record(), metric: 'latency', significant: true, direction: 'down' })]);
  comparisonConclusion(changes);
  assert.deepEqual(input, frozen);
});

test('覆盖数量守恒，缺测 slot 也属于共同指标而非缺失记录', () => {
  const before = report([record('北京', { latency: measurement(null, 'ms', 'unknown'), loss: measurement(0, '%') }), record('上海')]);
  const after = report([record('北京', { latency: measurement(null, 'ms', 'unknown'), retrans: measurement(0, '%') }), record('广州')]);
  const result = compareCoverage(after, before);
  assert.equal(result.records.current, result.records.common + result.records.added);
  assert.equal(result.records.previous, result.records.common + result.records.missing);
  assert.equal(result.metrics.current, result.metrics.common + result.metrics.added);
  assert.equal(result.metrics.previous, result.metrics.common + result.metrics.missing);
  assert.equal(result.metrics.common, result.metrics.comparable + result.metrics.incomparable);
  assert.equal(result.metrics.statusIncomparable, 1);
  assert.equal(result.incomparableMetrics[0].target, '北京');
  assert.equal(result.current.missingMetrics, 1);
});
