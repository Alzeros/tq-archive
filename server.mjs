import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseReport, compareReports, metricNames, PARSER_VERSION } from './lib/parser.mjs';
import { loadProbeNodes } from './lib/probe.mjs';
import { createStore } from './lib/store.mjs';
import { summarize } from './lib/insight.mjs';
import { aggregate, bandsOf, GROUPS, SECTIONS } from './lib/stats.mjs';
import { significance, isSignificantChange } from './lib/thresholds.mjs';
import { createAuth } from './lib/auth.mjs';
import { listKeys, getKey, createKey, updateKey, deleteKey, touchKey, scopeOf, authorizeKey, keysLoadError, backupBrokenKeys } from './lib/keys.mjs';
import { parseTqCsv, csvFingerprint, CSV_PARSER_VERSION } from './lib/csv-parser.mjs';

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
// 读明细，取不到就从留存的原始文件重建（HTML 与 CSV 各自的重解析规则）。
// 一份文件被截断/半写就会让 detail 返回 null，而聚合接口与详情页都依赖它 ——
// 不在这儿自愈的话，那份报告会永远打不开，只能手工删。
function loadDetail(id) {
  const detail = store.detail(id);
  if (detail) return { detail, error: '' };
  const broken = store.detailError(id);
  if (!broken || broken === 'missing-index') return { detail: null, error: '' };
  const index = store.database.reports.find(report => report.id === id);
  try {
    const parsed = index.sourceType === 'csv'
      ? parseTqCsv(store.raw(id).content, { sourceUrl: index.sourceUrl, testedAt: index.testedAt, identity: index.identity })
      : parseReport(store.raw(id).content, index.sourceUrl);
    const rebuilt = { ...parsed, id, nodeId: index.nodeId, rawExt: index.rawExt, upload: index.upload, importedAt: index.importedAt };
    store.refreshReports([rebuilt]);
    console.log(`报告 ${id} 的明细文件损坏，已从原始文件重建`);
    return { detail: rebuilt, error: '' };
  } catch (error) {
    console.warn(`报告 ${id} 明细损坏且重建失败：${error.message}`);
    return { detail: null, error };
  }
}
const detailOf = id => loadDetail(id).detail;
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
  // 批量启停节点会带上全部节点 id，上限给到 64KB
  return JSON.parse((await readText(request, 64 * 1024)) || '{}');
}
// ─── 脚本直传 ───────────────────────────────────────────────────────────
// 鉴权本体在 lib/keys.mjs 的 authorizeKey（可单测），这里只负责从请求头取 secret。
function apiKey(request, required = 'upload') {
  const secret = String(request.headers['x-tq-key'] || '').trim();
  if (!secret) return { error: 'API Key 缺失' };
  return authorizeKey(getKey(secret), required);
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
// 时间过滤参数归一化。报告的 testedAt 是 `2026-10-05T04:29:54+08:00` 这种北京时间串，
// 直接和纯日期做字符串比较有两个坑：
//   until=2026-10-05 会排掉 10-05 全天（因为 '2026-10-05T…' > '2026-10-05'），
//   带 Z 的调用方边界又和字典序对不上。统一补成当天的起止再比较。
function dateBound(raw, edge) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T${edge === 'end' ? '23:59:59' : '00:00:00'}+08:00`;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) return null;
  return text;
}
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
  const base = { ...meta, id, identity, bytes: Buffer.byteLength(csv), fingerprint: csvFingerprint(csv), csvParserVersion: CSV_PARSER_VERSION };
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
// ─── 静态资源版本号 ─────────────────────────────────────────────────────
// 反代 / CDN 会把 js、css 改成长缓存（线上 Cloudflare 改写为 max-age=14400 并在边缘缓存），
// 发版后页面是新的、脚本却还是旧的。HTML 本身不缓存，由它引用带内容版本号的地址即可绕过各层缓存。
// 版本号放在路径里（/v/<hash>/app.js）：部分 CDN 配置会忽略查询参数。
const versionedAssets = ['app.js', 'style.css', 'theme.js', 'picker.js', 'login.js', 'keys.js', 'nodes.js', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
const assetReference = new RegExp(`(["'])/(${versionedAssets.map(name => name.replace(/\./g, '\\.')).join('|')})\\1`, 'g');
const assetFiles = new Map();
async function assetFile(name) {
  const file = join(root, 'public', name);
  const { mtimeMs, size } = await stat(file);
  const hit = assetFiles.get(name);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  const content = await readFile(file, 'utf8');
  const deps = [...new Set([...content.matchAll(assetReference)].map(match => match[2]))].filter(dep => dep !== name);
  const info = { mtimeMs, size, hash: createHash('sha256').update(content).digest('hex'), deps };
  assetFiles.set(name, info);
  return info;
}
// 版本 = 自身内容 + 所引用资源的版本：只改 picker.js 时 app.js 的地址也会变，缓存里的旧 app.js 不会再引用旧 picker.js
async function assetVersion(name, trail = []) {
  const info = await assetFile(name);
  const deps = trail.includes(name) ? [] : await Promise.all(info.deps.map(dep => assetVersion(dep, [...trail, name])));
  return createHash('sha256').update(info.hash + deps.join('')).digest('hex').slice(0, 10);
}
async function withAssetVersions(text) {
  const names = [...new Set([...text.matchAll(assetReference)].map(match => match[2]))];
  const versions = Object.fromEntries(await Promise.all(names.map(async name => [name, await assetVersion(name)])));
  return text.replace(assetReference, (_, quote, name) => `${quote}/v/${versions[name]}/${name}${quote}`);
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  // 登录页与静态资源必须可匿名访问，否则未登录时前端根本加载不出来
  // 图标路径需匿名可达：多数抓取器（链接预览、书签同步、Safari）只请求 /favicon.ico 与 /apple-touch-icon.png，且不读页面
  const publicPaths = new Set(['/login', '/login.js', '/theme.js', '/style.css', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']);
  try {
    if (!allowedHosts.has(request.headers.host)) return send(response, 403, { error: '仅允许本机访问' });
    // 认证只配了一半时直接拒绝服务，而不是按"未启用登录"放行：
    // 静默 fail-open 会让公网部署在没有任何拦截的情况下对外开放。
    if (auth.misconfigured) return send(response, 503, { error: `认证配置不完整（${auth.misconfigured}），已停止服务以免裸奔；请补全后重启` });
    if (request.method === 'POST' && request.headers.origin && !allowedOrigins.has(request.headers.origin)) return send(response, 403, { error: '不允许跨站请求' });
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    // 带版本号的静态资源地址还原成原路径，后续的公开路径判断与文件查找不受影响
    url.pathname = url.pathname.replace(/^\/v\/[\da-f]{10}(?=\/)/, '');

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
    // 用 API Key 鉴权的接口（无 cookie），不走登录拦截；各自的 key 权限在处理函数内部校验。
    // 白名单式列举：新增鉴权接口必须显式写进来，默认仍走登录，避免误开放。
    // 只读通道只豁免 GET：匿名 DELETE /api/reports/:id 若也被豁免，会落空进登录路由照样删库。
    const keyAuthed = (path, method) => path === '/api/upload-csv' || (method === 'GET' && (path === '/api/stats' || path === '/api/reports' || /^\/api\/reports\/[a-f\d-]{36}$/.test(path)));
    if (!session.ok && !keyAuthed(url.pathname, request.method)) {
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
    if (request.method === 'PATCH' && url.pathname === '/api/nodes') {
      const { ids, enabled } = await body(request);
      if (!Array.isArray(ids) || !ids.length || typeof enabled !== 'boolean') throw new Error('参数不正确');
      return send(response, 200, { nodes: store.setNodesEnabled(ids.map(String), enabled) });
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
    // ─── 聚合查询（需要「只读」权限的 Key）─────────────────────────────
    // 过去回答"哪个区域/哪台机器最慢"只能把所有明细拉下来本地算：17 份就是 2MB，
    // 换来十几个数字。这里把同样的口径搬到服务端，一次请求只回几十行。
    // 汇总单位固定是「机器」：一台机器名下所有报告的记录倒在一起算，
    // 跨机器再汇总时每台等权，避免报告多的机器把区域数字带偏。
    if (request.method === 'GET' && url.pathname === '/api/stats') {
      // 与 /api/reports 同一套口径：登录用户走会话，无会话时才要求只读 key。
      // 之前这里无条件要 key，导致网页自己反而调不通这个接口。
      if (!session.ok) {
        const { error } = apiKey(request, 'read');
        if (error) return send(response, 401, { error });
      }
      const group = url.searchParams.get('group') || '';
      if (!GROUPS.includes(group)) return send(response, 400, { error: `group 只能是 ${GROUPS.join(' / ')}` });
      const section = url.searchParams.get('section') || 'ipv4';
      if (!SECTIONS.includes(section)) return send(response, 400, { error: `section 只能是 ${SECTIONS.join(' / ')}` });
      // 归一化后再比较：until 给纯日期时含当天整天，带时区的边界原样使用
      const since = dateBound(url.searchParams.get('since'), 'start');
      const until = dateBound(url.searchParams.get('until'), 'end');
      if (since === null) return send(response, 400, { error: 'since 需为 ISO 日期，如 2026-10-01' });
      if (until === null) return send(response, 400, { error: 'until 需为 ISO 日期，如 2026-10-05' });
      // region 过滤也要在这里做：aggregate 内部同样过滤（幂等），
      // 但 totals 统计的是 wanted 的规模，少这层过滤会与 groups 口径对不上。
      // 停用节点必须一起排除：界面只显示启用的节点，聚合却算上它们，
      // 就成了"关掉的机器还在给区域数字投票"。
      const nodeParam = url.searchParams.get('node') || '';
      const regionParam = url.searchParams.get('region') || '';
      const wanted = store.database.reports
        .filter(report => (since ? report.testedAt >= since : true))
        .filter(report => (until ? report.testedAt <= until : true))
        .filter(report => (nodeParam ? report.nodeId === nodeParam : true))
        .filter(report => store.database.nodes.find(item => item.id === report.nodeId)?.enabled !== false)
        .filter(report => (regionParam ? store.database.nodes.find(item => item.id === report.nodeId)?.region === regionParam : true));
      // 明细要逐份读盘：报告多了会变慢，这是明接口的固有代价，
      // 换来的是不必把 2MB 传给客户端再在本地重复算一遍。
      // 读不出来（源文件也没了）的记下来随响应返回，免得数字变少却毫无提示。
      const details = [];
      const unreadable = [];
      for (const report of wanted) {
        const { detail, error } = loadDetail(report.id);
        if (detail) details.push(detail);
        else unreadable.push({ id: report.id, nodeId: report.nodeId, reason: error ? '明细与原始文件均不可读' : '明细缺失' });
      }
      const groups = aggregate({
        nodes: store.database.nodes,
        reports: details,
        group,
        section,
        since,
        until,
        node: nodeParam,
        region: regionParam,
        carrier: url.searchParams.get('carrier') || ''
      });
      return send(response, 200, {
        group,
        section,
        filters: { since: since || null, until: until || null, node: nodeParam || null, region: regionParam || null, carrier: url.searchParams.get('carrier') || null },
        regionBands: bandsOf(),
        totals: { nodes: new Set(details.map(report => report.nodeId)).size, reports: details.length, skipped: unreadable.length },
        unreadable,
        groups
      });
    }

    // ─── 只读数据通道（需要「只读」权限的 Key）─────────────────────────
    // 给自动化分析用。刻意只给报告数据：不开放原始 HTML/CSV、Key 管理、节点开关、
    // 待绑定队列，也不接受任何写方法。上传 key 即使拿到也读不到这里。
    if (request.method === 'GET' && url.pathname === '/api/reports') {
      // 登录用户不受 key 体系限制（网页侧的全量权限通道）；无会话时才要求只读 key
      if (!session.ok) {
        const { error } = apiKey(request, 'read');
        if (error) return send(response, 401, { error });
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
      const node = url.searchParams.get('node') || '';
      // 与聚合接口同一套日期口径：给纯日期时从当天 00:00 起算
      const since = dateBound(url.searchParams.get('since'), 'start');
      if (since === null) return send(response, 400, { error: 'since 需为 ISO 日期，如 2026-10-01' });
      let matched = store.database.reports;
      if (node) matched = matched.filter(report => report.nodeId === node);
      if (since) matched = matched.filter(report => report.testedAt >= since);
      // 按测试时间正序取最近 limit 份：分析通常看最新的几份
      const page = [...matched].sort((left, right) => left.testedAt.localeCompare(right.testedAt)).slice(-limit);
      return send(response, 200, {
        // 节点只给分析必需的字段，不含 order / hidden 等界面内部状态
        nodes: store.database.nodes.map(item => ({ id: item.id, name: item.name, region: item.region, enabled: item.enabled, archived: item.archived })),
        reports: page.map(report => ({
          id: report.id, nodeId: report.nodeId, testedAt: report.testedAt, importedAt: report.importedAt,
          recordCount: report.recordCount, sectionCounts: report.sectionCounts, sourceType: report.sourceType || 'html',
          parserVersion: report.parserVersion, csvParserVersion: report.csvParserVersion, warningCount: report.warnings?.length || 0
        })),
        total: matched.length,
        syncedAt: store.database.syncedAt
      });
    }
    const readMatch = url.pathname.match(/^\/api\/reports\/([a-f\d-]{36})$/);
    // 只拦截"无会话的 GET"：登录用户走下方原路由拿全量详情（含 rawRows），
    // DELETE / move 等方法也必须落空到原路由，不能在这里被 key 校验误杀。
    if (readMatch && request.method === 'GET' && !session.ok) {
      const { error } = apiKey(request, 'read');
      if (error) return send(response, 401, { error });
      const report = detailOf(readMatch[1]);
      if (!report) return send(response, 404, { error: '报告不存在' });
      // 这个通道刻意只给报告数据。rawRows 是原始行文本（体积占大头、分析用不上）；
      // identity 与 upload 里是上传机器的主机名和出口 IP —— 与待绑定队列同级的信息，
      // 既然队列不开放，明细里也不能顺手带出去。
      const { rawRows, identity, upload, ...rest } = report;
      return send(response, 200, { ...rest, insight: summarize(report, store.database.nodes.find(item => item.id === report.nodeId)) });
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
        // 源文件没了就没法归档：明确说清楚并提示丢弃，而不是让 parseTqCsv 去撞一个 null
        if (csv === null) { store.markPendingBroken([id]); throw new Error('这份记录的 CSV 源文件已丢失，无法归档；请直接丢弃该条'); }
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
        // secret 一并返回：单用户自用、明文落盘，"只显示一次"没有对应的存储机制支撑，只会添麻烦。
        // 将来开放多用户时再改成哈希存储 + 创建时仅显示一次。
        const keys = listKeys().map(k => ({
          id: k.id,
          name: k.name,
          scope: scopeOf(k),
          secret: k.secret,
          enabled: k.enabled,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt
        }));
        return send(response, 200, { keys });
      }

      if (request.method === 'POST') {
        const { name, scope } = await body(request);
        if (!name || typeof name !== 'string' || !name.trim()) {
          return send(response, 400, { error: '请填写 Key 名称' });
        }
        // 缺省 upload：老脚本不带 scope 字段，行为不变
        const newKey = createKey(name.trim(), scope === 'read' ? 'read' : 'upload');
        return send(response, 201, {
          id: newKey.id,
          name: newKey.name,
          scope: newKey.scope,
          secret: newKey.secret,
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
      const current = detailOf(url.searchParams.get('current'));
      const previous = detailOf(url.searchParams.get('base'));
      if (!current || !previous || current.nodeId !== previous.nodeId || current.id === previous.id) throw new Error('请选择同一节点的两份不同报告');
      const changes = compareReports(current, previous);
      // 显著度在服务端标好：门槛表在 lib/thresholds.mjs，与档位判定同源。
      // 前端只用这个布尔值，不必自己复制一份带数字的规则。
      const marked = changes.map(change => ({
        ...change,
        significant: isSignificantChange(change.metric, change.delta, change.before, change.after)
      }));
      return send(response, 200, { changes: marked, significance, currentTestedAt: current.testedAt, baseTestedAt: previous.testedAt, added: current.records.filter(record => !previous.records.some(old => old.key === record.key)).length, removed: previous.records.filter(record => !current.records.some(next => next.key === record.key)).length });
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
      const report = detailOf(id);
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
      // 同时认无后缀形式：/login 就是无后缀的，/keys 却 404 显得不一致，
      // 手输地址、收藏夹、旧记录都可能是任一种
      '/keys': ['keys.html', 'text/html'],
      '/keys.js': ['keys.js', 'text/javascript'],
      '/nodes.html': ['nodes.html', 'text/html'],
      '/nodes': ['nodes.html', 'text/html'],
      '/nodes.js': ['nodes.js', 'text/javascript'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
      '/favicon.ico': ['favicon.ico', 'image/x-icon', true],
      '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', true],
      '/icon-192.png': ['icon-192.png', 'image/png', true],
      '/icon-512.png': ['icon-512.png', 'image/png', true]
    };
    const asset = assets[url.pathname];
    if (!asset) return send(response, 404, { error: '页面不存在' });
    // 图标等二进制资源按 buffer 发送，可长缓存：HTML 里引用的是带内容版本号的地址，内容变了地址就变
    if (asset[2]) {
      const data = await readFile(join(root, 'public', asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'public, max-age=86400' });
      return response.end(data);
    }
    let page = await readFile(join(root, 'public', asset[0]), 'utf8');
    if (asset[1] === 'text/html' || asset[1] === 'text/javascript') page = await withAssetVersions(page);
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
// 解析规则升级后，用留存的原始 CSV 重新解析已有直传报告：之前没解析的维度自动补齐，不必删掉重传
const pendingMeta = item => ({ receivedAt: item.receivedAt, testedAt: item.testedAt, timeSource: item.timeSource, hostname: item.hostname, sourceIp: item.sourceIp, keyName: item.keyName, filename: item.filename });
const staleReports = [];
for (const index of store.database.reports.filter(item => item.sourceType === 'csv' && (item.csvParserVersion || 0) < CSV_PARSER_VERSION)) {
  try {
    const old = store.detail(index.id);
    const parsed = parseTqCsv(store.raw(index.id).content, { sourceUrl: old.sourceUrl, testedAt: old.testedAt, identity: old.identity });
    staleReports.push({ ...parsed, id: old.id, nodeId: old.nodeId, rawExt: old.rawExt, upload: old.upload, importedAt: old.importedAt });
  } catch (error) { console.warn(`直传报告 ${index.id} 重新解析失败，保留原结果：${error.message}`); }
}
if (staleReports.length) { store.refreshReports(staleReports); console.log(`已按新规则重新解析 ${staleReports.length} 份直传报告`); }
// 链接导入的 HTML 报告走同一套机制：原始 HTML 一直留在 raw/ 里，
// 解析规则升级后（双栈两列教育网、国际节点 IPv6、-1 哨兵）自动补齐，不必删掉重导。
// 归属、导入时间、来源信息沿用旧记录，只替换解析结果。
const staleHtml = [];
for (const index of store.database.reports.filter(item => item.sourceType !== 'csv' && (item.parserVersion || 0) < PARSER_VERSION)) {
  try {
    const old = store.detail(index.id);
    const parsed = parseReport(store.raw(index.id).content, old.sourceUrl);
    staleHtml.push({ ...parsed, id: old.id, nodeId: old.nodeId, upload: old.upload, importedAt: old.importedAt });
  } catch (error) { console.warn(`报告 ${index.id} 重新解析失败，保留原结果：${error.message}`); }
}
if (staleHtml.length) { store.refreshReports(staleHtml); console.log(`已按新规则重新解析 ${staleHtml.length} 份链接报告`); }
// 待绑定队列的重解析：池文件可能已被清理或迁移不全，取不到就跳过并标记，
// 绝不能让启动流程抛异常 —— 这段在模块加载期跑，抛出去就是进程直接退出，
// 而条目还在库里，之后每次重启都会同样崩掉，只能手工编辑 database.json 才能恢复。
const stalePending = store.database.pending.filter(item => (item.csvParserVersion || 0) < CSV_PARSER_VERSION);
const brokenPending = [];
const refreshedPending = [];
for (const item of stalePending) {
  let csv = null;
  try { csv = store.pendingCsv(item.id); } catch (error) { console.warn(`待绑定 ${item.id} 读取失败：${error.message}`); }
  if (csv === null) { brokenPending.push(item.id); continue; }
  try { refreshedPending.push(pendingEntry(item.id, csv, pendingMeta(item))); }
  catch (error) { console.warn(`待绑定 ${item.id} 重新解析失败，保留原结果：${error.message}`); }
}
if (refreshedPending.length) store.refreshPending(refreshedPending);
// 除了"解析规则落后"的条目，还要体检整条队列：源文件没了就必须标出来。
// 只标版本落后的那些不够 —— 版本已是最新的条目在绑定时才会炸，
// 而那时的报错（ENOENT）对用户毫无意义。
const missingSources = [];
for (const item of store.database.pending) {
  if (item.broken || brokenPending.includes(item.id)) continue;
  try { if (store.pendingCsv(item.id) === null) missingSources.push(item.id); }
  catch (error) { console.warn(`待绑定 ${item.id} 读取失败：${error.message}`); }
}
const broken = [...new Set([...brokenPending, ...missingSources])];
if (broken.length) {
  store.markPendingBroken(broken);
  console.warn(`${broken.length} 条待绑定记录的 CSV 源文件已丢失（已标记，可在界面上丢弃）：${broken.join(', ')}`);
}
// API Key 文件读不出来（截断、写坏、权限）：备份原文件后拒绝启动。
// 静默按"没有 Key"跑下去的话，之后任何一次建 Key 都会用空列表覆盖它，
// 所有脚本机上的 secret 一次性作废且无法恢复。
if (keysLoadError()) {
  const backup = backupBrokenKeys();
  console.error(`${keysLoadError()}\n原文件已备份到 ${backup || '(备份失败，请立即手工复制)'}，请修好后重启。`);
  process.exit(1);
}
server.listen(port, '127.0.0.1', () => {
  if (auth.misconfigured) console.error(`TQ Archive running at http://127.0.0.1:${port} 但【认证配置不完整】：${auth.misconfigured}，所有请求将返回 503。请补全 AUTH_USER / AUTH_PASSWORD 后重启。`);
  else if (auth.enabled) console.log(`TQ Archive running at http://127.0.0.1:${port} (登录已启用，用户名 ${process.env.AUTH_USER})`);
  else console.log(`TQ Archive running at http://127.0.0.1:${port} (未配置账号，本机免登录；公网部署请设置 AUTH_USER / AUTH_PASSWORD)`);
});
