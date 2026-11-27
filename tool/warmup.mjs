#!/usr/bin/env node
// P5 预热：先让真实会话内核走完一轮最小对话，再退出。
//
// 只向 LM Studio 发一个 `max_tokens: 1` 的请求不足以覆盖内核真实请求的
// 形状（系统提示词、工具集、输出上限都不同）。实测那种预热返回后，首个
// 内核对话仍会重新编译十几秒。这里复用 stdio JSON-RPC 会话主链，确保
// 用户真正开口时模型已按同一形状热好。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const BASE = process.env.KONGGU_LLM_BASE ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.KONGGU_LLM_MODEL ?? 'qwen3-coder-next';

async function post(path, body) {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return { json: await response.json(), ms: Date.now() - started };
}

/// 仅预热 OpenAI 兼容端点；没有随包内核时作为降级路径保留。
export async function warmup(model = MODEL) {
  const models = await fetch(`${BASE}/models`).then((r) => {
    if (!r.ok) throw new Error(`/models -> HTTP ${r.status}`);
    return r.json();
  });
  const ids = (models.data ?? []).map((item) => item.id);
  if (!ids.includes(model)) {
    throw new Error(`模型未加载：${model}（先检查 ${BASE}/models）`);
  }
  const { ms } = await post('/chat/completions', {
    model,
    messages: [{ role: 'user', content: 'ok' }],
    max_tokens: 1,
    stream: false,
  });
  return ms;
}

/// 用真实内核完整跑一轮，等会话与后台插件收敛后再关闭。
export async function warmupKernel() {
  const dshPkg = resolve(
    process.env.KONGGU_DSH_PKG ??
      join(process.cwd(), 'runtime', 'macos-arm64', 'dsh'),
  );
  const bin = join(dshPkg, 'lib', 'bin.js');
  if (!existsSync(bin)) throw new Error(`missing DSH entry: ${bin}`);

  const bundledNode = join(
    process.cwd(),
    'runtime',
    'macos-arm64',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const requestedNode = process.env.KONGGU_NODE ?? bundledNode;
  const nodeExe = existsSync(requestedNode) ? requestedNode : process.execPath;
  const dshHome =
    process.env.KONGGU_DSH_HOME ??
    join(process.env.HOME ?? homedir(), '.ondra', 'dsh');
  const profile = process.env.KONGGU_PROFILE ?? 'ondra';
  const provider = process.env.KONGGU_PROVIDER ?? 'ondra-ui-magpie'
  const model = process.env.KONGGU_MODEL ?? MODEL;
  const securityPatch =
    process.env.KONGGU_EXTRA_PATCH ??
    join(process.cwd(), 'runtime', 'macos-arm64', 'security.patch.yml');
  const workspace =
    process.env.ONDRA_WORKSPACE_ROOT ??
    join(process.env.HOME ?? homedir(), '.ondra', 'workspace');
  mkdirSync(workspace, { recursive: true });
  // 预热用的用户句。默认使用短中文句，贴近用户真实首句；需要复现
  // 某一轮的首字延迟时，可用 KONGGU_WARMUP_PROMPT 传入完全相同的文本。
  const warmupPrompt = process.env.KONGGU_WARMUP_PROMPT ?? '你好';
  const sessionId = `ondra-warmup-${Date.now()}`;
  const settleMs = Number(process.env.KONGGU_WARMUP_SETTLE_MS ?? 1000);
  // 首次加载 44GB MLX 模型时，图编译可能远超手册里的 30s 估计。
  // 预热宁可变慢也不能半途杀掉内核，否则残留生成会拖慢紧随其后的探针。
  const timeoutMs = Number(
    process.env.KONGGU_WARMUP_TIMEOUT_MS ?? 300_000,
  );

  return await new Promise((resolvePromise, rejectPromise) => {
    const launchArgs = [bin, '--profile', profile];
    if (securityPatch && existsSync(securityPatch)) {
      launchArgs.push('--patch', securityPatch);
    }
    const child = spawn(nodeExe, launchArgs, {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        ONDRA_WORKSPACE_ROOT: workspace,
        ...(process.env.KONGGU_API_KEY
          ? {
              MAGPIE_API_KEY: process.env.KONGGU_API_KEY,
              QWEN_LOCAL_API_KEY: process.env.KONGGU_API_KEY,
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const started = Date.now();
    let promptAccepted = false;
    let turnEnded = false;
    let waitSent = false;
    let shutdownSent = false;
    let settled = false;
    let stderr = '';

    const timer = setTimeout(
      () =>
        fail(
          new Error(`kernel warmup timeout ${Math.round(timeoutMs / 1000)}s`),
        ),
      timeoutMs,
    );
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill('SIGTERM');
      rejectPromise(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      try {
        child.stdin.end();
      } catch {
        // 内核可能已经退出；这里只负责不再往管道里写。
      }
      resolvePromise(Date.now() - started);
    };
    const send = (id, method, params) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    };
    const maybeWait = () => {
      if (waitSent || !promptAccepted || !turnEnded) return;
      waitSent = true;
      send(3, 'session/wait', { sessionId });
    };

    child.stderr.on('data', (bytes) => {
      stderr = `${stderr}${bytes}`.slice(-4000);
    });
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      // 内核按设计在 flush shutdown 响应后立刻 process.exit(0)；
      // 不能等定时器，否则会把这次正常退出误判成失败。
      if (!settled && shutdownSent && code === 0) {
        done();
        return;
      }
      if (!settled) {
        fail(
          new Error(
            `kernel exited before warmup completed: code=${code} signal=${signal} ${stderr}`,
          ),
        );
      }
    });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.id === 1) {
        if (frame.error) {
          fail(new Error(JSON.stringify(frame.error)));
          return;
        }
        send(2, 'session/prompt', {
          sessionId,
          contentBlocks: [{ type: 'text', text: warmupPrompt }],
        });
        return;
      }
      if (frame.id === 2) {
        if (frame.error) {
          fail(new Error(JSON.stringify(frame.error)));
          return;
        }
        promptAccepted = true;
        maybeWait();
        return;
      }
      if (frame.id === 3) {
        if (frame.error) {
          fail(new Error(JSON.stringify(frame.error)));
          return;
        }
        setTimeout(() => {
          shutdownSent = true;
          send(4, 'shutdown', {});
        }, Math.max(0, settleMs)).unref();
        return;
      }
      if (frame.id === 4) {
        if (frame.error) {
          fail(new Error(JSON.stringify(frame.error)));
          return;
        }
        done();
        return;
      }
      if (frame.method === 'session.event') {
        const event = frame.params?.event;
        if (event?.type !== 'turn/end') return;
        const reason = event.data?.reason;
        if (reason?.kind === 'error' || reason?.kind === 'failed') {
          fail(new Error(JSON.stringify(reason)));
          return;
        }
        turnEnded = true;
        maybeWait();
      }
    });

    send(1, 'initialize', {
      cwd: workspace,
      provider,
      model,
    });
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const runtime = join(
      process.cwd(),
      'runtime',
      'macos-arm64',
      'dsh',
      'lib',
      'bin.js',
    );
    const hasKernel = existsSync(runtime);
    const ms = hasKernel ? await warmupKernel() : await warmup();
    console.log(`${hasKernel ? 'kernel warmup' : 'warmup'} ${ms}ms`);
  } catch (error) {
    console.error(`warmup failed: ${error.message}`);
    process.exit(1);
  }
}
