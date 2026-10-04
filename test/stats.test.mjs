import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, statsOf, bandsOf } from '../lib/stats.mjs';

const num = value => ({ value, unit: 'ms', status: 'ok', raw: String(value) });
const lat = value => num(value);
// 一份报告：给定「省份 → 运营商 → 延迟」的构造器
const makeReport = (id, nodeId, testedAt, spec) => ({
  id,
  nodeId,
  testedAt,
  records: Object.entries(spec).flatMap(([carrier, values]) =>
    values.map(([province, value]) => ({ section: 'ipv4', group: '国内三网', target: province, carrier, metrics: { latency: lat(value), loss: num(0) } }))
  )
});
const nodes = [
  { id: 'n1', name: '机器甲', region: 'HK', enabled: true },
  { id: 'n2', name: '机器乙', region: 'HK', enabled: true },
  { id: 'n3', name: '机器丙', region: 'HK', enabled: true },
  { id: 'n4', name: '机器丁', region: 'US', enabled: true }
];
// 甲：10 份报告、每份 3 条全 50ms（共 30 条）；乙 1 份 100ms；丙 1 份 300ms
const reports = [
  ...Array.from({ length: 10 }, (_, index) => makeReport(`a${index}`, 'n1', `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00+08:00`, {
    电信: [['广东', 50]], 联通: [['广东', 50]], 移动: [['广东', 50]]
  })),
  makeReport('b1', 'n2', '2026-10-15T00:00:00+08:00', { 电信: [['广东', 100]], 联通: [['广东', 100]], 移动: [['广东', 100]] }),
  makeReport('c1', 'n3', '2026-10-16T00:00:00+08:00', { 电信: [['广东', 300]], 联通: [['广东', 300]], 移动: [['广东', 300]] }),
  makeReport('d1', 'n4', '2026-10-16T00:00:00+08:00', { 电信: [['广东', 175]], 联通: [['广东', 175]], 移动: [['广东', 175]] })
];

test('汇总单位是机器：一台机器的多份报告倒在一起算', () => {
  const groups = aggregate({ nodes, reports, group: 'node', section: 'ipv4' });
  const jia = groups.find(group => group.key === 'n1');
  assert.equal(jia.reports, 10, '机器甲名下 10 份报告应归到同一组');
  assert.equal(jia.samples, 30, '10 份 × 3 个运营商 = 30 条样本');
  assert.equal(jia.latency.p50, 50);
  assert.deepEqual(jia.testedAt, { first: '2026-10-01T00:00:00+08:00', last: '2026-10-10T00:00:00+08:00' });
});

test('跨机器汇总每台等权：报告多的机器不会把区域数字带偏', () => {
  // 甲有 30 条样本全是 50ms，乙 3 条 100ms，丙 3 条 300ms。
  // 若按记录条数池化，30 条 50ms 会把中位数压到 50；等权则应是三台机器 p50 的中位数 100。
  const region = aggregate({ nodes, reports, group: 'region', section: 'ipv4' }).find(group => group.key === 'HK');
  assert.equal(region.nodes, 3);
  assert.equal(region.latency.p50, 100, '等权取各机器 p50 的中位数，而不是把所有记录倒进一个池子');
  assert.deepEqual(region.worstMachines.map(item => item.label), ['机器丙', '机器乙', '机器甲'], '最差机器要能直接下钻');
});

test('group=node 给出分运营商 p50，这是判断哪家绕路的唯一依据', () => {
  const records = [makeReport('x1', 'n1', '2026-10-01T00:00:00+08:00', { 电信: [['广东', 80]], 联通: [['广东', 82]], 移动: [['广东', 201]] })];
  const group = aggregate({ nodes, reports: records, group: 'node', section: 'ipv4' })[0];
  assert.equal(group.byCarrier.电信.p50, 80);
  assert.equal(group.byCarrier.移动.p50, 201, '移动整体绕路要能一眼看出来');
  assert.equal(group.byCarrier.移动.n, 1);
});

test('group=report 是时间序列，不展开 byCarrier（17 份 × 3 家太吵）', () => {
  const series = aggregate({ nodes, reports, group: 'report', section: 'ipv4' });
  assert.equal(series.length, 13, '10 份甲 + 乙 + 丙 + 丁');
  assert.equal(series[0].byCarrier, undefined, '时间序列不按运营商展开');
  assert.equal(series[0].testedAt, '2026-10-01T00:00:00+08:00', '按测试时间正序');
  assert.ok(series.at(-1).testedAt > series[0].testedAt);
});

test('group=carrier 跨机器看运营商整体质量', () => {
  const groups = aggregate({ nodes, reports, group: 'carrier', section: 'ipv4' });
  const keys = groups.map(group => group.key);
  assert.deepEqual(new Set(keys), new Set(['电信', '联通', '移动']));
});

test('group=carrier 每组用该运营商自己的数值，不能三个运营商返回同一个数', () => {
  // 回归守卫：曾经 rollUp 写死 machine.latency.p50（整机值），三个运营商结果完全相同
  const records = [makeReport('y1', 'n1', '2026-10-01T00:00:00+08:00', { 电信: [['广东', 80]], 联通: [['广东', 82]], 移动: [['广东', 201]] })];
  const groups = aggregate({ nodes, reports: records, group: 'carrier', section: 'ipv4' });
  const byKey = Object.fromEntries(groups.map(group => [group.key, group]));
  assert.equal(byKey.电信.latency.p50, 80);
  assert.equal(byKey.移动.latency.p50, 201);
  assert.notEqual(byKey.电信.latency.p50, byKey.移动.latency.p50, '运营商之间必须区分得开');
  assert.equal(byKey.移动.samples, 1, '样本数也只算该运营商自己的线路');
  assert.deepEqual(byKey.移动.worstMachines.map(item => item.p50), [201], 'worstMachines 同样按该运营商排序');
});

test('group=carrier 的丢包也只算该运营商自己的线路', () => {
  const records = [{
    id: 'z1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(50), loss: num(0) } },
      { section: 'ipv4', group: '国内三网', target: '江苏', carrier: '联通', metrics: { latency: lat(60), loss: num(30) } }
    ]
  }];
  const groups = aggregate({ nodes, reports: records, group: 'carrier', section: 'ipv4' });
  const byKey = Object.fromEntries(groups.map(group => [group.key, group]));
  assert.equal(byKey.电信.loss.lines, 0, '电信那条零丢包');
  assert.equal(byKey.联通.loss.lines, 1, '丢包 30% 的是联通那条');
  assert.equal(byKey.联通.loss.worst, 30);
});

test('group=report 每份报告都能算出延迟（曾经把 report.section 当维度名，导致全为 null）', () => {
  const series = aggregate({ nodes, reports, group: 'report', section: 'ipv4' });
  assert.equal(series.length, 13);
  assert.ok(series.every(group => group.latency && typeof group.latency.p50 === 'number'), '不允许出现 latency 为 null 的条目');
});

test('丢包比例按线路数算，重度与最差单独给出', () => {
  const records = [{
    id: 'p1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(50), loss: num(0) } },
      { section: 'ipv4', group: '国内三网', target: '江苏', carrier: '电信', metrics: { latency: lat(60), loss: num(4) } },
      { section: 'ipv4', group: '国内三网', target: '浙江', carrier: '电信', metrics: { latency: lat(70), loss: num(48) } }
    ]
  }];
  const group = aggregate({ nodes, reports: records, group: 'node', section: 'ipv4' })[0];
  assert.equal(group.loss.lines, 2, '有丢包的线路数');
  assert.equal(group.loss.ratio, 0.6667, '比例 = 有丢包 / 总线路数');
  assert.equal(group.loss.severe, 1, '≥10% 的算重度');
  assert.equal(group.loss.worst, 48);
});

test('section 决定丢包取哪个指标；双栈的教育网只统计 IPv4 一侧', () => {
  const records = [{
    id: 'm1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'cernet', group: 'CERNET-IPv4', target: '广东', carrier: '教育网IPv4', metrics: { latency: lat(60), loss: num(0) } },
      { section: 'cernet', group: 'CERNET2-IPv6', target: '广东', carrier: '教育网IPv6', metrics: { latency: lat(35), loss: num(0) } },
      { section: 'large4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(50), retrans: num(12) } }
    ]
  }];
  const cernet = aggregate({ nodes, reports: records, group: 'node', section: 'cernet' })[0];
  assert.equal(cernet.samples, 1, 'IPv6 那条要被排除，否则基数翻倍');
  assert.equal(cernet.latency.p50, 60);
  assert.equal(cernet.loss.lines, 0);
  const large4 = aggregate({ nodes, reports: records, group: 'node', section: 'large4' })[0];
  assert.equal(large4.loss.lines, 1, '大包维度取 retrans 而不是 loss');
  assert.equal(large4.loss.worst, 12);
});

test('测速永远取 speedtest 维度，与 section 无关', () => {
  const records = [{
    id: 's1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(50), loss: num(0) } },
      { section: 'speedtest', group: 'IPv4', target: '北京电信', carrier: '', metrics: { returnSpeed: { value: 171, unit: 'Mbps', status: 'ok', raw: '' }, outboundSpeed: { value: 4.2, unit: 'Mbps', status: 'ok', raw: '' } } }
    ]
  }];
  const group = aggregate({ nodes, reports: records, group: 'node', section: 'ipv4' })[0];
  assert.equal(group.speed.returnP50, 171);
  assert.equal(group.speed.outboundP50, 4.2, '去程 4.2 Mbps 这种问题要能从聚合里直接看到');
});

test('档位按各机器自己的区域基准判定', () => {
  const groups = aggregate({ nodes, reports, group: 'node', section: 'ipv4' });
  assert.equal(groups.find(g => g.key === 'n1').level, 'good', '香港机器 50ms → 好');
  assert.equal(groups.find(g => g.key === 'n3').level, 'bad', '香港机器 300ms → 差');
  assert.equal(groups.find(g => g.key === 'n4').level, 'good', '美国机器 175ms → 好（美国档 好≤175）');
});

test('since / until / region / carrier 过滤生效', () => {
  assert.equal(aggregate({ nodes, reports, group: 'node', section: 'ipv4', since: '2026-10-11' }).length, 3, '只看 10-11 之后');
  assert.equal(aggregate({ nodes, reports, group: 'node', section: 'ipv4', region: 'US' }).length, 1);
  assert.equal(aggregate({ nodes, reports, group: 'node', section: 'ipv4', node: 'n1' }).length, 1, '指定机器只剩一组');
});

test('group=report + carrier：首条记录是别家时不漏报告（曾经 find 只验第一条）', () => {
  const records = [makeReport('f1', 'n1', '2026-10-01T00:00:00+08:00', { 电信: [['广东', 80]], 联通: [['广东', 201]] })];
  assert.equal(aggregate({ nodes, reports: records, group: 'report', section: 'ipv4', carrier: '联通' }).length, 1, '报告里有联通记录就必须出现');
});

test('group=node + carrier：顶层全部换成该运营商口径（n、p50、level、loss 一致）', () => {
  const records = [{
    id: 'g1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(50), loss: lat(0) } },
      { section: 'ipv4', group: '国内三网', target: '江苏', carrier: '电信', metrics: { latency: lat(60), loss: lat(0) } },
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '联通', metrics: { latency: lat(300), loss: lat(30) } }
    ]
  }];
  const machine = aggregate({ nodes, reports: records, group: 'node', section: 'ipv4', carrier: '联通' })[0];
  assert.equal(machine.latency.p50, 300, '顶层 p50 必须是联通自己的，不是两池池化');
  assert.equal(machine.latency.n, 1, 'n 与 p50 必须同源，不能 n=1 配多池 p50');
  assert.equal(machine.samples, 1);
  assert.equal(machine.level, 'bad', '香港机器联通 300ms 必须按联通自己的值判级');
  assert.equal(machine.loss.lines, 1);
  assert.equal(machine.loss.worst, 30, '丢包也只算联通那条，不能把电信的带进来');
  assert.equal(machine.byCarrier['联通'].min, 300, 'byCarrier 保留全分位');
});

test('group=region：丢包字段必须为数值（曾经 spread 错字段名，NaN 落进 JSON 变 null）', () => {
  const records = [{
    id: 'rl1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(80), loss: lat(0) } },
      { section: 'ipv4', group: '国内三网', target: '江苏', carrier: '联通', metrics: { latency: lat(90), loss: lat(48) } }
    ]
  }];
  const region = aggregate({ nodes, reports: records, group: 'region', section: 'ipv4' })[0];
  assert.equal(region.loss.lines, 1, '有丢包的线路要数出来，不能是 null');
  assert.equal(region.loss.worst, 48);
  assert.equal(region.loss.severe, 1, '48% ≥10% 要计入重度');
  assert.equal(typeof region.loss.ratio, 'number');
  JSON.parse(JSON.stringify(region)); // NaN 会在序列化时变成 null，这一行保证上面断言的是真实数值
});

test('group=carrier：worstMachines 的 level 与展示的 p50 同口径重判', () => {
  const records = [{
    id: 'w1', nodeId: 'n1', testedAt: '2026-10-01T00:00:00+08:00',
    records: [
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '电信', metrics: { latency: lat(300), loss: lat(0) } },
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '联通', metrics: { latency: lat(50), loss: lat(0) } },
      { section: 'ipv4', group: '国内三网', target: '广东', carrier: '移动', metrics: { latency: lat(50), loss: lat(0) } }
    ]
  }];
  const dx = aggregate({ nodes, reports: records, group: 'carrier', section: 'ipv4' }).find(group => group.key === '电信');
  assert.equal(dx.worstMachines[0].p50, 300);
  assert.equal(dx.worstMachines[0].level, 'bad', '300ms 旁边不能贴整机判出的 good');
});

test('bandsOf 给全量基准，校准状态用标记区分（与 insight 的 latencyBands 同口径）', () => {
  const bands = bandsOf();
  assert.equal(bands.HK.calibrated, true);
  assert.equal(bands.SG.calibrated, false, '未校准区域也要回档位，否则消费方查不到数字');
  assert.equal(typeof bands.US.good, 'number');
});

test('statsOf 给出分位与离散度，空输入返回 null', () => {
  const s = statsOf([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(s.n, 9);
  assert.equal(s.p50, 50);
  assert.equal(s.min, 10);
  assert.equal(s.max, 90);
  assert.equal(s.spread, s.p90 - s.p50);
  assert.equal(statsOf([]), null);
  assert.equal(statsOf(['x', null]), null, '非数值不进统计，全被滤掉时与空输入同样返回 null');
});

test('分位用 nearest-rank 而非插值：偶数个样本取偏上的那个（与卡片口径一致）', () => {
  // 这是刻意的：insight.mjs 的卡片用同一套算法，两处不能算出不同结论
  assert.equal(statsOf([50, 300]).p50, 300);
});
