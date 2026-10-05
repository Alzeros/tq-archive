import { latencyBand } from './thresholds.mjs';
import { sectionNames } from './parser.mjs';

const numeric = measurement => !['unknown', 'failed', 'error', 'missing'].includes(measurement?.status) && Number.isFinite(measurement?.value) && measurement.value >= 0 ? measurement.value : null;
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

export function assessHealth(report, node = {}, previous = null, anomalies = []) {
  const records = report.records || [];
  const reasons = [];
  let score = 0;
  const raise = (value, text) => { score = Math.max(score, value); reasons.push({ value, text }); };
  const measured = records.filter(record => Object.values(record.metrics || {}).some(measurement => numeric(measurement) !== null));
  if (!measured.length) return { level: 'unknown', label: '无法评估', score: null, reasons: ['没有有效数值，不能判定网络健康'] };
  const lossGroups = new Map();
  for (const record of records) {
    const values = Object.entries(record.metrics || {}).filter(([metric]) => /loss|retrans/i.test(metric)).map(([, measurement]) => numeric(measurement)).filter(value => value !== null);
    if (!values.length) continue;
    const group = `${sectionNames[record.section] || record.section} / ${record.group || '默认分组'}`;
    if (!lossGroups.has(group)) lossGroups.set(group, []);
    lossGroups.get(group).push(Math.max(...values));
  }
  for (const [group, losses] of lossGroups) {
    const affected = losses.filter(value => value > 0);
    if (!affected.length) continue;
    const heavy = losses.filter(value => value >= 20);
    const moderate = losses.filter(value => value >= 5);
    const worst = Math.max(...affected);
    const ratio = affected.length / losses.length;
    const weighted = losses.reduce((total, value) => total + Math.min(value / 20, 1), 0) / losses.length;
    const severity = heavy.length ? 70 + Math.min(30, weighted * 30) : moderate.length || ratio >= 0.1 ? 40 + Math.min(29, weighted * 29) : 15 + Math.min(24, ratio * 100);
    raise(severity, `${group}：${affected.length}/${losses.length} 条已测线路有丢包或重传，其中 ${heavy.length} 条 ≥20%，最高 ${worst}%`);
  }
  const band = latencyBand(node.region);
  const carriers = new Map();
  for (const record of records.filter(record => record.section === 'ipv4')) {
    const value = numeric(record.metrics?.latency);
    if (value === null) continue;
    const carrier = record.carrier || '三网';
    if (!carriers.has(carrier)) carriers.set(carrier, []);
    carriers.get(carrier).push(value);
  }
  for (const [carrier, values] of carriers) {
    const value = median(values);
    if (value > band.fair) raise(value > band.fair * 1.5 ? 70 : 40, `${carrier}回程延迟 p50 ${Math.round(value)}ms，超过${band.label}参考上限 ${band.fair}ms`);
    else if (value > band.good) raise(15, `${carrier}回程延迟 p50 ${Math.round(value)}ms，处于区域参考的一般档`);
  }
  const failures = records.filter(record => Object.values(record.metrics || {}).some(measurement => /failed|失败|timeout|超时/i.test(String(measurement?.raw || ''))));
  if (failures.length) raise(failures.length / records.length >= 0.2 ? 70 : 40, `${failures.length} 条测试记录明确失败或超时`);
  for (const anomaly of anomalies) {
    if (anomaly.level === 'info' || /丢包|重传/.test(anomaly.text)) continue;
    raise(anomaly.level === 'danger' ? 70 : 15, anomaly.text);
  }
  const speeds = records.filter(record => record.section === 'speedtest');
  const previousRecords = new Map((previous?.records || []).map(record => [record.key, record]));
  for (const metric of ['returnSpeed', 'outboundSpeed']) {
    const matching = speeds.flatMap(record => {
      const current = numeric(record.metrics?.[metric]);
      const before = numeric(previousRecords.get(record.key)?.metrics?.[metric]);
      return current !== null && before > 0 && record.metrics[metric].unit === previousRecords.get(record.key).metrics[metric].unit ? [{ current, before, ratio: current / before }] : [];
    });
    if (matching.length >= 3) {
      const ratio = median(matching.map(item => item.ratio));
      const drop = median(matching.map(item => item.before - item.current));
      if (ratio < 0.7 && drop >= 20) raise(ratio < 0.3 ? 70 : 40, `${metric === 'returnSpeed' ? '回程' : '去程'}速度在 ${matching.length} 个共同测速点相对上一份下降约 ${Math.round((1 - ratio) * 100)}%`);
    }
  }
  const level = score >= 70 ? 'severe' : score >= 40 ? 'warn' : score > 0 ? 'observe' : 'healthy';
  return { level, label: { severe: '严重', warn: '注意', observe: '观察', healthy: '未见明显异常' }[level], score: Math.round(score), reasons: [...new Set(reasons.sort((left, right) => right.value - left.value).map(reason => reason.text))], basis: '0–100 为排序分数，取最严重信号；低速本身不判故障。丢包/重传按同维度分组的比例及轻重判定，延迟按区域参考，速度变化仅比较同节点共同测速点。' };
}
