const measurement = (value, unit) => ({ value, unit, status: 'ok' });

export function completeReport(rate = 0) {
  const records = [];
  const add = (section, group, target, carrier, metrics) => records.push({ key: JSON.stringify([section, group, target, carrier]), section, group, target, carrier, metrics });
  for (const carrier of ['电信', '联通', '移动']) {
    for (let index = 0; index < 3; index++) {
      for (const section of ['ipv4', 'large4']) add(section, '国内三网', `地点${index}`, carrier, { latency: measurement(10, 'ms'), [section === 'ipv4' ? 'loss' : 'retrans']: measurement(rate, '%') });
      add('speedtest', 'IPv4', `地点${index}${carrier}`, '', { returnRetrans: measurement(rate, '%'), returnSpeed: measurement(300, 'Mbps'), outboundSpeed: measurement(300, 'Mbps'), returnLatency: measurement(10, 'ms'), outboundLatency: measurement(10, 'ms') });
    }
  }
  add('cernet', 'CERNET-IPv4', '地点', '教育网', { loss: measurement(rate, '%'), latency: measurement(10, 'ms') });
  add('intl', '国际节点', '方向', 'IPv4', { downloadLatency: measurement(100, 'ms'), uploadLatency: measurement(100, 'ms'), downloadRetrans: measurement(0, '次'), uploadRetrans: measurement(0, '次') });
  for (const group of ['常用网站', '常用 CDN']) add('intl', group, '服务', '', { retrans: measurement(rate, '%'), latency: measurement(10, 'ms'), reachable: { value: '✓', unit: '', status: 'text' } });
  add('speedtest', '国际方向', '国际目标', '', { downloadRetransRate: measurement(rate, '%'), downloadSpeed: measurement(300, 'Mbps'), uploadSpeed: measurement(300, 'Mbps'), downloadLatency: measurement(100, 'ms'), uploadLatency: measurement(100, 'ms') });
  return { id: 'report', nodeId: 'node', testedAt: '2026-10-06T00:00:00Z', sections: ['ipv4', 'large4', 'cernet', 'intl', 'speedtest'], records };
}

export function dualStackReport(rate = 0) {
  const report = completeReport(rate);
  report.sections.push('ipv6');
  for (const original of [...report.records]) {
    if (!['ipv4', 'cernet'].includes(original.section) && original.group !== '国际节点' && !(original.section === 'speedtest' && original.group === 'IPv4' && original.target.endsWith('移动'))) continue;
    const record = structuredClone(original);
    if (record.section === 'ipv4') record.section = 'ipv6';
    if (record.section === 'cernet') record.group = 'CERNET2-IPv6';
    if (record.section === 'intl') record.carrier = 'IPv6';
    if (record.section === 'speedtest') record.group = 'IPv6';
    record.key = JSON.stringify([record.section, record.group, record.target, record.carrier]);
    report.records.push(record);
  }
  return report;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
