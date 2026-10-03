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

export function listKeys() {
  return loadKeys();
}

export function getKey(secret) {
  const keys = loadKeys();
  return keys.find(k => k.secret === secret) || null;
}

export function createKey(name, enabled = true) {
  const keys = loadKeys();
  const secret = randomBytes(32).toString('hex'); // 64位随机hex
  const key = {
    id: randomUUID(),
    name: name || '未命名',
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
