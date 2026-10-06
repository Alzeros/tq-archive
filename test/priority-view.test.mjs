import test from 'node:test';
import assert from 'node:assert/strict';
import { priorityView, parsePriorityView, priorityPresets } from '../lib/priority-view.mjs';

test('default weights, missing keys, boundaries and equivalent views', () => {
  assert.deepEqual(priorityView().weights, { access: { ct: 1, cu: 1, cm: 1, cernet: 1 }, usage: { intl: 1, domesticSpeed: 1, bulk: 1 } });
  const parsed = parsePriorityView(new URLSearchParams('access=cm:4&usage=bulk:0.25'));
  assert.equal(parsed.weights.access.ct, 1);
  assert.equal(parsed.weights.access.cm, 4);
  assert.equal(parsed.weights.usage.bulk, 0.25);
  assert.equal(priorityView({ access: { ct: 4, cu: 4, cm: 4, cernet: 4 } }).id, priorityView().id);
  assert.notEqual(priorityView({ access: { ct: 4, cu: 4, cm: 4 } }).id, priorityView().id);
  assert.equal(priorityView(priorityPresets.mobile).weights.access.cernet, 0.25);
});

test('malformed query weights are rejected, never silently defaulted', () => {
  for (const query of ['access=', 'access=ct:1&access=cm:1', 'access=ct:1,ct:2', 'access=foo:1', 'access=ct:NaN', 'access=ct:Infinity', 'access=ct:0', 'access=ct:-1', 'access=ct:4.1', 'access=ct:0.24', 'access=ct:', 'access=ct: 1', 'access=ct:0x1', 'access=ct:1,', 'access=ct:1:1', 'view=mobile', `access=${'x'.repeat(513)}`]) assert.throws(() => parsePriorityView(new URLSearchParams(query)), undefined, query);
});

test('object weights reject unknown, null, non-finite and string values', () => {
  for (const input of [null, [], { other: {} }, { access: null }, { access: [] }, { access: { foo: 1 } }, { usage: { intl: NaN } }, { usage: { domesticSpeed: Infinity } }, { access: { ct: '1' } }, { usage: { speed: 1 } }]) assert.throws(() => priorityView(input));
});

test('domestic speed name is explicit and old ambiguous query key is rejected', () => {
  assert.equal(parsePriorityView(new URLSearchParams('usage=domesticSpeed:4')).weights.usage.domesticSpeed, 4);
  for (const query of ['usage=speed:1', 'usage=domesticSpeed:1,domesticSpeed:2']) assert.throws(() => parsePriorityView(new URLSearchParams(query)));
});
