import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ONDRA_TEST_DSH_ROOT ||
  path.join(repo, 'runtime', `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`, 'dsh');
const require = createRequire(path.join(sdk, 'package.json'));
const roots = [];

after(() => {
  for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-plugin-boot-'));
  roots.push(home);
  const profile = path.join(home, 'profiles', 'ondra');
  fs.cpSync(path.join(repo, 'plugin-profile'), profile, { recursive: true });
  const sdkLinks = path.join(profile, 'node_modules', '@deepseek-ai');
  if (fs.existsSync(sdkLinks)) fs.rmSync(sdkLinks, { recursive: true, force: true });
  fs.symlinkSync(path.join(sdk, 'node_modules', '@deepseek-ai'), sdkLinks, 'dir');
  return { home, profile };
}

function appendPatch(profile, text) {
  fs.appendFileSync(path.join(profile, 'cordis.patch.yml'), `\n${text}\n`);
}

function runKernel(home, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(sdk, 'lib', 'bin.js'),
      '--profile',
      'ondra',
      ...extraArgs,
    ], {
      cwd: repo,
      env: {
        ...process.env,
        DSH_HOME: home,
        ONDRA_WORKSPACE_ROOT: repo,
        QWEN_LOCAL_API_KEY: process.env.QWEN_LOCAL_API_KEY ?? 'local-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.id === 1) {
          // Startup warnings are emitted after the initialize response on the
          // same process. Keep the pipe open briefly so assertions see them.
          setTimeout(
            () => finish({ code: null, stdout, stderr, frame }),
            250,
          );
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (settled) return;
      // Startup diagnostics are written just before the initialize response.
      // Let the stderr pipe drain one turn before returning the observation.
      setImmediate(() => finish({ code, stdout, stderr, frame: null }));
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { cwd: repo, provider: 'local-qwen', model: 'qwen3-coder-next' },
    })}\n`);
    setTimeout(() => finish({ code: null, stdout, stderr, frame: null, timeout: true }), 20_000).unref();
  });
}

test('wrong plugin package is visible in real startup diagnostics', async () => {
  const { home, profile } = makeHome();
  appendPatch(profile, [
    '- insert:',
    '    - id: deliberately-missing',
    "      name: '@deepseek-ai/dsh-tool-todoo'",
  ].join('\n'));
  const result = await runKernel(home);
  assert.equal(result.frame?.result?.serverInfo?.name, 'deepseek-harness-sdk-runtime');
  assert.match(result.stderr, /deliberately-missing/);
  assert.match(result.stderr, /@deepseek-ai\/dsh-tool-todoo/);
});

test('a plugin that throws in apply is isolated while the kernel still initializes', async () => {
  const { home, profile } = makeHome();
  const pluginDir = path.join(profile, 'node_modules', '@ondra', 'cordis-plugin-ondra-broken');
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: '@ondra/cordis-plugin-ondra-broken',
    type: 'module',
    exports: { '.': './lib/index.js' },
  }));
  fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), [
    "export const name = 'ondra-broken';",
    'export function apply() { throw new Error("deliberate apply failure"); }',
  ].join('\n'));
  appendPatch(profile, [
    '- insert:',
    '    - id: deliberately-broken',
    "      name: '@ondra/cordis-plugin-ondra-broken'",
  ].join('\n'));
  const result = await runKernel(home);
  assert.equal(result.frame?.result?.serverInfo?.name, 'deepseek-harness-sdk-runtime');
  assert.match(result.stderr, /deliberately-broken/);
  assert.match(result.stderr, /deliberate apply failure/);
});

test('a loaded plugin can report itself from apply without breaking startup', async () => {
  const { home, profile } = makeHome();
  const pluginDir = path.join(profile, 'node_modules', '@ondra', 'cordis-plugin-ondra-loaded');
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: '@ondra/cordis-plugin-ondra-loaded',
    type: 'module',
    exports: { '.': './lib/index.js' },
  }));
  fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), [
    "export const name = 'ondra-loaded';",
    "export function apply() { console.error('ondra-loaded: loaded'); }",
  ].join('\n'));
  appendPatch(profile, [
    '- insert:',
    '    - id: deliberately-loaded',
    "      name: '@ondra/cordis-plugin-ondra-loaded'",
  ].join('\n'));
  const result = await runKernel(home);
  assert.equal(result.frame?.result?.serverInfo?.name, 'deepseek-harness-sdk-runtime');
  assert.match(result.stderr, /ondra-loaded: loaded/);
});

test('disabling the persona assembler keeps startup healthy and removes its injection path', async () => {
  const { home, profile } = makeHome();
  appendPatch(profile, [
    '- id: ondra-persona-assemble',
    "  name: '@ondra/cordis-plugin-ondra-persona-assemble'",
    '  disabled: true',
  ].join('\n'));
  const result = await runKernel(home);
  assert.equal(result.frame?.result?.serverInfo?.name, 'deepseek-harness-sdk-runtime');
  assert.doesNotMatch(result.stderr, /ondra-persona-assemble.*failed/);
});
