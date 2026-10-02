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
  // 国际节点行现在带 IP 族，双栈报告才能把两张同名表都存下来
  assert.equal(pick(report, 'intl', '澳大利亚-悉尼', 'IPv4').metrics.downloadRetrans.value, 1);
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

// 最小报告骨架：同一 y 的 <text> 会被解析器归为一行；报告时间也必须落在 SVG 文本里
const fakeHtml = sections => sections
  .map(([id, rows]) => `<section id="${id}"><svg>${rows.map((cells, index) => cells.map(cell => `<text x="0" y="${100 + index * 20}">${cell}</text>`).join('')).join('')}</svg></section>`)
  .join('');
const STAMP = '报告时间：2026-01-01 00:00:00 CST（北京时间）';

test('双栈报告的教育网回程是 IPv4 / IPv6 两列，两列都要入库', () => {
  // 单栈报告是 4 格单列；支持 IPv6 的探针会渲染成 8 格两列。
  // 旧实现只认 3 个值，导致 31 个省份全部告警且一条都不入库。
  const parsed = parseReport(fakeHtml([['cernet', [
    ['教育网概览', 'CERNET-IPv4', '/', 'CERNET2-IPv6'],
    ['河北', '9929', '133ms', '0%', '/', '10099->9929', '134ms', '0%'],
    ['山西', '4837', '161ms', '0%', '/', '10099->9929', '140ms', '1%'],
    [STAMP]
  ]]]), 'x');
  assert.equal(parsed.records.filter(record => record.section === 'cernet').length, 4, '2 省 × 2 协议族');
  assert.equal(pick(parsed, 'cernet', '河北', '教育网IPv4').metrics.latency.value, 133);
  assert.equal(pick(parsed, 'cernet', '河北', '教育网IPv6').metrics.latency.value, 134);
  assert.equal(pick(parsed, 'cernet', '山西', '教育网IPv6').metrics.loss.value, 1);
  // 只喂了 cernet 一段，其余维度缺失的提示是正常的；这里只关心有没有结构类告警
  assert.deepEqual(parsed.warnings.filter(warning => /列结构|重复|未猜测/.test(warning)), []);
});

test('双栈报告的国际节点有 IPv4 / IPv6 两张同名表，不能被当作重复记录丢弃', () => {
  const parsed = parseReport(fakeHtml([['intl', [
    ['区域', '节点-IPv4', '下载延迟', '下载重传', '上传延迟', '上传重传'],
    ['亚洲', '香港', '201ms', '0', '198ms', '0'],
    ['区域', '节点-IPv6', '下载延迟', '下载重传', '上传延迟', '上传重传'],
    ['亚洲', '香港', '235ms', '0', '236ms', '0'],
    [STAMP]
  ]]]), 'x');
  assert.equal(parsed.records.filter(record => record.section === 'intl').length, 2, '同名目标的两张表都应保留');
  assert.equal(pick(parsed, 'intl', '香港', 'IPv4').metrics.downloadLatency.value, 201);
  assert.equal(pick(parsed, 'intl', '香港', 'IPv6').metrics.downloadLatency.value, 235);
  assert.deepEqual(parsed.warnings.filter(warning => /列结构|重复|未猜测/.test(warning)), []);
});

test('单栈报告的教育网回程仍是单列，carrier 保持 教育网', () => {
  const parsed = parseReport(fakeHtml([['cernet', [
    ['CERNET-IPv4', '零丢包: 30', '1-20%:  1', '>20%:  0'],
    ['教育网概览', 'CERNET-IPv4'],
    ['河北', 'Tata->Arelion', '179ms', '0%'],
    [STAMP]
  ]]]), 'x');
  assert.equal(pick(parsed, 'cernet', '河北', '教育网').metrics.latency.value, 179);
  assert.equal(pick(parsed, 'cernet', '河北', '教育网').metrics.route.value, 'Tata->Arelion');
});

test('值是 -1 这类失败哨兵时按未知处理，不能当成最小延迟', () => {
  // 报告用 -1ms 表示"测不出来"（同行丢包通常 100%）。若按数值处理，
  // 它会成为全场最小延迟，在热力图里被渲染成最优线路。
  const parsed = parseReport(fakeHtml([['ipv4', [
    ['河北', '4837', '-1ms', '100%', '/', '4837', '150ms', '0%', '/', '4837', '160ms', '0%'],
    ['山西', '4837', '170ms', '0%', '/', '4837', '-1ms', '-1%', '/', '4837', '180ms', '0%'],
    [STAMP]
  ]]]), 'x');
  const failed = pick(parsed, 'ipv4', '河北', '电信');
  assert.equal(failed.metrics.latency.status, 'unknown', '失败测量不应标为 ok');
  assert.equal(failed.metrics.latency.raw, '-1ms', '应保留原值供核对');
  assert.equal(failed.metrics.latency.value, '-1ms', '不应产出数值');
  assert.equal(pick(parsed, 'ipv4', '河北', '联通').metrics.latency.value, 150, '相邻列不受影响');
  assert.equal(pick(parsed, 'ipv4', '山西', '联通').metrics.loss.status, 'unknown');
  assert.ok(parsed.warnings.some(warning => warning.includes('不按零处理')));
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

test('分隔符位置异常时整行拒绝解析，不按位移猜测', () => {
  // 江苏行第二个分隔符（x=610）替换为普通文本：filter 后仍是 10 格，
  // 旧实现会把它当作 12 格行继续解析并静默左移，且不产生任何告警。
  const separator = '<text x="610" y="329.84" fill="#d8d2b8">/</text>';
  assert.ok(html.includes(separator), '定位分隔符失败，测试将失去意义');
  const parsed = parseReport(html.replace(separator, '<text x="610" y="329.84" fill="#d8d2b8">X</text>'), 'x');
  assert.equal(pick(parsed, 'ipv4', '江苏', '移动'), undefined, '结构不可信时不应产出记录');
  assert.ok(parsed.warnings.some(warning => warning.includes('江苏') && warning.includes('列结构异常')));
});

test('线路本身为 / 时不吞掉整行，也不把后续列左移', () => {
  // 运营商线路缺失：分隔符仍在原位，仅电信线路内容变为 /
  const route = '<text x="210" y="329.84" text-anchor="end" fill="#d8d2b8">4837</text>';
  assert.ok(html.includes(route), '定位线路失败，测试将失去意义');
  const parsed = parseReport(html.replace(route, '<text x="210" y="329.84" text-anchor="end" fill="#d8d2b8">/</text>'), 'x');
  const record = pick(parsed, 'ipv4', '江苏', '电信');
  assert.ok(record, '该省其余运营商的数据不应被整行丢弃');
  assert.equal(record.metrics.route.value, '/', '线路缺失应保留原值');
  assert.equal(record.metrics.latency.value, 188, '延迟应仍取本运营商自己的列');
  assert.equal(record.metrics.loss.value, 4);
  assert.equal(pick(parsed, 'ipv4', '江苏', '联通').metrics.latency.value, 173, '相邻运营商不应左移');
});
