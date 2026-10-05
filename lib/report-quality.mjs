import { sectionNames, metricNames } from './parser.mjs';

const textMetrics = new Set(['route', 'domain', 'reachable']);
const array = value => Array.isArray(value) ? value : [];
const entries = value => value && typeof value === 'object' ? Object.entries(value) : [];
const recordKey = record => record.key ?? JSON.stringify([record.section, record.group, record.target, record.carrier]);
const detail = record => ({ key: recordKey(record), section: record.section ?? '', group: record.group ?? '', target: record.target ?? '', carrier: record.carrier ?? '' });
const metricEntries = record => entries(record.metrics).filter(([name, measurement]) => !textMetrics.has(name) && measurement?.status !== 'text');

function measurementState(measurement, record) {
  if (record.status === 'failed' || measurement?.status === 'failed' || measurement?.status === 'error') return 'failed';
  if (measurement?.status === 'ok' && Number.isFinite(measurement.value) && measurement.value >= 0) return 'valid';
  const raw = String(measurement?.raw ?? measurement?.value ?? '').trim();
  if (/^(?:fail(?:ed)?|error)$/i.test(raw) || /^-\d+(?:\.\d+)?\s*(?:ms|[KMG]bps|%)?$/i.test(raw)) return 'failed';
  if (!raw || measurement?.status === 'missing') return 'missing';
  return 'unknown';
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
  return { records, duplicates };
}

const counts = () => ({ records: 0, numericMetrics: 0, validMetrics: 0, failedMetrics: 0, missingMetrics: 0, unknownMetrics: 0, unavailableMetrics: 0 });

function addCounts(destination, record) {
  destination.records++;
  for (const [, measurement] of metricEntries(record)) {
    const state = measurementState(measurement, record);
    destination.numericMetrics++;
    destination[`${state === 'valid' ? 'valid' : state}Metrics`]++;
    if (state !== 'valid') destination.unavailableMetrics++;
  }
}

export function reportCoverage(report) {
  const indexed = indexReport(report);
  const totals = counts();
  const sections = new Map();
  const issues = [];
  const ensureSection = (id, name) => {
    if (!sections.has(id)) sections.set(id, { id, name: name || sectionNames[id] || id, ...counts(), groups: new Map() });
    return sections.get(id);
  };
  for (const section of array(report?.sections)) {
    const id = typeof section === 'string' ? section : section?.id;
    if (id) ensureSection(id, section?.name);
  }
  for (const record of indexed.records.values()) {
    const section = ensureSection(record.section ?? '');
    const group = record.group ?? '';
    if (!section.groups.has(group)) section.groups.set(group, { group, ...counts() });
    for (const destination of [totals, section, section.groups.get(group)]) addCounts(destination, record);
    for (const [metric, measurement] of metricEntries(record)) {
      const state = measurementState(measurement, record);
      if (state === 'failed' || state === 'unknown') issues.push({ type: state, ...detail(record), metric });
    }
    if (record.status === 'failed' && !metricEntries(record).length) issues.push({ type: 'failed', ...detail(record) });
  }
  for (const [key, count] of indexed.duplicates) issues.push({ type: 'duplicate-key', ...detail(indexed.records.get(key)), count });
  for (const warning of array(report?.warnings)) {
    if (typeof warning !== 'string') continue;
    if (/^报告没有 .+ 维度$/.test(warning.trim())) continue;
    issues.push({ type: 'warning', message: warning });
  }
  for (const section of sections.values()) {
    if (!section.records) issues.push({ type: 'empty-section', section: section.id, message: `${section.name} 未解析出记录` });
  }
  const missingSections = Object.keys(sectionNames).filter(id => !sections.get(id)?.records);
  const partial = !totals.records || !totals.numericMetrics || missingSections.length > 0 || totals.missingMetrics > 0;
  const status = issues.length ? 'issues' : !totals.records ? 'empty' : partial ? 'partial' : 'ok';
  const label = { issues: '存在失败或解析告警', empty: '无可用记录', partial: '部分覆盖（不代表导入残缺）', ok: '已覆盖已知维度' }[status];
  return {
    status, label, partial, ...totals,
    duplicateRecords: [...indexed.duplicates.values()].reduce((sum, count) => sum + count, 0),
    missingSections, issues,
    sections: [...sections.values()].map(section => ({ ...section, groups: [...section.groups.values()] }))
  };
}

function coverageDifference(current, previous) {
  const result = {
    records: { current: current.records.size, previous: previous.records.size, common: 0, added: 0, missing: 0 },
    metrics: { current: 0, previous: 0, common: 0, added: 0, missing: 0, comparable: 0, incomparable: 0, unitIncomparable: 0, statusIncomparable: 0, duplicateIncomparable: 0 },
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
      if (!beforeMetrics.has(metric)) { result.addedMetrics.push(item); continue; }
      if (!afterMetrics.has(metric)) { result.missingMetrics.push(item); continue; }
      result.metrics.common++;
      const measurement = afterMetrics.get(metric);
      const old = beforeMetrics.get(metric);
      const reasons = [];
      if ((measurement?.unit ?? '') !== (old?.unit ?? '')) { result.metrics.unitIncomparable++; reasons.push('unit'); }
      if (measurementState(measurement, after) !== 'valid' || measurementState(old, before) !== 'valid') { result.metrics.statusIncomparable++; reasons.push('status'); }
      if (current.duplicates.has(key) || previous.duplicates.has(key)) { result.metrics.duplicateIncomparable++; reasons.push('duplicate-key'); }
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
  return { records: new Map([...indexed.records].filter(([, record]) => predicate(record))), duplicates: indexed.duplicates };
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
      const key = item[field];
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups].map(([key, count]) => ({ [field]: key, label: field === 'section' ? sectionNames[key] || key || '未标注维度' : key || '未标注运营商', count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'));
  };
  const worseningBySection = concentration('section');
  const worseningByCarrier = concentration('carrier');
  const describe = items => [...new Set(items.map(item => item.metricLabel))].slice(0, 3).join('、');
  const parts = [];
  if (improved.length) parts.push(`${improved.length} 项指标显著改善（${describe(improved)}）`);
  if (worsened.length) {
    parts.push(`${worsened.length} 项指标显著恶化（${describe(worsened)}）`);
    parts.push(`恶化分布：${worseningBySection.map(item => `${item.label} ${item.count} 项`).join('、')}；${worseningByCarrier.map(item => `${item.label} ${item.count} 项`).join('、')}`);
  }
  if (neutral.length) parts.push(`${neutral.length} 项显著变化无优劣语义，不判改善或恶化`);
  if (!parts.length) parts.push('没有可判定优劣的显著变化，不代表两份报告完全一致');
  if (improved.length && worsened.length) parts.push('改善与恶化并存，不作整体优劣结论');
  else if (improved.length || worsened.length) parts.push('仅反映共同可比指标，不作整份报告优劣结论');
  const status = improved.length && worsened.length ? 'mixed' : worsened.length ? 'worsened' : improved.length ? 'improved' : neutral.length ? 'neutral' : 'no-significant-change';
  return { status, summary: parts.join('；') + '。', improved, worsened, neutral, improvedMetrics: improved.length, worsenedMetrics: worsened.length, neutralMetrics: neutral.length, worseningBySection, worseningByCarrier };
}
