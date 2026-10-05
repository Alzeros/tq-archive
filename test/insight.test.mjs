import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, groupWarnings } from '../lib/insight.mjs';

const m = value => ({ value, unit: typeof value === 'number' ? 'ms' : '', status: typeof value === 'number' ? 'ok' : 'text', raw: String(value) });
const rec = (section, target, carrier, metrics) => ({ key: JSON.stringify([section, target, carrier]), section, group: '国内三网', target, carrier, metrics });
const report = records => ({ sections: [{ id: 'ipv4', name: 'IPv4 回程' }, { id: 'speedtest', name: '单线程测速' }], records });

test('热力图矩阵：行=省份，列=运营商，单元按矩阵内分位着色', () => {
  const result = summarize(report([
    rec('ipv4', '河北', '电信', { route: m('4837'), latency: m(150), loss: m(0) }),
    rec('ipv4', '河北', '联通', { route: m('4837'), latency: m(200), loss: m(0) }),
    rec('ipv4', '山西', '电信', { route: m('4837'), latency: m(140), loss: m(0) }),
    rec('ipv4', '山西', '联通', { route: m('4837'), latency: m(240), loss: m(1) })
  ]));
  assert.equal(result.matrices.length, 1);
  const matrix = result.matrices[0];
  assert.deepEqual(matrix.rows, ['河北', '山西']);
  assert.deepEqual(matrix.columns, ['电信', '联通']);
  const latency = matrix.metrics.find(item => item.id === 'latency');
  assert.equal(latency.cells[0][1].v, 200);
  assert.equal(latency.cells[0][1].l > latency.cells[0][0].l, true, '同一矩阵内更差的值应着更深');
  assert.equal(matrix.routes[0][0], '4837', 'route 单独存一份，不随指标重复');
});

test('测速矩阵：运营商拆列，速率高为好，缺失值不着色', () => {
  const speed = (target, metrics) => ({ ...rec('speedtest', target, '', Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { value, unit: key.includes('Speed') ? 'Mbps' : key.includes('Retrans') ? '%' : 'ms', status: 'ok', raw: String(value) }]))), group: 'IPv4' });
  const result = summarize(report([
    speed('上海电信', { returnSpeed: 502.3, outboundSpeed: 310.5, returnLatency: 150, outboundLatency: 160, returnRetrans: 0 }),
    speed('北京联通', { returnSpeed: 150, outboundSpeed: 90, returnLatency: 180, outboundLatency: 200, returnRetrans: 0.5 }),
    speed('广州移动', { returnSpeed: 45, outboundSpeed: null, returnLatency: 200, outboundLatency: 220, returnRetrans: 12 })
  ]));
  const matrix = result.matrices.find(item => item.id === 'speedtest');
  assert.ok(matrix, '测速记录应产出独立矩阵');
  assert.deepEqual(matrix.rows, ['上海', '北京', '广州']);
  assert.deepEqual(matrix.columns, ['电信', '联通', '移动']);
  const returnSpeed = matrix.metrics.find(item => item.id === 'returnSpeed');
  assert.equal(returnSpeed.unit, 'Mbps');
  assert.equal(returnSpeed.cells[0][0].v, 502.3);
  assert.equal(returnSpeed.cells[0][0].l, 0, '≥300Mbps 判好');
  assert.equal(returnSpeed.cells[1][1].l, 2, '150Mbps 判一般');
  assert.equal(returnSpeed.cells[2][2].l, 4, '45Mbps 判差');
  assert.equal(returnSpeed.cells[0][1].v, null, '无记录的组合不能画成数值');
  const outboundSpeed = matrix.metrics.find(item => item.id === 'outboundSpeed');
  assert.equal(outboundSpeed.cells[2][2].v, null, '失败指标保持中性，不冒充最低速');
  assert.equal(outboundSpeed.cells[2][2].l, null);
  assert.ok(result.speedRule.good > result.speedRule.fair, '速率阈值随 payload 带给前端');
});

test('速度离群用相对倍数检出，不依赖绝对阈值', () => {
  const speed = (target, value) => rec('speedtest', target, '', { returnSpeed: { value, unit: 'Mbps', status: 'ok', raw: `${value}Mbps` } });
  const result = summarize(report([
    { ...speed('北京电信', 480), group: 'IPv4' },
    { ...speed('上海电信', 2.2), group: 'IPv4' },
    { ...speed('广东电信', 490), group: 'IPv4' }
  ]));
  const hit = result.anomalies.find(item => item.text.includes('上海电信'));
  assert.ok(hit, '远低于同组中位数应被判为异常');
  assert.equal(hit.level, 'warn');
  assert.equal(hit.kind, 'speed-outlier');
  assert.match(hit.text, /不代表线路故障/);
});

test('延迟离群用 MAD 检出，正常波动不误报', () => {
  const base = [150, 155, 160, 165, 170, 175, 180];
  const records = base.map((value, index) => rec('ipv4', `省${index}`, '电信', { latency: m(value), loss: m(0) }));
  records.push(rec('ipv4', '异常省', '电信', { latency: m(400), loss: m(0) }));
  const result = summarize(report(records));
  const hit = result.anomalies.find(item => item.text.includes('异常省'));
  assert.ok(hit, '偏高中位数 230ms 应被判为离群');
  assert.ok(!result.anomalies.some(item => item.text.includes('省0')), '正常波动不应误报');
});

test('整份报告走同一条骨干时给出提示，多种骨干时不提示', () => {
  // 记录数不足 10 条不足以代表整份报告的骨干选择，不应提示
  const few = [rec('ipv4', '河北', '电信', { route: m('4837'), latency: m(150), loss: m(0) }), rec('ipv4', '山西', '电信', { route: m('4837'), latency: m(160), loss: m(0) })];
  assert.equal(summarize(report(few)).anomalies.some(item => item.text.includes('全部走')), false);
  const many = [];
  for (let index = 0; index < 12; index++) many.push(rec('ipv4', `省${index}`, '电信', { route: m('4837'), latency: m(150 + index), loss: m(0) }));
  assert.ok(summarize(report(many)).anomalies.some(item => item.text.includes('全部走 4837')), '12 条同骨干应提示');
  const mixed = many.map((item, index) => index < 6 ? item : { ...item, metrics: { ...item.metrics, route: m('4134') } });
  assert.ok(!summarize(report(mixed)).anomalies.some(item => item.text.includes('全部走')), '骨干不同不应提示');
});

test('延迟基准按机房区域选档：同一延迟在不同区域得到不同评级', () => {
  const records = Array.from({ length: 10 }, (_, index) => rec('ipv4', `省${index}`, '电信', { route: m('4837'), latency: m(200), loss: m(0) }));
  const gradeOf = region => summarize(report(records), { region }).cards.find(card => card.id === 'latency');
  assert.equal(gradeOf('DE').level, 'fair', '200ms 对德国机房属正常范围');
  assert.equal(gradeOf('US').level, 'fair', '200ms 对美国机房属正常范围');
  assert.equal(gradeOf('HK').level, 'bad', '200ms 对香港机房属异常');
  assert.equal(gradeOf('de').level, 'fair', 'region 大小写不敏感');
  assert.equal(gradeOf('').level, 'fair', '未给区域时退回兜底档，不报错');
  assert.equal(gradeOf('DE').basis, '德国基准：≤175 好，≤225 一般');
  assert.equal(gradeOf('').basis, '未知区域基准：≤160 好，≤215 一般');
});

test('热力图按区域基准判档，不再按报告内百分位 —— 健康的报告不该被染红', () => {
  // 一份"整体健康"的德国机房报告：全部落在德国基准的"好"区间内
  const records = Array.from({ length: 12 }, (_, index) => rec('ipv4', `省${index}`, '电信', { route: m('4837'), latency: m(150 + index), loss: m(0) }));
  const cells = summarize(report(records), { region: 'DE' }).matrices[0].metrics.find(item => item.id === 'latency').cells.flat();
  assert.equal(cells.every(cell => cell.l <= 1), true, '全部落在好区间时不应出现一般或差档');
  // 百分位着色会让最高值必然成为最深档，这正是需要避免的
  assert.equal(Math.max(...cells.map(cell => cell.l)) < 4, true);
});

test('同类解析提示按类归并，不逐条铺开', () => {
  const result = groupWarnings([
    '教育网回程 / 河北：列数不匹配，未猜测数据',
    '教育网回程 / 山西：列数不匹配，未猜测数据',
    '教育网回程 / 辽宁：列数不匹配，未猜测数据',
    '国际互联 / 香港 / IPv6 出现重复记录，已跳过',
    '国际互联 / 日本 / IPv6 出现重复记录，已跳过',
    '教育网回程 未解析出结构化记录，请检查原始文字'
  ]);
  assert.equal(result.total, 6);
  assert.equal(result.groups.length, 3, '3 条同类应归为一类而不是铺成 3 行');
  assert.deepEqual(result.groups[0], { scope: '教育网回程', title: '列数不匹配，未猜测数据', level: 'warn', count: 3, samples: ['河北', '山西', '辽宁'] });
  assert.equal(result.groups[0].samples.length, 3, '样例最多保留 5 个，避免又变成长串');
  assert.deepEqual(result.rest, []);
});

test('缺少维度与未知维度合并为同一行', () => {
  const result = groupWarnings(['报告没有 IPv6 回程 维度', '报告没有 教育网回程 维度', '未知维度 foo，仅保留原始文字']);
  assert.equal(result.groups.length, 2, '两个"缺少维度"应合成一行，未知维度单独一行');
  const missing = result.groups.find(group => group.title === '报告缺少该维度');
  assert.equal(missing.count, 2);
  assert.deepEqual(missing.samples, ['IPv6 回程', '教育网回程']);
});

test('旧版归档里没有维度名的提示也能归并', () => {
  // 早期版本产出的是「香港 /  出现重复记录，已跳过」（无维度名）。
  // 已归档报告的 warnings 是导入时落盘的字符串，改文案不会追溯修改它们。
  const result = groupWarnings(['香港 /  出现重复记录，已跳过', '日本 /  出现重复记录，已跳过']);
  assert.deepEqual(result.rest, [], '旧文案不能被丢进"其他"');
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].count, 2);
  assert.deepEqual(result.groups[0].samples, ['香港', '日本']);
});

test('parser 的每一类告警都能被归并规则识别，不会落进"其他"', () => {
  // 新增告警文案时若忘了补规则，这里会失败 —— 否则界面上会退化成一堵字墙
  const result = groupWarnings([
    '教育网回程 / 河北：列数不匹配，未猜测数据',
    'IPv4 回程 / 江苏 列结构异常，未猜测数据',
    'IPv4 回程 / 江苏 /  出现重复记录，已跳过',
    '报告没有 IPv6 回程 维度',
    '未知维度 foo，仅保留原始文字',
    '5 个指标为缺失、失败或未知格式，已保留原值，不按零处理',
    '教育网回程 未解析出结构化记录，请检查原始文字'
  ]);
  assert.deepEqual(result.rest, [], '有告警文案没被规则覆盖');
  assert.equal(result.groups.length, 7);
});

test('未识别的提示仍会展示，只是不参与归并', () => {
  const result = groupWarnings(['某个从未见过的提示']);
  assert.equal(result.groups.length, 0);
  assert.deepEqual(result.rest, ['某个从未见过的提示']);
  assert.equal(result.total, 1);
});

test('香港基准：良性运营商判好，整体绕路的移动判差', () => {
  // 实测数据：香港电信/联通 p90≈93（良性），移动整体 179-244ms（同省比电信差 120ms+，属绕路）
  const records = ['甲', '乙', '丙'].flatMap(province => [
    rec('ipv4', province, '电信', { route: m('4837'), latency: m(80), loss: m(0) }),
    rec('ipv4', province, '移动', { route: m('9929'), latency: m(200), loss: m(0) })
  ]);
  const result = summarize(report(records), { region: 'HK' });
  assert.equal(result.region.calibrated, true);
  assert.equal(result.region.good, 100);
  const cells = result.matrices[0].metrics.find(item => item.id === 'latency').cells;
  assert.equal(cells[0][0].l, 0, '80ms 在香港属良性线路');
  assert.equal(cells[0][1].l, 4, '200ms 是绕路，应判差');
});

test('某行某列缺数据时热力图留空，不能抛错也不能冒充最优', () => {
  // 实测里就有：法兰克福的教育网 IPv6 只有 30 个省（IPv4 有 31 个）。
  // 行列是各自去重出来的，空格子必须容忍，否则整个详情页会挂掉。
  const records = [
    rec('cernet', '河北', '教育网IPv4', { route: m('4837'), latency: m(150), loss: m(0) }),
    rec('cernet', '河北', '教育网IPv6', { route: m('4837'), latency: m(152), loss: m(0) }),
    rec('cernet', '山西', '教育网IPv4', { route: m('4837'), latency: m(160), loss: m(0) })
    // 山西 没有 IPv6 记录，矩阵会出现一个空格子
  ];
  const result = summarize(report(records), { region: 'DE' });
  const cells = result.matrices[0].metrics.find(item => item.id === 'latency').cells;
  assert.equal(result.matrices[0].columns.length, 2, '两个协议族都应成为列');
  assert.equal(cells[1][1].v, null, '缺失格子的值应为空');
  assert.equal(cells[1][1].l, null, '缺失不能落进最浅档，那等于把没有数据画成最好');
  const values = cells.flat().filter(cell => cell.v !== null);
  assert.equal(values.length, 3, '其余格子不受影响');
});

test('国际互联用全局档，不套用区域的中国延迟基准', () => {
  // 国际节点遍布全球，p50 天然在 140-180ms（四个实测区域都如此）。
  // 若套用香港的 100/150，香港 179ms 会被误判成差。
  const records = ['香港', '日本', '新加坡', '美国西部-洛杉矶', '英国-伦敦', '德国-法兰克福'].map(target => ({
    key: JSON.stringify(['intl', '国际节点', target, 'IPv4']),
    section: 'intl', group: '国际节点', target, carrier: 'IPv4',
    metrics: { downloadLatency: { value: 179, unit: 'ms', status: 'ok', raw: '179ms' } }
  }));
  const result = summarize({ sections: [{ id: 'intl', name: '国际互联' }], records }, { region: 'HK' });
  const card = result.cards.find(item => item.id === 'intl');
  assert.equal(card.level, 'good', '香港 179ms 的国际延迟属正常');
  assert.match(card.basis, /全局档/);
});

test('基准表标出已用实测校准的区域', () => {
  const result = summarize(report([]), { region: 'JP' });
  assert.equal(result.region.calibrated, true);
  assert.deepEqual(result.calibratedRegions.slice().sort(), ['DE', 'HK', 'JP', 'US']);
  const uncalibrated = summarize(report([]), { region: 'SG' });
  assert.equal(uncalibrated.region.calibrated, false, '新加坡还没有报告，必须标成待校准');
});

test('无丢包无异常时不产生误报，指标卡仍然齐全', () => {
  const records = [150, 155, 160].map((value, index) => rec('ipv4', `省${index}`, '电信', { route: m('4837'), latency: m(value), loss: m(0) }));
  const result = summarize(report(records));
  assert.deepEqual(result.anomalies.filter(item => item.level !== 'info'), []);
  assert.ok(result.cards.some(card => card.id === 'latency'), '延迟卡应存在');
  assert.ok(result.cards.some(card => card.id === 'spread'), '离散度卡应存在（不受机房位置影响）');
});
