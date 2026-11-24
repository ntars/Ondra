#!/usr/bin/env node
// 用 Node 自带 zlib 生成发布 zip。释放目录里有超过 1980-01-01 的旧时间戳，
// Windows PowerShell 5.1 的 Compress-Archive 会把它们写进 ZIP 日期字段时抛
// 「无法将 DateTimeOffset 转换为 Zip 文件时间」，随后留下一个 0 字节文件。
// 这里只写相对路径 + CRC/大小，不写本地时间，避免这个环境差异。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [rootArg, zipArg] = process.argv.slice(2);
if (!rootArg || !zipArg) {
  process.stderr.write('usage: node tool/zip_windows_release.mjs <release-dir> <zip-file>\n');
  process.exit(2);
}

const root = path.resolve(rootArg);
const zip = path.resolve(zipArg);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, data, crc) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(0, 10); // time
  head.writeUInt16LE(0x21, 12); // 1980-01-01
  head.writeUInt32LE(crc, 14);
  // 18 是压缩大小，22 是原始大小；两者不能混用，否则解压端读错长度。
  // 原始大小由调用方在写完头之前回填。
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(0, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf, data]);
}

function centralHeader(name, compressedSize, originalSize, crc, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt16LE(0x21, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(compressedSize, 20);
  head.writeUInt32LE(originalSize, 24);
  head.writeUInt16LE(nameBuf.length, 28);
  head.writeUInt16LE(0, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  head.writeUInt32LE(0, 38);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, nameBuf]);
}

const files = [];
function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rel);
    else if (entry.isFile()) files.push({ full, name: rel });
  }
}

walk(root);
files.sort((a, b) => a.name.localeCompare(b.name));

const tmp = `${zip}.tmp`;
const out = fs.openSync(tmp, 'w');
let offset = 0;
const central = [];
try {
  for (const file of files) {
    const raw = fs.readFileSync(file.full);
    const data = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const head = localHeader(file.name, data, crc);
    head.writeUInt32LE(raw.length, 22);
    fs.writeSync(out, head);
    fs.writeSync(out, data);
    central.push(centralHeader(file.name, data.length, raw.length, crc, offset));
    offset += head.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  for (const item of central) fs.writeSync(out, item);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeSync(out, end);
} finally {
  fs.closeSync(out);
}
fs.renameSync(tmp, zip);
process.stdout.write(`ZIP=${zip} FILES=${files.length} SIZE=${fs.statSync(zip).size}\n`);
