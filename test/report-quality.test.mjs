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
const fullCsv = readFileSync(new URL('./fixtures/tq-full.csv', import.meta.url), 'utf8');
const parseCsv = source => parseTqCsv(source, { sourceUrl: 'csv:test', testedAt: '2026-10-04T01:02:27+08:00' });
const aggregateWarning = '48 个指标为缺失、失败或未知格式，已保留原值，不按零处理';

test('探针主动跳过的指标单列一项，不冒充缺失也不建议重传', () => {
  // 真实案例：大包回程整段状态 SKIP。按"读数缺失"处理，提示会让人去重传
  // 一份本来就跳过这段的报告 —— 这是最误导的一类文案。
  const source = parseCsv(fullCsv);
  const before = reportCoverage(source);
  assert.equal(before.skippedMetrics, 0);
  assert.equal(before.missingMetrics, before.expectedMissingMetrics);
  for (const item of source.records.filter(entry => entry.section === 'large4')) {
    item.status = 'skipped';
    for (const metric of Object.values(item.metrics)) metric.status = 'skipped';
  }
  const after = reportCoverage(source);
  assert.equal(after.skippedMetrics, 186);
  assert.equal(after.validMetrics, before.validMetrics - 186);
  assert.equal(after.missingMetrics, before.missingMetrics, '跳过的不能冒充缺失');
  assert.equal(after.failedMetrics, 0);
  assert.equal(after.unavailableMetrics, before.unavailableMetrics, '跳过也不算"不可用"');
  assert.equal(after.partial, true, '整段没执行仍算覆盖不足');
  assert.equal(after.coverageStatus, 'insufficient');
  assert.equal(after.badgeStatus, 'neutral', 'SKIP 只能进入中性提示，不能显示解析告警');
  assert.match(after.coverageHint, /探针主动跳过（状态 SKIP）/);
  assert.doesNotMatch(after.coverageHint, /请重传/);
});

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

test('真实 tq-full 单栈的 48 项 IPv6 占位为 neutral，只有缺 ipv6 不算覆盖不足', () => {
  const csv = parseCsv(fullCsv);
  const html = parseReport(readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8'), 'html:test');
  for (const input of [csv, html]) {
    const coverage = reportCoverage(input);
    assert.equal(coverage.status, 'ok');
    assert.equal(coverage.badgeStatus, 'neutral');
    assert.equal(coverage.coverageStatus, 'single-stack');
    assert.equal(coverage.partial, false);
    assert.equal(coverage.importIncomplete, false);
    assert.deepEqual(coverage.missingSections, ['ipv6']);
    assert.deepEqual(coverage.missingExpectedSections, []);
    assert.equal(coverage.failedMetrics, 0);
    assert.equal(coverage.unknownMetrics, 0);
    assert.equal(coverage.validMetrics, 610);
    assert.match(coverage.label, /正常单栈/);
  }
  const coverage = reportCoverage(csv);
  assert.equal(coverage.numericMetrics, 658);
  assert.equal(coverage.missingMetrics, 48);
  assert.equal(coverage.expectedMissingMetrics, 48);
  assert.equal(coverage.expectedMissing.length, 48);
  assert.ok(coverage.expectedMissing.every(item => item.section === 'intl' && item.family === 'IPv6' && item.raw === '-' && item.reason === 'single-stack-ipv6'));
  assert.ok(coverage.expectedMissing.every(item => csv.records.some(record => record.key === item.key && record.metrics[item.metric].raw === item.raw)));
  assert.deepEqual(coverage.issues, []);
  assert.deepEqual(coverage.notices.map(notice => [notice.type, notice.severity]), [['warning', 'neutral']]);
  assert.equal(coverage.notices[0].message, aggregateWarning);
  assert.equal(coverage.notices[0].failedMetrics, 0);
  assert.equal(coverage.notices[0].expectedMissingMetrics, 48);
  const intl = coverage.sections.find(section => section.id === 'intl');
  assert.equal(intl.expectedMissingMetrics, 48);
  assert.equal(intl.groups.find(group => group.group === '国际节点').expectedMissingMetrics, 48);
});

test('CSV missing 空值和单栈 IPv6 横线占位均可追溯，不变成有效数值', () => {
  const source = fullCsv.split('\n').filter(line => !(line.startsWith('国际互联,IPv6,') && line.endsWith(',upload'))).join('\n');
  const parsed = parseCsv(source);
  assert.deepEqual(parsed.warnings, [aggregateWarning]);
  const coverage = reportCoverage(parsed);
  assert.equal(coverage.expectedMissingMetrics, 48);
  assert.equal(coverage.expectedMissing.filter(item => item.raw === '').length, 24);
  assert.equal(coverage.expectedMissing.filter(item => item.raw === '-').length, 24);
  assert.equal(coverage.validMetrics, 610);
  assert.equal(coverage.status, 'ok');
  const missingUpload = parseCsv(fullCsv.split('\n').filter(line => !(line.startsWith('国际互联,IPv4,香港,') && line.endsWith(',upload'))).join('\n'));
  const partial = reportCoverage(missingUpload);
  assert.equal(partial.expectedMissingMetrics, 48);
  assert.equal(partial.missingMetrics, 50);
  assert.equal(partial.partial, true);
  assert.equal(partial.badgeStatus, 'neutral');
  assert.equal(partial.importIncomplete, false);
});

test('同一条 48 聚合告警含真实失败时按字段标 failure，不能按数字忽略', () => {
  for (const sentinel of ['-1', 'failed', 'error']) {
    const source = fullCsv.replace(/^(国际互联,IPv6,[^\n]*,100\.00,)-(?=,iPerf3)/m, `$1${sentinel}`);
    assert.notEqual(source, fullCsv);
    const parsed = parseCsv(source);
    assert.deepEqual(parsed.warnings, [aggregateWarning]);
    const coverage = reportCoverage(parsed);
    assert.equal(coverage.status, 'issues');
    assert.equal(coverage.badgeStatus, 'failure');
    assert.equal(coverage.failedMetrics, 1);
    assert.equal(coverage.importIncomplete, false);
    assert.match(coverage.label, /测试失败/);
    assert.ok(coverage.issues.some(issue => issue.type === 'failed' && issue.severity === 'failure'));
    assert.equal(coverage.issues.find(issue => issue.message === aggregateWarning).severity, 'failure');
  }
});

test('纯缺失聚合告警为 neutral，未知字段、数量不符及解析告警仅作解析提示', () => {
  const metrics = Object.fromEntries(Array.from({ length: 48 }, (_, index) => [`slot${index}`, { ...measurement(null, 'ms', 'unknown'), raw: '' }]));
  const input = report([record('未测对象', metrics)], { warnings: [aggregateWarning] });
  const missing = reportCoverage(input);
  assert.equal(missing.badgeStatus, 'neutral');
  assert.equal(missing.failedMetrics, 0);
  assert.equal(missing.missingMetrics, 48);
  assert.equal(missing.expectedMissingMetrics, 0);
  assert.deepEqual(missing.issues, []);
  assert.equal(missing.notices[0].severity, 'neutral');
  for (const changed of [
    report([record('未测对象', { ...metrics, slot0: measurement('??', 'ms', 'unknown') })], { warnings: [aggregateWarning] }),
    report([record('未测对象', metrics)], { warnings: [aggregateWarning.replace('48', '49')] }),
    report([record()], { warnings: [aggregateWarning] }),
    report([record()], { warnings: ['列结构异常，未猜测数据'] })
  ]) {
    const coverage = reportCoverage(changed);
    assert.equal(coverage.badgeStatus, 'warning');
    assert.equal(coverage.failedMetrics, 0);
    assert.match(coverage.label, /解析提示/);
    assert.doesNotMatch(coverage.label, /测试失败/);
  }
});

test('三网、教育网或测速有有效 IPv6 实测时，国际 IPv6 横线保留 partial/missing', () => {
  const ipv6Rows = [
    fullCsv.split('\n').find(line => line.startsWith('三网,IPv4,')).replace('三网,IPv4,', '三网,IPv6,'),
    'CERNET2,IPv6,河北,教育网,he.example,::1,OK,25,25,0.00,200.000,4538',
    '三网单线程速度,IPv6,北京移动,北京移动,::1,,OK,100,0.00%,20,,,200,220,210,230'
  ];
  for (const row of ipv6Rows) {
    const coverage = reportCoverage(parseCsv(`${fullCsv}\n${row}`));
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.partial, true);
    assert.equal(coverage.expectedMissingMetrics, 0);
    assert.equal(coverage.missingMetrics, 48);
    assert.equal(coverage.unknownMetrics, 0);
    assert.equal(coverage.failedMetrics, 0);
    assert.equal(coverage.badgeStatus, 'neutral');
    assert.equal(coverage.importIncomplete, false);
    assert.deepEqual(coverage.issues, []);
    assert.match(coverage.label, /覆盖不足/);
  }
});

test('主动只测三网仍明确覆盖不足并核对范围，没有证据不称截断或导入不完整', () => {
  const parsed = parseCsv(readFileSync(new URL('./fixtures/tq-ipv4.csv', import.meta.url), 'utf8'));
  for (const input of [parsed, { ...parsed, expectedSections: ['ipv4', { id: 'ipv4' }] }]) {
    const coverage = reportCoverage(input);
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.badgeStatus, 'neutral');
    assert.equal(coverage.coverageStatus, 'insufficient');
    assert.equal(coverage.importIncomplete, false);
    assert.match(coverage.label, /覆盖不足/);
    assert.match(coverage.coverageHint, /核对测试范围/);
    assert.match(coverage.coverageHint, /若已执行完整测试.*重传/);
    assert.doesNotMatch(coverage.coverageHint, /截断|导入不完整/);
    assert.deepEqual(coverage.missingExpectedSections, []);
  }
  const incomplete = reportCoverage({ ...parsed, expectedSections: ['ipv4', { id: 'intl' }, 'intl', 'speedtest'] });
  assert.equal(incomplete.importIncomplete, true);
  assert.equal(incomplete.coverageStatus, 'incomplete');
  assert.equal(incomplete.badgeStatus, 'warning');
  assert.deepEqual(incomplete.missingExpectedSections, ['intl', 'speedtest']);
  assert.match(incomplete.label, /导入不完整/);
  assert.match(incomplete.coverageHint, /国际互联.*单线程测速.*重传/);
  const expectedIpv6 = reportCoverage({ ...parseCsv(fullCsv), expectedSections: ['ipv6'] });
  assert.equal(expectedIpv6.importIncomplete, true);
  assert.equal(expectedIpv6.partial, true);
  assert.equal(expectedIpv6.expectedMissingMetrics, 0);
  assert.deepEqual(expectedIpv6.missingExpectedSections, ['ipv6']);
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

test('预期 IPv6 占位保留共同或新增 slot，但不计可比数值，unit/status 原因仍保留', () => {
  const parsed = parseCsv(fullCsv);
  const same = compareCoverage(parsed, parsed);
  assert.equal(same.metrics.common, 658);
  assert.equal(same.metrics.comparable, 610);
  assert.equal(same.metrics.statusIncomparable, 48);
  assert.equal(same.metrics.expectedMissingIncomparable, 48);
  assert.ok(same.incomparableMetrics.every(item => item.reasons.includes('status') && item.reasons.includes('expected-missing')));
  assert.ok(same.incomparableMetrics.every(item => item.expectedMissing.current && item.expectedMissing.previous));
  const changed = structuredClone(parsed);
  changed.records.find(record => record.carrier === 'IPv6').metrics.downloadLatency.unit = 's';
  const differentUnit = compareCoverage(changed, parsed);
  assert.equal(differentUnit.metrics.unitIncomparable, 1);
  assert.deepEqual(differentUnit.incomparableMetrics.find(item => item.reasons.includes('unit')).reasons, ['unit', 'status', 'expected-missing']);
  const html = parseReport(readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8'), 'html:test');
  const added = compareCoverage(parsed, html);
  assert.equal(added.metrics.comparable, compareReports(parsed, html).length);
  assert.equal(added.addedMetrics.length, 48);
  assert.ok(added.addedMetrics.every(item => item.expectedMissing.current && !item.expectedMissing.previous));
  const missing = compareCoverage(html, parsed);
  assert.ok(missing.missingMetrics.every(item => !item.expectedMissing.current && item.expectedMissing.previous));
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
  assert.equal(result.headline, '2项显著改善·2项显著恶化');
  assert.match(result.focus, /IPv4 回程/);
  assert.match(result.focus, /IPv4 大包回程/);
  assert.match(result.summary, /2项显著改善·2项显著恶化/);
  assert.match(result.summary, /不作整体优劣结论/);
});

test('结论标题给出改善与恶化计数，focus 只取恶化最多的 top2 维度', () => {
  const change = (section, index, direction = 'up') => ({ ...record(`${section}-${index}`, {}, section), metric: 'latency', significant: true, direction });
  const changes = [
    ...Array.from({ length: 6 }, (_, index) => change('ipv4', index)),
    ...Array.from({ length: 3 }, (_, index) => change('intl', index)),
    change('large4', 0), change('ipv4', '改善', 'down'), change('speedtest', '改善', 'down')
  ];
  const conclusion = comparisonConclusion(changes);
  assert.equal(conclusion.headline, '2项显著改善·10项显著恶化');
  assert.equal(conclusion.focus, '恶化集中在 IPv4 回程（6项）、国际互联（3项）');
  assert.equal(conclusion.worseningBySection.length, 3);
  assert.doesNotMatch(conclusion.focus, /大包/);
  assert.doesNotMatch(conclusion.summary, /大包|电信/);
  assert.ok(conclusion.summary.length < 110);
  assert.equal(comparisonConclusion([...changes].reverse()).focus, conclusion.focus);
  const unchanged = comparisonConclusion([]);
  assert.equal(unchanged.headline, '0项显著改善·0项显著恶化');
  assert.equal(unchanged.focus, '暂无显著恶化');
});

test('运营商集中仅认三网，协议族与教育网归其他而不污染运营商标签', () => {
  const carriers = ['电信', '联通', '移动', 'IPv4', 'IPv6', '教育网', '教育网IPv4', '教育网IPv6', '', 'IPv6移动', ' 电信 ', 'CERNET'];
  const changes = carriers.map((carrier, index) => ({ ...record(`对象${index}`, {}, 'intl', carrier), metric: 'latency', significant: true, direction: 'up' }));
  const conclusion = comparisonConclusion(changes);
  const counts = Object.fromEntries(conclusion.worseningByCarrier.map(item => [item.carrier, item.count]));
  assert.deepEqual(counts, { 其他: 8, 电信: 2, 联通: 1, 移动: 1 });
  assert.ok(conclusion.worseningByCarrier.every(item => ['电信', '联通', '移动', '其他'].includes(item.label) && item.carrier === item.label));
  assert.equal(conclusion.worseningByCarrier.reduce((total, item) => total + item.count, 0), conclusion.worsenedMetrics);
  assert.deepEqual(conclusion.worsened.map(item => item.carrier), carriers);
  assert.doesNotMatch(conclusion.summary, /IPv6移动|教育网|未标注运营商/);
});

test('仅测速空 carrier 可从 target 三网后缀推断运营商，国际协议族和教育网不误推断', () => {
  const changes = [
    record('上海电信', {}, 'speedtest', '', 'IPv4'),
    record('上海联通', {}, 'speedtest', '', 'IPv4'),
    record('北京移动', {}, 'speedtest', '', 'IPv6'),
    record('Apple IPv4', {}, 'speedtest', '', '国际方向'),
    record('上海电信', {}, 'intl', 'IPv4', '国际节点'),
    record('北京移动', {}, 'intl', 'IPv6', '国际节点'),
    record('上海联通', {}, 'cernet', 'CERNET'),
    record('上海电信', {}, 'cernet', ''),
    record('上海电信', {}, 'speedtest', '联通', 'IPv4')
  ].map(item => ({ ...item, metric: 'latency', direction: 'up', significant: true }));
  const conclusion = comparisonConclusion(changes);
  assert.deepEqual(Object.fromEntries(conclusion.worseningByCarrier.map(item => [item.carrier, item.count])), { 其他: 5, 联通: 2, 电信: 1, 移动: 1 });
  assert.equal(conclusion.worsened[0].carrier, '');
  const actual = compareReports(parseCsv(fullCsv), parseCsv(fullCsv)).filter(change => change.section === 'speedtest' && change.metric === 'returnSpeed').map(change => ({ ...change, significant: true, direction: 'down', delta: -1 }));
  assert.deepEqual(Object.fromEntries(comparisonConclusion(actual).worseningByCarrier.map(item => [item.carrier, item.count])), { 电信: 3, 联通: 3, 移动: 3 });
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
