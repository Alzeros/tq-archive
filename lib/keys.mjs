import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '..', 'data');

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const keysFile = join(dataDir, 'keys.json');

// 文件读不出来时的原因，交给启动流程告警。绝不能静默当成"没有 Key"：
// 空列表会让所有脚本机突然 401，而之后任何一次增删又会拿空列表覆盖文件，
// 旧 secret 就再也找不回来了。
let loadError = '';

function loadKeys() {
  if (!existsSync(keysFile)) return [];
  let text;
  try {
    text = readFileSync(keysFile, 'utf8');
  } catch (error) {
    loadError = `API Key 文件无法读取：${error.message}`;
    return [];
  }
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('内容不是数组');
    loadError = '';
    return parsed;
  } catch (error) {
    loadError = `API Key 文件解析失败：${error.message}`;
    return [];
  }
}

// 原子写：与 lib/store.mjs 的 persist 同一套做法。就地写的话，
// 写到一半被杀/断电会留下截断的 JSON，而 touchKey 让这个文件在每次脚本上传时都被重写，
// 窗口并不小。
function saveKeys(keys) {
  // 读失败过就绝不再写：内存里那份是空列表，写下去等于把现存 Key 全部抹掉。
  // 调用方（server 启动）已经在读失败时拒绝启动了，这里是最后一道闸。
  if (loadError) throw new Error(`${loadError}（已拒绝写入，避免覆盖现有 Key）`);
  writeFileSync(`${keysFile}.tmp`, JSON.stringify(keys, null, 2));
  renameSync(`${keysFile}.tmp`, keysFile);
}

// 模块加载时就解析一次：loadError 必须是即时可知的，
// 否则启动流程的 keysLoadError() 在"还没人调用过 loadKeys"时永远读到空字符串，
// 检查等于没做（第一版就是这样，损坏的 keys.json 照样让服务起来了）。
loadKeys();

// 解析失败时先把原文件备份再返回：调用方（server 启动）会据此拒绝启动，
// 人工修好备份文件即可，不至于被后续写入覆盖掉。
export function keysLoadError() {
  return loadError;
}
export function backupBrokenKeys() {
  if (!loadError || !existsSync(keysFile)) return '';
  const target = `${keysFile}.corrupt`;
  try {
    writeFileSync(target, readFileSync(keysFile));
    return target;
  } catch {
    return '';
  }
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
