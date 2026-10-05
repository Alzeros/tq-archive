import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTqCsv } from '../lib/csv-parser.mjs';
import { assessHealth, healthLevel } from '../lib/health.mjs';

const measurement = (value, unit = 'ms') => ({ value, unit, status: 'ok' });
const record = (key, loss = 0, latency = 160) => ({ key, section: 'ipv4', carrier: '电信', metrics: { latency: measurement(latency), loss: measurement(loss, '%') } });
const report = records => ({ records });

test('100Mbps 端口不因绝对速率而告警', () => {
  const result = assessHealth(report([record('route'), { key: 'speed', section: 'speedtest', metrics: { returnSpeed: measurement(92, 'Mbps') } }]), { region: 'US' });
  assert.equal(result.level, 'healthy');
});
test('单条严重丢包不会被其他好线路稀释', () => {
  const result = assessHealth(report(Array.from({ length: 93 }, (_, index) => record(String(index), index ? 0 : 100))), { region: 'US' });
  assert.equal(result.level, 'severe');
  assert.match(result.reasons[0], /1\/93/);
});
test('轻度少量与大量丢包有区分，缺测不当正常', () => {
  assert.equal(assessHealth(report(Array.from({ length: 93 }, (_, index) => record(String(index), index ? 0 : 1))), { region: 'US' }).level, 'info');
  assert.equal(assessHealth(report([record('a', 1), record('b', 1)]), { region: 'US' }).level, 'observe');
  assert.equal(assessHealth(report([])).level, 'unknown');
});
test('速度变化仅比较同节点共同测速点，带宽腰斩可告警', () => {
  const speeds = value => report(Array.from({ length: 3 }, (_, index) => ({ key: String(index), section: 'speedtest', metrics: { returnSpeed: measurement(value, 'Mbps') } })));
  assert.equal(assessHealth(speeds(100), {}, speeds(100)).level, 'healthy');
  assert.equal(assessHealth(speeds(20), {}, speeds(100)).level, 'severe');
  assert.equal(assessHealth(speeds(20), {}, report([])).level, 'healthy');
});
test('说明不计故障，真实异常参与判级，不同单位不比较', () => {
  const source = report([record('route')]);
  assert.equal(assessHealth(source, { region: 'US' }, null, [{ level: 'info', text: '全部走 9929' }]).level, 'healthy');
  assert.equal(assessHealth(source, { region: 'US' }, null, [{ level: 'danger', text: '某方向速度仅 1Mbps，同组其他 500Mbps' }]).level, 'observe');
  const current = report(Array.from({ length: 3 }, (_, index) => ({ key: String(index), section: 'speedtest', metrics: { returnSpeed: measurement(1, 'Mbps') } })));
  const previous = structuredClone(current);
  for (const item of previous.records) item.metrics.returnSpeed = measurement(100, 'Gbps');
  assert.equal(assessHealth(current, {}, previous).level, 'healthy');
});
test('增加其他维度的零丢包记录不会稀释原维度故障', () => {
  const source = report([record('bad', 1), record('normal', 0)]);
  const first = assessHealth(source, { region: 'US' });
  source.records.push(...Array.from({ length: 100 }, (_, index) => ({ ...record(`intl-${index}`), section: 'intl' })));
  assert.equal(assessHealth(source, { region: 'US' }).score, first.score);
});
test('最严重原因排在前面，明确失败数值不参与健康读数', () => {
  const source = report([record('mild', 1), { ...record('severe', 100), section: 'large4' }]);
  const result = assessHealth(source, { region: 'US' });
  assert.match(result.reasons[0], /100%/);
  assert.equal(assessHealth(report([{ key: 'failed', metrics: { latency: { value: 10, status: 'failed' } } }])).level, 'unknown');
});
test('重传次数不套用百分比阈值，也不污染真正百分比的主因', () => {
  const counted = { key: 'international', section: 'intl', group: '国际节点', carrier: 'IPv4', metrics: { downloadRetrans: measurement(90000, '次'), uploadRetrans: measurement(10000, '次') } };
  const result = assessHealth(report([record('normal'), counted]), { region: 'US' });
  assert.equal(result.level, 'info');
  assert.equal(result.score, 25);
  assert.equal(result.primary.unit, '次');
  assert.equal(result.primary.value, 100000);
  assert.ok(!result.reasons[0].includes('≥20%'));
  const mixed = assessHealth(report([record('bad', 50), record('good'), counted]), { region: 'US' });
  assert.equal(mixed.level, 'warn');
  assert.equal(mixed.primary.unit, '%');
  assert.equal(mixed.primary.value, 50);
  assert.equal(mixed.primary.section, 'ipv4');
});
test('等级按展示分数分档，不让70至89分统一变严重', () => {
  for (const [score, level] of [[0, 'healthy'], [16, 'info'], [49, 'info'], [50, 'observe'], [69, 'observe'], [70, 'warn'], [89, 'warn'], [90, 'severe'], [100, 'severe']]) assert.equal(healthLevel(score), level);
  assert.equal(healthLevel(null), 'unknown');
  const result = assessHealth(report(Array.from({ length: 93 }, (_, index) => record(String(index), index ? 0 : 78))), { region: 'US' });
  assert.equal(result.level, healthLevel(result.score));
  assert.equal(result.level, 'warn');
});
test('不认识的重传单位不会猜成百分比，speed异常仅提示测速点离群', () => {
  const result = assessHealth(report([{ key: 'unknown-unit', section: 'intl', metrics: { downloadRetrans: measurement(2000, '') } }]), {});
  assert.equal(result.level, 'healthy');
  const speed = assessHealth(report([record('normal')]), { region: 'US' }, null, [{ kind: 'speed-outlier', level: 'warn', section: 'speedtest', value: 1, unit: 'Mbps', text: '测速点离群，不代表线路故障' }]);
  assert.equal(speed.level, 'observe');
  assert.equal(speed.primary.kind, 'speed-outlier');
  assert.equal(speed.primary.unit, 'Mbps');
});
test('真实完整CSV的国际重传次数不会被标成百分比故障', () => {
  const parsed = parseTqCsv(readFileSync(new URL('./fixtures/tq-full.csv', import.meta.url), 'utf8'), { testedAt: '2026-10-04T00:00:00+08:00' });
  const international = parsed.records.filter(item => item.section === 'intl' && item.group === '国际节点');
  assert.ok(international.some(item => item.metrics.downloadRetrans.unit === '次'));
  const result = assessHealth(report(international), { region: 'US' });
  assert.equal(result.level, 'info');
  assert.equal(result.primary.unit, '次');
  assert.ok(result.reasons.every(reason => !reason.includes('≥20%')));
});
