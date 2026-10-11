import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// 上传直传是脚本机唯一的写入口，跑在另一台机器上、崩溃了没人盯着。
// 这一组走真实 HTTP：起子进程、带真实 API Key、打真实请求。
// 库层的 pending/keys 已有测试，那部分不重复；这里只测 HTTP 边界上的东西 ——
// 鉴权前置判断、content-type、表头门槛、去重、请求头怎么变成归档元信息。

const csv = await readFile(new URL('./fixtures/tq-ipv4.csv', import.meta.url), 'utf8');
const repo = new URL('..', import.meta.url);

// 起一个带数据的实例，并返回一个可直接发请求的 client。
async function serve(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tq-upload-'));
  // 新库要靠探针同步才会有节点，而测试里连不上探针。直接写一份 database.json 铺好，
  // 这样绑定/归档这些路径才有节点可选（端点行为本身与节点来源无关）
  await writeFile(join(directory, 'database.json'), JSON.stringify({
    version: 2,
    syncedAt: null,
    nodes: [{ id: 'node-a', name: '节点-A', region: 'HK', order: 0 }, { id: 'node-b', name: '节点-B', region: 'US', order: 1 }],
    reports: [],
    pending: []
  }, null, 2));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: directory,
      AUTH_USER: 'test',
      AUTH_PASSWORD: 'upload-test-password',
      AUTH_SECURE: '0',
      ALLOWED_HOSTS: `127.0.0.1:${port}`,
      ALLOWED_ORIGINS: base
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  // 就绪 = 启动行已打出且真的连得上，否则后面所有断言都会报连不上而不是真问题
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes('TQ Archive running at')) {
      try { await fetch(`${base}/api/session`); break; } catch { /* 还没监听上 */ }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { base, output: () => output };
}

async function login(base) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password: 'upload-test-password' })
  });
  assert.equal(response.status, 200, '登录应成功');
  return { Cookie: response.headers.get('set-cookie').split(';')[0] };
}

async function createKey(base, cookie, scope) {
  const response = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `测试-${scope}`, scope })
  });
  assert.equal(response.status, 201);
  return (await response.json()).secret;
}

// 同一份内容再传会被判重复（按指纹）。测多份不同的内容时用这个做唯一化，
// 拿一个 fixture 里确实存在的延迟值 +1，保证内容变、指纹也变。
const variant = (tag) => csv.replace('174.116', `${175 + tag}.116`);

const upload = (base, key, body, headers = {}) => fetch(`${base}/api/upload-csv`, {
  method: 'POST',
  headers: { 'X-Tq-Key': key, 'Content-Type': 'text/csv', ...headers },
  body
});

test('上传直传：鉴权、表头门槛、去重与归档元信息', { timeout: 30000 }, async t => {
  const { base } = await serve(t);
  const cookie = await login(base);
  const uploadKey = await createKey(base, cookie, 'upload');
  const readKey = await createKey(base, cookie, 'read');

  // 预检：脚本开跑前先确认 hub 可达、key 有效
  const preflight = await fetch(`${base}/api/upload-csv`, { headers: { 'X-Tq-Key': uploadKey } });
  assert.equal(preflight.status, 200);
  assert.equal((await preflight.json()).key, `测试-upload`);

  // 正常上传
  const epoch = String(Date.parse('2026-10-04T01:02:27+08:00') / 1000);
  const first = await upload(base, uploadKey, csv, {
    'X-Report-Epoch': epoch,
    'X-Tq-Hostname': 'probe-01.example',
    'X-Real-IP': '203.0.113.7',
    'X-Tq-Filename': 'tq-2026-10-04.csv'
  });
  assert.equal(first.status, 202, '上传应入队');
  const queued = await first.json();
  assert.equal(queued.status, 'pending');
  assert.equal(queued.recordCount, 93);
  // 报告时间取自 CSV 修改时间（wrapper 传的头），不是上传时刻 —— 差 20 分钟会让趋势线错位
  assert.equal(queued.testedAt, '2026-10-04T01:02:27+08:00');

  // 元信息要落进队列：归属记忆靠 hostname + 出口 IP 配对
  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json();
  assert.equal(state.pending.length, 1);
  const entry = state.pending[0];
  assert.equal(entry.hostname, 'probe-01.example');
  assert.equal(entry.sourceIp, '203.0.113.7');
  assert.equal(entry.identity, 'probe-01.example · 203.0.113.7');
  assert.equal(entry.filename, 'tq-2026-10-04.csv');
  assert.equal(entry.timeSource, 'report');
  assert.equal(entry.keyName, '测试-upload');

  // 同一份数据重传不重复入队
  const again = await upload(base, uploadKey, csv);
  assert.equal(again.status, 200);
  const duplicate = await again.json();
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.kind, 'pending');
  assert.equal((await (await fetch(`${base}/api/state`, { headers: cookie })).json()).pending.length, 1, '重复上传不应增加队列长度');

  // 绑到节点后再次上传同一份：应识别为已归档，并说清楚在哪个节点
  await fetch(`${base}/api/pending/${entry.id}/bind`, {
    method: 'POST',
    headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: state.nodes[0].id })
  });
  const archived = await upload(base, uploadKey, csv);
  assert.equal(archived.status, 200);
  const seen = await archived.json();
  assert.equal(seen.kind, 'report');
  assert.match(seen.message, /已归档到「.+」/);

  // 指纹只认内容，与来源机器无关：换一台机器传同一份数据同样判重复。
  // 这是有意的 —— 同一份测试结果不该因为跑在几台机器上就归档多次。
  const otherMachine = await upload(base, uploadKey, csv, { 'X-Tq-Hostname': 'probe-02.example' });
  assert.equal(otherMachine.status, 200);
  assert.equal((await otherMachine.json()).kind, 'report');
});

test('上传直传：权限、内容类型与表头门槛', { timeout: 30000 }, async t => {
  const { base } = await serve(t);
  const cookie = await login(base);
  const uploadKey = await createKey(base, cookie, 'upload');
  const readKey = await createKey(base, cookie, 'read');

  // 无 key / 错 key / 只有只读权限：都不能上传
  assert.equal((await fetch(`${base}/api/upload-csv`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv })).status, 401);
  assert.equal((await upload(base, 'wrong-secret', csv)).status, 401);
  const readonly = await upload(base, readKey, csv);
  assert.equal(readonly.status, 401, '只读 key 不能上传');
  assert.match((await readonly.json()).error, /只读/);

  // content-type 不对要挡住：脚本传错类型时早失败比进队列再报错好
  const badType = await fetch(`${base}/api/upload-csv`, {
    method: 'POST',
    headers: { 'X-Tq-Key': uploadKey, 'Content-Type': 'application/json' },
    body: csv
  });
  assert.equal(badType.status, 400);
  assert.match((await badType.json()).error, /text\/csv/);

  // 不是 TQ 的 CSV
  const notCsv = await upload(base, uploadKey, 'name,age\nfoo,1\n');
  assert.equal(notCsv.status, 400);
  assert.match((await notCsv.json()).error, /表头不匹配/);

  // 缺必需列：门槛与解析器同源（都按列名判定），所以缺列在入口就被挡，不必入队
  const header = csv.split('\n')[0].replace(/^﻿/, '');
  const missing = await upload(base, uploadKey, header.replace('平均延迟ms,', '') + '\n三网,IPv4,河北,电信,OK,0.00,174.116\n');
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /表头不匹配/);
  assert.equal((await (await fetch(`${base}/api/state`, { headers: cookie })).json()).pending.length, 0, '缺列的 CSV 不该进队列占位');

  // 列顺序打乱不该被挡：解析按列名匹配，门槛也必须按列名，否则 core 调整列序就会把好数据挡在门外。
  // 表头和数据行要一起重排 —— 只挪表头得到的是一份真正错列的 CSV，那种情况门槛放行、解析器拒绝才是对的。
  const row = csv.split('\n')[1].split(',');
  const order = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];   // IP版本 挪到最前，其余原位
  const names = header.split(',');
  const reorderedCsv = order.map(i => names[i]).join(',') + '\n' + order.map(i => row[i]).join(',') + '\n';
  const reordered = await upload(base, uploadKey, reorderedCsv);
  assert.equal(reordered.status, 202);
  const entry = (await (await fetch(`${base}/api/state`, { headers: cookie })).json()).pending[0];
  assert.equal(entry.recordCount, 1, '列顺序打乱后仍应解析出记录');
  assert.equal(entry.error, '');
});

test('上传直传：缺失或离谱的报告时间退回上传时间，并标注来源', { timeout: 30000 }, async t => {
  const { base } = await serve(t);
  const cookie = await login(base);
  const uploadKey = await createKey(base, cookie, 'upload');

  // 不带头：退回上传时刻，且必须标成 upload —— 否则用户会把估算时间当成实测时间看
  const noEpoch = await upload(base, uploadKey, csv);
  assert.equal(noEpoch.status, 202);
  let entry = (await (await fetch(`${base}/api/state`, { headers: cookie })).json()).pending[0];
  assert.equal(entry.timeSource, 'upload');
  assert.match(entry.testedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/, '时间也要是北京时间带偏移');

  // 一年多以前的时间：不合理，脚本重装或时钟跑偏都可能，退回上传时间
  const far = await upload(base, uploadKey, variant(1), { 'X-Report-Epoch': String(Date.now() / 1000 - 400 * 86400) });
  assert.equal(far.status, 202);
  entry = (await (await fetch(`${base}/api/state`, { headers: cookie })).json()).pending.at(-1);
  assert.equal(entry.timeSource, 'upload', '超出合理范围的时间应退回上传时间');

  // 未来时间：同样不可信（时钟超前）
  const future = await upload(base, uploadKey, variant(2), { 'X-Report-Epoch': String(Date.now() / 1000 + 86400) });
  assert.equal(future.status, 202);
  entry = (await (await fetch(`${base}/api/state`, { headers: cookie })).json()).pending.at(-1);
  assert.equal(entry.timeSource, 'upload');
});

test('上传直传：非法请求头被清洗，不入库', { timeout: 30000 }, async t => {
  const { base } = await serve(t);
  const cookie = await login(base);
  const uploadKey = await createKey(base, cookie, 'upload');

  // 主机名带路径分隔符与超长内容：原样入库会污染界面显示，也会让归属记忆错配
  await upload(base, uploadKey, variant(1), { 'X-Tq-Hostname': '../../etc/passwd' });
  // 文件名带斜杠与路径片段
  await upload(base, uploadKey, variant(2), { 'X-Tq-Filename': 'a/b/../c.csv' });
  // 出口 IP 不合法
  await upload(base, uploadKey, variant(3), { 'X-Real-IP': "'; DROP TABLE--" });

  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json();
  assert.equal(state.pending.length, 3, '三份内容各不相同，都该入队');
  for (const item of state.pending) {
    assert.doesNotMatch(item.hostname, /[/\\]|\.\./, `主机名不该带路径片段：${item.hostname}`);
    assert.doesNotMatch(item.filename, /[/\\]/, `文件名不该带路径片段：${item.filename}`);
    assert.doesNotMatch(item.sourceIp, /[^0-9a-fA-F:.]/, `出口 IP 应被清洗或丢弃：${item.sourceIp}`);
  }
  assert.equal(state.pending.filter(item => item.hostname).length, 0, '非法主机名应整个丢弃，而不是截断后入库');
});
