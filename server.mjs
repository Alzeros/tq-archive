import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReport, compareReports, metricNames } from './lib/parser.mjs';
import { loadProbeNodes } from './lib/probe.mjs';
import { createStore } from './lib/store.mjs';
import { summarize } from './lib/insight.mjs';
import { createAuth } from './lib/auth.mjs';
import { listKeys, getKey, createKey, updateKey, deleteKey, touchKey } from './lib/keys.mjs';
import { parseTqCsv, csvFingerprint } from './lib/csv-parser.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const store = createStore(process.env.DATA_DIR || join(root, 'data'));
const previews = new Map();
const port = Number(process.env.PORT || 4173);
// 反代后浏览器发送的 Host 不含端口（标准 443/80），而本机直连带端口。
// 两种写法都接受，避免健康检查与反代互相拒绝。
function hostSet(value, fallback) {
  const result = new Set();
  for (const item of (value ?? fallback).split(',').map(entry => entry.trim()).filter(Boolean)) {
    result.add(item);
    result.add(item.replace(/:\d+$/, ''));
  }
  return result;
}
const allowedOrigins = hostSet(process.env.ALLOWED_ORIGINS, `http://127.0.0.1:${port},http://localhost:${port}`);
const allowedHosts = hostSet(process.env.ALLOWED_HOSTS, `127.0.0.1:${port},localhost:${port}`);
// 未配置 AUTH_USER / AUTH_PASSWORD 时不启用登录，便于本机直接使用。
// 反代到 https 域名时务必配置，并设置 AUTH_SECURE=1 让 Cookie 带 Secure。
const auth = createAuth({
  username: process.env.AUTH_USER,
  password: process.env.AUTH_PASSWORD,
  secure: process.env.AUTH_SECURE === '1' || process.env.AUTH_SECURE === 'true'
});
let importing = false;
let syncing = false;
// 登录失败次数过多时短暂锁定，避免在线爆破。
const failures = new Map();
const maxAttempts = 10;
const lockMs = 5 * 60 * 1000;
function summary(report) {
  const { records, rawRows, ...metadata } = report;
  const sectionCounts = Object.fromEntries(report.sections.map(section => [section.id, records.filter(record => record.section === section.id).length]));
  return { ...metadata, recordCount: records.length, sectionCounts };
}
function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
// 按字节收齐再整体解码：逐块拼字符串会把跨块的多字节汉字切成乱码（CSV 越大越容易遇到）
async function readText(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function body(request) {
  return JSON.parse((await readText(request, 10000)) || '{}');
}
// ─── 脚本直传 ───────────────────────────────────────────────────────────
function apiKey(request) {
  const secret = String(request.headers['x-tq-key'] || '').trim();
  if (!secret) return { error: 'API Key 缺失' };
  const record = getKey(secret);
  if (!record) return { error: 'API Key 错误' };
  if (!record.enabled) return { error: '该 API Key 已被禁用' };
  return { record };
}
// 脚本机经 Cloudflare / nginx 上来，socket 地址是代理的。取转发头里的来源，只用于展示与归属记忆，不参与鉴权
function clientIp(request) {
  const forwarded = request.headers['cf-connecting-ip'] || String(request.headers['x-forwarded-for'] || '').split(',')[0] || request.headers['x-real-ip'] || request.socket.remoteAddress || '';
  const ip = String(forwarded).trim().replace(/^::ffff:/, '');
  return /^[\da-fA-F:.]{2,45}$/.test(ip) ? ip : '';
}
const headerText = (value, pattern, max) => {
  const text = String(value || '').trim().slice(0, max);
  return pattern.test(text) ? text : '';
};
// 与网页报告的"报告时间"同口径：北京时间带偏移，排序与展示都不受服务器时区影响
const beijingIso = ms => `${new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19)}+08:00`;
// wrapper 传 CSV 的修改时间：core 写完 CSV 的同一秒生成报告时间，误差约 1 秒且不受时区影响。
// 缺失或离谱（超过一年前 / 晚于现在）时退回上传时间，并标注来源
function reportTime(epochHeader, fallbackMs) {
  const ms = Number(epochHeader) * 1000;
  if (Number.isFinite(ms) && ms > fallbackMs - 365 * 86400e3 && ms < fallbackMs + 10 * 60e3) return { testedAt: beijingIso(ms), timeSource: 'report' };
  return { testedAt: beijingIso(fallbackMs), timeSource: 'upload' };
}
// 解析失败也照样排队：原始 CSV 比一条报错更有价值，界面上会说明原因
function pendingEntry(id, csv, meta) {
  const identity = [meta.hostname, meta.sourceIp].filter(Boolean).join(' · ');
  const base = { ...meta, id, identity, bytes: Buffer.byteLength(csv), fingerprint: csvFingerprint(csv) };
  try {
    const parsed = parseTqCsv(csv, { sourceUrl: `csv:${id}`, testedAt: meta.testedAt, identity });
    const { cards } = summarize(parsed);
    const pick = cardId => {
      const card = cards.find(item => item.id === cardId);
      return card && typeof card.value === 'number' ? { value: card.value, unit: card.unit, note: card.note } : null;
    };
    return { ...base, recordCount: parsed.records.length, sections: parsed.sections, sectionCounts: summary(parsed).sectionCounts, warnings: parsed.warnings, error: '', preview: { latency: pick('latency'), loss: pick('loss') } };
  } catch (error) {
    return { ...base, recordCount: 0, sections: [], sectionCounts: {}, warnings: [], error: error.message, preview: {} };
  }
}
async function downloadReport(input) {
  const url = new URL(input);
  if (url.origin !== 'https://tcpquality.ibsgss.uk' || url.username || url.password || !/^\/r\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error('请填写 tcpquality.ibsgss.uk/r/… 格式的报告链接');
  url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`报告下载失败 (${response.status})`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('报告超过 4MB 限制'); chunks.push(chunk); }
  return { html: Buffer.concat(chunks).toString('utf8'), url: url.href };
}
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  // 登录页与静态资源必须可匿名访问，否则未登录时前端根本加载不出来
  const publicPaths = new Set(['/login', '/login.js', '/theme.js', '/style.css', '/favicon.svg']);
  try {
    if (!allowedHosts.has(request.headers.host)) return send(response, 403, { error: '仅允许本机访问' });
    if (request.method === 'POST' && request.headers.origin && !allowedOrigins.has(request.headers.origin)) return send(response, 403, { error: '不允许跨站请求' });
    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    if (request.method === 'POST' && url.pathname === '/api/login') {
      const ip = request.socket.remoteAddress || 'unknown';
      const record = failures.get(ip);
      if (record?.lockedUntil > Date.now()) return send(response, 429, { error: '尝试过多，请稍后再试' });
      const { username, password } = await body(request);
      if (!auth.verify(username, password)) {
        const attempts = (record?.attempts || 0) + 1;
        failures.set(ip, { attempts, lockedUntil: attempts >= maxAttempts ? Date.now() + lockMs : 0 });
        return send(response, 401, { error: '账号或密码不正确' });
      }
      failures.delete(ip);
      auth.login(request, response);
      return send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      auth.logout(request, response);
      return send(response, 200, { ok: true });
    }

    const session = auth.currentSession(request);
    // upload-csv 是脚本机用 API Key 鉴权的接口（无 cookie），不走登录拦截；
    // 它的 key 校验在处理函数内部完成。
    const keyAuthedPaths = new Set(['/api/upload-csv']);
    if (!session.ok && !keyAuthedPaths.has(url.pathname)) {
      // 接口返回 401 由前端跳转；页面请求直接送到登录页
      if (url.pathname.startsWith('/api/')) return send(response, 401, { error: '请先登录' });
      if (!publicPaths.has(url.pathname)) {
        response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        return response.end();
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/session') return send(response, 200, { authenticated: session.ok, enabled: auth.enabled });
    if (request.method === 'GET' && url.pathname === '/api/state') {
      // 归属建议每次现算：先绑定的一份会让同一台机器后续的报告自动带上推荐
      const pending = store.database.pending.map(item => ({ ...item, suggestion: store.rememberedNode(item.identity) }));
      return send(response, 200, { nodes: store.database.nodes, reports: store.database.reports, pending, syncedAt: store.database.syncedAt, metricNames, authEnabled: auth.enabled });
    }
    if (request.method === 'POST' && url.pathname === '/api/sync') {
      if (syncing) throw new Error('正在同步，请稍候');
      syncing = true;
      try { store.sync(await loadProbeNodes()); return send(response, 200, { count: store.database.nodes.filter(node => !node.archived).length }); } finally { syncing = false; }
    }
    if (request.method === 'POST' && url.pathname === '/api/preview') {
      if (importing) throw new Error('正在解析另一份报告，请稍候');
      importing = true;
      try {
        const input = await body(request);
        const fetched = await downloadReport(input.url);
        const parsed = parseReport(fetched.html, fetched.url);
        for (const [id, preview] of previews) if (Date.now() - preview.created > 30 * 60 * 1000) previews.delete(id);
        if (previews.size >= 20) previews.delete(previews.keys().next().value);
        const token = randomUUID();
        previews.set(token, { parsed, html: fetched.html, created: Date.now() });
        return send(response, 200, { token, report: summary(parsed), suggestion: store.suggestNode(parsed.identity) });
      } finally { importing = false; }
    }
    if (request.method === 'POST' && url.pathname === '/api/import') {
      const { token, nodeId } = await body(request);
      const preview = previews.get(token);
      if (!preview || Date.now() - preview.created > 30 * 60 * 1000) throw new Error('预览已过期，请重新解析');
      const report = store.insert(nodeId, preview.parsed, preview.html);
      previews.delete(token);
      return send(response, 201, summary(report));
    }
    if (url.pathname === '/api/upload-csv') {
      const { record, error } = apiKey(request);
      if (error) return send(response, 401, { error });
      // GET 只做预检：wrapper 开跑前确认 hub 可达、key 有效，免得测完二十分钟才发现传不上去
      if (request.method === 'GET') return send(response, 200, { ok: true, key: record.name });
      if (request.method !== 'POST') return send(response, 405, { error: 'Method Not Allowed' });
      if (!/text\/csv|text\/plain|application\/octet-stream/i.test(request.headers['content-type'] || '')) {
        return send(response, 400, { error: '请使用 text/csv 上传' });
      }
      const csv = await readText(request, 4 * 1024 * 1024);
      if (!/^\uFEFF?网络,IP版本,省份,运营商/.test(csv)) return send(response, 400, { error: 'CSV 表头不匹配，可能不是 TcpQuality 输出' });
      // 查重与入队之间没有 await，并发的同一份上传不会都挤进队列
      const duplicate = store.duplicateOf(csvFingerprint(csv));
      if (duplicate) {
        const message = duplicate.kind === 'report' ? `这份数据已归档到「${duplicate.nodeName}」，未重复入队` : '这份数据已在待绑定队列中，未重复入队';
        return send(response, 200, { status: 'duplicate', message, ...duplicate });
      }
      const now = Date.now();
      const entry = pendingEntry(randomUUID(), csv, {
        receivedAt: new Date(now).toISOString(),
        ...reportTime(request.headers['x-report-epoch'], now),
        hostname: headerText(request.headers['x-tq-hostname'], /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 64),
        sourceIp: clientIp(request),
        keyName: record.name,
        filename: headerText(request.headers['x-tq-filename'], /^[A-Za-z0-9._-]+$/, 100)
      });
      store.addPending(entry, csv);
      touchKey(record.id);
      return send(response, 202, { status: 'pending', id: entry.id, testedAt: entry.testedAt, recordCount: entry.recordCount, sections: entry.sections.map(section => section.name), warnings: entry.warnings, error: entry.error });
    }
    // 待绑定队列（需登录）：绑定到节点后成为正式报告，或直接丢弃
    const pendingMatch = url.pathname.match(/^\/api\/pending\/([a-f\d-]{36})(\/(bind|raw))?$/);
    if (pendingMatch) {
      const id = pendingMatch[1];
      if (request.method === 'DELETE' && !pendingMatch[3]) {
        store.removePending(id);
        return send(response, 200, { id });
      }
      if (request.method === 'POST' && pendingMatch[3] === 'bind') {
        const { nodeId } = await body(request);
        const entry = store.database.pending.find(item => item.id === id);
        if (!entry) throw new Error('待绑定记录不存在，可能已被处理');
        const csv = store.pendingCsv(id);
        const parsed = parseTqCsv(csv, { sourceUrl: `csv:${id}`, testedAt: entry.testedAt, identity: entry.identity });
        const upload = { hostname: entry.hostname, sourceIp: entry.sourceIp, keyName: entry.keyName, receivedAt: entry.receivedAt, timeSource: entry.timeSource };
        return send(response, 201, summary(store.bindPending(id, nodeId, { ...parsed, upload }, csv)));
      }
      if (request.method === 'GET' && pendingMatch[3] === 'raw') {
        const csv = store.pendingCsv(id);
        if (csv === null) return send(response, 404, { error: '待绑定记录不存在' });
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tq-pending-${id}.csv"` });
        return response.end(csv);
      }
      return send(response, 404, { error: '接口不存在' });
    }

    // ─── API Key 管理接口（仅登录用户可用）─────────────────────────────
    if (url.pathname === '/api/keys') {
      const session = auth.currentSession(request);
      if (!session.ok) return send(response, 401, { error: '请先登录' });

      if (request.method === 'GET') {
        const keys = listKeys().map(k => ({
          id: k.id,
          name: k.name,
          enabled: k.enabled,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt
          // 注意：不返回 secret
        }));
        return send(response, 200, { keys });
      }

      if (request.method === 'POST') {
        const { name } = await body(request);
        if (!name || typeof name !== 'string' || !name.trim()) {
          return send(response, 400, { error: '请填写 Key 名称' });
        }
        const newKey = createKey(name.trim());
        // 只在创建时返回 secret，之后永远看不到
        return send(response, 201, {
          id: newKey.id,
          name: newKey.name,
          secret: newKey.secret, // 仅此一次显示
          enabled: newKey.enabled,
          createdAt: newKey.createdAt
        });
      }

      return send(response, 405, { error: 'Method Not Allowed' });
    }

    const keyMatch = url.pathname.match(/^\/api\/keys\/([a-f\d-]+)$/);
    if (keyMatch) {
      const session = auth.currentSession(request);
      if (!session.ok) return send(response, 401, { error: '请先登录' });
      const id = keyMatch[1];

      if (request.method === 'PATCH') {
        const updates = await body(request);
        // 只允许改 name 和 enabled
        const allowed = {};
        if (updates.name !== undefined) allowed.name = String(updates.name).trim();
        if (updates.enabled !== undefined) allowed.enabled = Boolean(updates.enabled);
        if (Object.keys(allowed).length === 0) {
          return send(response, 400, { error: '没有可更新的字段' });
        }
        const updated = updateKey(id, allowed);
        if (!updated) return send(response, 404, { error: 'Key 不存在' });
        return send(response, 200, {
          id: updated.id,
          name: updated.name,
          enabled: updated.enabled,
          createdAt: updated.createdAt,
          lastUsedAt: updated.lastUsedAt
        });
      }

      if (request.method === 'DELETE') {
        const deleted = deleteKey(id);
        if (!deleted) return send(response, 404, { error: 'Key 不存在' });
        return send(response, 200, { id, deleted: true });
      }

      return send(response, 405, { error: 'Method Not Allowed' });
    }
    if (request.method === 'GET' && url.pathname === '/api/compare') {
      const current = store.detail(url.searchParams.get('current'));
      const previous = store.detail(url.searchParams.get('base'));
      if (!current || !previous || current.nodeId !== previous.nodeId || current.id === previous.id) throw new Error('请选择同一节点的两份不同报告');
      const changes = compareReports(current, previous);
      return send(response, 200, { changes, currentTestedAt: current.testedAt, baseTestedAt: previous.testedAt, added: current.records.filter(record => !previous.records.some(old => old.key === record.key)).length, removed: previous.records.filter(record => !current.records.some(next => next.key === record.key)).length });
    }
    const reportMatch = url.pathname.match(/^\/api\/reports\/([a-f\d-]+)(\/(export|raw|move))?$/);
    if (reportMatch) {
      const id = reportMatch[1];
      if (request.method === 'DELETE' && !reportMatch[3]) {
        store.remove(id);
        return send(response, 200, { id });
      }
      if (request.method === 'POST' && reportMatch[3] === 'move') {
        const { nodeId } = await body(request);
        const moved = store.move(id, nodeId);
        return send(response, 200, summary(moved));
      }
      if (request.method !== 'GET') return send(response, 404, { error: '接口不存在' });
      const report = store.detail(id);
      if (!report) return send(response, 404, { error: '报告不存在' });
      if (reportMatch[3] === 'raw') {
        const raw = store.raw(id);
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="tq-${id}.${raw.ext}"` });
        return response.end(raw.content);
      }
      if (reportMatch[3] === 'export') response.setHeader('Content-Disposition', `attachment; filename="tq-${id}.json"`);
      // 洞察在服务端算：parser 依赖 node:crypto，浏览器端跑不了。
      // 必须带上节点，延迟基准按机房区域选档，否则会把"离得远"判成"线路差"。
      return send(response, 200, { ...report, insight: summarize(report, store.database.nodes.find(item => item.id === report.nodeId)) });
    }
    if (request.method !== 'GET') return send(response, 404, { error: '接口不存在' });
    const assets = {
      '/': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
      '/theme.js': ['theme.js', 'text/javascript'],
      '/picker.js': ['picker.js', 'text/javascript'],
      '/login': ['login.html', 'text/html'],
      '/login.js': ['login.js', 'text/javascript'],
      '/keys.html': ['keys.html', 'text/html'],
      '/keys.js': ['keys.js', 'text/javascript'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml']
    };
    const asset = assets[url.pathname];
    if (!asset) return send(response, 404, { error: '页面不存在' });
    let page = await readFile(join(root, 'public', asset[0]), 'utf8');
    // 主题选择存于 cookie：服务端注入 data-theme，页面首帧即为正确配色，无闪烁
    const theme = (request.headers.cookie || '').match(/(?:^|;\s*)tq_theme=(light|dark)/)?.[1];
    if (theme) page = page.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-theme="${theme}">`);
    // 登录页与主界面都不应被缓存，避免发版后拿到旧壳子
    response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    response.end(page);
  } catch (error) { send(response, 400, { error: error.message || '请求失败' }); }
});
// 旧版上传接口只把 CSV 落盘、没有登记；启动时补进待绑定队列，测试时间按文件写入时间估算
for (const orphan of store.orphanPoolFiles()) {
  store.addPending(pendingEntry(orphan.id, orphan.csv, { receivedAt: new Date(orphan.mtimeMs).toISOString(), testedAt: beijingIso(orphan.mtimeMs), timeSource: 'upload', hostname: '', sourceIp: '', keyName: '', filename: '' }), orphan.csv);
}
server.listen(port, '127.0.0.1', () => {
  if (auth.enabled) console.log(`TQ Archive running at http://127.0.0.1:${port} (登录已启用，用户名 ${process.env.AUTH_USER})`);
  else console.log(`TQ Archive running at http://127.0.0.1:${port} (未配置账号，本机免登录；公网部署请设置 AUTH_USER / AUTH_PASSWORD)`);
});
