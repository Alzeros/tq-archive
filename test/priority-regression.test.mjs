import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessPriority } from '../lib/priority.mjs';
import { buildPriorityInput } from '../lib/priority-input.mjs';
import { priorityPresets } from '../lib/priority-view.mjs';
import { evaluatePriority } from '../scripts/evaluate-priority.mjs';
import { deepFreeze } from './fixtures/priority/factory.mjs';

const fixturePath = new URL('./fixtures/priority/samples.json', import.meta.url);
const bytes = await readFile(fixturePath, 'utf8');
const { samples } = deepFreeze(JSON.parse(bytes));
const get = alias => samples.find(sample => sample.node.id === alias);
const evaluate = (alias, view = {}) => {
  const sample = get(alias);
  return assessPriority(sample.report, sample.node, sample.previous, view);
};

test('all 17 real samples retain baseline counts and sanitized identities', () => {
  assert.equal(samples.length, 17);
  assert.equal(samples.filter(sample => sample.previous).length, 1);
  for (const [alias, score, heavy, valid] of [['sample-05', 97, 115, 340], ['sample-11', 97, 62, 217], ['sample-06', 91, 3, 217], ['sample-13', 90, 56, 217]]) assert.deepEqual([get(alias).baseline.score, get(alias).baseline.heavy, get(alias).baseline.valid], [score, heavy, valid]);
  assert.doesNotMatch(bytes, /sourceUrl|fingerprint|identity|cookie|password|apiKey|https?:\/\/|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
});

test('candidate real scores are frozen without pretending to be approved calibration', () => {
  const expected = [19.2, 21.2, 5.7, 8.8, 47.3, 8.8, 9.7, null, 30.2, 17.9, 39.2, 7.3, 30, 15.9, 0.6, 3.2, 15.1];
  assert.deepEqual(samples.map(sample => evaluate(sample.node.id).score), expected);
  assert.ok(evaluate('sample-13').score > evaluate('sample-06').score);
  assert.equal(evaluate('sample-15').score, 0.6);
  assert.equal(evaluate('sample-08').status, 'insufficient');
});

test('mobile lowers the intended contributions, without concealing independent mobile latency', () => {
  assert.equal(evaluate('sample-13', priorityPresets.mobile).score, 19.1);
  assert.equal(evaluate('sample-11', priorityPresets.mobile).score, 39);
  const normal = evaluate('sample-11');
  const mobile = evaluate('sample-11', priorityPresets.mobile);
  assert.ok(mobile.contributions.find(item => item.leaf === 'B.ct.v4').contribution < normal.contributions.find(item => item.leaf === 'B.ct.v4').contribution);
  assert.equal(mobile.primary.leaf, 'A.cm.v4');
  assert.equal(mobile.primary.primary.kind, 'latency');
});

test('verified mobile-only IPv6 template restores five samples without suppressing genuine missing data', () => {
  for (const alias of ['sample-02', 'sample-05', 'sample-09', 'sample-10', 'sample-17']) {
    const result = evaluate(alias);
    assert.equal(result.status, 'ready');
    assert.ok(Number.isFinite(result.score));
    assert.deepEqual(result.coverage.templateExclusions.map(item => item.leaf), ['D.ct.v6', 'D.cu.v6']);
    assert.equal(result.coverage.issues.length, 0);
    assert.ok(result.contributions.some(item => item.leaf === 'D.cm.v6'));
    assert.ok(Math.abs(result.contributions.reduce((sum, item) => sum + item.weight, 0) - 1) < 1e-10);
  }
  const incomplete = evaluate('sample-08');
  assert.equal(incomplete.score, null);
  assert.equal(incomplete.coverage.issues.length, 11);
  assert.ok(incomplete.coverage.issues.some(issue => issue.leaf === 'A.cernet.v4'));
  assert.equal(samples.filter(sample => evaluate(sample.node.id).status === 'ready').length, 16);
  const cloudnium = evaluate('sample-05', priorityPresets.mobile);
  assert.equal(cloudnium.score, 52.6);
  assert.ok(cloudnium.score > evaluate('sample-13', priorityPresets.mobile).score);
  assert.ok(cloudnium.score > evaluate('sample-11', priorityPresets.mobile).score);
});

test('all four candidate views retain explicit scores including unscored incomplete reports', () => {
  const expected = {
    mobile: [19.9, 20.1, 6.8, 7.7, 52.6, 5.6, 6.6, null, 20.6, 13.4, 39, 9.5, 19.1, 16.6, 0.4, 2.1, 15.7],
    telecom: [17.1, 24.4, 5.6, 6.8, 44.1, 6.7, 7.9, null, 43.1, 19.8, 43.2, 6.8, 35.3, 16.4, 1.2, 2.2, 18.2],
    bandwidth: [25.6, 24.3, 7.4, 9.7, 54.9, 9.7, 11.4, null, 33.7, 17.6, 48, 8.6, 35.5, 17.1, 0.6, 4.1, 15.3]
  };
  for (const [name, scores] of Object.entries(expected)) assert.deepEqual(samples.map(sample => evaluate(sample.node.id, priorityPresets[name]).score), scores);
});

test('VMRack-like 93 route failures count as execution failures, not invented percentages', () => {
  const result = evaluate('sample-01');
  assert.equal(result.status, 'ready');
  const bulk = result.contributions.filter(item => item.branch === 'B');
  assert.ok(bulk.every(item => item.localScore === 90 && item.breadth.valid === 0));
  assert.equal(result.facts.filter(fact => fact.kind === 'test-failed' && fact.leaf.startsWith('B.')).length, 93);
});

test('HTML shared education heading respects its structured IPv6 column', () => {
  const sample = get('sample-10');
  const input = buildPriorityInput(sample.report, sample.node);
  assert.equal(input.leaves.find(leaf => leaf.id === 'A.cernet.v6').status, 'ready');
  assert.ok(!input.issues.some(issue => issue.reason === 'IP 测试族标识冲突'));
});

test('real full dual stack is ready, and counts do not use percentage severity', () => {
  const result = evaluate('sample-14');
  assert.equal(result.status, 'ready');
  assert.equal(result.coverage.singleStack, false);
  assert.ok(result.facts.some(fact => fact.kind === 'count' && fact.value > 0));
  assert.ok(result.contributions.filter(item => item.member === 'nodes').every(item => item.channels.find(channel => channel.kind === 'rate').score === null));
});

test('offline evaluator is reproducible, read-only and includes all four views and sensitivity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'priority-evaluation-'));
  try {
    const result = await evaluatePriority(new URL('./fixtures/priority', import.meta.url).pathname, directory);
    assert.equal(Object.keys(result.views).length, 4);
    assert.equal(result.sensitivity.length, 9);
    assert.equal(result.singleAxisSensitivity.length, 35);
    assert.equal(result.views.bandwidth.label, '国内带宽优先');
    for (const [axis, keys] of Object.entries({ access: ['ct', 'cu', 'cm', 'cernet'], usage: ['intl', 'domesticSpeed', 'bulk'] })) {
      for (const key of keys) {
        const scans = result.singleAxisSensitivity.filter(run => run.axis === axis && run.key === key);
        assert.deepEqual(scans.map(run => run.value), [0.25, 0.5, 1, 2, 4]);
        for (const run of scans) {
          for (const [otherAxis, weights] of Object.entries(run.view.weights)) for (const [otherKey, value] of Object.entries(weights)) assert.equal(value, otherAxis === axis && otherKey === key ? run.value : 1);
          assert.equal(run.results.length, 17);
          for (const entry of run.results) {
            const baseline = result.views.default.entries.find(item => item.nodeId === entry.nodeId);
            if (entry.nodeId === 'sample-08') {
              for (const field of ['score', 'rank', 'scoreDelta', 'rankDelta']) assert.equal(entry[field], null);
            } else {
              assert.equal(entry.rankDelta, entry.rank - baseline.rank);
              for (const contribution of entry.contributions) {
                const before = baseline.priority.contributions.find(item => item.leaf === contribution.leaf);
                assert.equal(contribution.localScore, before.localScore);
                assert.ok(Math.abs(contribution.delta - (contribution.contribution - before.contribution)) < 1e-10);
              }
              if (run.value === 1) {
                assert.equal(entry.scoreDelta, 0);
                assert.equal(entry.rankDelta, 0);
                assert.equal(entry.primaryChanged, false);
                assert.ok(entry.contributions.every(item => item.delta === 0));
              }
            }
          }
        }
      }
    }
    for (const view of Object.values(result.views)) assert.equal(view.entries.length, 17);
    assert.equal(await readFile(fixturePath, 'utf8'), bytes);
    assert.deepEqual(await evaluatePriority(new URL('./fixtures/priority', import.meta.url).pathname, directory), result);
    await assert.rejects(evaluatePriority(new URL('./fixtures/priority', import.meta.url).pathname, new URL('./fixtures/priority', import.meta.url).pathname));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
