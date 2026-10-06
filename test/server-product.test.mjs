import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStore } from '../lib/store.mjs';
import { parseReport } from '../lib/parser.mjs';

test('看板摘要、覆盖对比与登录边界端到端一致', { timeout: 20000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'tq-product-'));
  const html = await readFile(new URL('./fixtures/report.html', import.meta.url), 'utf8');
  const store = createStore(directory);
  store.sync([{ id: 'active', name: '测试节点', region: 'US' }, { id: 'disabled', name: '停用节点', region: 'US' }]);
  const old = parseReport(html, 'https://tcpquality.ibsgss.uk/r/product-old');
  old.testedAt = '2026-10-01T08:00:00+08:00';
  const previous = store.insert('active', old, html);
  const next = structuredClone(old);
  next.testedAt = '2026-10-02T08:00:00+08:00';
  next.fingerprint = 'product-next';
  next.sourceUrl = 'https://tcpquality.ibsgss.uk/r/product-next';
  next.records.push({ key: 'international-v6', section: 'intl', group: '国际节点 IPv6', target: '测试点', carrier: '', metrics: { downloadLatency: { value: 30, unit: 'ms', status: 'ok', raw: '30ms' } } });
  next.records[0].metrics.latency.status = 'unknown';
  const current = store.insert('active', next, html);
  store.setNodesEnabled(['disabled'], false);
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DATA_DIR: directory, AUTH_USER: 'test', AUTH_PASSWORD: 'product-test-password', AUTH_SECURE: '0', ALLOWED_HOSTS: `127.0.0.1:${port}`, ALLOWED_ORIGINS: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  context.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  // 就绪要同时满足两件事：子进程打出启动行，且 /api/session 真能连上。
  // 原来固定 80×50ms（4 秒）在整仓并发跑时不够：server.mjs 的模块图变大或机器忙一点，
  // 子进程的启动就会被拖过窗口，而单独跑只要约 1 秒 —— 于是变成"概率性红灯"。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes('TQ Archive running at')) {
      try { await fetch(`${base}/api/session`); ready = true; break; } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
  assert.equal((await fetch(`${base}/api/compare?base=${previous.id}&current=${current.id}`)).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test', password: 'product-test-password' }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const dashboard = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  assert.equal(dashboard.entries.length, 1);
  assert.equal(dashboard.entries[0].reportId, current.id);
  assert.equal(dashboard.entries[0].trend.length, 2);
  assert.ok(dashboard.entries[0].assessment.reasons.length);
  assert.ok(!JSON.stringify(dashboard).includes('rawRows'));
  assert.ok(!Object.hasOwn(dashboard.entries[0], 'records'));
  // 视图层：候选优先级评分随视角参数重算，并与旧 assessment 并存（口径迁移期间两者都在）
  assert.equal(dashboard.priorityAlgorithm.version, 'priority-p0-candidate-3');
  assert.equal(dashboard.priorityAlgorithm.calibration, 'candidate');
  assert.equal(dashboard.view.id, dashboard.entries[0].priority.view.id);
  assert.equal(dashboard.entries[0].priority.algorithmVersion, 'priority-p0-candidate-3');
  // 本夹具塞了一条未注册的国际子组记录，所以候选覆盖不足 —— 这正是要守住的：
  // 接口不能因此报错，且依据不足时不许给档位（不能拿缺失当低风险）。
  assert.ok(['ready', 'insufficient'].includes(dashboard.entries[0].priority.status));
  if (dashboard.entries[0].priority.status === 'insufficient') assert.equal(dashboard.entries[0].priority.level, null);
  else assert.equal(dashboard.entries[0].priority.levelSource, 'candidate-scenario');
  const mobile = await (await fetch(`${base}/api/dashboard?access=cm:4`, { headers })).json();
  assert.notEqual(mobile.view.id, dashboard.view.id);
  assert.equal(mobile.entries[0].priority.view.shares.access.cm, 4 / 7);
  // 非法视角参数直接 400，不静默回退到默认 —— 否则用户以为自己调对了
  assert.equal((await fetch(`${base}/api/dashboard?usage=speed:1`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/dashboard?access=cm:9`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/dashboard?bogus=1`, { headers })).status, 400);
  const detail = await (await fetch(`${base}/api/reports/${current.id}`, { headers })).json();
  assert.deepEqual(detail.insight.assessment, dashboard.entries[0].assessment);
  const compared = await (await fetch(`${base}/api/compare?base=${previous.id}&current=${current.id}`, { headers })).json();
  assert.equal(compared.coverage.records.added, 1);
  assert.equal(compared.coverage.metrics.statusIncomparable, 1);
  assert.ok(!compared.changes.some(change => change.key === next.records[0].key && change.metric === 'latency'));
  assert.equal(compared.added, compared.coverage.records.added);
  assert.ok(compared.conclusion.summary);
  const page = await (await fetch(base, { headers })).text();
  assert.match(page, /\/v\/[a-f0-9]{10}\/archive.css/);
  const javascript = await (await fetch(`${base}/app.js`, { headers })).text();
  assert.match(javascript, /\/v\/[a-f0-9]{10}\/archive.js/);
});
