import { latencyBand, latencyByRegion, calibratedRegions, grade, loss as lossRule } from './thresholds.mjs';

// 纯计算层：把结构化记录汇总成统计量。不碰 HTTP、不读文件，
// 由 /api/stats 调用；口径与 lib/insight.mjs 的单份报告卡片保持一致
// （都用 lib/thresholds.mjs 的区域基准），避免出现"两套算法算出两个结论"。

const numbers = list => list.filter(value => typeof value === 'number').sort((left, right) => left - right);
// 分位用 nearest-rank：下标 = floor(n × p)，不做线性插值。
// 与 lib/insight.mjs 的卡片完全同一套算法 —— 两处必须一致，
// 否则会出现"区域汇总说一般、单机卡片说好"。注意偶数个样本时取的是偏上的那个。
function quantile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}
export function statsOf(values) {
  const sorted = numbers(values);
  if (!sorted.length) return null;
  const p10 = quantile(sorted, 0.1);
  const p50 = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);
  return {
    n: sorted.length,
    min: sorted[0],
    p10,
    p25: quantile(sorted, 0.25),
    p50,
    p75: quantile(sorted, 0.75),
    p90,
    max: sorted.at(-1),
    // 离散度与机房位置无关：只反映线路是否均匀，跨区域比较才有意义
    spread: p90 !== null && p50 !== null ? p90 - p50 : null
  };
}
const median = values => quantile(numbers(values), 0.5);

const numeric = (record, metric) => record.metrics?.[metric]?.value;
// 教育网 / 国际节点在双栈探针上会分成 IPv4 / IPv6 两套记录，汇总一律只取 IPv4 一侧
const isIPv6 = record => String(record.carrier || '').includes('IPv6');
const CARRIERS = ['电信', '联通', '移动'];
// 丢包与重传口径不同：section 决定用哪个指标，不混着算
const lossMetricOf = section => (section === 'large4' ? 'retrans' : 'loss');

function speedOf(records) {
  // 测速是独立维度，无论汇总哪个 section 都取同一份数据
  const rows = records.filter(record => record.section === 'speedtest' && record.group === 'IPv4');
  const pick = metric => median(rows.map(record => numeric(record, metric)));
  const back = pick('returnSpeed');
  if (back === null) return null;
  return { returnP50: back, outboundP50: pick('outboundSpeed') };
}

// 一台机器：它名下所有报告的记录倒在一起算。这是整个汇总的基本单位，
// 报告数不同的两台机器之间不会被"谁报告多谁话语权大"带偏。
function machineStat(node, reports, section) {
  const records = reports.flatMap(report => report.records).filter(record => record.section === section && !isIPv6(record));
  const lossKey = lossMetricOf(section);
  const lossValues = records.map(record => numeric(record, lossKey)).filter(value => typeof value === 'number');
  const withLoss = lossValues.filter(value => value > 0);
  const byCarrier = {};
  for (const carrier of CARRIERS) {
    const subset = records.filter(record => record.carrier === carrier);
    const carrierLoss = subset.map(record => numeric(record, lossKey)).filter(value => typeof value === 'number');
    const carrierWithLoss = carrierLoss.filter(value => value > 0);
    const latency = statsOf(subset.map(record => numeric(record, 'latency')));
    // 丢包也要按运营商拆：group=carrier 时整机的丢包数会答非所问。
    // 这里保留全部分位（延迟 statsOf 的结果摊开）：group=node&carrier= 时顶层 latency
    // 要整体换成该运营商的口径，光有 p50 撑不住其他分位字段。
    byCarrier[carrier] = latency && {
      ...latency,
      lossLines: carrierWithLoss.length,
      severe: carrierWithLoss.filter(value => value >= lossRule.severe).length,
      worst: carrierWithLoss.length ? Math.max(...carrierWithLoss) : 0
    };
  }
  const latency = statsOf(records.map(record => numeric(record, 'latency')));
  const band = latencyBand(node.region);
  return {
    key: node.id,
    label: node.name,
    region: node.region || null,
    regionLabel: band.label,
    nodes: 1,
    reports: reports.length,
    samples: latency?.n || 0,
    testedAt: { first: reports[0]?.testedAt || null, last: reports.at(-1)?.testedAt || null },
    latency,
    // 每份报告 p50 的中位数：与 latency.p50（记录池化）可能不同，报告多时差别更明显
    reportMedian: median(reports.map(report => statsOf(
      report.records.filter(record => record.section === section && !isIPv6(record)).map(record => numeric(record, 'latency'))
    )?.p50)),
    level: latency ? grade(latency.p50, band) : null,
    byCarrier,
    loss: {
      lines: withLoss.length,
      ratio: lossValues.length ? Number((withLoss.length / lossValues.length).toFixed(4)) : null,
      severe: withLoss.filter(value => value >= lossRule.severe).length,
      worst: withLoss.length ? Math.max(...withLoss) : 0
    },
    speed: speedOf(reports.flatMap(report => report.records))
  };
}

// 跨机器汇总：每台机器等权（取各机器 p50 的分布），不是把所有记录重新倒进一个池子，
// 否则报告多的机器会把区域整体数字带偏。
// pick 决定这一组「用机器的哪一项数值」：group=region 用整机 p50，group=carrier 用该运营商的 p50。
// 早期版本这里写死 machine.latency.p50，导致三个运营商返回完全相同的数字。
function rollUp(key, label, machines, pick) {
  if (!machines.length) return null;
  const band = latencyBand(key);
  const picked = machines.map(machine => pick(machine)).filter(Boolean);
  if (!picked.length) return null;
  const latency = statsOf(picked.map(item => item.p50));
  const carrierKeys = new Set(machines.flatMap(machine => Object.keys(machine.byCarrier || {})));
  const byCarrier = {};
  for (const carrier of carrierKeys) {
    const subset = statsOf(machines.map(machine => machine.byCarrier?.[carrier]?.p50).filter(value => typeof value === 'number'));
    if (subset) byCarrier[carrier] = { p50: subset.p50, n: machines.reduce((sum, machine) => sum + (machine.byCarrier?.[carrier]?.n || 0), 0) };
  }
  const lossLines = picked.reduce((sum, item) => sum + item.lossLines, 0);
  const lossSamples = picked.reduce((sum, item) => sum + item.n, 0);
  const speeds = machines.map(machine => machine.speed?.returnP50).filter(value => typeof value === 'number');
  const outSpeeds = machines.map(machine => machine.speed?.outboundP50).filter(value => typeof value === 'number');
  return {
    key,
    label,
    nodes: machines.length,
    reports: machines.reduce((sum, machine) => sum + machine.reports, 0),
    samples: lossSamples,
    latency,
    level: latency ? grade(latency.p50, band) : null,
    byCarrier,
    loss: {
      lines: lossLines,
      ratio: lossSamples ? Number((lossLines / lossSamples).toFixed(4)) : null,
      severe: picked.reduce((sum, item) => sum + item.severe, 0),
      worst: Math.max(0, ...picked.map(item => item.worst))
    },
    speed: speeds.length ? { returnP50: median(speeds), outboundP50: outSpeeds.length ? median(outSpeeds) : null } : null,
    // 最差的三台：区域/运营商级汇总本身看不出问题机器，给个下钻入口
    worstMachines: machines
      .map(machine => ({ machine, value: pick(machine) }))
      .filter(entry => typeof entry.value?.p50 === 'number')
      .sort((left, right) => right.value.p50 - left.value.p50)
      .slice(0, 3)
      // level 必须与展示的 p50 同口径：group=carrier 时 entry.value 是该运营商的 p50，
      // 贴整机判级会出现「联通 300ms 旁边标好」。按本组自己的 band 重判。
      .map(entry => ({ key: entry.machine.key, label: entry.machine.label, p50: entry.value.p50, level: grade(entry.value.p50, band) }))
  };
}

function reportStat(report, node, section) {
  const stat = machineStat({ id: node?.id, name: node?.name, region: node?.region }, [report], section);
  return {
    key: report.id,
    label: node?.name || report.nodeId,
    nodeId: report.nodeId,
    region: node?.region || null,
    regionLabel: stat.regionLabel,
    nodes: 1,
    reports: 1,
    testedAt: stat.testedAt.last,
    samples: stat.samples,
    latency: stat.latency,
    level: stat.level,
    loss: stat.loss,
    speed: stat.speed
    // 时间序列不展开 byCarrier：17 份 × 3 家 = 51 行，太吵；需要时再用 group=node 看
  };
}

export const GROUPS = ['node', 'region', 'carrier', 'report'];
export const SECTIONS = ['ipv4', 'large4', 'ipv6', 'cernet'];

export function aggregate({ nodes, reports, group, section, since, until, node: nodeId, region, carrier }) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const inScope = reports
    .filter(report => (region ? nodeById.get(report.nodeId)?.region === region : true))
    .filter(report => (nodeId ? report.nodeId === nodeId : true))
    .filter(report => (since ? report.testedAt >= since : true))
    .filter(report => (until ? report.testedAt <= until : true))
    .sort((left, right) => left.testedAt.localeCompare(right.testedAt));

  const byNode = new Map();
  for (const report of inScope) {
    if (!byNode.has(report.nodeId)) byNode.set(report.nodeId, []);
    byNode.get(report.nodeId).push(report);
  }
  const machines = [...byNode.entries()]
    .map(([id, list]) => machineStat(nodeById.get(id) || { id, name: id, region: null }, list, section))
    .filter(machine => machine.latency);

  if (group === 'node') {
    const filtered = carrier ? machines.filter(machine => machine.byCarrier[carrier]) : machines;
    if (!carrier) return filtered;
    // 带了运营商过滤，顶层数字就必须全是该运营商的口径，与 group=carrier 一致。
    // 原实现只换了 n / samples、留下整机池化的 p50 与 level：n=1 配一个两池 p50，自相矛盾。
    return filtered.map(machine => {
      const subset = machine.byCarrier[carrier];
      const { lossLines, severe, worst, ...subLatency } = subset;
      return {
        ...machine,
        samples: subset.n,
        latency: subLatency,
        level: grade(subset.p50, latencyBand(machine.region)),
        loss: { lines: lossLines, ratio: subset.n ? Number((lossLines / subset.n).toFixed(4)) : null, severe, worst }
      };
    });
  }
  if (group === 'report') {
    return inScope
      // 用 some 而不是 find 后再比对第一条：第一条记录可能是别的运营商，
      // 那样"有联通记录但首条是电信"的报告会被错误漏掉
      .filter(report => carrier
        ? report.records.some(item => item.section === section && !isIPv6(item) && item.carrier === carrier)
        : report.records.some(item => item.section === section && !isIPv6(item)))
      .map(report => reportStat(report, nodeById.get(report.nodeId), section));
  }

  const groups = new Map();
  for (const machine of machines) {
    const keys = group === 'region'
      ? [[machine.region || '未知', machine.regionLabel || '未知区域']]
      : Object.keys(machine.byCarrier).map(name => [name, name]);
    for (const [key, label] of keys) {
      if (carrier && group === 'carrier' && key !== carrier) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(machine);
    }
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const rolled = rollUp(
        key,
        key === '未知' ? '未知区域' : key,
        list,
        // group=region 看整机 p50，group=carrier 看该运营商的 p50 —— 两者不能混，
        // 否则三个运营商会返回一模一样的数字。
        // 注意 rollUp 期望的字段名是 lossLines/severe/worst（与 byCarrier 项对齐），
        // 而 machine.loss 叫 lines —— 曾经直接摊开 ...machine.loss，sum+undefined=NaN，
        // JSON 里变成 "loss": null，线上 group=region 的丢包栏全空。
        group === 'region'
          ? machine => (machine.latency ? { p50: machine.latency.p50, n: machine.latency.n, lossLines: machine.loss.lines, severe: machine.loss.severe, worst: machine.loss.worst } : null)
          : machine => machine.byCarrier[key] || null
      );
      // 区域组要能直接显示中文名：regionBands 里有 label，但消费方得自己回查一次才拿得到，
      // 而 group=node 早就给了 regionLabel。同一份数据两种取法，这里补齐。
      if (rolled && group === 'region') rolled.label = list[0]?.regionLabel || rolled.label;
      return rolled;
    })
    .filter(Boolean)
    .sort((left, right) => (left.latency?.p50 ?? Infinity) - (right.latency?.p50 ?? Infinity));
}

// 基准表给全量而非只给已校准：消费方查 DE（未校准）的档位时也拿得到数字，
// 校准状态用 calibrated 标记区分，与 insight 摘要的 latencyBands 同口径
export function bandsOf() {
  return Object.fromEntries(Object.keys(latencyByRegion).map(code => [code, { ...latencyBand(code), calibrated: calibratedRegions.has(code) }]));
}
export { latencyByRegion };
