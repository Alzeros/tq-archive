import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPriority, sortPriorities } from '../lib/priority.mjs';
import { priorityPresets } from '../lib/priority-view.mjs';
import { completeReport, deepFreeze } from './fixtures/priority/factory.mjs';

const assess = (report, weights = {}) => assessPriority(report, { region: 'US' }, null, weights);
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('education changes with access weight and contributions conserve the full score', () => {
  const report = completeReport();
  report.records.find(record => record.section === 'cernet').metrics.loss.value = 100;
  const normal = assess(deepFreeze(report));
  const mobile = assess(report, priorityPresets.mobile);
  almost(normal.unroundedScore, 12.5);
  assert.ok(mobile.score < normal.score);
  assert.equal(normal.primary.leaf, 'A.cernet.v4');
  for (const result of [normal, mobile]) {
    almost(result.contributions.reduce((sum, item) => sum + item.contribution, 0), result.unroundedScore);
    almost(result.contributions.reduce((sum, item) => sum + item.weight, 0), 1);
  }
});

test('domestic speed and bulk each take exactly one usage seat and follow access', () => {
  for (const branch of ['D', 'B']) {
    const report = completeReport();
    for (const record of report.records) {
      if (branch === 'D' && record.section === 'speedtest' && record.group === 'IPv4') record.metrics.returnRetrans.value = 100;
      if (branch === 'B' && record.section === 'large4') record.metrics.retrans.value = 100;
    }
    almost(assess(report).unroundedScore, 100 / 6);
    if (branch === 'D') for (const record of report.records.filter(record => record.section === 'speedtest' && record.target.endsWith('移动'))) record.metrics.returnRetrans.value = 0;
    else for (const record of report.records.filter(record => record.section === 'large4' && record.carrier === '移动')) record.metrics.retrans.value = 0;
    assert.ok(assess(report, priorityPresets.mobile).score < assess(report).score);
  }
});

test('international-only risk is invariant under access changes, not usage changes', () => {
  const report = completeReport();
  report.records.find(record => record.group === '常用网站').metrics.retrans.value = 100;
  const normal = assess(report);
  almost(normal.unroundedScore, assess(report, priorityPresets.mobile).unroundedScore);
  assert.notEqual(normal.score, assess(report, priorityPresets.bandwidth).score);
});

test('domestic speed weighting does not reassign international speed to the domestic seat', () => {
  const report = completeReport();
  report.records.find(record => record.group === '国际方向').metrics.downloadRetransRate.value = 100;
  const international = weights => assess(report, weights).contributions.find(item => item.leaf === 'I.speed.v4');
  const normal = international({});
  almost(normal.weight, 1 / 24);
  almost(international({ usage: { intl: 4 } }).weight, normal.weight * 2);
  almost(international({ usage: { domesticSpeed: 4 } }).weight, normal.weight / 2);
  assert.equal(international({ usage: { domesticSpeed: 4 } }).localScore, normal.localScore);
});

test('scaling all four access weights preserves score and canonical id', () => {
  const report = completeReport(10);
  report.records[0].metrics.loss.value = 100;
  const normal = assess(report, { access: { ct: 0.25, cu: 0.5, cm: 1, cernet: 0.25 } });
  const scaled = assess(report, { access: { ct: 1, cu: 2, cm: 4, cernet: 1 } });
  almost(normal.unroundedScore, scaled.unroundedScore);
  assert.equal(normal.view.id, scaled.view.id);
});

test('null coverage stays separate, known risks do not get renormalized or claim a primary', () => {
  const report = completeReport(100);
  report.records = report.records.filter(record => record.section !== 'large4');
  const result = assess(report);
  assert.equal(result.status, 'insufficient');
  for (const field of ['score', 'defaultScore', 'deltaFromDefault', 'primary']) assert.equal(result[field], null);
  almost(result.contributions.reduce((sum, item) => sum + item.weight, 0), 1);
  assert.ok(result.contributions.some(item => item.contribution !== null));
  assert.equal(assess(null).status, 'no-report');
});

test('primary is highest weighted contribution, no unweighted floor; facts are unchanged', () => {
  const report = completeReport();
  report.records.find(record => record.section === 'cernet').metrics.loss.value = 100;
  for (const record of report.records.filter(record => record.section === 'ipv4' && record.carrier === '移动')) record.metrics.loss.value = 20;
  const normal = assess(report);
  const mobile = assess(report, priorityPresets.mobile);
  assert.equal(normal.primary.leaf, 'A.cernet.v4');
  assert.equal(mobile.primary.leaf, 'A.cm.v4');
  assert.ok(mobile.score < 50);
  assert.deepEqual(normal.facts, mobile.facts);
  assert.equal(mobile.defaultScore, normal.score);
  almost(mobile.deltaFromDefault, Math.round((mobile.score - normal.score) * 10) / 10);
});

test('stable sorting uses display score, comparable breadth, time, id and isolates null', () => {
  const priority = assess(completeReport());
  const entry = (nodeId, ratio, testedAt = '2026-10-06') => ({ nodeId, testedAt, priority: { ...structuredClone(priority), breadth: { ...priority.breadth, weightedRatio: ratio } } });
  const first = entry('first', 0.9);
  const second = entry('second', 0.1, '2026-10-07');
  const unknown = { nodeId: 'unknown', testedAt: '2026-10-08', priority: assess(null) };
  assert.deepEqual(sortPriorities([unknown, second, first]).map(item => item.nodeId), ['first', 'second', 'unknown']);
  second.priority.breadth.signature = 'other-scope';
  assert.deepEqual(sortPriorities([first, second]).map(item => item.nodeId), ['second', 'first']);
  const tie = entry('aaa', 0.9);
  assert.deepEqual(sortPriorities([first, tie]).map(item => item.nodeId), ['aaa', 'first']);
});

test('mixed breadth scopes use a transitive tie-cohort ordering', () => {
  const base = assess(completeReport());
  const entries = ['a', 'b', 'c'].map((nodeId, index) => ({ nodeId, testedAt: `2026-10-0${index + 1}`, priority: { ...base, breadth: { signature: index === 1 ? 'different' : 'same', weightedRatio: 1 - index / 3 } } }));
  for (const permutation of [entries, [...entries].reverse(), [entries[1], entries[0], entries[2]]]) assert.deepEqual(sortPriorities(permutation).map(entry => entry.nodeId), ['c', 'b', 'a']);
});

test('same frozen inputs are deterministic and no node population is required', () => {
  const report = deepFreeze(completeReport(5));
  const before = assess(report);
  assess(completeReport(100));
  assert.deepEqual(assess(report), before);
  assert.equal(before.level, null);
  assert.equal(before.calibration, 'candidate');
});
