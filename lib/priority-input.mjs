import { reportCoverage } from './report-quality.mjs';
import { latencyByRegion, international, priorityRules } from './thresholds.mjs';

const carrierKeys = { 电信: 'ct', 联通: 'cu', 移动: 'cm' };
const rateNames = new Set(['loss', 'retrans', 'returnRetrans', 'downloadRetransRate']);
const speedNames = ['returnSpeed', 'outboundSpeed', 'downloadSpeed', 'uploadSpeed'];
const reachability = value => ['✓', '✔'].includes(value) ? true : ['x', '✗', '✘'].includes(value) ? false : null;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const identity = record => record.key ?? JSON.stringify([record.section, record.group, record.target, record.carrier]);
const missing = measurement => !measurement || ['', '-'].includes(String(measurement.raw ?? measurement.value ?? '').trim()) || measurement.status === 'missing';
const failed = measurement => ['failed', 'error'].includes(measurement?.status) || /^(?:fail(?:ed)?|error|timeout|timed out|失败|超时|-[\d.]+(?:ms|%)?)$/i.test(String(measurement?.raw ?? measurement?.value ?? '').trim());
const valid = (measurement, unit) => measurement?.status === 'ok' && measurement.unit === unit && Number.isFinite(measurement.value) && measurement.value >= 0 && (unit !== '%' || measurement.value <= 100);

export function interpolate(value, anchors) {
  if (!Number.isFinite(value)) return null;
  if (value <= anchors[0][0]) return anchors[0][1];
  for (let index = 1; index < anchors.length; index++) {
    const [end, upper] = anchors[index];
    const [start, lower] = anchors[index - 1];
    if (value <= end) return lower + (upper - lower) * (value - start) / (end - start);
  }
  return anchors.at(-1)[1];
}

export function rateDamage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? interpolate(value, priorityRules.rateAnchors) : null;
}

export function rateSeverity(values, meanShare = priorityRules.meanShare) {
  if (!Number.isFinite(meanShare) || meanShare < 0 || meanShare > 1) throw new RangeError('均值系数必须在 [0,1]');
  if (!values.length || values.some(value => rateDamage(value) === null)) return null;
  const risks = values.map(rateDamage);
  return meanShare * mean(risks) + (1 - meanShare) * Math.max(...risks);
}

export function classifyCarrier(record) {
  const structured = String(record.carrier ?? '').trim();
  const suffix = String(record.target ?? '').trim().match(/(电信|联通|移动)$/)?.[1];
  if (structured && !Object.hasOwn(carrierKeys, structured)) return { carrier: null, carrierSource: 'unknown', conflict: true };
  if (structured && suffix && structured !== suffix) return { carrier: null, carrierSource: 'conflict', conflict: true };
  return { carrier: carrierKeys[structured || suffix] ?? null, carrierSource: structured ? 'carrier' : suffix ? 'target-suffix' : 'unknown', conflict: false };
}

export function recordState(record) {
  if (['failed', 'error'].includes(record.status) || Object.values(record.metrics ?? {}).some(failed)) return 'test-failed';
  const measurements = Object.entries(record.metrics ?? {}).filter(([key]) => !['route', 'domain', 'reachable'].includes(key)).map(([, value]) => value);
  if (!measurements.length || measurements.every(missing)) return 'not-measured';
  return measurements.some(value => value.status === 'ok' && Number.isFinite(value.value)) ? 'observed' : 'parse-unknown';
}

function familyOf(record) {
  if (record.section === 'cernet' && !record.family && record.group === 'CERNET-IPv4' && record.carrier === '教育网IPv6') return 'v6';
  const markers = [record.family, record.group, record.carrier].filter(Boolean).map(String);
  if (markers.some(value => /IPv4/i.test(value)) && markers.some(value => /IPv6/i.test(value))) return null;
  return record.section === 'ipv6' || markers.some(value => /IPv6/i.test(value)) ? 'v6' : 'v4';
}

export function classifyPriorityRecord(record) {
  const family = familyOf(record);
  if (!family) return { error: 'IP 测试族标识冲突' };
  if (record.section === 'cernet') return { branch: 'A', member: 'cernet', family, carrierSource: 'section' };
  if (record.section === 'intl') {
    const member = { 国际节点: 'nodes', 常用网站: 'web', '常用 CDN': 'cdn' }[record.group];
    return member ? { branch: 'I', member, family } : { error: '未注册国际子组' };
  }
  if (record.section === 'speedtest' && record.group === '国际方向') return { branch: 'I', member: 'speed', family };
  if (!['ipv4', 'ipv6', 'large4', 'speedtest'].includes(record.section)) return { error: '未注册核心测试维度' };
  if (record.section === 'speedtest' && !['IPv4', 'IPv6'].includes(record.group)) return { error: '未注册国内测速子组' };
  const carrier = classifyCarrier(record);
  if (!carrier.carrier) return { error: carrier.conflict ? '运营商标识冲突或未知' : '运营商缺失' };
  return { branch: record.section === 'large4' ? 'B' : record.section === 'speedtest' ? 'D' : 'A', member: carrier.carrier, family, carrierSource: carrier.carrierSource };
}

function requiredMetrics(branch, member) {
  if (branch === 'D') return { returnRetrans: '%', returnSpeed: 'Mbps', outboundSpeed: 'Mbps', returnLatency: 'ms', outboundLatency: 'ms' };
  if (branch !== 'I') return { [branch === 'B' ? 'retrans' : 'loss']: '%', latency: 'ms' };
  if (member === 'nodes') return { downloadLatency: 'ms', uploadLatency: 'ms', downloadRetrans: '次', uploadRetrans: '次' };
  if (member === 'speed') return { downloadRetransRate: '%', downloadSpeed: 'Mbps', uploadSpeed: 'Mbps', downloadLatency: 'ms', uploadLatency: 'ms' };
  return { retrans: '%', latency: 'ms', reachable: 'text' };
}

function expectedLeaves(report, singleStack) {
  const result = [];
  const add = (branch, member, families) => families.forEach(family => result.push({ id: `${branch}.${member}.${family}`, branch, member, family }));
  const families = singleStack ? ['v4'] : ['v4', 'v6'];
  for (const carrier of ['ct', 'cu', 'cm', 'cernet']) add('A', carrier, families);
  for (const carrier of ['ct', 'cu', 'cm']) {
    add('B', carrier, ['v4']);
    add('D', carrier, priorityRules.domesticV6Template.carriers.includes(carrier) && report.records.some(record => record.section === 'speedtest' && record.group === 'IPv6') ? ['v4', 'v6'] : ['v4']);
  }
  add('I', 'nodes', families);
  for (const member of ['web', 'cdn', 'speed']) add('I', member, ['v4']);
  return result;
}

function speedOutliers(records) {
  const risks = new Map();
  for (const group of new Set(records.filter(record => record.section === 'speedtest').map(record => record.group))) {
    for (const metric of speedNames) {
      const comparable = records.filter(record => record.section === 'speedtest' && record.group === group && valid(record.metrics?.[metric], 'Mbps'));
      if (comparable.length < priorityRules.minimumSpeedPoints) continue;
      const center = median(comparable.map(record => record.metrics[metric].value));
      for (const record of comparable) {
        const value = record.metrics[metric].value;
        if (value < priorityRules.speedFloor && value * priorityRules.speedDivisor < center) {
          const score = priorityRules.speedOutlierCap * (1 - value / (center / priorityRules.speedDivisor));
          risks.set(identity(record), Math.max(risks.get(identity(record)) ?? 0, score));
        }
      }
    }
  }
  return risks;
}

function historySignal(records, report, previous, leaf) {
  if (!previous || !report.nodeId || previous.nodeId !== report.nodeId || !(Date.parse(previous.testedAt) < Date.parse(report.testedAt))) return { score: null, reason: '没有同节点严格更早的报告' };
  const before = new Map();
  for (const record of previous.records ?? []) {
    const key = identity(record);
    before.set(key, before.has(key) ? null : record);
  }
  const channels = [];
  for (const metric of speedNames) {
    const pairs = records.flatMap(record => {
      const prior = before.get(identity(record));
      const classified = prior && classifyPriorityRecord(prior);
      if (!prior || classified.branch !== leaf.branch || classified.member !== leaf.member || classified.family !== leaf.family || !valid(prior.metrics?.[metric], 'Mbps') || !valid(record.metrics?.[metric], 'Mbps') || prior.metrics[metric].value <= 0) return [];
      return [{ ratio: record.metrics[metric].value / prior.metrics[metric].value, drop: prior.metrics[metric].value - record.metrics[metric].value }];
    });
    if (pairs.length < priorityRules.minimumSpeedPoints) continue;
    const ratio = median(pairs.map(pair => pair.ratio));
    const drop = median(pairs.map(pair => pair.drop));
    const score = drop >= priorityRules.historyDrop && ratio < priorityRules.historyRatio ? interpolate(ratio, [[0, 100], [0.3, 80], [0.7, 0]]) : 0;
    channels.push({ metric, points: pairs.length, ratio, drop, score });
  }
  return channels.length ? { score: Math.max(...channels.map(channel => channel.score)), channels } : { score: null, reason: '每运营商及 IP 族同单位共同点不足 3 个' };
}

export function buildPriorityInput(report, node = {}, previous = null, options = {}) {
  if (!report) return { status: 'no-report', leaves: [], issues: [], facts: [] };
  const records = report.records ?? [];
  const meanShare = options.meanShare ?? priorityRules.meanShare;
  rateSeverity([0], meanShare);
  const quality = reportCoverage(report);
  const v6Records = records.filter(record => familyOf(record) === 'v6');
  const declaresV6 = [...(report.sections ?? []), ...(report.expectedSections ?? [])].some(section => (typeof section === 'string' ? section : section.id) === 'ipv6');
  const singleStack = !declaresV6 && records.some(record => record.section === 'ipv4' && recordState(record) === 'observed') && v6Records.every(record => record.section === 'intl' && record.group === '国际节点' && recordState(record) === 'not-measured');
  const leaves = expectedLeaves({ ...report, records }, singleStack).map(leaf => ({ ...leaf, records: [] }));
  const byId = new Map(leaves.map(leaf => [leaf.id, leaf]));
  const issues = [];
  const facts = [];
  const seen = new Set();
  const seenIdentity = new Set();
  const expectedUnmeasured = [];
  for (const record of records) {
    const key = identity(record);
    const semanticKey = JSON.stringify([record.section, record.group, record.target, record.carrier]);
    if (seen.has(key) || seenIdentity.has(semanticKey)) { issues.push({ key, state: 'parse-unknown', reason: '重复记录' }); continue; }
    seen.add(key);
    seenIdentity.add(semanticKey);
    const classified = classifyPriorityRecord(record);
    if (classified.error) { issues.push({ key, state: 'parse-unknown', reason: classified.error }); continue; }
    if (singleStack && classified.family === 'v6' && recordState(record) === 'not-measured') { expectedUnmeasured.push(key); continue; }
    const id = `${classified.branch}.${classified.member}.${classified.family}`;
    const leaf = byId.get(id);
    if (!leaf) { issues.push({ key, state: 'parse-unknown', reason: '测试族不在注册表中' }); continue; }
    leaf.records.push({ record, classified });
  }
  const outliers = speedOutliers(records);
  for (const leaf of leaves) {
    const rates = [];
    const latencies = [];
    const leafIssues = [];
    let failures = 0;
    let unreachable = 0;
    let knownExecutions = 0;
    const required = requiredMetrics(leaf.branch, leaf.member);
    const classifiedRecords = [];
    for (const { record, classified } of leaf.records) {
      const key = identity(record);
      const state = recordState(record);
      const wholeFailure = ['failed', 'error'].includes(record.status) || failed(record.metrics?.route);
      const unavailable = reachability(record.metrics?.reachable?.value) === false;
      if (['observed', 'test-failed'].includes(state) || unavailable) knownExecutions++;
      const recordRates = [];
      if (state === 'test-failed') { failures++; facts.push({ key, leaf: leaf.id, kind: 'test-failed', unit: '条', value: 1 }); }
      if (unavailable) { unreachable++; facts.push({ key, leaf: leaf.id, kind: 'unreachable', unit: '条', value: 1 }); }
      const expectedMetrics = { ...required, ...Object.fromEntries(Object.keys(record.metrics ?? {}).filter(metric => rateNames.has(metric)).map(metric => [metric, '%'])) };
      for (const [metric, unit] of Object.entries(expectedMetrics)) {
        const measurement = record.metrics?.[metric];
        const observed = unit === 'text' ? reachability(measurement?.value) !== null : valid(measurement, unit);
        if (observed) {
          if (rateNames.has(metric)) recordRates.push(measurement.value);
          if (unit === 'ms') latencies.push({ metric, value: measurement.value });
          if (unit === '次') facts.push({ key, leaf: leaf.id, kind: 'count', metric, unit, value: measurement.value });
        } else if (!wholeFailure && !unavailable && !failed(measurement)) {
          leafIssues.push({ key, leaf: leaf.id, metric, state: missing(measurement) ? 'not-measured' : 'parse-unknown', reason: `必需读数缺失或单位不符（${unit}）` });
        }
      }
      if (recordRates.length) {
        const rate = Math.max(...recordRates);
        rates.push(rate);
        if (rate > 0) facts.push({ key, leaf: leaf.id, kind: 'rate', unit: '%', value: rate });
      }
      classifiedRecords.push({ key, state, carrierSource: classified.carrierSource ?? null });
    }
    const count = leaf.records.length;
    if (!count) leafIssues.push({ leaf: leaf.id, state: 'not-measured', reason: '整个必需测试族缺失' });
    const band = leaf.branch === 'I' ? (leaf.member === 'nodes' ? international : null) : latencyByRegion[node.region];
    if (leaf.branch !== 'I' && !band) leafIssues.push({ leaf: leaf.id, state: 'parse-unknown', reason: '未知节点区域，无国内方向延迟参考' });
    const latencyChannels = band ? [...new Set(latencies.map(item => item.metric))].map(metric => {
      const value = median(latencies.filter(item => item.metric === metric).map(item => item.value));
      return { metric, value, unit: 'ms', score: interpolate(value, [[0, 0], [band.good, 0], [band.fair, 20], [band.fair * 1.5, 60], [band.fair * 2, 90], [band.fair * 3, 100]]) };
    }) : [];
    const history = leaf.branch === 'D' || leaf.member === 'speed' ? historySignal(leaf.records.map(item => item.record), report, previous, leaf) : { score: null, reason: '非测速叶子' };
    const channels = [
      { kind: 'rate', score: rateSeverity(rates, meanShare), unit: '%' },
      { kind: 'latency', score: latencyChannels.length ? Math.max(...latencyChannels.map(channel => channel.score)) : null, details: latencyChannels, reason: band ? null : '方向没有适用参考，仅保留延迟事实', unit: 'ms' },
      { kind: 'test-failed', score: knownExecutions ? priorityRules.failureScore * failures / knownExecutions : null, unit: '条' },
      { kind: 'unreachable', score: leaf.branch === 'I' && ['web', 'cdn'].includes(leaf.member) && count ? priorityRules.failureScore * unreachable / count : null, unit: '条' },
      { kind: 'speed-outlier', score: count && (leaf.branch === 'D' || leaf.member === 'speed') ? Math.max(0, ...leaf.records.map(({ record }) => outliers.get(identity(record)) ?? 0)) : null, unit: 'Mbps' },
      { kind: 'speed-change', ...history, unit: '%' }
    ];
    const available = channels.filter(channel => channel.score !== null).sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind));
    const localScore = available[0]?.score ?? null;
    const coverage = { observed: classifiedRecords.filter(record => record.state === 'observed').length, failed: failures, knownExecutions, records: count, issues: leafIssues };
    // worst 只用于界面把「最高 X%」讲清楚；判级本身只看 ratio 与 rateAnchors。
    const breadth = { heavy: rates.filter(value => value >= priorityRules.severeRate).length, valid: rates.length, ratio: rates.length ? rates.filter(value => value >= priorityRules.severeRate).length / rates.length : null, worst: rates.length ? Math.max(...rates) : null };
    Object.assign(leaf, { records: classifiedRecords, status: leafIssues.length ? 'insufficient' : 'ready', score: leafIssues.length ? null : localScore, knownRisk: localScore, channels, primary: available[0] ?? null, coverage, breadth });
    issues.push(...leafIssues);
  }
  const templateExclusions = ['ct', 'cu', 'cm'].filter(carrier => !priorityRules.domesticV6Template.carriers.includes(carrier)).map(carrier => ({ leaf: `D.${carrier}.v6`, state: 'not-in-template', reason: '已核对模板的国内 IPv6 测速只包含移动；不代表该运营商线路正常或不支持 IPv6' }));
  const conditionalTests = [{ leaf: 'D.cm.v6', state: leaves.some(leaf => leaf.id === 'D.cm.v6') ? 'present' : 'not-declared', reason: '国内 IPv6 测速有独立启用条件；整组未声明时不假定执行，出现记录后必需读数仍严格检查' }];
  return { status: issues.length ? 'insufficient' : 'ready', leaves, issues, facts, coverage: { singleStack, expectedUnmeasured, templateExclusions, conditionalTests, template: priorityRules.domesticV6Template, legacyStatus: quality.status } };
}
