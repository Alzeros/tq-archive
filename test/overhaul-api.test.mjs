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

test('改版增量接口契约：dashboard/compare/stats/report-detail 与 /charts.js CSP/版本注入', { timeout: 20000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'tq-overhaul-'));
  const html = await readFile(new URL('./fixtures/report.html', import.meta.url), 'utf8');
  const store = createStore(directory);
  store.sync([{ id: 'hk', name: '香港-测试', region: 'HK' }]);

  const old = parseReport(html, 'https://tcpquality.ibsgss.uk/r/overhaul-old');
  old.testedAt = '2026-11-17T09:30:00+08:00';
  old.identity = 'AS100 Old Host    IP: 156.239.13.146';
  const prev = store.insert('hk', old, html);

  const next = structuredClone(old);
  next.testedAt = '2026-11-18T21:30:00+08:00';
  next.fingerprint = 'overhaul-next';
  next.sourceUrl = 'https://tcpquality.ibsgss.uk/r/overhaul-next';
  next.identity = 'AS100 New Host    IP: 162.211.182.175';
  for (const r of next.records) {
    if (r.section === 'ipv4' && r.carrier === '联通' && typeof r.metrics.latency?.value === 'number') {
      r.metrics.latency.value = Math.max(10, r.metrics.latency.value - 60);
    }
  }
  const cur = store.insert('hk', next, html);

  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: directory,
      AUTH_USER: 'admin',
      AUTH_PASSWORD: 'overhaul-secret-password',
      AUTH_SECURE: '0',
      ALLOWED_HOSTS: `127.0.0.1:${port}`,
      ALLOWED_ORIGINS: base
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  context.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  });

  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes('TQ Archive running at')) {
      try { await fetch(`${base}/api/session`); ready = true; break; } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);

  // 未登录不可访问 charts.js
  assert.equal((await fetch(`${base}/charts.js`, { redirect: 'manual' })).status, 302);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'overhaul-secret-password' })
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };

  // 1. /api/dashboard
  const dash = await (await fetch(`${base}/api/dashboard?access=ct:1,cu:1,cm:1,cernet:0.25`, { headers })).json();
  assert.equal(dash.entries[0].priority.view.weights.access.cernet, 0.25);
  assert.ok(dash.entries[0].snapshot);
  assert.equal(dash.entries[0].snapshot.intl.nodes, undefined, '看板快照应精简去掉 intl.nodes');
  assert.ok(dash.entries[0].diff);
  assert.equal(dash.entries[0].diff.ipChanged, true);
  assert.ok(Array.isArray(dash.recentChanges));
  assert.equal(dash.recentChanges.length, 2);
  assert.equal(dash.recentChanges[0].reportId, cur.id);
  assert.equal(dash.recentChanges[0].previousId, prev.id);
  assert.ok(!JSON.stringify(dash).includes('rawRows'));

  // 2. /api/compare
  const cmp = await (await fetch(`${base}/api/compare?base=${prev.id}&current=${cur.id}`, { headers })).json();
  assert.ok(cmp.analysis);
  assert.equal(cmp.analysis.context.ipChanged, true);
  assert.equal(cmp.analysis.context.timeOfDayShift.changed, true);
  assert.ok(Array.isArray(cmp.analysis.brief) && cmp.analysis.brief.length >= 1);
  assert.ok(Array.isArray(cmp.analysis.overview) && cmp.analysis.overview.length >= 3);
  assert.ok(Array.isArray(cmp.analysis.diffMatrices) && cmp.analysis.diffMatrices.length >= 1);

  // 3. /api/stats?group=report&split=carrier
  const stats = await (await fetch(`${base}/api/stats?group=report&node=hk&split=carrier`, { headers })).json();
  const curStat = stats.groups.find(g => g.key === cur.id);
  assert.ok(curStat);
  assert.equal(curStat.sourceIp, '162.211.182.175');
  assert.ok(curStat.retrans && typeof curStat.retrans.lines === 'number');
  assert.ok(curStat.intl && typeof curStat.intl.unreachable === 'number');
  assert.ok(curStat.diffFromPrev && curStat.diffFromPrev.ipChanged === true);
  assert.equal(curStat.diffFromPrev.baseId, prev.id);

  // 4. /api/reports/:id
  const detail = await (await fetch(`${base}/api/reports/${cur.id}`, { headers })).json();
  assert.ok(detail.snapshot && Array.isArray(detail.snapshot.intl.nodes));
  assert.ok(detail.previousDiff && detail.previousDiff.ipChanged === true);

  // 5. 静态资源版本化与 CSP
  const appJs = await (await fetch(`${base}/app.js`, { headers })).text();
  assert.match(appJs, /\/v\/[a-f0-9]{10}\/charts\.js/);
  const chartsRes = await fetch(`${base}/charts.js`, { headers });
  assert.equal(chartsRes.status, 200);
  assert.match(chartsRes.headers.get('content-security-policy') || '', /style-src 'self'/);
});
