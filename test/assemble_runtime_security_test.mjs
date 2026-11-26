import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditSecurityFiles,
  restoreSecurityFiles,
} from '../tool/runtime_security.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-security-'));
  const nm = path.join(root, 'node_modules');
  for (const rel of [
    'dsh-sandbox/lib/index.js',
    'dsh-sandbox-local/lib/index.js',
    'dsh-fs-sandbox/lib/index.js',
    'dsh-user-approval/lib/index.js',
    'dsh-sandbox-policy/lib/index.js',
    'dsh-tool-fs/lib/index.js',
    'dsh-tool-bash/lib/index.js',
    'dsh-permission-presets/lib/index.js',
    'dsh-subagent/lib/index.js',
  ]) {
    const file = path.join(nm, '@deepseek-ai', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// [dsh-purge] bypass\n');
    fs.writeFileSync(`${file}.dshpurge.bak`, implementationFor(rel));
  }
  return { root, nm };
}

function implementationFor(rel) {
  switch (rel) {
    case 'dsh-sandbox/lib/index.js':
      return 'async function approveEscalation(request, approval) { return request; }\n';
    case 'dsh-sandbox-local/lib/index.js':
      return 'class P { async confine(argv, policy, signal) { return { argv }; } }\n';
    case 'dsh-fs-sandbox/lib/index.js':
      return 'class F { async checkedTarget(target, sandboxPolicy) { return target; } }\n';
    case 'dsh-user-approval/lib/index.js':
      return 'class ApprovalService { request() { return "allowed-once"; } }\n';
    case 'dsh-sandbox-policy/lib/index.js':
      return 'class SandboxPolicyService { constructor() { this.defaultMode = "read-only"; } }\n';
    case 'dsh-tool-fs/lib/index.js':
      return 'class FsSandboxController { resolvePolicy() {} }\n';
    case 'dsh-tool-bash/lib/index.js':
      return 'const resolveSandboxPolicy = () => ({});\n';
    case 'dsh-permission-presets/lib/index.js':
      return 'const presets = { sandbox: "workspace-write" };\n';
    default:
      return 'const subagent = {};\n';
  }
}

test('security restore replaces only purged safety files and audits them', () => {
  const { root, nm } = fixture();
  try {
    const restored = restoreSecurityFiles(nm);
    assert.equal(restored.length, 9);
    assert.doesNotThrow(() => auditSecurityFiles(nm));
    for (const rel of restored) {
      const text = fs.readFileSync(path.join(nm, '@deepseek-ai', rel), 'utf8');
      assert.doesNotMatch(text, /\[dsh-purge\]/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('security restore fails closed when the backup is missing', () => {
  const { root, nm } = fixture();
  try {
    fs.rmSync(
      path.join(nm, '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js.dshpurge.bak'),
    );
    assert.throws(
      () => restoreSecurityFiles(nm),
      /被 purge 但没有备份/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('security audit rejects a bypass left in a restored file', () => {
  const { root, nm } = fixture();
  try {
    restoreSecurityFiles(nm);
    fs.appendFileSync(
      path.join(nm, '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js'),
      '// [dsh-purge] sandbox bypass\n',
    );
    assert.throws(() => auditSecurityFiles(nm), /仍含 \[dsh-purge\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
