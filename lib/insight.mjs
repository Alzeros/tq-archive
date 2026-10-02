import { metricNames } from './parser.mjs';
import { latencyBand, latencyByRegion, levelFromBand, spread as spreadRule, loss as lossRule, speed as speedRule, gradeLabels, outlier } from './thresholds.mjs';

// 省份按大区聚合：判断"整个西北都慢"还是"只有新疆慢"，比逐省看更能定位问题层级。
const REGIONS = {
  华北: ['北京', '天津', '河北', '山西', '内蒙古'],
  东北: ['辽宁', '吉林', '黑龙江'],
  华东: ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'],
  华中: ['河南', '湖北', '湖南'],
  华南: ['广东', '广西', '海南'],
  西南: ['重庆', '四川', '贵州', '云南', '西藏'],
  西北: ['陕西', '甘肃', '青海', '宁夏', '新疆']
};
const regionOf = target => Object.keys(REGIONS).find(region => REGIONS[region].includes(target)) || '其他';

const numbers = list => list.filter(value => typeof value === 'number').sort((left, right) => left - right);
function quantile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}
function stats(list) {
  const sorted = numbers(list);
  if (!sorted.length) return null;
  return { count: sorted.length, min: sorted[0], max: sorted.at(-1), p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), mean: Math.round((sorted.reduce((sum, item) => sum + item, 0) / sorted.length) * 10) / 10 };
}
function median(list) { return quantile(numbers(list), 0.5); }
function grade(value, rule) {
  if (typeof value !== 'number' || !rule) return null;
  if (rule.reverse) return value >= rule.good ? 'good' : value >= rule.fair ? 'fair' : 'bad';
  return value <= rule.good ? 'good' : value <= rule.fair ? 'fair' : 'bad';
}
// 丢包 / 重传：0 与非 0 是质变而非量变，用固定色阶，不随区域变化
function lossLevel(value) {
  if (typeof value !== 'number') return 0;
  if (value <= 0) return 0;
  if (value <= 2) return 2;
  if (value <= 10) return 3;
  return 4;
}
// 相对离群：机房位置、量纲都无关，只看这份数据内部的分布。
function madOutliers(items) {
  const values = numbers(items.map(item => item.value));
  const center = quantile(values, 0.5);
  if (center === null) return [];
  const mad = quantile(values.map(value => Math.abs(value - center)).sort((left, right) => left - right), 0.5);
  if (!mad) return [];
  return items
    .filter(item => typeof item.value === 'number')
    .map(item => ({ ...item, deviation: Math.round(item.value - center), score: (item.value - center) / (mad * 1.4826) }))
    .filter(item => item.score > outlier.madFactor)
    .sort((left, right) => right.score - left.score);
}
const of = (report, section) => report.records.filter(record => record.section === section);
// 双栈探针会把同一目标渲染成 IPv4 / IPv6 两张表（教育网回程、国际节点都是如此）。
// 汇总类卡片一律取 IPv4 一侧，保证与单栈报告可比；IPv6 数据仍完整留在明细与热力图里。
const isIPv6 = record => String(record.carrier || '').includes('IPv6');
const metricValue = (record, metric) => record.metrics[metric]?.value;
const unitOf = (record, metric) => record.metrics[metric]?.unit || '';
const sectionName = (report, id) => report.sections.find(section => section.id === id)?.name || id;

// 热力图：行=省份，列=运营商。配色按「该机房所在区域的延迟基准」判绝对档位，
// 而不是按报告内百分位 —— 后者会让任何一份报告都有 20% 的格子被打成最深红，
// 把"这份报告里相对最差"渲染成"这条线路有问题"。
function buildMatrix(report, { id, name, metrics }, band) {
  const records = of(report, id);
  if (!records.length) return null;
  const rows = [];
  const seen = new Set();
  for (const record of records) if (!seen.has(record.target)) { seen.add(record.target); rows.push(record.target); }
  const columns = [...new Set(records.map(record => record.carrier).filter(Boolean))];
  const index = new Map(records.map(record => [`${record.target}|${record.carrier}`, record]));
  const cellOf = (row, column) => index.get(`${row}|${column}`);
  // route 是文本且每行每列固定一份，单独存一次即可，否则三个矩阵会重复八九百份
  const routes = rows.map(row => columns.map(column => String(metricValue(cellOf(row, column), 'route') || '')));
  const metrics_ = [];
  for (const metric of metrics) {
    if (metric === 'route') { metrics_.push({ id: 'route', name: metricNames.route || '线路', text: true }); continue; }
    const levelOfCell = metric === 'latency' ? value => levelFromBand(value, band) : lossLevel;
    metrics_.push({
      id: metric,
      name: metricNames[metric] || metric,
      unit: records.map(record => unitOf(record, metric)).find(Boolean) || '',
      cells: rows.map(row => columns.map(column => {
        const value = metricValue(cellOf(row, column), metric);
        // 缺失 / 测量失败不能落进"最浅档"：那等于把没有数据渲染成最好。
        // 统一用 l=null 表示"无数据"，前端据此画成中性样式。
        return typeof value === 'number' ? { v: value, l: levelOfCell(value) } : { v: null, l: null };
      }))
    });
  }
  return { id, name, rows, columns, regions: rows.map(regionOf), routes, metrics: metrics_ };
}

function findAnomalies(report) {
  const items = [];
  // 1. 丢包 / 重传：绝对量小但性质严重，按条数报
  for (const [section, metric, label] of [['ipv4', 'loss', '丢包'], ['large4', 'retrans', '重传'], ['ipv6', 'loss', '丢包'], ['cernet', 'loss', '丢包']]) {
    const bad = of(report, section).map(record => ({ target: record.target, carrier: record.carrier, value: metricValue(record, metric) })).filter(item => item.value > 0);
    if (!bad.length) continue;
    const worst = Math.max(...bad.map(item => item.value));
    const top = bad.sort((left, right) => right.value - left.value).slice(0, 3).map(item => `${item.target}${item.carrier ? '·' + item.carrier : ''} ${item.value}%`);
    items.push({ level: worst >= outlier.lossDanger ? 'danger' : 'warn', text: `${sectionName(report, section)}有 ${bad.length} 条线路出现${label}，最高 ${worst}%：${top.join('、')}` });
  }
  // 2. 延迟离群：相对中位数偏离过大，与机房位置无关
  for (const section of ['ipv4', 'large4', 'ipv6', 'cernet']) {
    const found = madOutliers(of(report, section).map(record => ({ target: record.target, carrier: record.carrier, value: metricValue(record, 'latency') })));
    for (const item of found.slice(0, 3)) {
      items.push({ level: 'warn', text: `${sectionName(report, section)} ${item.target}${item.carrier ? '·' + item.carrier : ''} ${item.value}ms，比中位数高 ${item.deviation}ms` });
    }
  }
  // 3. 速度离群：不用绝对阈值，只看是否远低于同组其他节点
  for (const group of [...new Set(of(report, 'speedtest').map(record => record.group))]) {
    const records = of(report, 'speedtest').filter(record => record.group === group);
    for (const metric of ['returnSpeed', 'outboundSpeed', 'downloadSpeed', 'uploadSpeed']) {
      const rows = records.map(record => ({ target: record.target, value: metricValue(record, metric) })).filter(item => typeof item.value === 'number');
      if (rows.length < 3) continue;
      const center = median(rows.map(row => row.value));
      if (!center) continue;
      for (const row of rows.filter(item => item.value * outlier.speedDivisor < center && item.value < outlier.speedFloor).sort((left, right) => left.value - right.value).slice(0, 2)) {
        items.push({ level: 'danger', text: `${group} ${row.target} ${metricNames[metric]}仅 ${row.value}Mbps，同组其他节点中位数 ${center}Mbps` });
      }
    }
  }
  // 4. 整份报告走同一条骨干：解释了"为什么某个运营商慢"，而 route 字段原本只是表格里一列没人看的文字
  for (const section of ['ipv4', 'large4', 'cernet']) {
    const records = of(report, section);
    if (records.length < 10) continue;
    const routes = new Set(records.map(record => String(metricValue(record, 'route') || '')).filter(Boolean));
    if (routes.size === 1) items.push({ level: 'info', text: `${sectionName(report, section)} ${records.length} 条线路全部走 ${[...routes][0]}，未区分运营商骨干` });
  }
  // 5. 常用网站 / CDN 不可达
  const unreachable = of(report, 'intl').filter(record => ['常用网站', '常用 CDN'].includes(record.group) && String(record.metrics.reachable?.raw || '') !== '✓');
  if (unreachable.length) items.push({ level: 'danger', text: `${unreachable.length} 个服务不可达：${unreachable.slice(0, 5).map(record => record.target).join('、')}` });
  return items;
}

function buildCards(report, band) {
  const cards = [];
  const ipv4 = of(report, 'ipv4');
  // 延迟类卡片一律以「该机房所在区域的基准」判定，并把依据写进卡片，避免阈值变成黑箱
  const latencyBasis = `${band.label}基准：≤${band.good} 好，≤${band.fair} 一般`;
  const ipv4Latency = stats(ipv4.map(record => metricValue(record, 'latency')));
  if (ipv4Latency) {
    cards.push({ id: 'latency', label: '国内回程延迟 p50', value: ipv4Latency.p50, unit: 'ms', level: grade(ipv4Latency.p50, band), note: `p90 ${ipv4Latency.p90} · 最好 ${ipv4Latency.min}`, basis: latencyBasis });
    // 离散度：不受机房地理位置影响，比绝对延迟更能说明线路是否均衡
    const deviation = ipv4Latency.p90 - ipv4Latency.p50;
    cards.push({ id: 'spread', label: '延迟离散度 p90−p50', value: deviation, unit: 'ms', level: grade(deviation, spreadRule), note: '越大说明越不均匀', basis: `≤${spreadRule.good} 好，≤${spreadRule.fair} 一般` });
  }
  // 按运营商聚合：三网差异是"这台机器适合给谁用"的直接依据
  const carriers = [...new Set(ipv4.map(record => record.carrier).filter(Boolean))];
  if (carriers.length) {
    const perCarrier = carriers.map(carrier => ({ carrier, mean: stats(ipv4.filter(record => record.carrier === carrier).map(record => metricValue(record, 'latency')))?.mean })).filter(item => typeof item.mean === 'number').sort((left, right) => right.mean - left.mean);
    if (perCarrier.length > 1) {
      const worst = perCarrier[0];
      const best = perCarrier.at(-1);
      cards.push({ id: 'carrier', label: '最差运营商', value: worst.mean, unit: 'ms', level: grade(worst.mean, band), note: `${worst.carrier}，比${best.carrier}高 ${Math.round(worst.mean - best.mean)}ms`, basis: latencyBasis });
    }
  }
  // 丢包分轻重：4% 相当于 25 个包里丢 1 个，与 48% 不是一回事。
  // 只报总条数会把"普遍轻微"和"少数严重"渲染成同一个红格，误导判断。
  const losses = [...of(report, 'ipv4').map(record => metricValue(record, 'loss')), ...of(report, 'large4').map(record => metricValue(record, 'retrans'))].filter(value => typeof value === 'number');
  const total = losses.length;
  const withLoss = losses.filter(value => value > 0);
  const severe = withLoss.filter(value => value >= lossRule.severe);
  cards.push({
    id: 'loss',
    label: '丢包 / 重传线路',
    value: severe.length || withLoss.length,
    unit: '条',
    level: severe.length ? 'bad' : withLoss.length ? 'fair' : 'good',
    note: severe.length
      ? `其中 ${severe.length} 条 ≥${lossRule.severe}%（最高 ${Math.max(...withLoss)}%），另有 ${withLoss.length - severe.length} 条轻度`
      : withLoss.length ? `均为轻度（最高 ${Math.max(...withLoss)}%）` : `共 ${total} 条线路全部零丢包`,
    basis: `有 ≥${lossRule.severe}% 的重度丢包判差；仅轻度判一般；全零判好`
  });
  const cernet = stats(of(report, 'cernet').filter(record => !isIPv6(record)).map(record => metricValue(record, 'latency')));
  if (cernet) cards.push({ id: 'cernet', label: '教育网延迟 p50', value: cernet.p50, unit: 'ms', level: grade(cernet.p50, band), note: `${cernet.count} 个省份`, basis: latencyBasis });
  const intlLatency = stats(of(report, 'intl').filter(record => record.group === '国际节点' && !isIPv6(record)).map(record => metricValue(record, 'downloadLatency')));
  if (intlLatency) cards.push({ id: 'intl', label: '国际下载延迟 p50', value: intlLatency.p50, unit: 'ms', level: grade(intlLatency.p50, band), note: `${intlLatency.count} 个节点`, basis: latencyBasis });
  const speedRecords = of(report, 'speedtest').filter(record => record.group === 'IPv4');
  const returnSpeed = median(speedRecords.map(record => metricValue(record, 'returnSpeed')));
  const outboundSpeed = median(speedRecords.map(record => metricValue(record, 'outboundSpeed')));
  if (returnSpeed !== null) cards.push({ id: 'speed', label: '回程 / 去程速度', value: returnSpeed, unit: 'Mbps', level: grade(returnSpeed, speedRule), note: `去程中位数 ${outboundSpeed}Mbps`, basis: `≥${speedRule.good} 好，≥${speedRule.fair} 一般` });
  return cards;
}

function buildServices(report) {
  const rows = of(report, 'intl').filter(record => ['常用网站', '常用 CDN'].includes(record.group));
  if (!rows.length) return null;
  // 延迟可能是"缺失/失败"（原值为文本），这类服务不参与快慢排名，只统计可达性
  const ranked = rows.map(record => ({
    name: record.target,
    group: record.group,
    reachable: String(record.metrics.reachable?.raw || ''),
    latency: typeof metricValue(record, 'latency') === 'number' ? metricValue(record, 'latency') : null,
    retrans: metricValue(record, 'retrans')
  })).sort((left, right) => (right.latency ?? -Infinity) - (left.latency ?? -Infinity));
  const measured = ranked.filter(row => row.latency !== null);
  return { total: rows.length, unreachable: ranked.filter(row => row.reachable !== '✓').length, slowest: measured.slice(0, 5), fastest: measured.slice(-3).reverse() };
}

function buildRegions(report, band) {
  const records = of(report, 'ipv4');
  if (!records.length) return [];
  const buckets = new Map();
  for (const record of records) {
    const region = regionOf(record.target);
    if (!buckets.has(region)) buckets.set(region, []);
    const value = metricValue(record, 'latency');
    if (typeof value === 'number') buckets.get(region).push(value);
  }
  // 大区之间本来就存在境内距离差，但仍以同一区域基准上色，保证与卡片口径一致
  return [...buckets.entries()].map(([name, values]) => ({ name, ...stats(values), level: levelFromBand(quantile(numbers(values), 0.5), band) })).sort((left, right) => right.p50 - left.p50);
}

export function summarize(report, node = {}) {
  const band = latencyBand(node.region);
  const matrices = [
    buildMatrix(report, { id: 'ipv4', name: 'IPv4 回程', metrics: ['latency', 'loss', 'route'] }, band),
    buildMatrix(report, { id: 'large4', name: 'IPv4 大包回程', metrics: ['latency', 'retrans', 'route'] }, band),
    // IPv6 回程只有双栈探针的报告才有，没有时 buildMatrix 返回 null 自然不显示
    buildMatrix(report, { id: 'ipv6', name: 'IPv6 回程', metrics: ['latency', 'loss', 'route'] }, band),
    buildMatrix(report, { id: 'cernet', name: '教育网回程', metrics: ['latency', 'loss', 'route'] }, band)
  ].filter(Boolean);
  return {
    // 机房区域决定延迟基准，前端用它显示判定依据，也让阈值不再是黑箱
    region: { code: String(node.region || '').toUpperCase() || null, label: band.label, good: band.good, fair: band.fair },
    cards: buildCards(report, band),
    anomalies: findAnomalies(report),
    matrices,
    services: buildServices(report),
    regions: buildRegions(report, band),
    // 把整张基准表带给前端：用户要看的就是"哪个区域对应什么延迟区间、什么颜色"
    latencyBands: latencyByRegion,
    gradeLabels
  };
}
