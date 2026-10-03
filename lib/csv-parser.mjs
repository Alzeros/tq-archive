import { createHash } from 'node:crypto';
import { sectionNames, provinces } from './parser.mjs';

// TcpQuality core 生成的 CSV（原本上传给官方 /generate 渲染 SVG 的那份）→ 与 parseReport 相同的记录模型。
// section / group / target / carrier / 单位都必须与链接导入的报告一致：record.key 对不上，
// 两种来源的报告就无法在同一条趋势线上对比，变化对比会把每一项都算成"新增/移除"。
// 版本号升级后，服务启动时会用留存的原始 CSV 重新解析已有的直传报告。
export const CSV_PARSER_VERSION = 2;

const carriers = new Set(['电信', '联通', '移动']);
const sectionOrder = ['ipv4', 'large4', 'ipv6', 'cernet', 'intl', 'speedtest'];
// 国际互联网站行的"运营商"列是分类，网页里对应两张表
const siteGroups = { '网站': '常用网站', 'CDN': '常用 CDN' };

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

// BOM、换行风格不同的同一份 CSV 必须算出同一个指纹，否则重传会重复排队
export const normalizeCsv = text => String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
export const csvFingerprint = text => createHash('sha256').update(normalizeCsv(text)).digest('hex');

const text = value => ({ value, unit: '', status: 'text', raw: value });
const missing = unit => ({ value: null, unit, status: 'unknown', raw: '' });
// 数值字段，允许带同名单位后缀（测速重传写成 0.00%）。负数是测量失败的哨兵值，与网页解析同口径
function measure(raw, unit, { digits, scale = 1 } = {}) {
  const value = String(raw ?? '').trim();
  const match = value.match(/^(-?\d+(?:\.\d+)?)(%|ms|Mbps)?$/);
  if (!match || (match[2] && match[2] !== unit)) return { value: value || null, unit, status: 'unknown', raw: value };
  const number = Number(match[1]) * scale;
  if (number < 0) return { value, unit, status: 'unknown', raw: value };
  return { value: digits === undefined ? number : Number(number.toFixed(digits)), unit, status: 'ok', raw: value };
}
// 探测失败时 core 可能写 0 延迟 + 100% 丢包；0ms 会被当成全场最优，必须按失败处理
function latency(raw, ok, digits) {
  const result = measure(raw, 'ms', { digits });
  return !ok && !(result.value > 0) ? { value: result.raw || null, unit: 'ms', status: 'unknown', raw: result.raw } : result;
}

export function parseTqCsv(csvText, { sourceUrl, testedAt, identity = '' }) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('CSV 内容为空');
  if (!testedAt || !Number.isFinite(Date.parse(testedAt))) throw new Error('缺少有效的测试时间，已停止解析，避免错误归档');
  const normalized = normalizeCsv(csvText);
  const [headerLine, ...lines] = normalized.split('\n');
  const header = headerLine.split(',').map(cell => cell.trim());
  const column = new Map(header.map((name, index) => [name, index]));
  for (const name of ['网络', 'IP版本', '省份', '运营商', '状态', '丢包率(%)', '平均延迟ms', '线路']) {
    if (!column.has(name)) throw new Error(`CSV 缺少「${name}」列，可能不是 TcpQuality 输出`);
  }

  const records = [];
  const warnings = [];
  const rawRows = {};
  const byKey = new Map();
  const filledDirections = new Set();
  const unknownRows = new Map();
  function add(section, group, target, carrier, metrics) {
    const key = JSON.stringify([section, group, target, carrier]);
    if (byKey.has(key)) { warnings.push(`${sectionNames[section]} / ${target}${carrier ? ` / ${carrier}` : ''} 出现重复记录，已跳过`); return; }
    const record = { key, section, group, target, carrier, metrics };
    byKey.set(key, record);
    records.push(record);
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    // core 用 echo/printf 直接拼接字段，不加引号也不含逗号，逐列 split 即可
    const cells = line.split(',').map(cell => cell.trim());
    const get = name => cells[column.get(name)] ?? '';
    const network = get('网络');
    const ok = get('状态') === 'OK';

    const route = routeTarget(network, get('IP版本'));
    if (route) {
      (rawRows[route.section] ||= []).push(cells);
      const province = get('省份');
      const carrier = route.carrier || get('运营商');
      if (!provinces.has(province)) { warnings.push(`${sectionNames[route.section]} / ${province || '空省份'}：不在省份列表中，已跳过`); continue; }
      if (!route.carrier && !carriers.has(carrier)) { warnings.push(`${sectionNames[route.section]} / ${province}：运营商「${carrier}」无法识别，已跳过`); continue; }
      const routeLabel = get('线路');
      add(route.section, route.group, province, carrier, {
        route: text(routeLabel),
        // 网页报告延迟显示为整数毫秒；CSV 带三位小数，保留一位足够看趋势，也不至于让表格太碎
        latency: latency(get('平均延迟ms'), ok, 1),
        [route.third]: measure(get('丢包率(%)'), '%')
      });
      continue;
    }

    if (network === '国际互联') {
      (rawRows.intl ||= []).push(cells);
      const target = get('省份');
      const group = siteGroups[get('运营商')];
      if (group) {
        // 网站 / CDN：TCP443 探测。网页的"重传"列就是这里的丢包率，延迟按 CSV 原精度显示（如 2.180ms）
        add('intl', group, target, '', {
          domain: text(get('域名')),
          reachable: text(ok ? '✓' : '✗'),
          latency: latency(get('平均延迟ms'), ok),
          retrans: measure(get('丢包率(%)'), '%')
        });
        continue;
      }
      // 国际节点 iPerf3：上传、下载各一行，合并成网页里的一行四列；协议族写进 carrier，IPv6 表才不会被当成重复丢掉
      const family = get('IP版本');
      const direction = get('iPerf3方向');
      if (get('运营商') === '延迟' && target && ['IPv4', 'IPv6'].includes(family) && ['upload', 'download'].includes(direction)) {
        const key = JSON.stringify(['intl', '国际节点', target, family]);
        if (!byKey.has(key)) add('intl', '国际节点', target, family, { downloadLatency: missing('ms'), downloadRetrans: missing('次'), uploadLatency: missing('ms'), uploadRetrans: missing('次') });
        if (filledDirections.has(`${key}|${direction}`)) { warnings.push(`国际互联 / ${target} / ${family} ${direction === 'upload' ? '上传' : '下载'}方向出现重复记录，已跳过`); continue; }
        filledDirections.add(`${key}|${direction}`);
        const record = byKey.get(key);
        record.metrics[`${direction}Latency`] = latency(get('平均延迟ms'), ok, 1);
        record.metrics[`${direction}Retrans`] = measure(get('iPerf3重传次数'), '次');
        continue;
      }
      unknownRows.set(`国际互联 / ${get('运营商') || '空分类'}`, (unknownRows.get(`国际互联 / ${get('运营商') || '空分类'}`) || 0) + 1);
      continue;
    }

    if (network === '三网单线程速度') {
      (rawRows.speedtest ||= []).push(cells);
      const label = get('IP版本');
      const speed = name => measure(get(name), 'Mbps', { digits: 1 });
      // 官方报告的延迟 = TLS 握手耗时的一半（core 注释：兼容层把连接 / TLS 字段都除以 2，连接字段已预先乘 2）。
      // TLS 缺失时退回连接字段，同样除以 2
      const half = (tls, connect) => {
        const fromTls = measure(get(tls), 'ms', { digits: 1, scale: 0.5 });
        return fromTls.status === 'ok' ? fromTls : measure(get(connect), 'ms', { digits: 1, scale: 0.5 });
      };
      if (label === 'AppleCDN') {
        // Apple 行字段顺序（core speedtest_collect_applecdn）：发送=上传速度，收到=下载重传，丢包率列=下载速度
        add('speedtest', '国际方向', get('省份'), '', {
          downloadRetransRate: measure(get('收到'), '%'),
          downloadSpeed: speed('丢包率(%)'),
          uploadSpeed: speed('发送'),
          downloadLatency: half('去程TLS握手耗时ms', '去程连接耗时ms'),
          uploadLatency: half('回程TLS握手耗时ms', '回程连接耗时ms')
        });
      } else {
        // 三网行：上传 = 回程、下载 = 去程（CSV 表头本身把上传连接标为"回程连接耗时"）。
        // 对象名与网页一致：IPv4 为"区域 + 运营商"（北京电信），IPv6 行的省份列已是完整名称
        const ipv6 = label === 'IPv6';
        add('speedtest', ipv6 ? 'IPv6' : 'IPv4', ipv6 ? get('省份') : `${label}${get('省份')}`, '', {
          returnRetrans: measure(get('收到'), '%'),
          returnSpeed: speed('发送'),
          outboundSpeed: speed('丢包率(%)'),
          returnLatency: half('回程TLS握手耗时ms', '回程连接耗时ms'),
          outboundLatency: half('去程TLS握手耗时ms', '去程连接耗时ms')
        });
      }
      continue;
    }
    // TCP 配置（拥塞控制、缓存）网页也只作说明文字，不作为指标；原始行保留
    if (network === '三网单线程配置') { (rawRows.speedtest ||= []).push(cells); continue; }
    unknownRows.set(network || '空', (unknownRows.get(network || '空') || 0) + 1);
  }

  const present = new Set(Object.keys(rawRows));
  const sections = sectionOrder.filter(id => present.has(id)).map(id => ({ id, name: sectionNames[id] }));
  for (const section of sections) if (!records.some(record => record.section === section.id)) warnings.push(`${section.name} 未解析出结构化记录，请检查原始 CSV`);
  for (const [type, count] of unknownRows) warnings.push(`未识别的行类型「${type}」${count} 行，已跳过`);
  for (const section of ['ipv4', 'large4', 'cernet', 'intl', 'speedtest']) if (!present.has(section)) warnings.push(`报告没有 ${sectionNames[section]} 维度`);
  const unknown = records.flatMap(record => Object.values(record.metrics)).filter(metric => metric.status === 'unknown').length;
  if (unknown) warnings.push(`${unknown} 个指标为缺失、失败或未知格式，已保留原值，不按零处理`);
  if (!records.length) throw new Error('CSV 里没有可解析的数据（三网 / 大包 / 教育网 / 国际互联 / 单线程测速）');

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
