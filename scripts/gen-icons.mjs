// 从 favicon.svg 生成 PNG/ICO 图标，供不支持 SVG 图标的浏览器、苹果书签与抓取器使用。
// 需要本机装有 Chrome（headless 截图渲染 SVG 精确到像素）。生成的文件提交进仓库，服务器不需要构建。
// 用法：node scripts/gen-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const work = mkdtempSync(join(tmpdir(), 'tq-icons-'));

// Chrome 截图即按视口尺寸输出 PNG；--default-background-color=00000000 让空白处保持透明
function renderPng(size, out) {
  const html = `<!doctype html><meta charset="utf-8"><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`;
  const page = join(work, `page-${size}.html`);
  writeFileSync(page, html);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${out}`, `file://${page}`],
    { stdio: 'pipe' });
}

// ICO 容器：目录项直接内嵌 PNG 数据（Windows Vista+ 与所有现代浏览器都支持）
function buildIco(pngs, out) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  writeFileSync(out, Buffer.concat([head, ...entries, ...pngs.map(p => p.data)]));
}

try {
  const shipped = [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]];
  for (const [name, size] of shipped) renderPng(size, join(root, 'public', name));
  const icoEntries = [16, 32, 48].map(size => {
    const file = join(work, `icon-${size}.png`);
    renderPng(size, file);
    return { size, data: readFileSync(file) };
  });
  buildIco(icoEntries, join(root, 'public', 'favicon.ico'));
  for (const [name, size] of [...shipped.map(([n, s]) => [n, s]), ['favicon.ico', '16+32+48']]) console.log(`已生成 public/${name} (${size})`);
} finally { rmSync(work, { recursive: true, force: true }); }
