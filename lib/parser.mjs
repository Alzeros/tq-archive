import { createHash } from 'node:crypto';

const sectionNames = { ipv4: 'IPv4 回程', large4: 'IPv4 大包回程', ipv6: 'IPv6 回程', cernet: '教育网回程', intl: '国际互联', speedtest: '单线程测速' };
const provinces = new Set('河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 海南 四川 贵州 云南 陕西 甘肃 青海 内蒙古 广西 西藏 宁夏 新疆 北京 天津 上海 重庆'.split(' '));
export const metricNames = {
  route: '线路', latency: '延迟', loss: '丢包', retrans: '重传', downloadLatency: '下载延迟', downloadRetrans: '下载重传次数', uploadLatency: '上传延迟', uploadRetrans: '上传重传次数',
  domain: '域名', reachable: '可达', returnRetrans: '回程重传', returnSpeed: '回程速度', outboundSpeed: '去程速度', returnLatency: '回程延迟', outboundLatency: '去程延迟', downloadSpeed: '下载速度', uploadSpeed: '上传速度', downloadRetransRate: '下载重传'
};
function decode(text) {
  return text.replace(/<[^>]*>/g, '').replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity]).trim();
}
function value(raw, expectedUnit = '') {
  const match = raw.match(/^(-?\d+(?:\.\d+)?)\s*(ms|Mbps|Gbps|Kbps|%)?$/i);
  if (!match) return { value: raw || null, unit: expectedUnit, status: 'unknown', raw };
  let number = Number(match[1]);
  let unit = match[2] || expectedUnit;
  if (unit === 'Gbps') { number *= 1000; unit = 'Mbps'; }
  if (unit === 'Kbps') { number /= 1000; unit = 'Mbps'; }
  return { value: number, unit, status: 'ok', raw };
}
function rowsFromSvg(svg) {
  const rows = new Map();
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const coordinate = match[1].match(/\by="([^"]+)"/)?.[1];
    if (coordinate === undefined) continue;
    if (!rows.has(coordinate)) rows.set(coordinate, []);
    rows.get(coordinate).push(decode(match[2]));
  }
  return [...rows.values()];
}
const carriers = ['电信', '联通', '移动'];
function carrierGroups(row) {
  // 三网行固定为「省份 + 3×(线路, 指标, 丢包) + 2 个 / 分隔符」= 12 格；
  // 少数渲染省略分隔符时为 10 格。分隔符位置必须落在预期下标，否则整行不可信。
  if (row.length === 12 && row[4] === '/' && row[8] === '/') return [row.slice(1, 4), row.slice(5, 8), row.slice(9, 12)];
  if (row.length === 10 && !row.slice(1).includes('/')) return [row.slice(1, 4), row.slice(4, 7), row.slice(7, 10)];
  return null;
}
export function parseReport(html, sourceUrl) {
  const warnings = [];
  const records = [];
  const sections = [];
  const rawRows = {};
  function add(section, group, target, carrier, fields, values, units = []) {
    if (fields.length !== values.length) { warnings.push(`${sectionNames[section]} / ${target}：列数不匹配，未猜测数据`); return; }
    const metrics = Object.fromEntries(fields.map((field, index) => [field, ['route', 'domain', 'reachable'].includes(field) ? { value: values[index], unit: '', status: 'text', raw: values[index] } : value(values[index], units[index] || '')]));
    const key = JSON.stringify([section, group, target, carrier]);
    if (records.some(record => record.key === key)) { warnings.push(`${target} / ${carrier} 出现重复记录，已跳过`); return; }
    records.push({ key, section, group, target, carrier, metrics });
  }
  for (const match of html.matchAll(/<section\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    const section = match[1];
    if (!match[2].includes('<svg')) continue;
    const rows = rowsFromSvg(match[2]);
    rawRows[section] = rows;
    sections.push({ id: section, name: sectionNames[section] || section });
    if (!sectionNames[section]) { warnings.push(`未知维度 ${section}，仅保留原始文字`); continue; }
    let group = '';
    for (const row of rows) {
      if (['ipv4', 'large4', 'ipv6'].includes(section) && provinces.has(row[0])) {
        const groups = carrierGroups(row);
        if (!groups) { warnings.push(`${sectionNames[section]} / ${row[0]} 列结构异常，未猜测数据`); continue; }
        for (const [index, cells] of groups.entries()) add(section, '国内三网', row[0], carriers[index], ['route', 'latency', section === 'large4' ? 'retrans' : 'loss'], cells, ['', 'ms', '%']);
      } else if (section === 'cernet') {
        if (row[0] === '教育网概览') group = row[1] || 'CERNET';
        if (provinces.has(row[0])) add(section, group || 'CERNET-IPv4', row[0], '教育网', ['route', 'latency', 'loss'], row.slice(1), ['', 'ms', '%']);
      } else if (section === 'intl') {
        if (row[0] === '区域') { group = '国际节点'; continue; }
        if (row[0] === '常用网站' || row[0] === '常用 CDN') { group = row[0]; continue; }
        if (group === '国际节点' && row.length === 6 && row[1] && row[1] !== '节点-IPv4') add(section, group, row[1], '', ['downloadLatency', 'downloadRetrans', 'uploadLatency', 'uploadRetrans'], row.slice(2), ['ms', '次', 'ms', '次']);
        if (['常用网站', '常用 CDN'].includes(group) && row.length === 5 && row[0] !== '服务') add(section, group, row[0], '', ['domain', 'reachable', 'latency', 'retrans'], row.slice(1), ['', '', 'ms', '%']);
      } else if (section === 'speedtest') {
        if (['IPv4', 'IPv6', '国际方向'].includes(row[0]) && row.length === 6) { group = row[0]; continue; }
        if (row.length !== 6 || !group || row[0].startsWith('拥塞控制') || row[0].startsWith('排队算法')) continue;
        const fields = group === '国际方向' ? ['downloadRetransRate', 'downloadSpeed', 'uploadSpeed', 'downloadLatency', 'uploadLatency'] : ['returnRetrans', 'returnSpeed', 'outboundSpeed', 'returnLatency', 'outboundLatency'];
        add(section, group, row[0], '', fields, row.slice(1), ['%', 'Mbps', 'Mbps', 'ms', 'ms']);
      }
    }
  }
  if (!records.length) throw new Error('未发现可识别的 TQ 数据；页面可能失效或格式发生变化。');
  const text = Object.values(rawRows).flat().flat().join('\n');
  const timestamp = text.match(/报告时间[：:]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*CST（北京时间）/);
  if (!timestamp) throw new Error('无法确认报告测试时间和时区，已停止导入，避免错误归档。');
  const testedAt = `${timestamp[1]}T${timestamp[2]}+08:00`;
  if (!Number.isFinite(Date.parse(testedAt))) throw new Error('报告测试时间无效');
  for (const section of ['ipv4', 'large4', 'cernet', 'intl', 'speedtest']) if (!rawRows[section]) warnings.push(`报告没有 ${sectionNames[section]} 维度`);
  const unknown = records.flatMap(record => Object.values(record.metrics)).filter(metric => metric.status === 'unknown').length;
  if (unknown) warnings.push(`${unknown} 个指标为缺失、失败或未知格式，已保留原值，不按零处理`);
  for (const section of sections) if (!records.some(record => record.section === section.id)) warnings.push(`${section.name} 未解析出结构化记录，请检查原始文字`);
  return { parserVersion: 1, sourceUrl, testedAt, importedAt: new Date().toISOString(), fingerprint: createHash('sha256').update(JSON.stringify(rawRows)).digest('hex'), identity: text.match(/AS\d+[^\n]+/)?.[0] || '', sections, records, rawRows, warnings };
}
export function compareReports(current, previous) {
  const oldRecords = new Map(previous.records.map(record => [record.key, record]));
  const result = [];
  for (const record of current.records) {
    const old = oldRecords.get(record.key);
    for (const [metric, measurement] of Object.entries(record.metrics)) {
      const before = old?.metrics[metric];
      if (typeof measurement.value !== 'number' || typeof before?.value !== 'number' || measurement.unit !== before.unit) continue;
      const delta = Number((measurement.value - before.value).toFixed(4));
      result.push({ key: record.key, section: record.section, group: record.group, target: record.target, carrier: record.carrier, metric, before: before.value, after: measurement.value, delta, unit: measurement.unit, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same' });
    }
  }
  return result;
}
