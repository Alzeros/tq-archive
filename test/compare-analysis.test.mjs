import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSourceIp,
  timeBucket,
  summarizeReportSnapshot,
  compactSnapshot,
  buildCompactDiff,
  analyzeComparison
} from '../lib/compare-analysis.mjs';
import { compareReports } from '../lib/parser.mjs';
import { isSignificantChange } from '../lib/thresholds.mjs';

const ok = (value, unit = '') => ({ value, unit, status: 'ok', raw: `${value}${unit}` });
const txt = value => ({ value, unit: '', status: 'text', raw: value });

const PROVINCES = ['北京', '上海', '广东', '江苏', '浙江', '湖北', '四川', '陕西'];

function makeFullReport({
  id,
  testedAt,
  sourceIp = '',
  identity = '',
  ctLat = 45,
  cuLat = 185,
  cmLat = 58,
  cuRoute = '163',
  lossCount = 0,
  retransPct = 0,
  returnSpeed = 210,
  intlLat = 175,
  unreachable = false,
  cernetLoss = 0,
  outliers = {}
} = {}) {
  const records = [];
  for (const [idx, prov] of PROVINCES.entries()) {
    const ctV = outliers[`${prov}:电信`] ?? (ctLat + idx);
    const cuV = outliers[`${prov}:联通`] ?? (cuLat + idx);
    const cmV = outliers[`${prov}:移动`] ?? (cmLat + idx);
    for (const [carrier, lat, route] of [['电信', ctV, 'CN2'], ['联通', cuV, cuRoute], ['移动', cmV, 'CMI']]) {
      const lossVal = (carrier === '联通' && idx < lossCount) ? 12 : 0;
      records.push({
        key: JSON.stringify(['ipv4', '国内三网', prov, carrier]),
        section: 'ipv4',
        group: '国内三网',
        target: prov,
        carrier,
        metrics: { route: txt(route), latency: ok(lat, 'ms'), loss: ok(lossVal, '%') }
      });
      const retVal = (carrier === '移动' && idx < lossCount && retransPct > 0) ? retransPct : 0;
      records.push({
        key: JSON.stringify(['large4', '国内三网', prov, carrier]),
        section: 'large4',
        group: '国内三网',
        target: prov,
        carrier,
        metrics: { route: txt(route), latency: ok(lat + 2, 'ms'), retrans: ok(retVal, '%') }
      });
    }
    records.push({
      key: JSON.stringify(['cernet', 'CERNET-IPv4', prov, '教育网']),
      section: 'cernet',
      group: 'CERNET-IPv4',
      target: prov,
      carrier: '教育网',
      metrics: { route: txt('CERNET'), latency: ok(70 + idx, 'ms'), loss: ok(idx < 2 ? cernetLoss : 0, '%') }
    });
  }
  for (const [target, dLat] of [['香港', intlLat - 15], ['日本', intlLat], ['新加坡', intlLat + 10]]) {
    records.push({
      key: JSON.stringify(['intl', '国际节点', target, 'IPv4']),
      section: 'intl',
      group: '国际节点',
      target,
      carrier: 'IPv4',
      metrics: {
        downloadLatency: ok(dLat, 'ms'),
        downloadRetrans: ok(1, '次'),
        uploadLatency: ok(dLat + 4, 'ms'),
        uploadRetrans: ok(0, '次')
      }
    });
  }
  records.push({
    key: JSON.stringify(['intl', '常用网站', 'Google', '']),
    section: 'intl',
    group: '常用网站',
    target: 'Google',
    carrier: '',
    metrics: { domain: txt('google.com'), reachable: txt(unreachable ? '✗' : '✓'), latency: ok(unreachable ? 999 : 42, 'ms'), retrans: ok(0, '%') }
  });
  for (const carrier of ['电信', '联通', '移动']) {
    records.push({
      key: JSON.stringify(['speedtest', 'IPv4', `上海${carrier}`, '']),
      section: 'speedtest',
      group: 'IPv4',
      target: `上海${carrier}`,
      carrier: '',
      metrics: {
        returnRetrans: ok(0, '%'),
        returnSpeed: ok(returnSpeed, 'Mbps'),
        outboundSpeed: ok(returnSpeed + 40, 'Mbps'),
        returnLatency: ok(40, 'ms'),
        outboundLatency: ok(38, 'ms')
      }
    });
  }
  return {
    id,
    nodeId: 'hk-1',
    testedAt,
    identity,
    upload: sourceIp ? { sourceIp } : undefined,
    records
  };
}

test('extractSourceIp 支持上传来源、明文 IP 与 HTML 脱敏 IP', () => {
  assert.equal(extractSourceIp({ upload: { sourceIp: '156.239.13.146' }, identity: 'AS1 IP: 1.1.*.*' }), '156.239.13.146');
  assert.equal(extractSourceIp({ identity: 'host · 162.211.182.175' }), '162.211.182.175');
  assert.equal(extractSourceIp({ identity: 'AS209557 Geelinx Ltd    IP: 109.66.*.*' }), '109.66.*.*');
  assert.equal(extractSourceIp({ identity: 'host · 2001:db8::1' }), '2001:db8::1');
  assert.equal(extractSourceIp({}), '');
});

test('timeBucket 按北京时间区分白天、晚高峰与凌晨', () => {
  assert.equal(timeBucket('2026-11-17T09:26:00+08:00').id, 'day');
  assert.equal(timeBucket('2026-11-18T21:38:00+08:00').id, 'peak');
  assert.equal(timeBucket('2026-11-18T19:00:00Z').id, 'night'); // 03:00 CST
});

test('summarizeReportSnapshot 与 compactSnapshot 输出完整三网+国际快照并精简节点数组', () => {
  const report = makeFullReport({ id: 'r1', testedAt: '2026-11-17T09:26:00+08:00', sourceIp: '156.239.13.146' });
  const snap = summarizeReportSnapshot(report, { region: 'HK' });
  assert.equal(snap.region.code, 'HK');
  assert.equal(snap.carriers.电信.route, 'CN2');
  assert.equal(snap.carriers.联通.latencyLevel, 'bad');
  assert.equal(snap.intl.nodes.length, 3);
  const compact = compactSnapshot(snap);
  assert.equal(compact.intl.nodes, undefined);
  assert.equal(compact.intl.nodeCount, 3);
});

test('buildCompactDiff 与 analyzeComparison 聚类三网事件、识别 IP/时段差异与离群省、隔离教育网', () => {
  const before = makeFullReport({
    id: 'b',
    testedAt: '2026-11-17T09:26:00+08:00',
    sourceIp: '156.239.13.146',
    ctLat: 42,
    cuLat: 185,
    cuRoute: '163',
    lossCount: 0,
    retransPct: 0,
    returnSpeed: 213,
    cernetLoss: 0
  });
  const after = makeFullReport({
    id: 'a',
    testedAt: '2026-11-18T21:38:00+08:00',
    sourceIp: '162.211.182.175',
    ctLat: 44,
    cuLat: 50,
    cuRoute: '4837',
    lossCount: 4,
    retransPct: 45,
    returnSpeed: 34,
    cernetLoss: 30,
    outliers: { '湖北:联通': 260 }
  });
  const rawChanges = compareReports(after, before).map(c => ({
    ...c,
    significant: isSignificantChange(c.metric, c.delta, c.before, c.after)
  }));
  const diff = buildCompactDiff(after, before, { region: 'HK' });
  assert.equal(diff.ipChanged, true);
  assert.equal(diff.timeOfDayShift.changed, true);
  assert.equal(diff.verdict, 'mixed');
  assert.ok(diff.tags.some(t => t.text === 'IP 变更'));

  const analysis = analyzeComparison(after, before, rawChanges, { region: 'HK' });
  assert.equal(analysis.context.ipChanged, true);
  assert.equal(analysis.context.timeOfDayShift.beforeLabel, '白天');
  assert.equal(analysis.context.timeOfDayShift.afterLabel, '晚高峰');
  const cuBrief = analysis.brief.find(b => b.scope === '联通' && b.kind === 'latency');
  assert.ok(cuBrief, '应把多省联通延迟变化聚合成一条简报');
  assert.equal(cuBrief.severity, 'good');
  assert.ok(cuBrief.detail.includes('163 → 4837'));
  assert.ok(cuBrief.outliers.some(o => o.includes('湖北')), '应单独点名离群省份');
  assert.ok(!analysis.brief.some(b => b.scope === '教育网'), '教育网不应挤占主简报');
  assert.equal(analysis.secondaryBrief.length, 1);
  assert.equal(analysis.secondaryBrief[0].scope, '教育网');
  assert.ok(analysis.diffMatrices.some(m => m.id === 'ipv4'));
  assert.ok(analysis.diffMatrices.find(m => m.id === 'cernet')?.secondary);
});

test('analyzeComparison 在仅线路数上升但无显著单条恶化时不抛 TypeError，且热力图拦截单位不一致', () => {
  const before = makeFullReport({ id: 'b2', testedAt: '2026-11-17T10:00:00+08:00' });
  const after = makeFullReport({ id: 'a2', testedAt: '2026-11-18T10:00:00+08:00', lossCount: 4, retransPct: 0.2 });
  // 模拟：后份报告里记录有轻度丢包但单条变化被视为未进 significant changes，触发 lineDelta >= 3 && worsened.length === 0
  for (const r of after.records) {
    if (r.section === 'ipv4' && r.carrier === '电信' && ['北京', '上海', '广东', '江苏'].includes(r.target)) {
      r.metrics.loss = ok(0.4, '%');
    }
    if (r.section === 'ipv4' && r.target === '北京' && r.carrier === '电信') {
      r.metrics.latency = ok(1, 's'); // 人为制造单位不一致
    }
  }
  const analysis = analyzeComparison(after, before, [], { region: 'HK' });
  const lossBrief = analysis.brief.find(b => b.scope === 'IPv4 丢包');
  assert.ok(lossBrief);
  assert.match(lossBrief.detail, /新增 8 条/);
  const ipv4Matrix = analysis.diffMatrices.find(m => m.id === 'ipv4');
  const latMetric = ipv4Matrix.metrics.find(m => m.id === 'latency');
  const bjIdx = ipv4Matrix.rows.indexOf('北京');
  const ctIdx = ipv4Matrix.columns.indexOf('电信');
  assert.equal(latMetric.cells[bjIdx][ctIdx].delta, null);
  assert.equal(latMetric.cells[bjIdx][ctIdx].tone, 'na');
});
