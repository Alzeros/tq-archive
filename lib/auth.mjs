import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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

export function createAuth({ username, password, secure, sessionTtl = 7 * 24 * 3600 * 1000 }) {
  const enabled = Boolean(username && password);
  // 未配置账号时直接放行：本机自用场景不必登录，公网部署则必须配置。
  const sessions = new Map();
  const cookieName = 'tq_session';

  function prune() {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
  }
  function parseCookies(header = '') {
    const result = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return result;
  }
  function currentSession(request) {
    if (!enabled) return { ok: true };
    prune();
    const token = parseCookies(request.headers.cookie)[cookieName];
    const session = token ? sessions.get(token) : null;
    if (!session) return { ok: false };
    // 滑动续期：活跃用户不会在使用中被登出
    session.expires = Date.now() + sessionTtl;
    return { ok: true, token };
  }
  function cookie(value, maxAge) {
    // HttpOnly 挡住 document.cookie 读取；SameSite=Lax 挡跨站提交；Secure 仅在 https 下启用
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  return {
    enabled,
    currentSession,
    login(request, response) {
      if (!enabled) return { ok: true };
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { expires: Date.now() + sessionTtl });
      response.setHeader('Set-Cookie', cookie(token, Math.floor(sessionTtl / 1000)));
      return { ok: true };
    },
    logout(request, response) {
      const token = parseCookies(request.headers.cookie)[cookieName];
      if (token) sessions.delete(token);
      response.setHeader('Set-Cookie', cookie('', 0));
    },
    verify(user, input) {
      if (!enabled) return true;
      if (typeof user !== 'string' || typeof input !== 'string') return false;
      return equal(user, username) && equal(input, password);
    }
  };
}
