import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '..', 'data');

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const keysFile = join(dataDir, 'keys.json');

function loadKeys() {
  if (!existsSync(keysFile)) return [];
  try {
    return JSON.parse(readFileSync(keysFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  writeFileSync(keysFile, JSON.stringify(keys, null, 2));
}

// Key 的权限范围：
//   upload —— 只能往「待绑定」队列写，脚本机用这个。读不到任何报告数据。
//   read   —— 只能读报告索引与明细，给自动化分析用。改不了任何东西。
// 分开是因为脚本机不止一台：一旦上传 key 也能读，任何一台被攻破就等于把整个数据层拖走。
// 旧 key 没有 scope 字段，一律按 upload 处理 —— 升级不该让存量 key 凭空多出读权限。
export function scopeOf(key) {
  return key?.scope === 'read' ? 'read' : 'upload';
}

// 权限判定集中在这里，server 只负责取 secret —— 这段是安全边界，必须能单测。
// 精确匹配 scope，不做包含关系：以后新增中间权限时不会被"高权限兼容低权限"悄悄放宽。
export function authorizeKey(record, required) {
  if (!record) return { error: 'API Key 错误' };
  if (!record.enabled) return { error: '该 API Key 已被禁用' };
  const scope = scopeOf(record);
  if (scope !== required) return { error: `该 Key 是「${scope === 'read' ? '只读' : '上传'}」权限，无权访问此接口` };
  return { record };
}

export function listKeys() {
  return loadKeys();
}

export function getKey(secret) {
  const keys = loadKeys();
  return keys.find(k => k.secret === secret) || null;
}

export function createKey(name, scope = 'upload', enabled = true) {
  const keys = loadKeys();
  const secret = randomBytes(32).toString('hex'); // 64位随机hex
  const key = {
    id: randomUUID(),
    name: name || '未命名',
    scope: scopeOf({ scope }),
    secret,
    enabled,
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  keys.push(key);
  saveKeys(keys);
  return key;
}

export function updateKey(id, updates) {
  const keys = loadKeys();
  const index = keys.findIndex(k => k.id === id);
  if (index === -1) return null;
  keys[index] = { ...keys[index], ...updates, id }; // id 不允许改
  saveKeys(keys);
  return keys[index];
}

export function deleteKey(id) {
  const keys = loadKeys();
  const filtered = keys.filter(k => k.id !== id);
  saveKeys(filtered);
  return filtered.length < keys.length;
}

export function touchKey(id) {
  updateKey(id, { lastUsedAt: new Date().toISOString() });
}
