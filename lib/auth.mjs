import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 固定迭代：单账号场景下 scrypt 的开销没有意义，
// 直接用 sha256(salt + 密码) 并以 timingSafeEqual 比较，避免明文与长度差异泄漏。
const salt = 'tq-archive-v1';

function digest(value) {
  return createHash('sha256').update(`${salt}:${value}`).digest();
}
function equal(a, b) {
  const left = digest(a);
  const right = digest(b);
  return timingSafeEqual(left, right);
}
// 会话 ID 用随机 UUID：它会被写进 data/sessions.json，
// 沿用 auth 模块自身的命名空间是为了让这个文件一眼看出属于谁。
const sessionId = () => randomUUID();

// 会话落盘：以前只存内存，服务器每次重启（= 每次部署 git pull）登录态就全没了，
// 频繁部署的节点上每周要输好几次密码。文件放在 DATA_DIR 里，与其余状态一起被备份带走。
function createSessionStore(file) {
  let sessions = [];
  let loaded = true;
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      sessions = Array.isArray(parsed?.sessions) ? parsed.sessions.filter(item => item && typeof item.token === 'string' && Number.isFinite(item.expires)) : [];
    } catch {
      // 文件坏了不该把人锁在门外：当作"没有有效会话"，重新登录即可，
      // 但不要立刻覆盖它 —— 人工还有机会从里面捞出点什么
      sessions = [];
      loaded = false;
    }
  }
  function persist() {
    if (!file || !loaded) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ sessions }, null, 2));
      renameSync(`${file}.tmp`, file);
    } catch {
      // 落盘失败不能影响登录本身：内存里的会话这次仍然有效，只是重启后要重新登录
    }
  }
  function clear() {
    sessions = [];
    if (file && loaded) { try { unlinkSync(file); } catch { /* 已经不在就算了 */ } }
  }
  return {
    get all() { return sessions; },
    prune(now) {
      const alive = sessions.filter(session => session.expires > now);
      // 只有真的清理掉了才写盘：prune 每个请求都会跑，不能不问就写
      if (alive.length !== sessions.length) { sessions = alive; persist(); }
    },
    get(token) {
      const session = sessions.find(item => item.token === token);
      return session || null;
    },
    touch(session, expires) {
      // 滑动续期只改内存：每个请求都写一次盘不值得，反正重启后按最后落盘的过期时间算
      session.expires = expires;
    },
    add(token, expires) {
      sessions.push({ token, expires });
      persist();
    },
    remove(token) {
      const before = sessions.length;
      sessions = sessions.filter(session => session.token !== token);
      if (sessions.length !== before) persist();
    },
    clear
  };
}

export function createAuth({ username, password, secure, sessionTtl = 7 * 24 * 3600 * 1000, sessionFile = '' }) {
  const enabled = Boolean(username && password);
  // 只配一半（改错变量名、EnvironmentFile 留空行）时绝不能当成"未启用"：
  // enable 为假会让所有接口裸奔，而运维侧只看到一行"本机免登录"的日志。
  // 记下来由 server 直接拒绝服务，配错总比敞开强。
  const misconfigured = !enabled && Boolean(username || password)
    ? `只设置了 ${username ? 'AUTH_USER' : 'AUTH_PASSWORD'}，另一个为空`
    : '';
  // 未配置账号时直接放行：本机自用场景不必登录，公网部署则必须配置。
  const store = createSessionStore(enabled ? sessionFile : '');
  const cookieName = 'tq_session';

  function prune() {
    store.prune(Date.now());
  }
  function parseCookies(header = '') {
    const result = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const value = part.slice(index + 1).trim();
      let decoded = value;
      // decodeURIComponent 遇到裸 % （tq_theme=50%、foo=%zz）会抛 URIError，
      // 一路冒到 server 顶层 catch，变成每个请求都 400 —— 浏览器会一直带着这个
      // cookie，等于把该浏览器永久锁在门外（连登录页都打不开）。解不开就按原文用。
      try { decoded = decodeURIComponent(value); } catch { /* 保留原值 */ }
      result[part.slice(0, index).trim()] = decoded;
    }
    return result;
  }
  function currentSession(request) {
    if (!enabled) return { ok: true };
    prune();
    const token = parseCookies(request.headers.cookie)[cookieName];
    const session = token ? store.get(token) : null;
    if (!session) return { ok: false };
    // 滑动续期：活跃用户不会在使用中被登出
    store.touch(session, Date.now() + sessionTtl);
    return { ok: true, token };
  }
  function cookie(value, maxAge) {
    // HttpOnly 挡住 document.cookie 读取；SameSite=Lax 挡跨站提交；Secure 仅在 https 下启用。
    // Max-Age 是浏览器端的截止时间，与服务器的滑动续期不是一回事：服务端会话会随
    // 每次请求续期，但 Cookie 本身到期就没了，所以它给的是"最长不登录天数"。
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  return {
    enabled,
    misconfigured,
    currentSession,
    login(request, response) {
      if (!enabled) return { ok: true };
      prune();
      const token = sessionId();
      store.add(token, Date.now() + sessionTtl);
      response.setHeader('Set-Cookie', cookie(token, Math.floor(sessionTtl / 1000)));
      return { ok: true };
    },
    logout(request, response) {
      const token = parseCookies(request.headers.cookie)[cookieName];
      if (token) store.remove(token);
      response.setHeader('Set-Cookie', cookie('', 0));
    },
    verify(user, input) {
      if (!enabled) return true;
      if (typeof user !== 'string' || typeof input !== 'string') return false;
      return equal(user, username) && equal(input, password);
    },
    // 测试与运维用：当前有效会话数（不含过期）
    sessionCount() {
      prune();
      return store.all.length;
    }
  };
}
