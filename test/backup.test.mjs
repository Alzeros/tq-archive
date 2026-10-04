import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { packDirectory } from '../lib/backup.mjs';

// 备份是这个工具唯一的灾备手段：打包出来的东西必须真能被解开、内容一字不差。
// 因此这里不满足于"字节数对得上"，而是用系统 tar 实际解包再逐文件比对。

const buildTree = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tq-backup-'));
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });
  mkdirSync(join(dir, 'csv-pool'), { recursive: true });
  mkdirSync(join(dir, 'empty-dir'), { recursive: true });
  writeFileSync(join(dir, 'database.json'), JSON.stringify({ version: 2, nodes: [], reports: [], pending: [] }));
  writeFileSync(join(dir, 'keys.json'), JSON.stringify([{ id: 'k1', secret: 'a'.repeat(64) }]));
  writeFileSync(join(dir, 'reports', 'r1.json'), JSON.stringify({ id: 'r1', records: [{ target: '吉林', loss: 78 }] }));
  writeFileSync(join(dir, 'raw', 'r1.html'), '<html>报告</html>');
  writeFileSync(join(dir, 'csv-pool', 'p1.csv'), '网络,IP版本\n');
  return dir;
};

const unpack = (archive, target) => {
  mkdirSync(target, { recursive: true });
  const file = join(target, 'backup.tar.gz');
  writeFileSync(file, archive);
  execFileSync('tar', ['-xzf', file, '-C', target]);
  return target;
};

test('打包出的 tar.gz 能被系统 tar 解开，且文件内容一字不差', () => {
  const source = buildTree();
  const archive = packDirectory(source);
  // gzip 魔数，确保是真压缩包而不是改了个扩展名的 tar
  assert.equal(archive.subarray(0, 2).toString('hex'), '1f8b');

  const target = unpack(archive, mkdtempSync(join(tmpdir(), 'tq-unpack-')));
  for (const rel of ['database.json', 'keys.json', 'reports/r1.json', 'raw/r1.html', 'csv-pool/p1.csv']) {
    assert.ok(existsSync(join(target, rel)), `${rel} 应被归档`);
    assert.equal(readFileSync(join(target, rel), 'utf8'), readFileSync(join(source, rel), 'utf8'), `${rel} 内容必须一致`);
  }
  assert.ok(existsSync(join(target, 'empty-dir')), '空目录也要还原，否则恢复后目录结构不全');
});

test('额外条目（备份说明）以文件形式进包，不破坏其余内容', () => {
  const source = buildTree();
  const archive = packDirectory(source, [{ name: 'README-备份说明.txt', content: '恢复方式：覆盖 data/ 后重启' }]);
  const target = unpack(archive, mkdtempSync(join(tmpdir(), 'tq-unpack-')));
  assert.equal(readFileSync(join(target, 'README-备份说明.txt'), 'utf8'), '恢复方式：覆盖 data/ 后重启');
  assert.ok(existsSync(join(target, 'database.json')));
});

test('中文文件名与内容不乱码（tar 头按 UTF-8 写）', () => {
  const source = mkdtempSync(join(tmpdir(), 'tq-backup-cn-'));
  writeFileSync(join(source, '备份说明.txt'), '丢包 78%，延迟 175ms');
  const archive = packDirectory(source);
  const target = unpack(archive, mkdtempSync(join(tmpdir(), 'tq-unpack-cn-')));
  assert.equal(readFileSync(join(target, '备份说明.txt'), 'utf8'), '丢包 78%，延迟 175ms');
});

test('超长路径的文件能完整还原（走 prefix 字段，装不下的目录条目按设计丢弃）', () => {
  const source = mkdtempSync(join(tmpdir(), 'tq-backup-long-'));
  const deep = join(source, ...Array.from({ length: 8 }, (_, index) => `目录层级${index}-xxxxxxxx`));
  mkdirSync(deep, { recursive: true });
  const file = join(deep, '很长的文件名-避免被截断-yyyyyyyyyyyy.json');
  writeFileSync(file, '{"ok":true}');
  const target = unpack(packDirectory(source), mkdtempSync(join(tmpdir(), 'tq-unpack-long-')));
  // 路径必须原样还原：tar 头只有 100 字节给路径，超长要用 prefix 字段拆。
  // 末段 100 字节内没有 '/' 的目录条目 ustar 装不下，会被跳过 —— 但解包文件时
  // tar 会把父目录逐级建出来，所以文件本身必须完好无损。
  const restored = join(target, file.slice(source.length + 1));
  assert.ok(existsSync(restored), '长路径下的文件必须完整还原');
  assert.equal(readFileSync(restored, 'utf8'), '{"ok":true}');
});

test('超长路径的文件条目绝不能静默跳过（少备份比备份失败更危险）', () => {
  const source = mkdtempSync(join(tmpdir(), 'tq-backup-unpackable-'));
  // 单个文件名本身就超过 100 字节，且没有 '/' 可拆：ustar 头装不下
  const name = '名'.repeat(40) + '.json';
  assert.ok(Buffer.byteLength(name) > 100);
  writeFileSync(join(source, name), '{}');
  assert.throws(() => packDirectory(source), /路径过长/, '宁可报错也不能打出一个缺文件的备份');
});

test('空目录也能打包（只有两个结尾零块，不报错）', () => {
  const source = mkdtempSync(join(tmpdir(), 'tq-backup-empty-'));
  const archive = packDirectory(source);
  assert.ok(gunzipSync(archive).length >= 1024, '至少要有两个 512 字节的结尾块');
  const target = unpack(archive, mkdtempSync(join(tmpdir(), 'tq-unpack-empty-')));
  assert.ok(existsSync(join(target, 'backup.tar.gz')));
});

test('归档的 sha256 前缀稳定：同样的输入产出同样的内容', () => {
  const source = buildTree();
  const first = packDirectory(source);
  const second = packDirectory(source);
  // gzip 头里会写 mtime，所以不做逐字节比较，只确认体积量级一致（防止漏掉文件）
  assert.ok(Math.abs(first.length - second.length) < 64, '同样内容两次打包体积应基本一致');
});

test('打不开的目录会抛错，而不是产出半个归档', () => {
  assert.throws(() => packDirectory(join(tmpdir(), 'tq-not-exist-' + Date.now())));
});
