import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const url = process.env.ONDRA_TEST_URL ?? 'http://127.0.0.1:8765';
const executable = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'ondra-browser-'));
const chrome = spawn(executable, [
  '--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const exited = once(chrome, 'exit');
let socket;
try {
  const endpoint = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
    let output = '';
    chrome.on('error', reject);
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); accept(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  const pending = new Map();
  const errors = [];
  let sequence = 0;
  let session;
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.id) {
      const request = pending.get(frame.id);
      if (!request) return;
      pending.delete(frame.id);
      clearTimeout(request.timeout);
      if (frame.error) request.reject(new Error(JSON.stringify(frame.error)));
      else request.accept(frame.result);
    }
    if (frame.method === 'Runtime.exceptionThrown') errors.push(frame.params.exceptionDetails);
  });
  function call(method, params = {}, attached = true) {
    const id = ++sequence;
    return new Promise((accept, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
      pending.set(id, { accept, reject, timeout });
      socket.send(JSON.stringify({ id, method, params, ...(attached && session ? { sessionId: session } : {}) }));
    });
  }
  const target = await call('Target.createTarget', { url: 'about:blank' }, false);
  session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await evaluate(expression);
      if (result) return result;
      await delay(100);
    }
    throw new Error(`UI condition timed out: ${expression}`);
  }
  const text = 'document.body.innerText';
  async function click(label) {
    const bounds = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[role="button"], flt-semantics')];
      const el = nodes.find(e => e.getAttribute('aria-label') === ${JSON.stringify(label)} || e.textContent === ${JSON.stringify(label)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`);
    assert(bounds, `Missing UI element: ${label}`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...bounds });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...bounds });
    await delay(250);
  }
  await call('Page.navigate', { url });
  await waitFor('!!document.querySelector("flt-semantics-placeholder")');
  await evaluate('document.querySelector("flt-semantics-placeholder").click()');
  await waitFor(`${text}.includes('开始使用')`);
  await click('开始使用');
  await waitFor(`!${text}.includes('欢迎使用 空谷')`);
  console.log('PASS onboarding');
  for (const label of ['记忆星图', '历史对话', '插件扩展', '备份还原', '导入导出', '使用教程', '对话日志', '插件日志', '系统日志', '状态面板']) {
    await click(label);
    await waitFor(`${text}.split('\\n').filter(line => line === ${JSON.stringify(label)}).length >= 2`);
    console.log(`PASS navigation ${label}`);
  }
  await click('哦鲸鲸');
  await waitFor(`${text}.includes('通用设置')`);
  for (const [label, content] of [['通用设置', '网页白名单'], ['模型基座', '默认模型'], ['通道接口', '机器人凭据'], ['人设设定', '当前人设'], ['关于空谷', '开源许可']]) {
    await click(label);
    await waitFor(`${text}.includes(${JSON.stringify(content)})`);
    console.log(`PASS settings ${label}`);
  }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`!${text}.includes('通用设置')`);
  const snapshot = await evaluate(text);
  await writeFile(resolve('build/reports/browser-smoke.txt'), snapshot);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve('build/reports/browser-smoke.png'), Buffer.from(screenshot.data, 'base64'));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS browser runtime exceptions: 0');
} finally {
  socket?.close();
  chrome.kill();
  await exited;
  await rm(profile, { recursive: true, force: true });
}
