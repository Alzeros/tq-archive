import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealth } from '../lib/health.mjs';

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
  assert.equal(assessHealth(report(Array.from({ length: 93 }, (_, index) => record(String(index), index ? 0 : 1))), { region: 'US' }).level, 'observe');
  assert.equal(assessHealth(report([record('a', 1), record('b', 1)]), { region: 'US' }).level, 'warn');
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
  assert.equal(assessHealth(source, { region: 'US' }, null, [{ level: 'danger', text: '某方向速度仅 1Mbps，同组其他 500Mbps' }]).level, 'severe');
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
