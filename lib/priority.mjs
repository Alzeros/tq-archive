import { priorityRules } from './thresholds.mjs';
import { priorityView } from './priority-view.mjs';
import { buildPriorityInput } from './priority-input.mjs';

const round = value => Math.round((value + Number.EPSILON) * 10) / 10;

// 档位取自 priorityRules.levels（场景校准的候选边界）。分数是连续量，档位只是它上面
// 的一层粗标签，排序仍用分数本身；边界推导见 lib/thresholds.mjs 的注释与
// test/priority.test.mjs 的标定守卫。
const levelOf = score => Number.isFinite(score) ? priorityRules.levels.find(rule => score >= rule.min) ?? null : null;

function aggregate(input, view) {
  const access = view.shares.access;
  const usage = view.shares.usage;
  const domesticTotal = access.ct + access.cu + access.cm;
  const contributions = input.leaves.map(leaf => {
    const families = input.leaves.filter(candidate => candidate.branch === leaf.branch && candidate.member === leaf.member).length;
    const weight = leaf.branch === 'A' ? 0.5 * access[leaf.member] / families
      : leaf.branch === 'I' ? 0.5 * usage.intl / 4 / families
        : 0.5 * usage[leaf.branch === 'D' ? 'domesticSpeed' : 'bulk'] * access[leaf.member] / domesticTotal / families;
    return { leaf: leaf.id, branch: leaf.branch, member: leaf.member, family: leaf.family, localScore: leaf.score, knownRisk: leaf.knownRisk, weight, contribution: leaf.score === null ? null : leaf.score * weight, primary: leaf.primary, channels: leaf.channels, breadth: leaf.breadth };
  });
  // 被探针整族跳过（SKIP）的叶子不参与分子，也不该留在分母里 —— 按实际参与的叶子
  // 重新归一化。全部叶子都参与时 Σw 本来等于 1，这一步与原来的求和等价，
  // 所以对现有样本是零变化（回归测试守着这一点）。
  const participating = contributions.filter(item => item.contribution !== null);
  const participatingWeight = participating.reduce((sum, item) => sum + item.weight, 0);
  const effectiveContributions = input.status !== 'ready' || !participatingWeight ? contributions : contributions.map(item => !participatingWeight
    ? item
    : { ...item, weight: item.weight / participatingWeight, contribution: item.contribution === null ? null : item.contribution / participatingWeight });
  const total = input.status === 'ready' && participatingWeight > 0 ? effectiveContributions.reduce((sum, item) => sum + (item.contribution ?? 0), 0) : null;
  const reasons = effectiveContributions.filter(item => item.contribution !== null).sort((left, right) => right.contribution - left.contribution || left.leaf.localeCompare(right.leaf));
  const rateLeaves = effectiveContributions.filter(item => item.breadth.ratio !== null);
  const rateWeight = rateLeaves.reduce((sum, item) => sum + item.weight, 0);
  const breadth = {
    scope: '每记录百分比最大值 ≥20%；不含次数；按相同聚合树加权并在有比例读数的叶子内归一化',
    signature: rateLeaves.map(item => `${item.leaf}:${item.breadth.valid}`).sort().join('|'),
    weightedRatio: total !== null && rateWeight > 0 ? rateLeaves.reduce((sum, item) => sum + item.weight * item.breadth.ratio, 0) / rateWeight : null
  };
  return { total, score: total === null ? null : round(total), contributions: effectiveContributions, reasons, breadth };
}

export function assessPriority(report, node = {}, previous = null, weights = {}, options = {}) {
  const view = priorityView(weights);
  const input = buildPriorityInput(report, node, previous, options);
  const current = aggregate(input, view);
  const defaults = aggregate(input, priorityView());
  const level = input.status === 'ready' ? levelOf(current.score) : null;
  return {
    algorithmVersion: options.meanShare !== undefined && options.meanShare !== priorityRules.meanShare ? `${priorityRules.algorithmVersion}:mean=${options.meanShare}` : priorityRules.algorithmVersion,
    calibration: 'candidate',
    status: input.status,
    score: current.score,
    unroundedScore: current.total,
    level: level?.level ?? null,
    label: input.status === 'ready' ? level?.label ?? '候选分·待标定' : input.status === 'no-report' ? '无报告' : '排序依据不足',
    levelSource: level ? 'candidate-scenario' : null,
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
