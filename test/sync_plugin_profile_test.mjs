import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('compatibility grants use plugin identity, not dependency requirement keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-sync-profile-'));
  const profile = path.join(tmp, '.ondra', 'dsh', 'profiles', 'ondra');
  const pkg = path.join(
    profile,
    'node_modules',
    '@ondra',
    'cordis-plugin-fixture',
  );
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-ondra',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(profile, 'compatibility.json'),
    `${JSON.stringify({
      '@deepseek-ai/dsh-llm@0.2.2-rc.1': ['0.2.1-rc.3'],
      '@ondra/cordis-plugin-fixture@1.2.3': ['0.2.1-rc.3'],
    })}\n`,
  );
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    `${JSON.stringify({
      name: '@ondra/cordis-plugin-fixture',
      version: '1.2.3',
      peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.2-rc.1' },
    })}\n`,
  );
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), 'export {};\n');
  const dest = path.join(tmp, 'plugin-profile');

  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, 'tool', 'sync_plugin_profile.mjs'),
      '--from',
      profile,
      '--dest',
      dest,
    ],
    {
      cwd: repo,
      env: { ...process.env, HOME: tmp },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const grants = JSON.parse(
    fs.readFileSync(path.join(dest, 'compatibility.json'), 'utf8'),
  );
  assert.deepEqual(grants, {
    '@ondra/cordis-plugin-fixture@1.2.3': ['0.2.1-rc.3'],
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});
