import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTqCsv, csvFingerprint } from '../lib/csv-parser.mjs';
import { parseReport, compareReports } from '../lib/parser.mjs';

// 真实样本：run-with-hub.sh 从一台 VPS 直传上来的 CSV（默认三网，仅 IPv4）
const csv = readFileSync(new URL('./fixtures/tq-ipv4.csv', import.meta.url), 'utf8');
const html = readFileSync(new URL('./fixtures/report.html', import.meta.url), 'utf8');
const meta = { sourceUrl: 'csv:test', testedAt: '2026-10-04T01:02:27+08:00', identity: 'vps · 203.0.113.7' };
const parse = (text = csv) => parseTqCsv(text, meta);
const header = csv.split('\n')[0];
const rowsOf = network => csv.split('\n').slice(1).filter(Boolean).map(line => line.replace(/^三网,IPv4,/, network));

test('真实 CSV 解析出 31 省 × 三网，带上测试时间与来源', () => {
  const report = parse();
  assert.equal(report.records.length, 93);
  assert.deepEqual(report.sections.map(section => section.id), ['ipv4']);
  assert.equal(report.sourceType, 'csv');
  assert.equal(report.testedAt, meta.testedAt);
  assert.equal(report.identity, meta.identity);
  const anhui = report.records.find(record => record.target === '安徽' && record.carrier === '联通');
  assert.deepEqual(anhui.metrics.loss, { value: 4, unit: '%', status: 'ok', raw: '4.00' });
  assert.equal(anhui.metrics.latency.unit, 'ms');
  assert.equal(anhui.metrics.route.value, '4837');
});

test('探针主动跳过的行（状态 SKIP）单独标状态，不混进"缺失、失败或未知格式"', () => {
  // 真实案例：某台机器的大包回程整段被探针跳过（状态 SKIP、线路 Hidden），
  // 如果按"读数缺失"处理，界面会建议重传一份本来就跳过这段的报告。
  const text = [header,
    ...rowsOf('三网,IPv4,'),
    ...rowsOf('IPv4大包,IPv4,').map(line => line.replace(',OK,', ',SKIP,')),
    'CERNET,IPv4,河北,教育网,he-edu.example,1.1.1.1,OK,25,25,0.00,190.000,4538'
  ].join('\n');
  const report = parse(text);
  const skippedRows = report.records.filter(record => record.section === 'large4');
  assert.equal(skippedRows.length, 93);
  assert.ok(skippedRows.every(record => record.status === 'skipped'));
  assert.ok(skippedRows.every(record => record.metrics.latency.status === 'skipped' && record.metrics.retrans.status === 'skipped'));
  // 93 条 × (延迟 + 重传)
  assert.ok(report.warnings.some(warning => /^186 个指标由探针主动跳过（状态 SKIP）/.test(warning)));
  assert.ok(!report.warnings.some(warning => /缺失、失败或未知格式/.test(warning)));
  // 正常行不受影响，不该被顺手打上 skipped
  assert.ok(report.records.filter(record => record.section === 'ipv4').every(record => !record.status));
});

test('国际互联上传下载一条 SKIP 时保留另一方向的有效读数', () => {
  const lines = [header,
    '国际互联,IPv4,节点,延迟,,203.0.113.1,OK,1,1,0,100,线路,,,,,2,download',
    '国际互联,IPv4,节点,延迟,,203.0.113.1,SKIP,1,1,0,100,Hidden,,,,,2,upload'
  ];
  const record = parseTqCsv(lines.join('\n'), meta).records[0];
  assert.equal(record.metrics.downloadLatency.status, 'ok');
  assert.equal(record.metrics.uploadLatency.status, 'skipped');
  assert.equal(record.status, undefined);
});

test('记录 key 与单位和链接导入的网页报告一致，可以直接做变化对比', () => {
  const fromCsv = parse();
  const fromHtml = parseReport(html, 'https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM');
  const htmlKeys = new Set(fromHtml.records.filter(record => record.section === 'ipv4').map(record => record.key));
  assert.ok(fromCsv.records.every(record => htmlKeys.has(record.key)), 'CSV 的 key 必须能在网页报告里找到');
  // 93 条 × 延迟 + 丢包，单位不一致的指标会被 compareReports 跳过
  assert.equal(compareReports(fromCsv, fromHtml).length, 186);
});

test('大包记作重传、IPv6 归入 ipv6、教育网双栈按运营商名区分', () => {
  const text = [header, ...rowsOf('三网,IPv4,'), ...rowsOf('IPv4大包,IPv4,'), ...rowsOf('三网,IPv6,'),
    'CERNET,IPv4,河北,教育网,he-edu.example,1.1.1.1,OK,25,25,0.00,190.000,4538',
    'CERNET2,IPv6,河北,教育网,he-edu6.example,::1,OK,25,25,0.00,200.000,4538'].join('\n');
  const report = parse(text);
  assert.deepEqual(report.sections.map(section => section.id), ['ipv4', 'large4', 'ipv6', 'cernet']);
  const large = report.records.find(record => record.section === 'large4');
  assert.ok(large.metrics.retrans && !large.metrics.loss, '大包第三列是重传，不能记成丢包');
  assert.equal(report.records.filter(record => record.section === 'ipv6').length, 93);
  const cernet = report.records.filter(record => record.section === 'cernet');
  assert.deepEqual(cernet.map(record => [record.group, record.carrier]), [['CERNET-IPv4', '教育网'], ['CERNET2-IPv6', '教育网IPv6']]);
});

test('探测失败的 0 延迟按失败处理，不被当成最优线路', () => {
  const text = [header, '三网,IPv4,河北,电信,he-ct.example,1.1.1.1,FAIL,25,0,100.00,0.000,'].join('\n');
  const record = parse(text).records[0];
  assert.equal(record.metrics.latency.status, 'unknown');
  assert.equal(record.metrics.loss.value, 100);
  assert.ok(parse(text).warnings.some(text => text.includes('不按零处理')));
});

// 一次完整测试（菜单一路回车）的真实样本：三网 / 大包 / 教育网 / 国际互联 / 单线程测速都在同一份 CSV 里
const full = readFileSync(new URL('./fixtures/tq-full.csv', import.meta.url), 'utf8');
const find = (report, section, group, target, carrier = '') => report.records.find(record => record.section === section && record.group === group && record.target === target && record.carrier === carrier);
const values = record => Object.fromEntries(Object.entries(record.metrics).map(([key, metric]) => [key, metric.status === 'unknown' ? null : metric.value]));

test('完整 CSV 解析出五个维度，唯一提示是 IPv6 国际节点全部失败', () => {
  const report = parse(full);
  assert.deepEqual(report.sections.map(section => section.id), ['ipv4', 'large4', 'cernet', 'intl', 'speedtest']);
  assert.equal(report.records.length, 290);
  // 12 个 IPv6 国际节点 × 4 项指标均为 FAIL
  assert.deepEqual(report.warnings, ['48 个指标为缺失、失败或未知格式，已保留原值，不按零处理']);
});

test('完整 CSV 的 key 与单位和网页报告一致：五个维度都能做变化对比', () => {
  const fromCsv = parse(full);
  const fromHtml = parseReport(html, 'https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM');
  const htmlKeys = new Set(fromHtml.records.map(record => record.key));
  // 网页样本是单栈报告，没有 IPv6 国际节点；其余每个 key 都必须对得上
  assert.deepEqual(fromCsv.records.filter(record => !htmlKeys.has(record.key)).map(record => `${record.group}/${record.carrier}`), Array(12).fill('国际节点/IPv6'));
  const comparable = {};
  for (const change of compareReports(fromCsv, fromHtml)) comparable[change.section] = (comparable[change.section] || 0) + 1;
  assert.deepEqual(comparable, { ipv4: 186, large4: 186, cernet: 62, intl: 126, speedtest: 50 });
});

test('单线程测速：上传为回程、下载为去程，延迟取 TLS 握手耗时的一半', () => {
  const report = parse(full);
  // 原始行：北京,电信,…,OK,492.2,0.00%,3.0,,,338,368,358,368
  assert.deepEqual(values(find(report, 'speedtest', 'IPv4', '北京电信')), { returnRetrans: 0, returnSpeed: 492.2, outboundSpeed: 3, returnLatency: 184, outboundLatency: 184 });
  // Apple 行字段顺序不同：发送=上传，收到=下载重传，丢包率列=下载；…,520.7,0.00%,431.0,,,5,74,4,187
  assert.deepEqual(values(find(report, 'speedtest', '国际方向', 'Apple IPv4')), { downloadRetransRate: 0, downloadSpeed: 431, uploadSpeed: 520.7, downloadLatency: 93.5, uploadLatency: 37 });
});

test('测速失败或 TLS 缺失：速度记为未知，延迟退回连接耗时', () => {
  const text = [header,
    '三网单线程速度,上海,电信,上海,,,FAIL,failed,-,failed,,,300,-,-,-',
    '三网单线程速度,IPv6,深圳移动,深圳移动,240e::1,,OK,100.5,1.20%,20.0,,,200,220,210,230'].join('\n');
  const report = parse(text);
  assert.deepEqual(values(find(report, 'speedtest', 'IPv4', '上海电信')), { returnRetrans: null, returnSpeed: null, outboundSpeed: null, returnLatency: 150, outboundLatency: null });
  assert.deepEqual(values(find(report, 'speedtest', 'IPv6', '深圳移动')), { returnRetrans: 1.2, returnSpeed: 100.5, outboundSpeed: 20, returnLatency: 110, outboundLatency: 115 });
});

test('国际节点的上传、下载两行合并成一条，IPv6 单独成行', () => {
  const report = parse(full);
  assert.deepEqual(values(find(report, 'intl', '国际节点', '加拿大-蒙特利尔', 'IPv4')), { downloadLatency: 62.6, downloadRetrans: 0, uploadLatency: 62.5, uploadRetrans: 0 });
  assert.deepEqual(values(find(report, 'intl', '国际节点', '加拿大-蒙特利尔', 'IPv6')), { downloadLatency: null, downloadRetrans: null, uploadLatency: null, uploadRetrans: null });
  const duplicate = parse([header,
    '国际互联,IPv4,香港,延迟,hk.example,1.1.1.1,OK,0,0,0.00,146.000,iPerf3,亚洲,asia,,,0,upload',
    '国际互联,IPv4,香港,延迟,hk.example,1.1.1.1,OK,0,0,0.00,150.000,iPerf3,亚洲,asia,,,0,upload'].join('\n'));
  assert.equal(find(duplicate, 'intl', '国际节点', '香港', 'IPv4').metrics.uploadLatency.value, 146);
  assert.ok(duplicate.warnings.some(text => text.includes('上传方向出现重复记录')));
});

test('网站与 CDN：可达性按状态标记，延迟保留 CSV 原精度', () => {
  const report = parse([header,
    '国际互联,IPv4,Adobe Assets,网站,assets.adobe.com,1.1.1.1,OK,30,30,0.00,2.180,TCP443',
    '国际互联,IPv4,Akamai Edge,CDN,a.example,1.1.1.1,FAIL,15,0,100.00,0.000,TCP443'].join('\n'));
  assert.deepEqual(values(find(report, 'intl', '常用网站', 'Adobe Assets')), { domain: 'assets.adobe.com', reachable: '✓', latency: 2.18, retrans: 0 });
  assert.deepEqual(values(find(report, 'intl', '常用 CDN', 'Akamai Edge')), { domain: 'a.example', reachable: '✗', latency: null, retrans: 100 });
});

test('BOM 与换行风格不影响指纹：同一份数据重传能被识别', () => {
  const crlf = csv.replace(/^﻿/, '').replace(/\n/g, '\r\n');
  assert.equal(csvFingerprint(csv), csvFingerprint(crlf));
  assert.equal(parse(csv).fingerprint, csvFingerprint(crlf));
});

test('没有可识别的数据、缺列、缺测试时间时拒绝解析', () => {
  assert.throws(() => parse([header, '未知类型,IPv4,河北,电信,x,,OK,1,1,0,1,'].join('\n')), /没有可解析的数据/);
  assert.throws(() => parse('网络,IP版本,省份\n三网,IPv4,河北'), /缺少/);
  assert.throws(() => parseTqCsv(csv, { ...meta, testedAt: '' }), /测试时间/);
});
