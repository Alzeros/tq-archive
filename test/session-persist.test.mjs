import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../lib/auth.mjs';

// 会话以前只存在内存里：服务器每次重启（= 每次部署 git pull）登录态全没了，
// 频繁部署的节点上每周要输好几次密码。这里验证落盘后能跨进程存活。

const request = (cookie = '') => ({ headers: { cookie } });
const collector = () => {
  const headers = {};
  return { headers, setHeader: (key, value) => { headers[key] = value; } };
};
const newDir = () => mkdtempSync(join(tmpdir(), 'tq-session-'));
const fileIn = dir => join(dir, 'sessions.json');

// 拿到登录后的 cookie 值
function login(auth) {
  const response = collector();
  auth.login(request(), response);
  return response.headers['Set-Cookie'].split(';')[0];
}

test('会话落盘后重启仍然有效：部署一次不用重登一次', () => {
  const dir = newDir();
  const file = fileIn(dir);
  const before = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  const cookie = login(before);
  assert.ok(existsSync(file), '登录后应立刻落盘');
  assert.equal(before.currentSession(request(cookie)).ok, true);

  // 模拟重启：新建实例，只有密码和会话文件
  const after = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  assert.equal(after.currentSession(request(cookie)).ok, true, '重启后旧 cookie 仍应有效');
  assert.equal(after.sessionCount(), 1);
});

test('登出会把会话从文件里删掉：重启也不能复活', () => {
  const dir = newDir();
  const file = fileIn(dir);
  const auth = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  const cookie = login(auth);
  auth.logout(request(cookie), collector());
  assert.equal(auth.currentSession(request(cookie)).ok, false);
  const restarted = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  assert.equal(restarted.currentSession(request(cookie)).ok, false, '登出是持久的');
});

test('过期会话在重启后依然过期', () => {
  const dir = newDir();
  const file = fileIn(dir);
  // TTL 为负：签发即过期
  const auth = createAuth({ username: 'admin', password: 'pw', sessionFile: file, sessionTtl: -1000 });
  const cookie = login(auth);
  const restarted = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  assert.equal(restarted.currentSession(request(cookie)).ok, false);
});

test('损坏的会话文件不会把人锁在门外，也不被立刻覆盖', () => {
  const dir = newDir();
  const file = fileIn(dir);
  writeFileSync(file, '{"sessions": [{"token": "半写');
  const auth = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  // 解析失败 = 没有有效会话，但账号密码仍然可用，重新登录即可
  assert.equal(auth.currentSession(request('tq_session=whatever')).ok, false);
  assert.equal(auth.verify('admin', 'pw'), true);
  assert.equal(readFileSync(file, 'utf8'), '{"sessions": [{"token": "半写', '坏文件不该被静默清空，人工还有机会捞');
  // 重新登录后才会写盘
  const cookie = login(auth);
  assert.equal(auth.currentSession(request(cookie)).ok, true);
});

test('会话文件形状不对（不是数组）时按无会话处理', () => {
  const dir = newDir();
  const file = fileIn(dir);
  writeFileSync(file, JSON.stringify({ sessions: 'nope' }));
  const auth = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  assert.equal(auth.sessionCount(), 0);
  const cookie = login(auth);
  assert.equal(auth.currentSession(request(cookie)).ok, true);
});

test('未启用登录时不碰会话文件', () => {
  const dir = newDir();
  const file = fileIn(dir);
  const auth = createAuth({ username: '', password: '', sessionFile: file });
  assert.equal(auth.enabled, false);
  assert.equal(auth.login(request(), collector()).ok, true);
  assert.equal(existsSync(file), false, '免登录模式下没有会话可存');
});

test('只配一半认证时不签发会话，也不写文件', () => {
  const dir = newDir();
  const file = fileIn(dir);
  const auth = createAuth({ username: 'admin', password: '', sessionFile: file });
  assert.match(auth.misconfigured, /AUTH_USER/);
  assert.equal(auth.enabled, false, '配错时不能当成免登录放行');
  assert.equal(existsSync(file), false);
});

test('多个会话并存：换浏览器登录不影响已有会话', () => {
  const dir = newDir();
  const file = fileIn(dir);
  const auth = createAuth({ username: 'admin', password: 'pw', sessionFile: file });
  const first = login(auth);
  const second = login(auth);
  assert.notEqual(first, second, '每次登录是新会话');
  assert.equal(auth.sessionCount(), 2);
  auth.logout(request(first), collector());
  assert.equal(auth.currentSession(request(first)).ok, false);
  assert.equal(auth.currentSession(request(second)).ok, true, '登出一个不该影响另一个');
});

test('落盘失败不影响这次登录本身', () => {
  const dir = newDir();
  // 把会话文件指向一个不可能写入的位置（父路径是文件）
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const auth = createAuth({ username: 'admin', password: 'pw', sessionFile: join(blocker, 'nested', 'sessions.json') });
  const cookie = login(auth);
  assert.equal(auth.currentSession(request(cookie)).ok, true, '写盘失败也要能用，只是重启后需重新登录');
  rmSync(dir, { recursive: true, force: true });
});
