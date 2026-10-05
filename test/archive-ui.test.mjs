import test from 'node:test';
import assert from 'node:assert/strict';
import { previousReport, staleNodes } from '../public/archive.js';

test('上一份按测试时间选取，同刻及其他节点不误选', () => {
  const current = { id: 'current', nodeId: 'one', testedAt: '2026-10-06T08:00:00+08:00' };
  const reports = [current, { id: 'earlier', nodeId: 'one', testedAt: '2026-10-05T23:00:00Z' }, { id: 'old', nodeId: 'one', testedAt: '2026-10-05T06:00:00+08:00' }, { id: 'same', nodeId: 'one', testedAt: current.testedAt }, { id: 'foreign', nodeId: 'two', testedAt: '2026-10-06T07:59:00+08:00' }];
  assert.equal(previousReport(reports, current).id, 'earlier');
  assert.equal(previousReport([], current), null);
});
test('新鲜度只包含启用非归档节点，未测和过期分别提示', () => {
  const nodes = [{ id: 'old', enabled: true }, { id: 'never', enabled: true }, { id: 'disabled', enabled: false }, { id: 'archived', archived: true }];
  const reports = [{ nodeId: 'old', testedAt: '2026-10-01T00:00:00Z' }];
  const result = staleNodes(nodes, reports, 7, Date.parse('2026-10-09T00:00:00Z'));
  assert.deepEqual(result.map(item => item.node.id), ['never', 'old']);
  assert.equal(result[1].age, 8);
});
