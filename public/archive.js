export function previousReport(reports, current) {
  const timestamp = Date.parse(current.testedAt);
  return reports.filter(report => report.nodeId === current.nodeId && report.id !== current.id && Date.parse(report.testedAt) < timestamp).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt))[0] || null;
}

export function staleNodes(nodes, reports, days = 7, now = Date.now()) {
  return nodes.filter(node => node.enabled !== false && !node.archived).map(node => {
    const latest = reports.filter(report => report.nodeId === node.id).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt))[0];
    const age = latest ? Math.floor((now - Date.parse(latest.testedAt)) / 86400000) : null;
    return { node, latest, age };
  }).filter(item => !item.latest || !Number.isFinite(item.age) || item.age >= days).sort((left, right) => (right.age ?? Infinity) - (left.age ?? Infinity));
}
