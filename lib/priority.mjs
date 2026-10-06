import { priorityRules } from './thresholds.mjs';
import { priorityView } from './priority-view.mjs';
import { buildPriorityInput } from './priority-input.mjs';

const round = value => Math.round((value + Number.EPSILON) * 10) / 10;

function aggregate(input, view) {
  const access = view.shares.access;
  const usage = view.shares.usage;
  const domesticTotal = access.ct + access.cu + access.cm;
  const contributions = input.leaves.map(leaf => {
    const families = input.leaves.filter(candidate => candidate.branch === leaf.branch && candidate.member === leaf.member).length;
    const weight = leaf.branch === 'A' ? 0.5 * access[leaf.member] / families
      : leaf.branch === 'I' ? 0.5 * usage.intl / 4 / families
        : 0.5 * usage[leaf.branch === 'D' ? 'speed' : 'bulk'] * access[leaf.member] / domesticTotal / families;
    return { leaf: leaf.id, branch: leaf.branch, member: leaf.member, family: leaf.family, localScore: leaf.score, knownRisk: leaf.knownRisk, weight, contribution: leaf.score === null ? null : leaf.score * weight, primary: leaf.primary, channels: leaf.channels, breadth: leaf.breadth };
  });
  const total = input.status === 'ready' ? contributions.reduce((sum, item) => sum + item.contribution, 0) : null;
  const reasons = contributions.filter(item => item.contribution !== null).sort((left, right) => right.contribution - left.contribution || left.leaf.localeCompare(right.leaf));
  const rateLeaves = contributions.filter(item => item.breadth.ratio !== null);
  const rateWeight = rateLeaves.reduce((sum, item) => sum + item.weight, 0);
  const breadth = {
    scope: '每记录百分比最大值 ≥20%；不含次数；按相同聚合树加权并在有比例读数的叶子内归一化',
    signature: rateLeaves.map(item => `${item.leaf}:${item.breadth.valid}`).sort().join('|'),
    weightedRatio: total !== null && rateWeight > 0 ? rateLeaves.reduce((sum, item) => sum + item.weight * item.breadth.ratio, 0) / rateWeight : null
  };
  return { total, score: total === null ? null : round(total), contributions, reasons, breadth };
}

export function assessPriority(report, node = {}, previous = null, weights = {}, options = {}) {
  const view = priorityView(weights);
  const input = buildPriorityInput(report, node, previous, options);
  const current = aggregate(input, view);
  const defaults = aggregate(input, priorityView());
  return {
    algorithmVersion: options.meanShare !== undefined && options.meanShare !== priorityRules.meanShare ? `${priorityRules.algorithmVersion}:mean=${options.meanShare}` : priorityRules.algorithmVersion,
    calibration: 'candidate',
    status: input.status,
    score: current.score,
    unroundedScore: current.total,
    level: null,
    label: input.status === 'ready' ? '候选分·待标定' : input.status === 'no-report' ? '无报告' : '排序依据不足',
    defaultScore: defaults.score,
    deltaFromDefault: current.score === null || defaults.score === null ? null : round(current.score - defaults.score),
    view,
    primary: input.status === 'ready' && current.reasons[0]?.contribution > 0 ? current.reasons[0] : null,
    reasons: current.reasons,
    contributions: current.contributions,
    coverage: { ...input.coverage, issues: input.issues, leaves: input.leaves.map(leaf => ({ id: leaf.id, status: leaf.status, ...leaf.coverage })) },
    facts: input.facts,
    breadth: current.breadth
  };
}

export function sortPriorities(entries) {
  const cohorts = new Map();
  for (const entry of entries) {
    if (entry.priority.status !== 'ready') continue;
    const score = entry.priority.score;
    if (!cohorts.has(score)) cohorts.set(score, []);
    cohorts.get(score).push(entry.priority);
  }
  const comparable = new Set([...cohorts].filter(([, priorities]) => priorities.every(priority => priority.breadth.weightedRatio !== null) && new Set(priorities.map(priority => `${priority.algorithmVersion}|${priority.view.id}|${priority.breadth.signature}`)).size === 1).map(([score]) => score));
  const timestamp = entry => Number.isFinite(Date.parse(entry.testedAt)) ? Date.parse(entry.testedAt) : 0;
  return [...entries].sort((left, right) => {
    const leftReady = left.priority.status === 'ready';
    const rightReady = right.priority.status === 'ready';
    if (leftReady !== rightReady) return leftReady ? -1 : 1;
    if (leftReady) {
      const score = right.priority.score - left.priority.score;
      if (score) return score;
      if (comparable.has(left.priority.score)) {
        const breadth = right.priority.breadth.weightedRatio - left.priority.breadth.weightedRatio;
        if (breadth) return breadth;
      }
    }
    return timestamp(right) - timestamp(left) || String(left.nodeId).localeCompare(String(right.nodeId), 'en');
  });
}
