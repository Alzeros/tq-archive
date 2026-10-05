import { latencyBand } from './thresholds.mjs';
import { sectionNames } from './parser.mjs';

const numeric = measurement => !['unknown', 'failed', 'error', 'missing'].includes(measurement?.status) && Number.isFinite(measurement?.value) && measurement.value >= 0 ? measurement.value : null;
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

export function healthLevel(score) {
  if (!Number.isFinite(score)) return 'unknown';
  return score >= 90 ? 'severe' : score >= 70 ? 'warn' : score >= 50 ? 'observe' : score > 0 ? 'info' : 'healthy';
}

export function assessHealth(report, node = {}, previous = null, anomalies = []) {
  const records = report.records || [];
  const reasons = [];
  let score = 0;
  const raise = (severity, text, signal = {}) => { score = Math.max(score, severity); reasons.push({ score: severity, text, ...signal }); };
  const measured = records.filter(record => Object.values(record.metrics || {}).some(measurement => numeric(measurement) !== null));
  if (!measured.length) return { level: 'unknown', label: '无法评估', score: null, reasons: ['没有有效数值，不能判定网络健康'] };
  const lossGroups = new Map();
  const countGroups = new Map();
  for (const record of records) {
    const measurements = Object.entries(record.metrics || {}).filter(([metric, measurement]) => /loss|retrans/i.test(metric) && numeric(measurement) !== null);
    const group = `${sectionNames[record.section] || record.section} / ${record.group || '默认分组'}`;
    const rates = measurements.filter(([, measurement]) => measurement.unit === '%' && measurement.value <= 100).map(([, measurement]) => measurement.value);
    const counts = measurements.filter(([, measurement]) => measurement.unit === '次').map(([, measurement]) => measurement.value);
    if (rates.length) {
      if (!lossGroups.has(group)) lossGroups.set(group, { section: record.section, values: [] });
      lossGroups.get(group).values.push(Math.max(...rates));
    }
    if (counts.length) {
      if (!countGroups.has(group)) countGroups.set(group, { section: record.section, values: [] });
      countGroups.get(group).values.push(...counts);
    }
  }
  for (const [group, { section, values: losses }] of lossGroups) {
    const affected = losses.filter(value => value > 0);
    if (!affected.length) continue;
    const heavy = losses.filter(value => value >= 20);
    const moderate = losses.filter(value => value >= 5);
    const worst = Math.max(...affected);
    const ratio = affected.length / losses.length;
    const weighted = losses.reduce((total, value) => total + Math.min(value / 20, 1), 0) / losses.length;
    const severity = heavy.length ? 70 + 20 * worst / 100 + 10 * weighted : moderate.length || ratio >= 0.1 ? 50 + 15 * weighted + 5 * ratio : 15 + Math.min(24, ratio * 100);
    raise(severity, `${group}：${affected.length}/${losses.length} 条已测线路有丢包或重传率，其中 ${heavy.length} 条 ≥20%，最高 ${worst}%`, { kind: 'rate', section, group, label: `${sectionNames[section] || section}·丢包/重传率`, value: worst, unit: '%' });
  }
  for (const [group, { section, values: counts }] of countGroups) {
    const affected = counts.filter(value => value > 0);
    if (!affected.length) continue;
    const total = affected.reduce((sum, value) => sum + value, 0);
    raise(25, `${group}：${affected.length}/${counts.length} 个已测方向有重传，累计 ${total} 次；次数没有发送总量分母，仅作记录，不按百分比判严重度`, { kind: 'count', section, group, label: `${sectionNames[section] || section}·重传次数`, value: total, unit: '次' });
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
    const signal = { kind: 'latency', section: 'ipv4', carrier, label: `${carrier}回程延迟`, value: Math.round(value), unit: 'ms' };
    if (value > band.fair) raise(value > band.fair * 2 ? 90 : value > band.fair * 1.5 ? 80 : 60, `${carrier}回程延迟 p50 ${Math.round(value)}ms，超过${band.label}参考上限 ${band.fair}ms`, signal);
    else if (value > band.good) raise(15, `${carrier}回程延迟 p50 ${Math.round(value)}ms，处于区域参考的一般档`, signal);
  }
  const failures = records.filter(record => Object.values(record.metrics || {}).some(measurement => /failed|失败|timeout|超时/i.test(String(measurement?.raw || ''))));
  if (failures.length) raise(50 + 50 * failures.length / records.length, `${failures.length} 条测试记录明确失败或超时`, { kind: 'failure', label: '测试失败', value: failures.length, unit: '条' });
  for (const anomaly of anomalies) {
    if (anomaly.level === 'info' || /丢包|重传/.test(anomaly.text)) continue;
    const speedOutlier = anomaly.kind === 'speed-outlier' || /速度|Mbps/.test(anomaly.text);
    raise(speedOutlier ? 50 : anomaly.level === 'danger' ? 90 : 40, anomaly.text, { kind: speedOutlier ? 'speed-outlier' : 'anomaly', section: anomaly.section, label: speedOutlier ? '测速点离群' : '相对异常', value: anomaly.value, unit: anomaly.unit });
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
      if (ratio < 0.7 && drop >= 20) raise(ratio < 0.3 ? 70 + (1 - ratio) * 30 : 50 + (1 - ratio) * 20, `${metric === 'returnSpeed' ? '回程' : '去程'}速度在 ${matching.length} 个共同测速点相对上一份下降约 ${Math.round((1 - ratio) * 100)}%（同节点变化，不代表线路故障）`, { kind: 'speed-change', section: 'speedtest', label: `${metric === 'returnSpeed' ? '回程' : '去程'}速度下降`, value: Math.round((1 - ratio) * 100), unit: '%' });
    }
  }
  score = Math.round(Math.min(100, score));
  const level = healthLevel(score);
  const signals = reasons.sort((left, right) => right.score - left.score).filter((reason, index, sorted) => sorted.findIndex(item => item.text === reason.text) === index).map(reason => ({ ...reason, score: Math.round(reason.score) }));
  return { level, label: { severe: '严重', warn: '注意', observe: '观察', info: '轻度信号', healthy: '未见明显异常' }[level], score, reasons: signals.map(reason => reason.text), primary: signals[0] || null, signals, basis: '0–100 为排序分数：≥90 严重、70–89 注意、50–69 观察、低于50为轻度信号。% 按比例和轻重判定，次仅记录有无重传，不当百分比；速度离群不是线路故障。' };
}
