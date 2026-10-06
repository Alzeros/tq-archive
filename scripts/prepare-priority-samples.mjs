import { readFile, readdir, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export async function prepareSamples({ snapshotPath, historyDirectory, outputDirectory, privateDirectory }) {
  const snapshotBytes = await readFile(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes);
  if (!Array.isArray(snapshot.reports) || !snapshot.state?.nodes || !snapshot.capturedAt) throw new Error('输入不是已捕获的审核快照');
  const sourceDirectory = await realpath(resolve(snapshotPath, '..'));
  for (const directory of [outputDirectory, privateDirectory]) {
    if (resolve(directory) === sourceDirectory || (historyDirectory && resolve(directory) === await realpath(historyDirectory))) throw new Error('输出目录不能覆盖输入目录');
  }
  const history = [];
  if (historyDirectory) for (const file of (await readdir(historyDirectory)).filter(file => file.endsWith('.json')).sort()) history.push(await readJson(join(historyDirectory, file)));
  const targetAliases = new Map();
  const cleanReport = (report, nodeId, reportId) => ({
    id: reportId,
    nodeId,
    testedAt: report.testedAt,
    parserVersion: report.parserVersion,
    sourceFormat: report.sourceUrl?.startsWith('csv:') ? 'csv' : 'html',
    sections: (report.sections ?? []).map(section => ({ id: typeof section === 'string' ? section : section.id })),
    records: report.records.map(record => {
      const targetKey = JSON.stringify([record.section, record.group, record.target]);
      if (!targetAliases.has(targetKey)) targetAliases.set(targetKey, `target-${String(targetAliases.size + 1).padStart(3, '0')}`);
      const suffix = record.section === 'speedtest' && record.group !== '国际方向' ? record.target.match(/(电信|联通|移动)$/)?.[1] ?? '' : '';
      const target = targetAliases.get(targetKey) + suffix;
      const metrics = Object.fromEntries(Object.entries(record.metrics).filter(([key]) => key !== 'domain').map(([key, metric]) => {
        const safe = key === 'route' ? { value: /^(failed|error|timeout)$/i.test(String(metric.value)) ? metric.value : 'measured', status: metric.status, unit: metric.unit } : { value: metric.value, status: metric.status, unit: metric.unit };
        return [key, safe];
      }));
      return { key: JSON.stringify([record.section, record.group, target, record.carrier]), section: record.section, group: record.group, target, carrier: record.carrier, metrics };
    })
  });
  const manifest = [];
  const samples = snapshot.reports.map((report, index) => {
    const node = snapshot.state.nodes.find(node => node.id === report.nodeId);
    if (!node) throw new Error('报告缺少节点元数据');
    const alias = `sample-${String(index + 1).padStart(2, '0')}`;
    const earlierMetadata = snapshot.state.reports.filter(candidate => candidate.nodeId === report.nodeId && Date.parse(candidate.testedAt) < Date.parse(report.testedAt)).sort((left, right) => Date.parse(right.testedAt) - Date.parse(left.testedAt));
    const expected = earlierMetadata[0];
    const previous = expected ? history.find(candidate => candidate.nodeId === report.nodeId && candidate.testedAt === expected.testedAt && candidate.fingerprint === expected.fingerprint) : null;
    const old = snapshot.dashboard.entries.find(entry => entry.reportId === report.id)?.assessment ?? report.insight?.assessment;
    const rows = report.records.filter(record => ['ipv4', 'ipv6', 'large4', 'cernet'].includes(record.section));
    const rates = rows.flatMap(record => {
      const values = Object.entries(record.metrics).filter(([metric, value]) => /loss|retrans/i.test(metric) && value.unit === '%' && value.status === 'ok' && Number.isFinite(value.value) && value.value >= 0 && value.value <= 100).map(([, value]) => value.value);
      return values.length ? [Math.max(...values)] : [];
    });
    manifest.push({ alias, name: node.name, nodeId: node.id, region: node.region, reportId: report.id, testedAt: report.testedAt, fingerprint: report.fingerprint, contentHash: digest(JSON.stringify(report)), sourceFormat: report.sourceUrl?.startsWith('csv:') ? 'csv' : 'html', assessment: old, baseline: { heavy: rates.filter(rate => rate >= 20).length, valid: rates.length }, coverage: report.coverage, history: expected ? { expectedReportId: expected.id, available: !!previous, verifiedBy: previous ? 'nodeId + testedAt + fingerprint' : null } : { available: false, reason: '快照没有更早报告' } });
    return { node: { id: alias, region: node.region }, report: cleanReport(report, alias, `${alias}-latest`), previous: previous ? cleanReport(previous, alias, `${alias}-previous`) : null, baseline: { score: old?.score ?? null, primaryKind: old?.primary?.kind ?? null, heavy: rates.filter(rate => rate >= 20).length, valid: rates.length } };
  });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(outputDirectory, 'samples.json'), JSON.stringify({ capturedAt: snapshot.capturedAt, samples }) + '\n', { flag: 'wx' });
  await writeFile(join(privateDirectory, 'manifest.json'), JSON.stringify({ capturedAt: snapshot.capturedAt, snapshotHash: digest(snapshotBytes), manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { samples: samples.length, histories: samples.filter(sample => sample.previous).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [snapshotPath, historyDirectory, outputDirectory, privateDirectory] = process.argv.slice(2);
  if (!snapshotPath || !outputDirectory || !privateDirectory) throw new Error('用法：node scripts/prepare-priority-samples.mjs <snapshot.json> <history-dir> <fixture-dir> <private-dir>');
  console.log(await prepareSamples({ snapshotPath, historyDirectory, outputDirectory, privateDirectory }));
}
