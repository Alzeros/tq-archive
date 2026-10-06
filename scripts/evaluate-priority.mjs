import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { assessPriority, sortPriorities } from '../lib/priority.mjs';
import { priorityPresets, priorityPresetLabels, priorityView } from '../lib/priority-view.mjs';
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
    views[name] = { label: priorityPresetLabels[name], view: priorityView(weights), entries: sorted.map((entry, index) => ({ ...entry, rank: entry.priority.status === 'ready' ? index + 1 : null })) };
  }
  const sensitivity = [];
  for (const meanShare of [0.7, 0.8, 0.9]) {
    for (const mobileWeight of [0.75, 1, 1.25]) {
      const weights = { access: { ct: 0.25, cu: 0.25, cm: mobileWeight, cernet: 0.25 } };
      const entries = sortPriorities(samples.map(sample => ({ nodeId: sample.node.id, testedAt: sample.report.testedAt, priority: assessPriority(sample.report, sample.node, sample.previous, weights, { meanShare }) })));
      sensitivity.push({ meanShare, weights, results: entries.map((entry, index) => ({ nodeId: entry.nodeId, score: entry.priority.score, rank: entry.priority.status === 'ready' ? index + 1 : null })) });
    }
  }
  const singleAxisSensitivity = [];
  for (const [axis, weights] of Object.entries(priorityView().weights)) {
    for (const key of Object.keys(weights)) {
      for (const value of [0.25, 0.5, 1, 2, 4]) {
        const view = priorityView({ [axis]: { [key]: value } });
        const entries = sortPriorities(samples.map(sample => ({ nodeId: sample.node.id, testedAt: sample.report.testedAt, priority: assessPriority(sample.report, sample.node, sample.previous, view.weights) })));
        const results = entries.map((entry, index) => {
          const baseline = views.default.entries.find(candidate => candidate.nodeId === entry.nodeId);
          const rank = entry.priority.status === 'ready' ? index + 1 : null;
          return {
            nodeId: entry.nodeId, status: entry.priority.status, score: entry.priority.score, rank,
            scoreDelta: entry.priority.deltaFromDefault,
            rankDelta: rank === null || baseline.rank === null ? null : rank - baseline.rank,
            primary: entry.priority.primary?.leaf ?? null,
            primaryChanged: (entry.priority.primary?.leaf ?? null) !== (baseline.priority.primary?.leaf ?? null),
            contributions: entry.priority.contributions.map(item => {
              const before = baseline.priority.contributions.find(candidate => candidate.leaf === item.leaf);
              return { leaf: item.leaf, localScore: item.localScore, weight: item.weight, contribution: item.contribution, delta: item.contribution === null || before?.contribution == null ? null : item.contribution - before.contribution };
            })
          };
        });
        singleAxisSensitivity.push({ axis, key, value, view, results });
      }
    }
  }
  const result = { algorithmVersion: priorityRules.algorithmVersion, calibration: 'candidate', capturedAt, inputHash: createHash('sha256').update(bytes).digest('hex'), parameters: priorityRules, views, sensitivity, singleAxisSensitivity };
  const lines = ['# P0 离线候选演算', '', `算法：${result.algorithmVersion}；样本抓取时间：${capturedAt}。仅候选参数，不是上线分数。`, '', '分档待 G0 确认；没有前份时历史通道不可用，不影响当前覆盖。原始事实、失败及所有覆盖原因见同目录 evaluation.json。', '', '国内带宽优先提高国内测速和大包的相对份额；国际方向测速仍属于国际访问。', '', '| 样本 | 旧分 | 默认 | 移动优先 | 电信优先 | 国内带宽优先 | 默认主贡献 |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const sample of samples) {
    const priorities = Object.values(views).map(view => view.entries.find(entry => entry.nodeId === sample.node.id).priority);
    lines.push(`| ${sample.node.id} | ${sample.baseline.score} | ${priorities.map(priority => priority.score ?? '依据不足').join(' | ')} | ${priorities[0].primary?.leaf ?? '—'} |`);
  }
  lines.push('', '## 覆盖与历史限制', '');
  for (const sample of samples) {
    const priority = views.default.entries.find(entry => entry.nodeId === sample.node.id).priority;
    lines.push(`- ${sample.node.id}：${sample.previous ? '有已验证前份' : '历史不可用'}；${priority.status === 'ready' ? '注册范围内必需读数完整' : [...new Set(priority.coverage.issues.map(issue => `${issue.leaf ?? ''} ${issue.reason}`))].join('；')}；模板不包含 ${priority.coverage.templateExclusions.map(item => item.leaf).join('、')}；${priority.coverage.conditionalTests.map(item => `${item.leaf} ${item.state}`).join('、')}`);
  }
  lines.push('', '## 敏感性', '', '固定比较移动预设；均值系数 0.7/0.8/0.9，移动权重 0.75/1/1.25，其余接入为 0.25，用途全 1。完整九组结果见 JSON。', '');
  for (const sample of samples) {
    const results = sensitivity.map(run => run.results.find(entry => entry.nodeId === sample.node.id)).filter(entry => entry.rank !== null);
    if (results.length) lines.push(`- ${sample.node.id}：分数 ${Math.min(...results.map(entry => entry.score))}–${Math.max(...results.map(entry => entry.score))}；名次 ${Math.min(...results.map(entry => entry.rank))}–${Math.max(...results.map(entry => entry.rank))}`);
  }
  lines.push('', '## 单项权重扫描', '', '分别调整 access 的 ct/cu/cm/cernet 和 usage 的 intl/domesticSpeed/bulk，每次仅改一项为 0.25/0.5/1/2/4，其余保持 1，共 35 组。调高一项会改变同组其他项的相对份额。', '', 'rankDelta 为当前名次减默认名次，正数表示后移。分数不变不等于贡献不变，名次不变也不代表权重无影响。不人为规定名次最多变化几位；完整贡献及差值见 JSON。', '');
  for (const [axis, weights] of Object.entries(priorityView().weights)) {
    for (const key of Object.keys(weights)) {
      lines.push(`### ${axis}.${key}`, '', '| 样本 | 分数范围 | 名次范围 | 相对默认名次变化 |', '| --- | ---: | ---: | ---: |');
      for (const sample of samples) {
        const runs = singleAxisSensitivity.filter(run => run.axis === axis && run.key === key).map(run => run.results.find(entry => entry.nodeId === sample.node.id)).filter(entry => entry.rank !== null);
        const range = field => `${Math.min(...runs.map(entry => entry[field]))}–${Math.max(...runs.map(entry => entry[field]))}`;
        lines.push(`| ${sample.node.id} | ${runs.length ? range('score') : '依据不足'} | ${runs.length ? range('rank') : '—'} | ${runs.length ? range('rankDelta') : '—'} |`);
      }
      lines.push('');
    }
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
