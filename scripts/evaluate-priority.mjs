import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { assessPriority, sortPriorities } from '../lib/priority.mjs';
import { priorityPresets, priorityView } from '../lib/priority-view.mjs';
import { priorityRules } from '../lib/thresholds.mjs';

export async function evaluatePriority(inputDirectory, outputDirectory) {
  const inputPath = await realpath(inputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = await realpath(outputDirectory);
  if (inputPath === outputPath || inputPath.startsWith(outputPath + '/')) throw new Error('演算输出不得覆盖输入目录');
  const bytes = await readFile(join(inputPath, 'samples.json'));
  const { capturedAt, samples } = JSON.parse(bytes);
  const views = {};
  for (const [name, weights] of Object.entries(priorityPresets)) {
    const entries = samples.map(sample => ({ nodeId: sample.node.id, testedAt: sample.report.testedAt, oldScore: sample.baseline.score, priority: assessPriority(sample.report, sample.node, sample.previous, weights) }));
    const sorted = sortPriorities(entries);
    views[name] = { view: priorityView(weights), entries: sorted.map((entry, index) => ({ ...entry, rank: entry.priority.status === 'ready' ? index + 1 : null })) };
  }
  const sensitivity = [];
  for (const meanShare of [0.7, 0.8, 0.9]) {
    for (const mobileWeight of [0.75, 1, 1.25]) {
      const weights = { access: { ct: 0.25, cu: 0.25, cm: mobileWeight, cernet: 0.25 } };
      const entries = sortPriorities(samples.map(sample => ({ nodeId: sample.node.id, testedAt: sample.report.testedAt, priority: assessPriority(sample.report, sample.node, sample.previous, weights, { meanShare }) })));
      sensitivity.push({ meanShare, weights, results: entries.map((entry, index) => ({ nodeId: entry.nodeId, score: entry.priority.score, rank: entry.priority.status === 'ready' ? index + 1 : null })) });
    }
  }
  const result = { algorithmVersion: priorityRules.algorithmVersion, calibration: 'candidate', capturedAt, inputHash: createHash('sha256').update(bytes).digest('hex'), parameters: priorityRules, views, sensitivity };
  const lines = ['# P0 离线候选演算', '', `算法：${result.algorithmVersion}；样本抓取时间：${capturedAt}。仅候选参数，不是上线分数。`, '', '分档待 G0 确认；没有前份时历史通道不可用，不影响当前覆盖。原始事实、失败及所有覆盖原因见同目录 evaluation.json。', '', '| 样本 | 旧分 | 默认 | 移动优先 | 电信优先 | 带宽优先 | 默认主贡献 |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const sample of samples) {
    const priorities = Object.values(views).map(view => view.entries.find(entry => entry.nodeId === sample.node.id).priority);
    lines.push(`| ${sample.node.id} | ${sample.baseline.score} | ${priorities.map(priority => priority.score ?? '依据不足').join(' | ')} | ${priorities[0].primary?.leaf ?? '—'} |`);
  }
  lines.push('', '## 覆盖与历史限制', '');
  for (const sample of samples) {
    const priority = views.default.entries.find(entry => entry.nodeId === sample.node.id).priority;
    lines.push(`- ${sample.node.id}：${sample.previous ? '有已验证前份' : '历史不可用'}；${priority.status === 'ready' ? '当前读数完整' : [...new Set(priority.coverage.issues.map(issue => `${issue.leaf ?? ''} ${issue.reason}`))].join('；')}`);
  }
  lines.push('', '## 敏感性', '', '固定比较移动预设；均值系数 0.7/0.8/0.9，移动权重 0.75/1/1.25，其余接入为 0.25，用途全 1。完整九组结果见 JSON。', '');
  for (const sample of samples) {
    const results = sensitivity.map(run => run.results.find(entry => entry.nodeId === sample.node.id)).filter(entry => entry.rank !== null);
    if (results.length) lines.push(`- ${sample.node.id}：分数 ${Math.min(...results.map(entry => entry.score))}–${Math.max(...results.map(entry => entry.score))}；名次 ${Math.min(...results.map(entry => entry.rank))}–${Math.max(...results.map(entry => entry.rank))}`);
  }
  await writeFile(join(outputPath, 'evaluation.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(join(outputPath, 'evaluation.md'), lines.join('\n') + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('用法：node scripts/evaluate-priority.mjs --input <样本目录> --output <演算输出目录>');
  const result = await evaluatePriority(args[1], args[3]);
  console.log(`${result.algorithmVersion}: ${result.views.default.entries.length} 个样本；输出 ${resolve(args[3])}`);
}
