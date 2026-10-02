import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReport, compareReports, metricNames } from './lib/parser.mjs';
import { loadProbeNodes } from './lib/probe.mjs';
import { createStore } from './lib/store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const store = createStore(process.env.DATA_DIR || join(root, 'data'));
const previews = new Map();
const port = Number(process.env.PORT || 4173);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port}`).split(',').map(value => value.trim()).filter(Boolean));
const allowedHosts = new Set((process.env.ALLOWED_HOSTS ?? `127.0.0.1:${port},localhost:${port}`).split(',').map(value => value.trim()).filter(Boolean));
let importing = false;
let syncing = false;
function summary(report) {
  const { records, rawRows, ...metadata } = report;
  const sectionCounts = Object.fromEntries(report.sections.map(section => [section.id, records.filter(record => record.section === section.id).length]));
  return { ...metadata, recordCount: records.length, sectionCounts };
}function send(response, status, data) {
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
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    if (!allowedHosts.has(request.headers.host)) return send(response, 403, { error: '仅允许本机访问' });
    if (request.method === 'POST' && request.headers.origin && !allowedOrigins.has(request.headers.origin)) return send(response, 403, { error: '不允许跨站请求' });
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, { nodes: store.database.nodes, reports: store.database.reports, syncedAt: store.database.syncedAt, metricNames });
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
        return send(response, 200, { token, report: summary(parsed) });
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
    const reportMatch = url.pathname.match(/^\/api\/reports\/([a-f\d-]+)(\/(export|raw))?$/);
    if (reportMatch) {
      const id = reportMatch[1];
      if (request.method === 'DELETE' && !reportMatch[3]) {
        store.remove(id);
        return send(response, 200, { id });
      }
      if (request.method !== 'GET') return send(response, 404, { error: '接口不存在' });
      const report = store.detail(id);
      if (!report) return send(response, 404, { error: '报告不存在' });
      if (reportMatch[3]) response.setHeader('Content-Disposition', `attachment; filename="tq-${id}.${reportMatch[3] === 'raw' ? 'html' : 'json'}"`);
      if (reportMatch[3] === 'raw') { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return response.end(store.raw(id)); }
      return send(response, 200, report);
    }
    if (request.method !== 'GET') return send(response, 404, { error: '接口不存在' });
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const asset = assets[url.pathname];
    if (!asset) return send(response, 404, { error: '页面不存在' });
    response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    response.end(await readFile(join(root, 'public', asset[0])));
  } catch (error) { send(response, 400, { error: error.message || '请求失败' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`TQ Archive running at http://127.0.0.1:${port}`));
