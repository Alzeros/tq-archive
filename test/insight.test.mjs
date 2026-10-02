import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../lib/insight.mjs';

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

test('速度离群用相对倍数检出，不依赖绝对阈值', () => {
  const speed = (target, value) => rec('speedtest', target, '', { returnSpeed: { value, unit: 'Mbps', status: 'ok', raw: `${value}Mbps` } });
  const result = summarize(report([
    { ...speed('北京电信', 480), group: 'IPv4' },
    { ...speed('上海电信', 2.2), group: 'IPv4' },
    { ...speed('广东电信', 490), group: 'IPv4' }
  ]));
  const hit = result.anomalies.find(item => item.text.includes('上海电信'));
  assert.ok(hit, '远低于同组中位数应被判为异常');
  assert.equal(hit.level, 'danger');
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

test('无丢包无异常时不产生误报，指标卡仍然齐全', () => {
  const records = [150, 155, 160].map((value, index) => rec('ipv4', `省${index}`, '电信', { route: m('4837'), latency: m(value), loss: m(0) }));
  const result = summarize(report(records));
  assert.deepEqual(result.anomalies.filter(item => item.level !== 'info'), []);
  assert.ok(result.cards.some(card => card.id === 'latency'), '延迟卡应存在');
  assert.ok(result.cards.some(card => card.id === 'spread'), '离散度卡应存在（不受机房位置影响）');
});
