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

test('国际互联与测速行暂不入库，但保留原始行并给出提示', () => {
  const text = [header, ...rowsOf('三网,IPv4,'),
    '国际互联,IPv4,Google,常用网站,www.google.com,1.1.1.1,OK,15,15,0.00,2.000,TCP443',
    '三网单线程速度,IPv4,电信,上海,1234,,OK,300,0.10,500,,,10,20,30,40'].join('\n');
  const report = parse(text);
  assert.ok(report.records.every(record => !['intl', 'speedtest'].includes(record.section)));
  assert.deepEqual(report.sections.map(section => section.id), ['ipv4', 'intl', 'speedtest']);
  assert.equal(report.rawRows.intl.length, 1);
  assert.ok(report.warnings.some(text => text.startsWith('国际互联 1 行暂未解析')));
  assert.ok(report.warnings.some(text => text.startsWith('单线程测速 1 行暂未解析')));
});

test('BOM 与换行风格不影响指纹：同一份数据重传能被识别', () => {
  const crlf = csv.replace(/^﻿/, '').replace(/\n/g, '\r\n');
  assert.equal(csvFingerprint(csv), csvFingerprint(crlf));
  assert.equal(parse(csv).fingerprint, csvFingerprint(crlf));
});

test('没有回程数据、缺列、缺测试时间时拒绝解析', () => {
  assert.throws(() => parse([header, '三网单线程速度,IPv4,电信,上海,1234,,OK,300,0.10,500,,'].join('\n')), /没有可解析的回程数据/);
  assert.throws(() => parse('网络,IP版本,省份\n三网,IPv4,河北'), /缺少/);
  assert.throws(() => parseTqCsv(csv, { ...meta, testedAt: '' }), /测试时间/);
});
