import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReport, compareReports } from '../lib/parser.mjs';

const html = readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8');
const report = parseReport(html, 'https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM');
const pick = (source, section, target, carrier) => source.records.find(record => record.section === section && record.target === target && record.carrier === carrier);

test('解析出全部五个维度且无告警', () => {
  assert.deepEqual(report.sections.map(section => section.id), ['ipv4', 'large4', 'cernet', 'intl', 'speedtest']);
  assert.equal(report.warnings.length, 0);
});

test('三网回程按省份与运营商拆分，线路单独保存', () => {
  const record = pick(report, 'ipv4', '江苏', '电信');
  assert.equal(record.metrics.route.value, '4837');
  assert.equal(record.metrics.latency.value, 188);
  assert.equal(record.metrics.loss.value, 4);
  assert.equal(report.records.filter(item => item.section === 'ipv4').length, 93);
});

test('丢包与大包重传分开存储，不混用', () => {
  assert.equal(pick(report, 'ipv4', '江苏', '电信').metrics.loss.value, 4);
  assert.equal(pick(report, 'large4', '江苏', '电信').metrics.retrans.value, 58);
  assert.equal(pick(report, 'ipv4', '江苏', '电信').metrics.retrans, undefined);
});

test('单线程测速保留双向速度与重传', () => {
  const record = pick(report, 'speedtest', '上海电信', '');
  assert.equal(record.group, 'IPv4');
  assert.equal(record.metrics.returnRetrans.value, 8.56);
  assert.equal(record.metrics.returnSpeed.value, 60.2);
  assert.equal(record.metrics.outboundSpeed.value, 2.2);
});

test('国际互联拆成节点、网站与 CDN 三组', () => {
  const groups = new Set(report.records.filter(record => record.section === 'intl').map(record => record.group));
  assert.equal(groups.size, 3);
  assert.ok(groups.has('国际节点') && groups.has('常用网站') && groups.has('常用 CDN'));
  assert.equal(pick(report, 'intl', '澳大利亚-悉尼', '').metrics.downloadRetrans.value, 1);
  assert.equal(pick(report, 'intl', 'ChatGPT', '').metrics.reachable.value, '✓');
});

test('以报告测试时间归档，而非导入时间', () => {
  assert.equal(report.testedAt, '2026-10-02T17:42:28+08:00');
  assert.ok(Date.parse(report.testedAt) < Date.parse(report.importedAt));
});

test('相同报告产生相同指纹，可用于去重', () => {
  assert.equal(parseReport(html, 'x').fingerprint, report.fingerprint);
});

test('缺少报告时间时拒绝解析', () => {
  const stripped = html.replace(/报告时间：[^<]*CST（北京时间）/g, '');
  assert.throws(() => parseReport(stripped, 'x'), /测试时间/);
});

test('值格式变化时保留原文并告警，不按零处理', () => {
  const parsed = parseReport(html.replaceAll('188ms', '超时'), 'x');
  assert.equal(pick(parsed, 'ipv4', '江苏', '电信').metrics.latency.status, 'unknown');
  assert.ok(parsed.warnings.some(warning => warning.includes('不按零处理')));
});

test('对比只输出可比较的数值指标，并给出方向', () => {
  const older = {
    ...report,
    testedAt: '2026-10-01T17:42:28+08:00',
    records: report.records.map(record => ({
      ...record,
      metrics: Object.fromEntries(Object.entries(record.metrics).map(([key, measurement]) => [key, typeof measurement.value === 'number' ? { ...measurement, value: measurement.value - 10 } : measurement]))
    }))
  };
  const changes = compareReports(report, older);
  assert.ok(changes.length > 200);
  assert.ok(changes.every(change => change.delta === 10 && change.direction === 'up'));
  assert.ok(changes.every(change => change.metric !== 'route'));
  assert.equal(changes.find(change => change.section === 'ipv4' && change.target === '江苏' && change.carrier === '电信' && change.metric === 'loss').delta, 10);
});
