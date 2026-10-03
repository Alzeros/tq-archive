import { createHash } from 'node:crypto';
import { sectionNames, provinces } from './parser.mjs';

// TcpQuality core 生成的 CSV（原本上传给官方 /generate 渲染 SVG 的那份）→ 与 parseReport 相同的记录模型。
// section / group / carrier / 单位都必须与链接导入的报告一致：record.key 对不上，
// 两种来源的报告就无法在同一条趋势线上对比，变化对比会把每一项都算成"新增/移除"。
export const CSV_PARSER_VERSION = 1;

const carriers = new Set(['电信', '联通', '移动']);
const sectionOrder = ['ipv4', 'large4', 'ipv6', 'cernet', 'intl', 'speedtest'];

// 回程类行（三网 / 大包 / 教育网）列结构相同：省份,运营商,域名,IP,状态,发送,收到,丢包率,平均延迟,线路
function routeTarget(network, family) {
  if (network === '三网' && family === 'IPv4') return { section: 'ipv4', group: '国内三网', third: 'loss' };
  if (network === '三网' && family === 'IPv6') return { section: 'ipv6', group: '国内三网', third: 'loss' };
  // 网页把大包这一列标为"重传"，沿用 retrans，否则与链接导入的报告对不上
  if (network === 'IPv4大包') return { section: 'large4', group: '国内三网', third: 'retrans' };
  // 单栈网页报告的教育网记作 CERNET-IPv4 / 教育网；IPv6 的运营商名带 IPv6，洞察靠它区分双栈
  if (network === 'CERNET') return { section: 'cernet', group: 'CERNET-IPv4', third: 'loss', carrier: '教育网' };
  if (network === 'CERNET2') return { section: 'cernet', group: 'CERNET2-IPv6', third: 'loss', carrier: '教育网IPv6' };
  return null;
}
// 国际互联、单线程测速的 CSV 行与网页表格差异较大（上传/下载拆成两行、连接耗时口径换算），
// 还没有真实样本核对映射，先不入库，避免猜错的数字混进趋势；原始 CSV 随报告完整保留。
const deferred = { '国际互联': 'intl', '三网单线程速度': 'speedtest', '三网单线程配置': 'speedtest' };

// BOM、换行风格不同的同一份 CSV 必须算出同一个指纹，否则重传会重复排队
export const normalizeCsv = text => String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
export const csvFingerprint = text => createHash('sha256').update(normalizeCsv(text)).digest('hex');

function measure(raw, unit, digits) {
  const text = String(raw ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { value: text || null, unit, status: 'unknown', raw: text };
  const value = Number(text);
  // 负数是测量失败的哨兵值，与网页解析同口径：按数值处理会把失败画成"最优"
  if (value < 0) return { value: text, unit, status: 'unknown', raw: text };
  return { value: digits === undefined ? value : Number(value.toFixed(digits)), unit, status: 'ok', raw: text };
}

export function parseTqCsv(text, { sourceUrl, testedAt, identity = '' }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV 内容为空');
  if (!testedAt || !Number.isFinite(Date.parse(testedAt))) throw new Error('缺少有效的测试时间，已停止解析，避免错误归档');
  const normalized = normalizeCsv(text);
  const [headerLine, ...lines] = normalized.split('\n');
  const header = headerLine.split(',').map(cell => cell.trim());
  const column = new Map(header.map((name, index) => [name, index]));
  for (const name of ['网络', 'IP版本', '省份', '运营商', '状态', '丢包率(%)', '平均延迟ms', '线路']) {
    if (!column.has(name)) throw new Error(`CSV 缺少「${name}」列，可能不是 TcpQuality 输出`);
  }

  const records = [];
  const warnings = [];
  const rawRows = {};
  const seen = new Set();
  const deferredRows = new Map();
  const unknownNetworks = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    // core 用 echo/printf 直接拼接字段，不加引号也不含逗号，逐列 split 即可
    const cells = line.split(',').map(cell => cell.trim());
    const get = name => cells[column.get(name)] ?? '';
    const network = get('网络');
    const target = routeTarget(network, get('IP版本'));
    if (!target) {
      const section = deferred[network];
      if (section) {
        (rawRows[section] ||= []).push(cells);
        deferredRows.set(section, (deferredRows.get(section) || 0) + 1);
      } else {
        unknownNetworks.set(network, (unknownNetworks.get(network) || 0) + 1);
      }
      continue;
    }
    (rawRows[target.section] ||= []).push(cells);
    const province = get('省份');
    const carrier = target.carrier || get('运营商');
    if (!provinces.has(province)) { warnings.push(`${sectionNames[target.section]} / ${province || '空省份'}：不在省份列表中，已跳过`); continue; }
    if (!target.carrier && !carriers.has(carrier)) { warnings.push(`${sectionNames[target.section]} / ${province}：运营商「${carrier}」无法识别，已跳过`); continue; }
    const key = JSON.stringify([target.section, target.group, province, carrier]);
    if (seen.has(key)) { warnings.push(`${sectionNames[target.section]} / ${province} / ${carrier} 出现重复记录，已跳过`); continue; }
    seen.add(key);
    // 网页报告延迟显示为整数毫秒；CSV 带三位小数，保留一位足够看趋势，也不至于让表格太碎
    let latency = measure(get('平均延迟ms'), 'ms', 1);
    // 探测失败时 core 可能写 0 延迟 + 100% 丢包；0ms 会被当成全场最优，必须按失败处理
    if (get('状态') !== 'OK' && !(latency.value > 0)) latency = { value: latency.raw || null, unit: 'ms', status: 'unknown', raw: latency.raw };
    const route = get('线路');
    records.push({
      key,
      section: target.section,
      group: target.group,
      target: province,
      carrier,
      metrics: {
        route: { value: route, unit: '', status: 'text', raw: route },
        latency,
        [target.third]: measure(get('丢包率(%)'), '%')
      }
    });
  }

  const present = new Set([...records.map(record => record.section), ...deferredRows.keys()]);
  const sections = sectionOrder.filter(id => present.has(id)).map(id => ({ id, name: sectionNames[id] }));
  for (const [section, count] of deferredRows) warnings.push(`${sectionNames[section]} ${count} 行暂未解析：CSV 映射还需要真实样本核对，原始 CSV 已完整保留`);
  for (const [network, count] of unknownNetworks) warnings.push(`未识别的行类型「${network || '空'}」${count} 行，已跳过`);
  for (const section of ['ipv4', 'large4', 'cernet', 'intl', 'speedtest']) if (!present.has(section)) warnings.push(`报告没有 ${sectionNames[section]} 维度`);
  const unknown = records.flatMap(record => Object.values(record.metrics)).filter(metric => metric.status === 'unknown').length;
  if (unknown) warnings.push(`${unknown} 个指标为缺失、失败或未知格式，已保留原值，不按零处理`);
  if (!records.length) throw new Error('CSV 里没有可解析的回程数据（三网 / 大包 / 教育网）');

  return {
    parserVersion: 1,
    sourceType: 'csv',
    csvParserVersion: CSV_PARSER_VERSION,
    sourceUrl,
    testedAt,
    importedAt: new Date().toISOString(),
    fingerprint: csvFingerprint(normalized),
    identity,
    sections,
    records,
    rawRows,
    warnings
  };
}
