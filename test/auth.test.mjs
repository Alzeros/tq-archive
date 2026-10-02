import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../lib/auth.mjs';

const request = (cookie = '') => ({ headers: { cookie } });
const collector = () => {
  const headers = {};
  return { headers, setHeader: (key, value) => { headers[key] = value; } };
};

test('未配置账号时不启用登录，本机可直接使用', () => {
  const auth = createAuth({});
  assert.equal(auth.enabled, false);
  assert.equal(auth.currentSession(request()).ok, true);
  assert.equal(auth.verify('任意', '任意'), true);
});

test('账号密码正确时签发会话，错误时不签发', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret' });
  assert.equal(auth.enabled, true);
  assert.equal(auth.verify('admin', 's3cret'), true);
  assert.equal(auth.verify('admin', 'wrong'), false);
  assert.equal(auth.verify('someone', 's3cret'), false);
});

test('非字符串输入不通过校验，也不抛异常', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret' });
  for (const value of [undefined, null, 123, {}, []]) assert.equal(auth.verify(value, value), false);
});

test('会话 cookie 可被后续请求识别', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret' });
  const response = collector();
  auth.login(request(), response);
  const cookie = response.headers['Set-Cookie'];
  assert.match(cookie, /^tq_session=/);
  assert.match(cookie, /HttpOnly/, '必须带 HttpOnly 防止脚本读取');
  assert.match(cookie, /SameSite=Lax/, '必须带 SameSite 防止跨站提交');
  assert.doesNotMatch(cookie, /Secure/, '未启用 AUTH_SECURE 时不应带 Secure');
  const token = cookie.split(';')[0];
  assert.equal(auth.currentSession(request(token)).ok, true);
  assert.equal(auth.currentSession(request('tq_session=伪造')).ok, false);
});

test('https 场景下 Cookie 带 Secure', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret', secure: true });
  const response = collector();
  auth.login(request(), response);
  assert.match(response.headers['Set-Cookie'], /; Secure/);
});

test('登出后旧 cookie 立即失效', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret' });
  const response = collector();
  auth.login(request(), response);
  const token = response.headers['Set-Cookie'].split(';')[0];
  assert.equal(auth.currentSession(request(token)).ok, true);
  const logout = collector();
  auth.logout(request(token), logout);
  assert.match(logout.headers['Set-Cookie'], /Max-Age=0/, '应下发过期 cookie 清除浏览器端');
  assert.equal(auth.currentSession(request(token)).ok, false);
});

test('过期会话被拒绝', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret', sessionTtl: -1000 });
  const response = collector();
  auth.login(request(), response);
  const token = response.headers['Set-Cookie'].split(';')[0];
  assert.equal(auth.currentSession(request(token)).ok, false, 'TTL 为负应立即过期');
});

test('畸形 cookie 头不导致崩溃', () => {
  const auth = createAuth({ username: 'admin', password: 's3cret' });
  for (const cookie of ['', 'tq_session', '=abc', 'a=1; tq_session=x; b=2', ';;=;', 'tq_session=%E4%B8%AD']) {
    assert.equal(auth.currentSession(request(cookie)).ok, false);
  }
});
