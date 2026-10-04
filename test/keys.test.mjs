import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// keys.mjs 在模块加载时就确定了 DATA_DIR，必须先设好再动态导入，
// 否则测试会把 keys.json 写进仓库的 data/ 里
const dir = mkdtempSync(join(tmpdir(), 'tq-keys-'));
process.env.DATA_DIR = dir;
const { createKey, scopeOf, authorizeKey, listKeys, updateKey } = await import('../lib/keys.mjs');

test('旧 key 没有 scope 字段时按上传处理：升级不该让存量 key 凭空多出读权限', () => {
  assert.equal(scopeOf({}), 'upload');
  assert.equal(scopeOf({ scope: 'read' }), 'read');
  assert.equal(scopeOf({ scope: '什么鬼' }), 'upload', '无法识别的 scope 退回最小权限');
  assert.equal(scopeOf(null), 'upload');
});

test('创建 key 时按传入的 scope 落库，缺省是上传', () => {
  const read = createKey('分析用', 'read');
  const upload = createKey('服务器A');
  assert.equal(read.scope, 'read');
  assert.equal(upload.scope, 'upload');
  assert.equal(listKeys().filter(k => k.scope === 'read').length, 1);
});

test('权限精确匹配：只读 key 进不了上传接口，上传 key 进不了读接口', () => {
  const read = createKey('r', 'read');
  const upload = createKey('u', 'upload');
  assert.equal(authorizeKey(read, 'read').error, undefined);
  assert.equal(authorizeKey(upload, 'upload').error, undefined);
  assert.match(authorizeKey(read, 'upload').error, /无权访问/);
  assert.match(authorizeKey(upload, 'read').error, /无权访问/);
});

test('禁用与不存在的 key 一律拒绝，禁用后即便权限对也不放行', () => {
  const key = createKey('x', 'read');
  assert.match(authorizeKey({ ...key, enabled: false }, 'read').error, /已被禁用/);
  assert.match(authorizeKey(null, 'read').error, /API Key 错误/);
  assert.equal(authorizeKey(updateKey(key.id, { enabled: true }), 'read').error, undefined);
});

test('secret 是 64 位随机 hex 且互不相同', () => {
  const a = createKey('a', 'read');
  const b = createKey('b', 'read');
  assert.match(a.secret, /^[a-f\d]{64}$/);
  assert.notEqual(a.secret, b.secret);
});

test('id 不允许被改写', () => {
  const key = createKey('c', 'read');
  const updated = updateKey(key.id, { name: '改名', id: 'hacked', scope: 'upload' });
  assert.equal(updated.id, key.id, 'id 必须保持不变');
  assert.equal(updated.name, '改名');
  assert.equal(updated.scope, 'upload', 'scope 本身允许改（便于把上传 key 提升为只读）');
});
