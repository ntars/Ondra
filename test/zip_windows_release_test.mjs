import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

const REPO = path.resolve(import.meta.dirname, '..');
const TOOL = path.join(REPO, 'tool', 'zip_windows_release.mjs');

function readEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'missing end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localOffset = buf.readUInt32LE(offset + 42);
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressedSize = buf.readUInt32LE(localOffset + 18);
    entries.set(name, buf.subarray(dataStart, dataStart + compressedSize));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('Windows release zip keeps nested entries and old file times', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-zip-test-'));
  try {
    fs.mkdirSync(path.join(root, 'runtime', 'windows-x64'), { recursive: true });
    const body = 'bundled runtime marker\n';
    const nested = path.join(root, 'runtime', 'windows-x64', 'node.exe.txt');
    fs.writeFileSync(nested, body);
    fs.writeFileSync(path.join(root, 'ondra.exe'), 'exe');
    // Compress-Archive on Windows PowerShell 5.1 rejects these timestamps.
    fs.utimesSync(nested, new Date('1970-01-01T00:00:00Z'), new Date('1970-01-01T00:00:00Z'));

    const zipPath = path.join(root, 'release.zip');
    const result = spawnSync(process.execPath, [TOOL, root, zipPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FILES=2/);

    const entries = readEntries(zipPath);
    assert.deepEqual([...entries.keys()].sort(), [
      'ondra.exe',
      'runtime/windows-x64/node.exe.txt',
    ]);
    // First entry starts with a 30-byte local header; method is at +8.
    const method = fs.readFileSync(zipPath).readUInt16LE(8);
    assert.equal(method, 8, 'entries should be deflated');
    const buf = fs.readFileSync(zipPath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    assert.notEqual(eocd, -1);
    let centralOffset = buf.readUInt32LE(eocd + 16);
    const count = buf.readUInt16LE(eocd + 10);
    for (let i = 0; i < count; i += 1) {
      const nameLen = buf.readUInt16LE(centralOffset + 28);
      const extraLen = buf.readUInt16LE(centralOffset + 30);
      const commentLen = buf.readUInt16LE(centralOffset + 32);
      const name = buf.subarray(centralOffset + 46, centralOffset + 46 + nameLen).toString('utf8');
      const localOffset = buf.readUInt32LE(centralOffset + 42);
      const compressedSize = buf.readUInt32LE(centralOffset + 20);
      const originalSize = buf.readUInt32LE(centralOffset + 24);
      assert.equal(buf.readUInt32LE(localOffset + 18), compressedSize, `${name}: local compressed size`);
      assert.equal(buf.readUInt32LE(localOffset + 22), originalSize, `${name}: local original size`);
      const diskSize = fs.statSync(path.join(root, name)).size;
      assert.equal(originalSize, diskSize, `${name}: original size must match file on disk`);
      assert.notEqual(compressedSize, originalSize, `${name}: compressed size must be real`);
      centralOffset += 46 + nameLen + extraLen + commentLen;
    }
    const data = entries.get('runtime/windows-x64/node.exe.txt');
    assert.equal(zlib.inflateRawSync(data).toString('utf8'), body);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
