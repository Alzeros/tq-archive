import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// keys.mjs 在模块加载时就确定 DATA_DIR 并解析一次文件，所以必须在导入前把目录准备好。
// 这个文件专门测"文件坏了怎么办"：不能静默清空，也不能让后来者把它覆盖掉。
const dir = mkdtempSync(join(tmpdir(), 'tq-keys-corrupt-'));
process.env.DATA_DIR = dir;
writeFileSync(join(dir, 'keys.json'), '[{"id":"abc","name":"写到一半');
const { listKeys, createKey, keysLoadError, backupBrokenKeys, authorizeKey } = await import('../lib/keys.mjs');

test('损坏的 keys.json 在模块加载时就被识别，不静默当成没有 Key', () => {
  // 懒加载的话，启动流程检查时还没人调用过 loadKeys，永远读到空字符串 —— 检查等于没做
  assert.match(keysLoadError(), /API Key 文件解析失败/);
  assert.deepEqual(listKeys(), []);
  assert.match(authorizeKey(null, 'upload').error, /API Key 错误/);
});

test('读失败后拒绝任何写入，避免用空列表覆盖现存 Key', () => {
  // 这是最要命的一步：一旦被覆盖，所有脚本机上的 secret 都无法恢复
  assert.throws(() => createKey('新 key', 'read'), /已拒绝写入/);
  assert.equal(readFileSync(join(dir, 'keys.json'), 'utf8'), '[{"id":"abc","name":"写到一半', '原文件必须原样保留');
});

test('备份出损坏文件供人工修复', () => {
  const target = backupBrokenKeys();
  assert.equal(target, join(dir, 'keys.json.corrupt'));
  assert.ok(existsSync(target));
  assert.equal(readFileSync(target, 'utf8'), '[{"id":"abc","name":"写到一半');
});

test('内容不是数组也算损坏，不能当成空列表继续跑', async () => {
  const other = mkdtempSync(join(tmpdir(), 'tq-keys-shape-'));
  writeFileSync(join(other, 'keys.json'), '{"keys":[]}');
  const saved = process.env.DATA_DIR;
  process.env.DATA_DIR = other;
  // 同一个模块实例的 DATA_DIR 已经固定，这里用子进程验证形状检查
  const { execFileSync } = await import('node:child_process');
  const script = `
    const m = await import(${JSON.stringify(new URL('../lib/keys.mjs', import.meta.url).href)});
    console.log(JSON.stringify({ error: m.keysLoadError(), keys: m.listKeys().length }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: other } }).toString();
  const result = JSON.parse(out);
  assert.match(result.error, /内容不是数组/);
  assert.equal(result.keys, 0);
  process.env.DATA_DIR = saved;
});
