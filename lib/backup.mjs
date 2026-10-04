import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// 最小 tar 打包：只够把 data/ 目录原样装成一个可解开的归档。
// 不引第三方依赖（整个项目零依赖），也不做流式写入 —— 这份数据量在几十 MB 级，
// 一次性组进内存换来实现简单、不会写坏半个包。
//
// tar 的格式约束（踩过的点）：
//   · 头固定 512 字节，字段用 ASCII，路径超过 100 字节要拆 prefix（ustar 才支持）
//   · 每个头后面跟文件内容并补齐到 512 的整数倍
//   · 结尾是两个全零块
//   · 校验和字段先按 8 个空格算，写回时是 6 位八进制 + NUL + 空格
const BLOCK = 512;

function tarHeader(name, size, mtimeMs, type) {
  const header = Buffer.alloc(BLOCK, 0);
  const write = (text, offset, length) => header.write(text, offset, Math.min(length, Buffer.byteLength(text)), 'utf8');
  // 路径拆分：base 必须 ≤100 字节、prefix ≤155 字节（ustar 规范），超了要拆。
  // 注意按字节而不是字符回切 —— 中文路径三个字节一个字，按字符算会写超。
  // 兜底：写进头之前必须确认装得下。ustar 的路径字段没有"续行"概念，超了就只能截断，
  // 而截断出来的归档看起来是好的 —— 宁可失败也不能悄悄少东西。
  // 目录条目是个例外：它只是让空目录能被还原，跳过它并不丢内容（tar 解包文件时
  // 会把父目录逐级建出来），所以放不下就丢弃；文件放不下必须报错。
  const tooLong = () => {
    if (type === 'dir') return null;
    throw new Error(`路径过长，无法打包：${name}`);
  };
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const buffer = Buffer.from(name, 'utf8');
    let cut = -1;
    // base 要落在 100 字节以内。目录条目末尾是 '/'，它会占掉一个字节，
    // 所以切点最多到 length-99（切点之后还有 base 本身 + 可能的尾斜杠）。
    // 这里差一个字节曾经让超长文件名被 header.write 的 min() 悄悄截断 ——
    // 归档里是残缺的文件名，解出来才知道少了东西。
    for (let index = Math.max(0, buffer.length - 99); index > 0; index -= 1) {
      if (buffer[index] === 0x2f) { cut = index; break; }
    }
    if (cut <= 0) return tooLong();
    prefix = buffer.subarray(0, cut).toString('utf8');
    base = buffer.subarray(cut + 1).toString('utf8');
    // 目录条目以 / 结尾，拆完要补回去，否则解包会把它当成空文件
    if (base.endsWith('/')) base = base.slice(0, -1);
  }
  if (!base || Buffer.byteLength(base) > 100) return tooLong();
  if (Buffer.byteLength(prefix) > 155) return tooLong();
  write(base, 0, 100);
  // 权限固定 0644 / 0755，跟随宿主 umask 会让归档在不同机器上解出不同权限
  write(type === 'dir' ? '0000755' : '0000644', 100, 8);
  write('0000000', 108, 8); // uid
  write('0000000', 116, 8); // gid
  write(size.toString(8).padStart(11, '0'), 124, 12);
  write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0'), 136, 12);
  header.write('        ', 148, 8, 'utf8'); // 校验和先填空格
  write(type === 'dir' ? '5' : '0', 156, 1);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  write('tq-hub', 265, 32);
  write('tq-hub', 297, 32);
  write(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(sum.toString(8).padStart(6, '0'), 148, 6);
  header.write(' ', 154, 1, 'utf8');
  return header;
}

const pad = size => (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

// 收集目录下所有文件（相对路径），目录本身也入包以便空目录能还原
function walk(root, current = '') {
  const entries = [];
  for (const name of readdirSync(join(root, current)).sort()) {
    const rel = current ? `${current}/${name}` : name;
    const full = join(root, rel);
    const info = statSync(full);
    if (info.isDirectory()) {
      entries.push({ name: `${rel}/`, size: 0, mtimeMs: info.mtimeMs, type: 'dir' });
      entries.push(...walk(root, rel));
    } else if (info.isFile()) {
      entries.push({ name: rel, size: info.size, mtimeMs: info.mtimeMs, type: 'file', full });
    }
    // 符号链接等其余类型直接跳过：data/ 目录里不该出现，进包反而危险
  }
  return entries;
}

// 把整个目录打成 tar.gz。extra 允许调用方塞入内容由内存生成的条目（例如备份元信息）
export function packDirectory(root, extra = []) {
  const chunks = [];
  const entries = walk(root);
  for (const entry of entries) {
    const header = tarHeader(entry.name, entry.size, entry.mtimeMs, entry.type);
    if (!header) continue; // 路径过长的目录条目：丢弃，文件条目会把父目录带出来
    chunks.push(header);
    if (entry.type === 'file') {
      const content = readFileSync(entry.full);
      chunks.push(content, Buffer.alloc(pad(content.length)));
    }
  }
  for (const item of extra) {
    const content = Buffer.from(item.content, 'utf8');
    const header = tarHeader(item.name, content.length, item.mtimeMs ?? Date.now(), 'file');
    if (!header) throw new Error(`路径过长，无法打包：${item.name}`);
    chunks.push(header, content, Buffer.alloc(pad(content.length)));
  }
  // 结尾两个全零块：少了它 GNU tar 会警告"归档意外结束"
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

// 归档里的相对路径统一用 /，跨平台解包都认得
export const archivePath = (prefix, name) => [prefix, name].filter(Boolean).join('/').split(sep).join('/');
export { walk, relative };
