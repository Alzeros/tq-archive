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
  const expected = [19.2, null, 5.7, 8.8, null, 8.8, 9.7, null, null, null, 39.2, 7.3, 30, 15.9, 0.6, 3.2, null];
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

test('missing IPv6 domestic carrier coverage is reported, including the severe real sample', () => {
  for (const alias of ['sample-02', 'sample-05', 'sample-09', 'sample-10', 'sample-17']) {
    const result = evaluate(alias);
    assert.equal(result.score, null);
    assert.ok(result.coverage.issues.some(issue => issue.leaf === 'D.ct.v6'));
    assert.ok(result.coverage.issues.some(issue => issue.leaf === 'D.cu.v6'));
  }
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
    for (const view of Object.values(result.views)) assert.equal(view.entries.length, 17);
    assert.equal(await readFile(fixturePath, 'utf8'), bytes);
    assert.deepEqual(await evaluatePriority(new URL('./fixtures/priority', import.meta.url).pathname, directory), result);
    await assert.rejects(evaluatePriority(new URL('./fixtures/priority', import.meta.url).pathname, new URL('./fixtures/priority', import.meta.url).pathname));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
