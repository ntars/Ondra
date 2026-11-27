import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditSecurityFiles } from '../tool/runtime_security.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ONDRA_TEST_DSH_ROOT ||
  path.join(
    repo,
    'runtime',
    `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`,
    'dsh',
  );
const require = createRequire(path.join(sdk, 'package.json'));
const { Context } = require('@deepseek-ai/cordis');
const { SandboxedFileSystem } = require('@deepseek-ai/dsh-fs-sandbox');

const roots = [];
const contexts = [];

after(async () => {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
  for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.homedir(), '.ondra-sandbox-test-'));
  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  roots.push(parent);
  return { parent, workspace, outside };
}

function mount(workspace, mode) {
  const ctx = new Context();
  contexts.push(ctx);
  const policy = { mode, workspaceRoot: workspace };
  ctx.provide('sandboxPolicy', {
    defaultMode: mode,
    resolve: () => policy,
  });
  const filesystem = new SandboxedFileSystem(ctx, {
    cwd: workspace,
    diffBasisMaxBytes: 1024 * 1024,
  });
  return { filesystem, policy };
}

test('bundled runtime security files are no longer purged or bypassed', () => {
  assert.doesNotThrow(() => auditSecurityFiles(path.join(sdk, 'node_modules')));
});

test('workspace-write allows a write inside and denies a sibling outside', async () => {
  const { workspace, outside } = fixture();
  const { filesystem, policy } = mount(workspace, 'workspace-write');
  const inside = await filesystem.resolve(path.join(workspace, 'inside.txt'));
  const outsideTarget = await filesystem.resolve(path.join(outside, 'outside.txt'));

  await filesystem.writeText(
    inside,
    'inside',
    undefined,
    undefined,
    policy,
  );
  assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');

  await assert.rejects(
    filesystem.writeText(
      outsideTarget,
      'outside',
      undefined,
      undefined,
      policy,
    ),
    (error) => {
      assert.equal(error.code, 'FS_SANDBOX_DENIED');
      assert.match(error.message, /workspace-write/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(outside, 'outside.txt')), false);
});

test('read-only denies even an in-workspace mutation', async () => {
  const { workspace } = fixture();
  const { filesystem, policy } = mount(workspace, 'read-only');
  const target = await filesystem.resolve(path.join(workspace, 'denied.txt'));

  await assert.rejects(
    filesystem.writeText(target, 'denied', undefined, undefined, policy),
    (error) => {
      assert.equal(error.code, 'FS_SANDBOX_DENIED');
      assert.match(error.message, /read-only/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(workspace, 'denied.txt')), false);
});

