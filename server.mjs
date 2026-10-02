import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReport, compareReports, metricNames } from './lib/parser.mjs';
import { loadProbeNodes } from './lib/probe.mjs';
import { createStore } from './lib/store.mjs';
import { createAuth } from './lib/auth.mjs';

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
async function body(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 10000) throw new Error('请求过大'); }
  return JSON.parse(text || '{}');
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
  const publicPaths = new Set(['/login', '/login.js', '/theme.js', '/style.css']);
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
    if (!session.ok) {
      // 接口返回 401 由前端跳转；页面请求直接送到登录页
      if (url.pathname.startsWith('/api/')) return send(response, 401, { error: '请先登录' });
      if (!publicPaths.has(url.pathname)) {
        response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        return response.end();
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/session') return send(response, 200, { authenticated: session.ok, enabled: auth.enabled });
    if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, { nodes: store.database.nodes, reports: store.database.reports, syncedAt: store.database.syncedAt, metricNames, authEnabled: auth.enabled });
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
      if (reportMatch[3]) response.setHeader('Content-Disposition', `attachment; filename="tq-${id}.${reportMatch[3] === 'raw' ? 'html' : 'json'}"`);
      if (reportMatch[3] === 'raw') { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return response.end(store.raw(id)); }
      return send(response, 200, report);
    }
    if (request.method !== 'GET') return send(response, 404, { error: '接口不存在' });
    const assets = {
      '/': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
      '/theme.js': ['theme.js', 'text/javascript'],
      '/picker.js': ['picker.js', 'text/javascript'],
      '/login': ['login.html', 'text/html'],
      '/login.js': ['login.js', 'text/javascript']
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
server.listen(port, '127.0.0.1', () => {
  if (auth.enabled) console.log(`TQ Archive running at http://127.0.0.1:${port} (登录已启用，用户名 ${process.env.AUTH_USER})`);
  else console.log(`TQ Archive running at http://127.0.0.1:${port} (未配置账号，本机免登录；公网部署请设置 AUTH_USER / AUTH_PASSWORD)`);
});
