import { metricNames } from './parser.mjs';
import { latencyBand, international as intlRule, loss as lossRule, speed as speedRule, grade, isSignificantChange } from './thresholds.mjs';

const CARRIERS = ['电信', '联通', '移动'];
const REGION_ORDER = ['华北', '东北', '华东', '华中', '华南', '西南', '西北'];
const PROVINCE_REGIONS = {
  华北: ['北京', '天津', '河北', '山西', '内蒙古'],
  东北: ['辽宁', '吉林', '黑龙江'],
  华东: ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'],
  华中: ['河南', '湖北', '湖南'],
  华南: ['广东', '广西', '海南'],
  西南: ['重庆', '四川', '贵州', '云南', '西藏'],
  西北: ['陕西', '甘肃', '青海', '宁夏', '新疆']
};
const PROVINCE_INDEX = new Map(
  REGION_ORDER.flatMap(region => PROVINCE_REGIONS[region]).map((name, index) => [name, index])
);
const regionOfProvince = name => REGION_ORDER.find(region => PROVINCE_REGIONS[region].includes(name)) || '其他';

const round1 = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const numbers = list => list.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
function quantile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}
const median = list => {
  const sorted = numbers(list);
  return sorted.length ? round1(quantile(sorted, 0.5)) : null;
};
const p90 = list => {
  const sorted = numbers(list);
  return sorted.length ? round1(quantile(sorted, 0.9)) : null;
};
const isIPv6 = record => record?.section === 'ipv6' || [record?.family, record?.carrier, record?.group].some(v => /IPv6/i.test(String(v ?? '')));
const numVal = (record, metric) => {
  const m = record?.metrics?.[metric];
  if (!m || m.status === 'unknown' || m.status === 'failed' || m.status === 'error' || m.status === 'skipped' || m.status === 'missing') return null;
  return typeof m.value === 'number' && Number.isFinite(m.value) && m.value >= 0 ? m.value : null;
};
const textVal = (record, metric) => String(record?.metrics?.[metric]?.value ?? record?.metrics?.[metric]?.raw ?? '').trim();

export function extractSourceIp(report) {
  const fromUpload = String(report?.upload?.sourceIp || '').trim();
  if (fromUpload) return fromUpload;
  const identity = String(report?.identity || '').trim();
  if (!identity) return '';
  const v4 = identity.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (v4) return v4[0];
  const v6 = identity.match(/\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/);
  if (v6) return v6[0];
  const masked = identity.match(/\bIP:\s*([\da-fA-F.:*]{4,45})/i);
  return masked ? masked[1] : '';
}

export function timeBucket(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const bj = new Date(ms + 8 * 3600 * 1000);
  const hour = bj.getUTCHours();
  const minute = bj.getUTCMinutes();
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (hour >= 19 && hour <= 23) return { id: 'peak', label: '晚高峰', hour, clock };
  if (hour >= 8 && hour <= 18) return { id: 'day', label: '白天', hour, clock };
  return { id: 'night', label: '凌晨', hour, clock };
}

function formatGap(hours) {
  if (!Number.isFinite(hours) || hours < 0) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} 小时`;
  return `${Math.round((hours / 24) * 10) / 10} 天`;
}

function dominantRoute(records) {
  const counts = new Map();
  let total = 0;
  for (const record of records) {
    const route = textVal(record, 'route');
    if (!route || route === '-' || route === '—') continue;
    total += 1;
    counts.set(route, (counts.get(route) || 0) + 1);
  }
  if (!total) return { name: '', share: 0 };
  const [name, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { name, share: Number((count / total).toFixed(2)) };
}

function speedCarrierOf(record) {
  const c = String(record?.carrier || '').trim();
  if (CARRIERS.includes(c)) return c;
  const target = String(record?.target || '').trim();
  return CARRIERS.find(name => target.endsWith(name)) || '';
}

function speedRowName(record) {
  const target = String(record?.target || '').trim();
  const hit = CARRIERS.find(name => target.endsWith(name));
  return hit ? target.slice(0, -hit.length) : target;
}

export function summarizeReportSnapshot(report, node = {}) {
  const records = Array.isArray(report?.records) ? report.records : [];
  const band = latencyBand(node?.region);
  const ofSection = section => records.filter(record => record.section === section && !isIPv6(record));

  const ipv4 = ofSection('ipv4');
  const large4 = ofSection('large4');
  const speedV4 = records.filter(record => record.section === 'speedtest' && record.group === 'IPv4');
  const speedIntl = records.filter(record => record.section === 'speedtest' && record.group === '国际方向');
  const intlNodesRaw = records.filter(record => record.section === 'intl' && record.group === '国际节点' && !isIPv6(record));
  const intlServices = records.filter(record => record.section === 'intl' && ['常用网站', '常用 CDN'].includes(record.group));
  const cernet = ofSection('cernet');

  const carriers = {};
  for (const carrier of CARRIERS) {
    const v4Rows = ipv4.filter(record => record.carrier === carrier);
    const l4Rows = large4.filter(record => record.carrier === carrier);
    const spRows = speedV4.filter(record => speedCarrierOf(record) === carrier);
    const latVals = v4Rows.map(r => numVal(r, 'latency')).filter(v => v !== null);
    const lossVals = v4Rows.map(r => numVal(r, 'loss')).filter(v => v !== null);
    const withLoss = lossVals.filter(v => v > 0);
    const retransVals = l4Rows.map(r => numVal(r, 'retrans')).filter(v => v !== null);
    const withRetrans = retransVals.filter(v => v > 0);
    const latP50 = median(latVals);
    const route = dominantRoute(v4Rows);
    carriers[carrier] = {
      latencyP50: latP50,
      latencyP90: p90(latVals),
      latencyLevel: latP50 !== null ? grade(latP50, band) : null,
      route: route.name,
      routeShare: route.share,
      lossLines: withLoss.length,
      lossTotal: lossVals.length,
      lossSevere: withLoss.filter(v => v >= lossRule.severe).length,
      lossMax: withLoss.length ? Math.max(...withLoss) : 0,
      retransLines: withRetrans.length,
      retransTotal: retransVals.length,
      retransSevere: withRetrans.filter(v => v >= lossRule.severe).length,
      retransMax: withRetrans.length ? Math.max(...withRetrans) : 0,
      returnSpeed: median(spRows.map(r => numVal(r, 'returnSpeed')).filter(v => v !== null)),
      outboundSpeed: median(spRows.map(r => numVal(r, 'outboundSpeed')).filter(v => v !== null))
    };
  }

  const intlNodes = intlNodesRaw.map(record => {
    const dl = numVal(record, 'downloadLatency');
    const ul = numVal(record, 'uploadLatency');
    return {
      target: record.target,
      downloadLatency: dl,
      uploadLatency: ul,
      downloadRetrans: numVal(record, 'downloadRetrans'),
      uploadRetrans: numVal(record, 'uploadRetrans'),
      level: dl !== null ? grade(dl, intlRule) : null
    };
  });
  const intlLatP50 = median(intlNodes.map(item => item.downloadLatency).filter(v => v !== null));
  const unreachable = intlServices.filter(record => textVal(record, 'reachable') !== '✓');

  const allIpv4Lat = ipv4.map(r => numVal(r, 'latency')).filter(v => v !== null);
  const overallLatP50 = median(allIpv4Lat);
  const ipv4Losses = ipv4.map(r => numVal(r, 'loss')).filter(v => v !== null);
  const large4Retrans = large4.map(r => numVal(r, 'retrans')).filter(v => v !== null);
  const combinedLoss = [...ipv4Losses, ...large4Retrans];
  const withAnyLoss = combinedLoss.filter(v => v > 0);
  const severeAnyLoss = withAnyLoss.filter(v => v >= lossRule.severe);
  const returnSpeed = median(speedV4.map(r => numVal(r, 'returnSpeed')).filter(v => v !== null));
  const outboundSpeed = median(speedV4.map(r => numVal(r, 'outboundSpeed')).filter(v => v !== null));

  const cernetLat = median(cernet.map(r => numVal(r, 'latency')).filter(v => v !== null));
  const cernetLossVals = cernet.map(r => numVal(r, 'loss')).filter(v => v !== null).filter(v => v > 0);

  return {
    testedAt: report?.testedAt || null,
    identity: String(report?.identity || '').trim(),
    sourceIp: extractSourceIp(report),
    hostname: String(report?.upload?.hostname || '').trim(),
    region: {
      code: String(node?.region || '').toUpperCase() || null,
      label: band.label,
      good: band.good,
      fair: band.fair
    },
    carriers,
    intl: {
      latencyP50: intlLatP50,
      level: intlLatP50 !== null ? grade(intlLatP50, intlRule) : null,
      nodeCount: intlNodes.length,
      nodes: intlNodes,
      servicesTotal: intlServices.length,
      unreachableCount: unreachable.length,
      unreachableNames: unreachable.slice(0, 5).map(r => r.target),
      speedDown: median(speedIntl.map(r => numVal(r, 'downloadSpeed')).filter(v => v !== null)),
      speedUp: median(speedIntl.map(r => numVal(r, 'uploadSpeed')).filter(v => v !== null))
    },
    overall: {
      latencyP50: overallLatP50,
      latencyLevel: overallLatP50 !== null ? grade(overallLatP50, band) : null,
      lossLines: withAnyLoss.length,
      lossSevere: severeAnyLoss.length,
      lossMax: withAnyLoss.length ? Math.max(...withAnyLoss) : 0,
      ipv4LossLines: ipv4Losses.filter(v => v > 0).length,
      large4RetransLines: large4Retrans.filter(v => v > 0).length,
      lossLevel: severeAnyLoss.length ? 'bad' : withAnyLoss.length ? 'fair' : 'good',
      returnSpeed,
      outboundSpeed,
      speedLevel: returnSpeed !== null ? grade(returnSpeed, speedRule) : null
    },
    cernet: {
      latencyP50: cernetLat,
      latencyLevel: cernetLat !== null ? grade(cernetLat, band) : null,
      lossLines: cernetLossVals.length,
      lossMax: cernetLossVals.length ? Math.max(...cernetLossVals) : 0
    }
  };
}

// 精简版快照：供看板接口使用，去掉 intl.nodes 明细数组以保持响应紧凑
export function compactSnapshot(snapshot) {
  if (!snapshot) return null;
  const { nodes, ...intlRest } = snapshot.intl || {};
  return { ...snapshot, intl: intlRest };
}

export function buildCompactDiff(current, previous, node = {}, precomputed = null) {
  if (!current || !previous) return null;
  const afterSnap = precomputed?.after || summarizeReportSnapshot(current, node);
  const beforeSnap = precomputed?.before || summarizeReportSnapshot(previous, node);

  const beforeIp = beforeSnap.sourceIp;
  const afterIp = afterSnap.sourceIp;
  const ipChanged = Boolean(beforeIp && afterIp && beforeIp !== afterIp);

  const bTime = timeBucket(previous.testedAt);
  const aTime = timeBucket(current.testedAt);
  const gapHours = (Date.parse(current.testedAt) - Date.parse(previous.testedAt)) / 3600e3;
  const timeOfDayShift = bTime && aTime ? {
    changed: bTime.id !== aTime.id,
    beforeId: bTime.id,
    afterId: aTime.id,
    beforeLabel: bTime.label,
    afterLabel: aTime.label,
    beforeClock: bTime.clock,
    afterClock: aTime.clock,
    gapHours: Number.isFinite(gapHours) ? round1(gapHours) : null,
    gapLabel: formatGap(gapHours)
  } : null;

  const carriers = {};
  let improvedSignals = 0;
  let worsenedSignals = 0;
  const candidateTags = [];

  if (ipChanged) {
    candidateTags.push({ priority: 95, kind: 'context', tone: 'info', text: 'IP 变更' });
  }

  for (const carrier of CARRIERS) {
    const b = beforeSnap.carriers[carrier];
    const a = afterSnap.carriers[carrier];
    const delta = (a?.latencyP50 !== null && b?.latencyP50 !== null) ? round1(a.latencyP50 - b.latencyP50) : null;
    const significant = delta !== null && Math.abs(delta) >= 10;
    const routeChanged = Boolean(b?.route && a?.route && b.route !== a.route && b.routeShare >= 0.5 && a.routeShare >= 0.5);
    const lossDelta = (a?.lossLines ?? 0) - (b?.lossLines ?? 0);
    const retransDelta = (a?.retransLines ?? 0) - (b?.retransLines ?? 0);
    carriers[carrier] = {
      before: b?.latencyP50 ?? null,
      after: a?.latencyP50 ?? null,
      delta,
      significant,
      lossDelta,
      retransDelta,
      routeChanged,
      beforeRoute: b?.route || '',
      afterRoute: a?.route || ''
    };
    if (significant) {
      if (delta < 0) {
        improvedSignals += 1;
        candidateTags.push({ priority: 70 + Math.min(25, Math.abs(delta) / 5), kind: 'carrier', tone: 'good', text: `${carrier} ${Math.round(delta)}ms` });
      } else {
        worsenedSignals += 1;
        candidateTags.push({ priority: 70 + Math.min(25, Math.abs(delta) / 5), kind: 'carrier', tone: 'bad', text: `${carrier} +${Math.round(delta)}ms` });
      }
    }
  }

  const lossBefore = beforeSnap.overall.lossLines;
  const lossAfter = afterSnap.overall.lossLines;
  const lossDeltaLines = lossAfter - lossBefore;
  const severeDelta = afterSnap.overall.lossSevere - beforeSnap.overall.lossSevere;
  if (Math.abs(lossDeltaLines) >= 5 || Math.abs(severeDelta) >= 3) {
    if (lossDeltaLines > 0) {
      worsenedSignals += 1;
      candidateTags.push({ priority: 86 + Math.min(12, Math.abs(lossDeltaLines) / 5), kind: 'loss', tone: 'bad', text: `丢包/重传 +${lossDeltaLines}条` });
    } else if (lossDeltaLines < 0) {
      improvedSignals += 1;
      candidateTags.push({ priority: 82 + Math.min(12, Math.abs(lossDeltaLines) / 5), kind: 'loss', tone: 'good', text: `丢包/重传 ${lossDeltaLines}条` });
    }
  }

  const spBefore = beforeSnap.overall.returnSpeed;
  const spAfter = afterSnap.overall.returnSpeed;
  let speedDelta = null;
  let speedPct = null;
  let speedSig = false;
  if (spBefore !== null && spAfter !== null) {
    speedDelta = round1(spAfter - spBefore);
    speedPct = spBefore > 0 ? Math.round((speedDelta / spBefore) * 100) : null;
    speedSig = isSignificantChange('returnSpeed', speedDelta, spBefore, spAfter);
    if (speedSig && (speedPct === null || Math.abs(speedPct) >= 15)) {
      if (speedDelta > 0) {
        improvedSignals += 1;
        candidateTags.push({ priority: 84, kind: 'speed', tone: 'good', text: speedPct !== null ? `带宽 +${speedPct}%` : `带宽 +${Math.round(speedDelta)}M` });
      } else {
        worsenedSignals += 1;
        candidateTags.push({ priority: 88, kind: 'speed', tone: 'bad', text: speedPct !== null ? `带宽 ${speedPct}%` : `带宽 ${Math.round(speedDelta)}M` });
      }
    }
  }

  const intlBefore = beforeSnap.intl.latencyP50;
  const intlAfter = afterSnap.intl.latencyP50;
  const intlDelta = (intlBefore !== null && intlAfter !== null) ? round1(intlAfter - intlBefore) : null;
  const intlSig = intlDelta !== null && Math.abs(intlDelta) >= 15;
  const unreachableDelta = afterSnap.intl.unreachableCount - beforeSnap.intl.unreachableCount;
  if (unreachableDelta > 0) {
    worsenedSignals += 1;
    candidateTags.push({ priority: 85, kind: 'intl', tone: 'bad', text: `国际不可达 +${unreachableDelta}` });
  } else if (unreachableDelta < 0) {
    improvedSignals += 1;
    candidateTags.push({ priority: 75, kind: 'intl', tone: 'good', text: `国际恢复 ${Math.abs(unreachableDelta)}项` });
  } else if (intlSig) {
    if (intlDelta < 0) {
      improvedSignals += 1;
      candidateTags.push({ priority: 68, kind: 'intl', tone: 'good', text: `国际 ${Math.round(intlDelta)}ms` });
    } else {
      worsenedSignals += 1;
      candidateTags.push({ priority: 68, kind: 'intl', tone: 'warn', text: `国际 +${Math.round(intlDelta)}ms` });
    }
  }

  candidateTags.sort((a, b) => b.priority - a.priority);
  const tags = candidateTags.slice(0, 4).map(({ kind, tone, text }) => ({ kind, tone, text }));
  if (!tags.length) tags.push({ kind: 'steady', tone: 'neutral', text: '整体平稳' });

  const verdict = improvedSignals && worsenedSignals ? 'mixed'
    : worsenedSignals ? 'worsened'
    : improvedSignals ? 'improved'
    : 'steady';

  return {
    baseId: previous.id,
    baseTestedAt: previous.testedAt,
    currentId: current.id,
    currentTestedAt: current.testedAt,
    ipChanged,
    beforeIp,
    afterIp,
    timeOfDayShift,
    carriers,
    intl: { before: intlBefore, after: intlAfter, delta: intlDelta, significant: intlSig, unreachableDelta },
    speed: { before: spBefore, after: spAfter, delta: speedDelta, pct: speedPct, significant: speedSig },
    loss: { beforeLines: lossBefore, afterLines: lossAfter, deltaLines: lossDeltaLines, beforeSevere: beforeSnap.overall.lossSevere, afterSevere: afterSnap.overall.lossSevere, deltaSevere: severeDelta },
    tags,
    verdict
  };
}

function classifyDiffTone(metric, delta, before, after, significant) {
  if (delta === null || !Number.isFinite(delta)) return 'na';
  if (!significant || delta === 0) return 'neutral';
  if (/speed/i.test(metric)) {
    const base = Math.max(Math.abs(before || 0), Math.abs(after || 0), 1);
    const rel = Math.abs(delta) / base;
    if (delta > 0) return (delta >= 80 || rel >= 0.45) ? 'good-strong' : 'good';
    return (delta <= -80 || rel >= 0.4) ? 'bad-strong' : 'bad';
  }
  if (/loss|retrans/i.test(metric)) {
    if (delta < 0) return delta <= -10 ? 'good-strong' : 'good';
    return delta >= 10 ? 'bad-strong' : 'bad';
  }
  // latency
  if (delta < 0) return delta <= -40 ? 'good-strong' : 'good';
  return delta >= 40 ? 'bad-strong' : 'bad';
}

function sortProvinces(list) {
  return [...list].sort((a, b) => {
    const ia = PROVINCE_INDEX.has(a) ? PROVINCE_INDEX.get(a) : 999;
    const ib = PROVINCE_INDEX.has(b) ? PROVINCE_INDEX.get(b) : 999;
    return ia - ib || a.localeCompare(b, 'zh-CN');
  });
}

function buildSectionDiffMatrix(current, previous, { id, name, metrics, secondary = false, speedMode = false }) {
  const pickRecords = report => {
    const all = Array.isArray(report?.records) ? report.records : [];
    if (speedMode) return all.filter(r => r.section === 'speedtest' && r.group === 'IPv4');
    return all.filter(r => r.section === id && !isIPv6(r));
  };
  const afterRecs = pickRecords(current);
  const beforeRecs = pickRecords(previous);
  if (!afterRecs.length && !beforeRecs.length) return null;

  const mapOf = recs => {
    const m = new Map();
    for (const r of recs) {
      const row = speedMode ? speedRowName(r) : r.target;
      const col = speedMode ? (speedCarrierOf(r) || '测速') : (r.carrier || '默认');
      if (!m.has(`${row}|${col}`)) m.set(`${row}|${col}`, r);
    }
    return m;
  };
  const afterMap = mapOf(afterRecs);
  const beforeMap = mapOf(beforeRecs);
  const rowSet = new Set();
  const colSet = new Set();
  for (const key of new Set([...afterMap.keys(), ...beforeMap.keys()])) {
    const [row, col] = key.split('|');
    rowSet.add(row);
    colSet.add(col);
  }
  const rows = sortProvinces([...rowSet]);
  const cols = [
    ...CARRIERS.filter(c => colSet.has(c)),
    ...[...colSet].filter(c => !CARRIERS.includes(c))
  ];
  const regions = rows.map(regionOfProvince);
  const routes = rows.map(row => cols.map(col => ({
    before: textVal(beforeMap.get(`${row}|${col}`), 'route'),
    after: textVal(afterMap.get(`${row}|${col}`), 'route')
  })));

  const metricBlocks = metrics.map(metric => {
    let unit = '';
    const cells = rows.map(row => cols.map(col => {
      const bRec = beforeMap.get(`${row}|${col}`);
      const aRec = afterMap.get(`${row}|${col}`);
      const bVal = numVal(bRec, metric);
      const aVal = numVal(aRec, metric);
      const bUnit = bRec?.metrics?.[metric]?.unit || '';
      const aUnit = aRec?.metrics?.[metric]?.unit || '';
      if (!unit) unit = aUnit || bUnit || '';
      if (bVal === null || aVal === null || (bUnit && aUnit && bUnit !== aUnit)) {
        return { before: bVal, after: aVal, delta: null, significant: false, tone: 'na' };
      }
      const delta = round1(aVal - bVal);
      const significant = isSignificantChange(metric, delta, bVal, aVal);
      return {
        before: bVal,
        after: aVal,
        delta,
        significant,
        tone: classifyDiffTone(metric, delta, bVal, aVal, significant)
      };
    }));
    const totalComparable = cells.flat().filter(c => c.delta !== null).length;
    if (!totalComparable) return null;
    const improved = cells.flat().filter(c => c.tone === 'good' || c.tone === 'good-strong').length;
    const worsened = cells.flat().filter(c => c.tone === 'bad' || c.tone === 'bad-strong').length;
    return {
      id: metric,
      name: `${metricNames[metric] || metric}变化`,
      unit,
      totalComparable,
      improved,
      worsened,
      cells
    };
  }).filter(Boolean);

  if (!metricBlocks.length) return null;
  return { id, name, secondary, rows, regions, columns: cols, routes, metrics: metricBlocks };
}

function buildIntlDiff(current, previous, beforeSnap, afterSnap) {
  const beforeMap = new Map((beforeSnap.intl.nodes || []).map(n => [n.target, n]));
  const afterMap = new Map((afterSnap.intl.nodes || []).map(n => [n.target, n]));
  const targets = [...new Set([...afterMap.keys(), ...beforeMap.keys()])];
  const nodes = targets.map(target => {
    const b = beforeMap.get(target);
    const a = afterMap.get(target);
    const bLat = b?.downloadLatency ?? null;
    const aLat = a?.downloadLatency ?? null;
    const delta = (bLat !== null && aLat !== null) ? round1(aLat - bLat) : null;
    const significant = delta !== null && isSignificantChange('downloadLatency', delta, bLat, aLat);
    return {
      target,
      beforeLatency: bLat,
      afterLatency: aLat,
      delta,
      significant,
      tone: classifyDiffTone('downloadLatency', delta, bLat, aLat, significant),
      beforeRetrans: b?.downloadRetrans ?? null,
      afterRetrans: a?.downloadRetrans ?? null
    };
  });

  const svcOf = report => new Map(
    (Array.isArray(report?.records) ? report.records : [])
      .filter(r => r.section === 'intl' && ['常用网站', '常用 CDN'].includes(r.group))
      .map(r => [r.target, {
        target: r.target,
        group: r.group,
        reachable: textVal(r, 'reachable') === '✓',
        latency: numVal(r, 'latency')
      }])
  );
  const bSvc = svcOf(previous);
  const aSvc = svcOf(current);
  const services = [];
  for (const name of new Set([...aSvc.keys(), ...bSvc.keys()])) {
    const b = bSvc.get(name);
    const a = aSvc.get(name);
    if (!b || !a) continue;
    const reachChanged = b.reachable !== a.reachable;
    const delta = (b.latency !== null && a.latency !== null) ? round1(a.latency - b.latency) : null;
    const latSig = delta !== null && Math.abs(delta) >= 20;
    if (reachChanged || latSig) {
      services.push({
        target: name,
        group: a.group,
        beforeReachable: b.reachable,
        afterReachable: a.reachable,
        reachChanged,
        beforeLatency: b.latency,
        afterLatency: a.latency,
        delta,
        tone: reachChanged ? (a.reachable ? 'good-strong' : 'bad-strong') : classifyDiffTone('latency', delta, b.latency, a.latency, latSig)
      });
    }
  }
  services.sort((a, b) => Number(b.reachChanged) - Number(a.reachChanged) || Math.abs(b.delta || 0) - Math.abs(a.delta || 0));

  return { nodes, services };
}

export function analyzeComparison(current, previous, changes = [], node = {}) {
  const beforeSnap = summarizeReportSnapshot(previous, node);
  const afterSnap = summarizeReportSnapshot(current, node);
  const compact = buildCompactDiff(current, previous, node, { before: beforeSnap, after: afterSnap });

  const routeChanges = CARRIERS
    .map(carrier => ({ carrier, before: beforeSnap.carriers[carrier]?.route || '', after: afterSnap.carriers[carrier]?.route || '', changed: compact.carriers[carrier]?.routeChanged }))
    .filter(item => item.changed);

  const context = {
    baseTestedAt: previous.testedAt,
    currentTestedAt: current.testedAt,
    gapHours: compact.timeOfDayShift?.gapHours ?? null,
    gapLabel: compact.timeOfDayShift?.gapLabel || '',
    beforeIp: compact.beforeIp,
    afterIp: compact.afterIp,
    ipChanged: compact.ipChanged,
    beforeIdentity: beforeSnap.identity,
    afterIdentity: afterSnap.identity,
    timeOfDayShift: compact.timeOfDayShift,
    routeChanges
  };

  const brief = [];
  const secondaryBrief = [];

  // 1. 三网回程延迟事件聚类
  const ipv4LatChanges = changes.filter(c => c.section === 'ipv4' && c.metric === 'latency');
  for (const carrier of CARRIERS) {
    const items = ipv4LatChanges.filter(c => c.carrier === carrier);
    if (!items.length) continue;
    const improved = items.filter(c => c.significant && c.delta < 0);
    const worsened = items.filter(c => c.significant && c.delta > 0);
    const bMed = beforeSnap.carriers[carrier]?.latencyP50;
    const aMed = afterSnap.carriers[carrier]?.latencyP50;
    const medDelta = (bMed !== null && aMed !== null) ? round1(aMed - bMed) : median(items.map(i => i.delta));
    const rc = routeChanges.find(r => r.carrier === carrier);
    const total = items.length;

    const findOutliers = baseDelta => items
      .filter(i => i.significant && Math.abs(i.delta - baseDelta) >= 40 && Math.abs(i.delta) >= 25)
      .sort((a, b) => Math.abs(b.delta - baseDelta) - Math.abs(a.delta - baseDelta))
      .slice(0, 3)
      .map(i => `${i.target} ${i.before}→${i.after}ms (${i.delta > 0 ? '+' : ''}${i.delta}ms)`);

    const deltaText = medDelta !== null ? `（${medDelta > 0 ? '+' : ''}${medDelta}ms）` : '';

    if (improved.length >= 3 && improved.length / total >= 0.45 && improved.length > worsened.length) {
      const strong = medDelta !== null && medDelta <= -50;
      const routeHint = rc ? `，主路由 ${rc.before} → ${rc.after}` : (strong ? '（疑似路由切换为直连）' : '');
      brief.push({
        severity: 'good',
        priority: strong ? 96 : 82,
        scope: carrier,
        kind: 'latency',
        title: `${carrier}回程${strong ? '大幅改善' : '整体改善'}`,
        detail: `${improved.length}/${total} 省延迟显著下降，中位 ${bMed ?? '—'}ms → ${aMed ?? '—'}ms${deltaText}${routeHint}`,
        outliers: findOutliers(medDelta ?? 0)
      });
    } else if (worsened.length >= 3 && worsened.length / total >= 0.45 && worsened.length > improved.length) {
      const strong = medDelta !== null && medDelta >= 50;
      const routeHint = rc ? `，主路由 ${rc.before} → ${rc.after}` : (strong ? '（疑似出现绕路）' : '');
      brief.push({
        severity: strong ? 'bad' : 'warn',
        priority: strong ? 98 : 80,
        scope: carrier,
        kind: 'latency',
        title: `${carrier}回程${strong ? '明显恶化' : '整体偏高'}`,
        detail: `${worsened.length}/${total} 省延迟显著上升，中位 ${bMed ?? '—'}ms → ${aMed ?? '—'}ms${deltaText}${routeHint}`,
        outliers: findOutliers(medDelta ?? 0)
      });
    } else if (improved.length + worsened.length > 0) {
      const sig = [...worsened, ...improved].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const topText = sig.slice(0, 3).map(i => `${i.target} ${i.delta > 0 ? '+' : ''}${i.delta}ms`).join('、');
      const netBad = worsened.length > improved.length;
      const netGood = improved.length > worsened.length;
      brief.push({
        severity: netBad ? 'warn' : netGood ? 'good' : 'info',
        priority: 65 + Math.min(15, Math.abs(sig[0].delta) / 10),
        scope: carrier,
        kind: 'latency',
        title: `${carrier}局部 ${sig.length} 省波动`,
        detail: `${worsened.length ? `${worsened.length} 省上升` : ''}${worsened.length && improved.length ? '、' : ''}${improved.length ? `${improved.length} 省下降` : ''}：${topText}`,
        outliers: []
      });
    }
  }

  // 2. 丢包 & 大包重传聚类
  const lossSpecs = [
    { section: 'ipv4', metric: 'loss', label: 'IPv4 丢包', beforeLines: beforeSnap.overall.ipv4LossLines, afterLines: afterSnap.overall.ipv4LossLines },
    { section: 'large4', metric: 'retrans', label: '大包重传', beforeLines: beforeSnap.overall.large4RetransLines, afterLines: afterSnap.overall.large4RetransLines }
  ];
  for (const spec of lossSpecs) {
    const items = changes.filter(c => c.section === spec.section && c.metric === spec.metric && c.significant);
    const worsened = items.filter(c => c.delta > 0).sort((a, b) => b.after - a.after || b.delta - a.delta);
    const improved = items.filter(c => c.delta < 0).sort((a, b) => a.delta - b.delta);
    const lineDelta = spec.afterLines - spec.beforeLines;
    const worstAfter = worsened[0]?.after ?? 0;
    if (worsened.length >= 2 || lineDelta >= 3 || (worsened.length && worstAfter >= 10)) {
      const byCarrier = CARRIERS
        .map(c => [c, worsened.filter(i => i.carrier === c).length])
        .filter(([, n]) => n > 0)
        .map(([c, n]) => `${c} ${n}条`);
      const worstList = worsened.slice(0, 3).map(i => `${i.target}·${i.carrier} ${i.after}%`);
      const detail = worsened.length
        ? `${worsened.length} 条线路恶化${byCarrier.length ? `（${byCarrier.join('、')}）` : ''}，最高 ${worstAfter}%：${worstList.join('、')}`
        : `新增 ${lineDelta} 条含${spec.label}的记录（主要为新覆盖或轻度波动）`;
      brief.push({
        severity: worstAfter >= 10 || worsened.length >= 8 ? 'bad' : 'warn',
        priority: 90 + Math.min(9, Math.max(worsened.length, lineDelta) / 5),
        scope: spec.label,
        kind: 'loss',
        title: `${spec.label}加重（${spec.beforeLines} → ${spec.afterLines} 条线路）`,
        detail,
        outliers: []
      });
    } else if (improved.length >= 3 || lineDelta <= -3) {
      const bestList = improved.slice(0, 3).map(i => `${i.target}·${i.carrier} ${i.before}%→${i.after}%`);
      const detail = improved.length
        ? `${improved.length} 条线路显著好转：${bestList.join('、')}`
        : `含${spec.label}的线路减少 ${Math.abs(lineDelta)} 条`;
      brief.push({
        severity: 'good',
        priority: 84,
        scope: spec.label,
        kind: 'loss',
        title: `${spec.label}缓解（${spec.beforeLines} → ${spec.afterLines} 条线路）`,
        detail,
        outliers: []
      });
    }
  }

  // 3. 回程 / 去程测速汇总
  const spBefore = beforeSnap.overall.returnSpeed;
  const spAfter = afterSnap.overall.returnSpeed;
  const outBefore = beforeSnap.overall.outboundSpeed;
  const outAfter = afterSnap.overall.outboundSpeed;
  const spDelta = (spBefore !== null && spAfter !== null) ? round1(spAfter - spBefore) : null;
  const spSig = spDelta !== null && isSignificantChange('returnSpeed', spDelta, spBefore, spAfter);
  const outDelta = (outBefore !== null && outAfter !== null) ? round1(outAfter - outBefore) : null;
  const outSig = outDelta !== null && isSignificantChange('outboundSpeed', outDelta, outBefore, outAfter);
  if (spSig || outSig) {
    const pct = (spBefore && spDelta !== null) ? Math.round((spDelta / spBefore) * 100) : null;
    const carrierSpeeds = CARRIERS.map(c => {
      const b = beforeSnap.carriers[c]?.returnSpeed;
      const a = afterSnap.carriers[c]?.returnSpeed;
      if (b === null || a === null) return null;
      const d = round1(a - b);
      if (!isSignificantChange('returnSpeed', d, b, a)) return null;
      return `${c} ${b}→${a}Mbps`;
    }).filter(Boolean);
    const worse = spSig ? spDelta < 0 : outDelta < 0;
    const parts = [];
    if (spBefore !== null && spAfter !== null) parts.push(`回程中位 ${spBefore} → ${spAfter} Mbps${pct !== null ? `（${pct > 0 ? '+' : ''}${pct}%）` : ''}`);
    if (outBefore !== null && outAfter !== null && outSig) parts.push(`去程 ${outBefore} → ${outAfter} Mbps`);
    if (carrierSpeeds.length) parts.push(`分网：${carrierSpeeds.join('、')}`);
    brief.push({
      severity: worse ? (pct !== null && pct <= -40 ? 'bad' : 'warn') : 'good',
      priority: worse ? 92 : 83,
      scope: '国内测速',
      kind: 'speed',
      title: spSig ? `回程带宽${spDelta < 0 ? '明显下降' : '明显提升'}` : `去程带宽${outDelta < 0 ? '下降' : '提升'}`,
      detail: parts.join('；'),
      outliers: []
    });
  }

  // 4. 国际互联汇总
  const intlDiff = buildIntlDiff(current, previous, beforeSnap, afterSnap);
  const intlBefore = beforeSnap.intl.latencyP50;
  const intlAfter = afterSnap.intl.latencyP50;
  const intlDelta = (intlBefore !== null && intlAfter !== null) ? round1(intlAfter - intlBefore) : null;
  const newlyDown = intlDiff.services.filter(s => s.reachChanged && !s.afterReachable);
  const recovered = intlDiff.services.filter(s => s.reachChanged && s.afterReachable);
  if (newlyDown.length || recovered.length || (intlDelta !== null && Math.abs(intlDelta) >= 10)) {
    const parts = [];
    const intlNodeCount = afterSnap.intl.nodeCount || beforeSnap.intl.nodeCount;
    if (intlDelta !== null && Math.abs(intlDelta) >= 10) parts.push(`${intlNodeCount ? `${intlNodeCount} 个` : ''}国际节点延迟 p50 ${intlBefore} → ${intlAfter}ms（${intlDelta > 0 ? '+' : ''}${intlDelta}ms）`);
    if (newlyDown.length) parts.push(`新增不可达：${newlyDown.slice(0, 4).map(s => s.target).join('、')}`);
    if (recovered.length) parts.push(`恢复可达：${recovered.slice(0, 4).map(s => s.target).join('、')}`);
    const worse = newlyDown.length > 0 || (intlDelta !== null && intlDelta >= 10);
    brief.push({
      severity: newlyDown.length ? 'bad' : worse ? 'warn' : 'good',
      priority: newlyDown.length ? 89 : 76,
      scope: '国际互联',
      kind: 'intl',
      title: newlyDown.length ? `国际服务新增 ${newlyDown.length} 项不可达` : (worse ? '国际延迟上升' : '国际互联改善'),
      detail: parts.join('；'),
      outliers: []
    });
  }

  // 5. 次要维度：教育网（不进入主简报，折叠展示）
  const cernetChanges = changes.filter(c => c.section === 'cernet' && c.significant);
  if (cernetChanges.length) {
    const bC = beforeSnap.cernet.latencyP50;
    const aC = afterSnap.cernet.latencyP50;
    const dC = (bC !== null && aC !== null) ? round1(aC - bC) : null;
    const lossDiff = afterSnap.cernet.lossLines - beforeSnap.cernet.lossLines;
    const parts = [];
    if (dC !== null && Math.abs(dC) >= 10) parts.push(`延迟 p50 ${bC}→${aC}ms（${dC > 0 ? '+' : ''}${dC}ms）`);
    if (lossDiff !== 0) parts.push(`丢包线路 ${beforeSnap.cernet.lossLines}→${afterSnap.cernet.lossLines}条`);
    if (!parts.length) parts.push(`${cernetChanges.length} 项显著波动`);
    secondaryBrief.push({
      severity: 'info',
      scope: '教育网',
      kind: 'cernet',
      title: '教育网回程变化（次要）',
      detail: parts.join('；')
    });
  }

  brief.sort((a, b) => b.priority - a.priority);
  if (!brief.length) {
    brief.push({
      severity: 'info',
      priority: 0,
      scope: '整体',
      kind: 'steady',
      title: '三网与国际核心指标整体平稳',
      detail: '延迟、丢包、回程带宽与国际互联均在常规波动范围内，无明显路由或质量变化。',
      outliers: []
    });
  }

  // 三网 + 国际总览表
  const overview = CARRIERS.map(carrier => {
    const b = beforeSnap.carriers[carrier];
    const a = afterSnap.carriers[carrier];
    const latDelta = (b?.latencyP50 !== null && a?.latencyP50 !== null) ? round1(a.latencyP50 - b.latencyP50) : null;
    const latSig = latDelta !== null && Math.abs(latDelta) >= 10;
    const spB = b?.returnSpeed ?? null;
    const spA = a?.returnSpeed ?? null;
    const spD = (spB !== null && spA !== null) ? round1(spA - spB) : null;
    const spS = spD !== null && isSignificantChange('returnSpeed', spD, spB, spA);
    return {
      key: carrier,
      label: carrier,
      secondary: false,
      latency: { before: b?.latencyP50 ?? null, after: a?.latencyP50 ?? null, delta: latDelta, level: a?.latencyLevel ?? null, tone: classifyDiffTone('latency', latDelta, b?.latencyP50, a?.latencyP50, latSig) },
      loss: { beforeLines: b?.lossLines ?? 0, afterLines: a?.lossLines ?? 0, deltaLines: (a?.lossLines ?? 0) - (b?.lossLines ?? 0), beforeMax: b?.lossMax ?? 0, afterMax: a?.lossMax ?? 0 },
      retrans: { beforeLines: b?.retransLines ?? 0, afterLines: a?.retransLines ?? 0, deltaLines: (a?.retransLines ?? 0) - (b?.retransLines ?? 0), beforeMax: b?.retransMax ?? 0, afterMax: a?.retransMax ?? 0 },
      speed: { before: spB, after: spA, delta: spD, tone: classifyDiffTone('returnSpeed', spD, spB, spA, spS) },
      route: { before: b?.route || '', after: a?.route || '', changed: Boolean(b?.route && a?.route && b.route !== a.route) }
    };
  });

  if (beforeSnap.intl.nodeCount || afterSnap.intl.nodeCount || beforeSnap.intl.servicesTotal || afterSnap.intl.servicesTotal) {
    const iDelta = (beforeSnap.intl.latencyP50 !== null && afterSnap.intl.latencyP50 !== null) ? round1(afterSnap.intl.latencyP50 - beforeSnap.intl.latencyP50) : null;
    const iSig = iDelta !== null && Math.abs(iDelta) >= 10;
    overview.push({
      key: 'intl',
      label: '国际互联',
      secondary: false,
      latency: { before: beforeSnap.intl.latencyP50, after: afterSnap.intl.latencyP50, delta: iDelta, level: afterSnap.intl.level, tone: classifyDiffTone('downloadLatency', iDelta, beforeSnap.intl.latencyP50, afterSnap.intl.latencyP50, iSig) },
      unreachable: { before: beforeSnap.intl.unreachableCount, after: afterSnap.intl.unreachableCount, delta: afterSnap.intl.unreachableCount - beforeSnap.intl.unreachableCount },
      speed: { before: beforeSnap.intl.speedDown, after: afterSnap.intl.speedDown, delta: (beforeSnap.intl.speedDown !== null && afterSnap.intl.speedDown !== null) ? round1(afterSnap.intl.speedDown - beforeSnap.intl.speedDown) : null, tone: 'neutral' }
    });
  }

  const diffMatrices = [
    buildSectionDiffMatrix(current, previous, { id: 'ipv4', name: 'IPv4 回程', metrics: ['latency', 'loss'] }),
    buildSectionDiffMatrix(current, previous, { id: 'large4', name: 'IPv4 大包回程', metrics: ['latency', 'retrans'] }),
    buildSectionDiffMatrix(current, previous, { id: 'speedtest', name: '单线程测速', metrics: ['returnSpeed', 'outboundSpeed'], speedMode: true }),
    buildSectionDiffMatrix(current, previous, { id: 'cernet', name: '教育网回程', metrics: ['latency', 'loss'], secondary: true })
  ].filter(Boolean);

  return {
    context,
    verdict: compact.verdict,
    tags: compact.tags,
    brief,
    secondaryBrief,
    overview,
    diffMatrices,
    intlDiff
  };
}
