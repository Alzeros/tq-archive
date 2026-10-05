import { sectionNames, metricNames } from './parser.mjs';

const textMetrics = new Set(['route', 'domain', 'reachable']);
const carriers = new Set(['电信', '联通', '移动']);
const array = value => Array.isArray(value) ? value : [];
const entries = value => value && typeof value === 'object' ? Object.entries(value) : [];
const sectionId = section => typeof section === 'string' ? section : section?.id;
const recordKey = record => record.key ?? JSON.stringify([record.section, record.group, record.target, record.carrier]);
const detail = record => ({ key: recordKey(record), section: record.section ?? '', group: record.group ?? '', target: record.target ?? '', carrier: record.carrier ?? '' });
const metricEntries = record => entries(record.metrics).filter(([name, measurement]) => !textMetrics.has(name) && measurement?.status !== 'text');
const measurementRaw = measurement => String(measurement?.raw ?? measurement?.value ?? '').trim();
const ipv6Record = record => record.section === 'ipv6' || [record.family, record.carrier, record.group].some(value => /IPv6/i.test(String(value ?? '')));

function measurementState(measurement, record) {
  if (['failed', 'error'].includes(record.status) || measurement?.status === 'failed' || measurement?.status === 'error') return 'failed';
  if (measurement?.status === 'ok' && Number.isFinite(measurement.value) && measurement.value >= 0) return 'valid';
  const raw = measurementRaw(measurement);
  if (/^(?:fail(?:ed)?|error)$/i.test(raw) || /^-\d+(?:\.\d+)?\s*(?:ms|[KMG]bps|%)?$/i.test(raw)) return 'failed';
  if (!raw || raw === '-' || measurement?.status === 'missing') return 'missing';
  return 'unknown';
}

function singleStackReport(report, records) {
  if ([...array(report?.sections), ...array(report?.expectedSections)].some(section => sectionId(section) === 'ipv6')) return false;
  let ipv4Measured = false;
  for (const record of records.values()) {
    const metrics = metricEntries(record);
    if (!ipv6Record(record)) {
      if (metrics.some(([, measurement]) => measurementState(measurement, record) === 'valid')) ipv4Measured = true;
      continue;
    }
    if (record.section !== 'intl' || record.group !== '国际节点' || !metrics.length) return false;
    if (!metrics.every(([, measurement]) => measurementState(measurement, record) === 'missing')) return false;
  }
  return ipv4Measured;
}

function indexReport(report) {
  const records = new Map();
  const duplicates = new Map();
  for (const record of array(report?.records)) {
    if (!record || typeof record !== 'object') continue;
    const key = recordKey(record);
    if (records.has(key)) duplicates.set(key, (duplicates.get(key) || 0) + 1);
    else records.set(key, record);
  }
  const singleStack = singleStackReport(report, records);
  const expectedMissingKeys = new Set(singleStack ? [...records].filter(([, record]) => ipv6Record(record)).map(([key]) => key) : []);
  return { records, duplicates, singleStack, expectedMissingKeys };
}

function indexedState(measurement, record, indexed) {
  return indexed.expectedMissingKeys.has(recordKey(record)) ? 'expected-missing' : measurementState(measurement, record);
}

const counts = () => ({ records: 0, numericMetrics: 0, validMetrics: 0, failedMetrics: 0, missingMetrics: 0, unknownMetrics: 0, unavailableMetrics: 0, expectedMissingMetrics: 0 });

function addCounts(destination, record, indexed) {
  destination.records++;
  for (const [, measurement] of metricEntries(record)) {
    const state = indexedState(measurement, record, indexed);
    destination.numericMetrics++;
    destination[`${state === 'expected-missing' ? 'missing' : state}Metrics`]++;
    if (state === 'expected-missing') destination.expectedMissingMetrics++;
    if (state !== 'valid') destination.unavailableMetrics++;
  }
}

export function reportCoverage(report) {
  const indexed = indexReport(report);
  const totals = counts();
  const sections = new Map();
  const issues = [];
  const notices = [];
  const expectedMissing = [];
  const ensureSection = (id, name) => {
    if (!sections.has(id)) sections.set(id, { id, name: name || sectionNames[id] || id, ...counts(), groups: new Map() });
    return sections.get(id);
  };
  for (const section of array(report?.sections)) {
    const id = sectionId(section);
    if (id) ensureSection(id, section?.name);
  }
  for (const record of indexed.records.values()) {
    const section = ensureSection(record.section ?? '');
    const group = record.group ?? '';
    if (!section.groups.has(group)) section.groups.set(group, { group, ...counts() });
    for (const destination of [totals, section, section.groups.get(group)]) addCounts(destination, record, indexed);
    for (const [metric, measurement] of metricEntries(record)) {
      const state = indexedState(measurement, record, indexed);
      if (state === 'expected-missing') expectedMissing.push({ ...detail(record), metric, family: 'IPv6', raw: measurementRaw(measurement), reason: 'single-stack-ipv6' });
      if (state === 'failed' || state === 'unknown') issues.push({ type: state, severity: state === 'failed' ? 'failure' : 'warning', ...detail(record), metric });
    }
    if (['failed', 'error'].includes(record.status) && !metricEntries(record).length) issues.push({ type: 'failed', severity: 'failure', ...detail(record) });
  }
  for (const [key, count] of indexed.duplicates) issues.push({ type: 'duplicate-key', severity: 'warning', ...detail(indexed.records.get(key)), count });
  const hasFailures = issues.some(issue => issue.severity === 'failure');
  for (const warning of array(report?.warnings)) {
    if (typeof warning !== 'string') continue;
    if (/^报告没有 .+ 维度$/.test(warning.trim())) continue;
    const aggregate = warning.trim().match(/^(\d+)\s*个指标为缺失、失败或未知格式，已保留原值，不按零处理$/);
    if (aggregate) {
      const reportedMetrics = Number(aggregate[1]);
      const pureMissing = reportedMetrics > 0 && reportedMetrics === totals.missingMetrics && !totals.unknownMetrics;
      const severity = hasFailures ? 'failure' : pureMissing ? 'neutral' : 'warning';
      const destination = severity === 'neutral' ? notices : issues;
      destination.push({ type: 'warning', severity, message: warning, reportedMetrics, failedMetrics: totals.failedMetrics, missingMetrics: totals.missingMetrics, unknownMetrics: totals.unknownMetrics, expectedMissingMetrics: totals.expectedMissingMetrics });
    } else issues.push({ type: 'warning', severity: 'warning', message: warning });
  }
  for (const section of sections.values()) {
    if (!section.records) issues.push({ type: 'empty-section', severity: 'warning', section: section.id, message: `${section.name} 未解析出记录` });
  }
  const missingSections = Object.keys(sectionNames).filter(id => !sections.get(id)?.records);
  const missingExpectedSections = [...new Set(array(report?.expectedSections).map(sectionId).filter(Boolean))].filter(id => !sections.get(id)?.records);
  const importIncomplete = missingExpectedSections.length > 0;
  const missingCoreSections = missingSections.filter(id => id !== 'ipv6');
  const partial = !totals.records || !totals.numericMetrics || missingCoreSections.length > 0 || totals.missingMetrics > totals.expectedMissingMetrics || importIncomplete;
  const coverageStatus = importIncomplete ? 'incomplete' : !totals.records ? 'empty' : partial ? 'insufficient' : indexed.singleStack ? 'single-stack' : 'covered';
  const hasParseIssues = issues.some(issue => issue.severity === 'warning');
  const badgeStatus = hasFailures ? 'failure' : importIncomplete || hasParseIssues ? 'warning' : 'neutral';
  const status = badgeStatus !== 'neutral' ? 'issues' : !totals.records ? 'empty' : partial ? 'partial' : 'ok';
  const coverageLabel = { incomplete: '导入不完整', empty: '无可用记录', insufficient: '覆盖不足（不代表导入残缺）', 'single-stack': '正常单栈覆盖', covered: '已覆盖已知维度' }[coverageStatus];
  const label = [hasFailures ? '存在测试失败' : hasParseIssues ? '存在解析提示' : '', coverageLabel].filter(Boolean).join(' · ');
  const names = ids => ids.map(id => sectionNames[id] || id).join('、');
  const coverageHint = importIncomplete ? `明确要求的 ${names(missingExpectedSections)} 缺失，导入不完整，请重传完整测试报告。`
    : missingCoreSections.length ? `缺少 ${names(missingCoreSections)}，覆盖不足；请核对测试范围，若已执行完整测试，请重传报告。`
    : partial ? '存在未测指标，请核对测试范围，若已执行完整测试，请重传报告。'
    : indexed.singleStack ? '仅缺 IPv6 回程，符合正常单栈；IPv6 占位不计有效数值。'
    : '已覆盖已知维度，不推断各维度的采样完整性。';
  return {
    status, label, partial, badgeStatus, coverageStatus, coverageHint, importIncomplete, ...totals,
    duplicateRecords: [...indexed.duplicates.values()].reduce((sum, count) => sum + count, 0),
    missingSections, missingExpectedSections, expectedMissing, issues, notices,
    sections: [...sections.values()].map(section => ({ ...section, groups: [...section.groups.values()] }))
  };
}

function coverageDifference(current, previous) {
  const result = {
    records: { current: current.records.size, previous: previous.records.size, common: 0, added: 0, missing: 0 },
    metrics: { current: 0, previous: 0, common: 0, added: 0, missing: 0, comparable: 0, incomparable: 0, unitIncomparable: 0, statusIncomparable: 0, duplicateIncomparable: 0, expectedMissingIncomparable: 0 },
    addedRecords: [], missingRecords: [], addedMetrics: [], missingMetrics: [], incomparableMetrics: []
  };
  for (const record of current.records.values()) result.metrics.current += metricEntries(record).length;
  for (const record of previous.records.values()) result.metrics.previous += metricEntries(record).length;
  for (const key of new Set([...current.records.keys(), ...previous.records.keys()])) {
    const after = current.records.get(key);
    const before = previous.records.get(key);
    if (after && before) result.records.common++;
    else if (after) result.addedRecords.push(detail(after));
    else result.missingRecords.push(detail(before));
    const afterMetrics = new Map(after ? metricEntries(after) : []);
    const beforeMetrics = new Map(before ? metricEntries(before) : []);
    for (const metric of new Set([...afterMetrics.keys(), ...beforeMetrics.keys()])) {
      const item = { ...detail(after || before), metric };
      const currentExpected = afterMetrics.has(metric) && current.expectedMissingKeys.has(key);
      const previousExpected = beforeMetrics.has(metric) && previous.expectedMissingKeys.has(key);
      if (currentExpected || previousExpected) item.expectedMissing = { current: currentExpected, previous: previousExpected };
      if (!beforeMetrics.has(metric)) { result.addedMetrics.push(item); continue; }
      if (!afterMetrics.has(metric)) { result.missingMetrics.push(item); continue; }
      result.metrics.common++;
      const measurement = afterMetrics.get(metric);
      const old = beforeMetrics.get(metric);
      const reasons = [];
      if ((measurement?.unit ?? '') !== (old?.unit ?? '')) { result.metrics.unitIncomparable++; reasons.push('unit'); }
      if (indexedState(measurement, after, current) !== 'valid' || indexedState(old, before, previous) !== 'valid') { result.metrics.statusIncomparable++; reasons.push('status'); }
      if (current.duplicates.has(key) || previous.duplicates.has(key)) { result.metrics.duplicateIncomparable++; reasons.push('duplicate-key'); }
      if (currentExpected || previousExpected) { result.metrics.expectedMissingIncomparable++; reasons.push('expected-missing'); }
      if (reasons.length) result.incomparableMetrics.push({ ...item, reasons });
      else result.metrics.comparable++;
    }
  }
  result.records.added = result.addedRecords.length;
  result.records.missing = result.missingRecords.length;
  result.metrics.added = result.addedMetrics.length;
  result.metrics.missing = result.missingMetrics.length;
  result.metrics.incomparable = result.incomparableMetrics.length;
  return result;
}

function subset(indexed, predicate) {
  return { ...indexed, records: new Map([...indexed.records].filter(([, record]) => predicate(record))) };
}

export function compareCoverage(current, previous) {
  const after = indexReport(current);
  const before = indexReport(previous);
  const currentCoverage = reportCoverage(current);
  const previousCoverage = reportCoverage(previous);
  const sectionIds = new Set([...currentCoverage.sections, ...previousCoverage.sections].map(section => section.id));
  const sections = [...sectionIds].map(id => {
    const currentSection = subset(after, record => (record.section ?? '') === id);
    const previousSection = subset(before, record => (record.section ?? '') === id);
    const groups = new Set([...currentSection.records.values(), ...previousSection.records.values()].map(record => record.group ?? ''));
    return {
      id, name: sectionNames[id] || id,
      ...coverageDifference(currentSection, previousSection),
      groups: [...groups].map(group => ({ group, ...coverageDifference(subset(currentSection, record => (record.group ?? '') === group), subset(previousSection, record => (record.group ?? '') === group)) }))
    };
  });
  return { ...coverageDifference(after, before), current: currentCoverage, previous: previousCoverage, sections };
}

function preference(metric) {
  if (/speed/i.test(metric)) return 'up';
  if (/latency|loss|retrans/i.test(metric)) return 'down';
  return null;
}

function carrierFor(item) {
  const carrier = String(item.carrier).trim();
  if (carriers.has(carrier)) return carrier;
  if (!carrier && item.section === 'speedtest') return String(item.target).trim().match(/(电信|联通|移动)$/)?.[1] || '其他';
  return '其他';
}

export function comparisonConclusion(changes) {
  const improved = [];
  const worsened = [];
  const neutral = [];
  const seen = new Set();
  for (const change of array(changes)) {
    if (!change || change.significant !== true || !['up', 'down'].includes(change.direction)) continue;
    if (change.before !== undefined && !Number.isFinite(change.before)) continue;
    if (change.after !== undefined && !Number.isFinite(change.after)) continue;
    if (change.delta !== undefined && (!Number.isFinite(change.delta) || change.delta === 0)) continue;
    const identity = JSON.stringify([recordKey(change), change.metric]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const desired = preference(change.metric || '');
    const item = { ...detail(change), metric: change.metric, metricLabel: metricNames[change.metric] || change.metric, direction: change.direction };
    if (!desired) neutral.push(item);
    else if (change.direction === desired) improved.push(item);
    else worsened.push(item);
  }
  const concentration = field => {
    const groups = new Map();
    for (const item of worsened) {
      const key = field === 'carrier' ? carrierFor(item) : item[field];
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups].map(([key, count]) => ({ [field]: key, label: field === 'section' ? sectionNames[key] || key || '未标注维度' : key, count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'));
  };
  const worseningBySection = concentration('section');
  const worseningByCarrier = concentration('carrier');
  const headline = `${improved.length}项显著改善·${worsened.length}项显著恶化`;
  const focus = worsened.length ? `恶化集中在 ${worseningBySection.slice(0, 2).map(item => `${item.label}（${item.count}项）`).join('、')}` : '暂无显著恶化';
  const parts = [];
  if (improved.length || worsened.length) parts.push(headline);
  if (neutral.length) parts.push(`${neutral.length}项显著变化无优劣语义`);
  if (!parts.length) parts.push('没有可判定优劣的显著变化，不代表两份报告完全一致');
  if (improved.length && worsened.length) parts.push('改善与恶化并存，不作整体优劣结论');
  else if (improved.length || worsened.length) parts.push('仅反映共同可比指标，不作整份报告优劣结论');
  const status = improved.length && worsened.length ? 'mixed' : worsened.length ? 'worsened' : improved.length ? 'improved' : neutral.length ? 'neutral' : 'no-significant-change';
  return { status, headline, focus, summary: parts.join('；') + '。', improved, worsened, neutral, improvedMetrics: improved.length, worsenedMetrics: worsened.length, neutralMetrics: neutral.length, worseningBySection, worseningByCarrier };
}
