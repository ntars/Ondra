#!/usr/bin/env node
// Manual kernel probe: initialize, optionally send one prompt, then stop.
//
// Environment:
//   KONGGU_DSH_HOME  DSH home (default: ~/.ondra/dsh)
//   KONGGU_PROFILE   profile name (default: ondra)
//   KONGGU_DSH_PKG   @deepseek-ai/dsh package directory (default: bundled
//                    runtime when present, otherwise the installed app)
//   KONGGU_NODE      node executable (default: process.execPath)
//
// KONGGU_PROVIDER / KONGGU_MODEL select the provider/model parameters.
// They default to the app-managed Magpie route so the bare `node tool/probe.mjs`
// P0 command reads the same profile the app uses. P5 passes local-qwen explicitly.
// KONGGU_PROMPT turns the probe into a one-turn conversation check. It carries no
// fallback for a missing profile: a successful initialize with the wrong tree is not P0.
// KONGGU_PROMPT_FILE is the same check for payloads too large for the environment.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const installedPkg =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh';
const bundledPkg = join(process.cwd(), 'runtime', 'macos-arm64', 'dsh');
const dshPkg =
  process.env.KONGGU_DSH_PKG ??
  (existsSync(join(bundledPkg, 'lib', 'bin.js')) ? bundledPkg : installedPkg);
const bin = join(dshPkg, 'lib', 'bin.js');
const dshHome =
  process.env.KONGGU_DSH_HOME ??
  join(process.env.HOME ?? homedir(), '.ondra', 'dsh');
const profile = process.env.KONGGU_PROFILE ?? 'ondra';
const node = process.env.KONGGU_NODE ?? process.execPath;
const provider = process.env.KONGGU_PROVIDER ?? 'ondra-ui-magpie';
const model = process.env.KONGGU_MODEL ?? 'group/ntars';
const prompt = process.env.KONGGU_PROMPT_FILE
  ? readFileSync(process.env.KONGGU_PROMPT_FILE, 'utf8')
  : (process.env.KONGGU_PROMPT ?? '');
const sessionId = process.env.KONGGU_SESSION_ID ?? 'session-1';
// P5 latency runs warmup and the measured prompt in one kernel process so the
// local model's HTTP connection (and its prefix KV cache) survives between them.
const warmupPrompt = process.env.KONGGU_PROBE_WARMUP_PROMPT ?? '';
const warmupSettleMs = Number(
  process.env.KONGGU_PROBE_WARMUP_SETTLE_MS ?? 1000,
);

if (!existsSync(bin)) {
  console.error(`missing DSH entry: ${bin}`);
  process.exit(2);
}

const extraPatch = process.env.KONGGU_EXTRA_PATCH ?? '';
const launchArgs = [bin, '--profile', profile];
if (extraPatch) launchArgs.push('--patch', extraPatch);
const apiKey = process.env.KONGGU_API_KEY ?? '';
const childEnv = { ...process.env, DSH_HOME: dshHome };
if (apiKey) childEnv.MAGPIE_API_KEY = apiKey;
if (apiKey) childEnv.QWEN_LOCAL_API_KEY = apiKey;
const child = spawn(node, launchArgs, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let settled = false;
let promptAccepted = false;
let turnReason = null;
let promptStartedAt = null;
let firstTextReported = false;
let phase = 'main';
let activeSessionId = sessionId;
let warmupAccepted = false;
let warmupTurnEnded = false;
let mainPromptSent = false;
let nextId = 2;
const pending = new Map();
const finish = (code, message) => {
  if (settled) return;
  settled = true;
  if (message) console.error(message);
  child.stdin.end();
  child.kill('SIGTERM');
  process.exit(code);
};

function send(method, params, id) {
  const frame = { jsonrpc: '2.0', method, params };
  if (id !== undefined) frame.id = id;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function startMainPrompt() {
  if (mainPromptSent) return;
  mainPromptSent = true;
  phase = 'main';
  activeSessionId = sessionId;
  const id = nextId++;
  promptStartedAt = Date.now();
  pending.set(id, { method: 'session/prompt', started: promptStartedAt });
  send('session/prompt', {
    sessionId,
    contentBlocks: [{ type: 'text', text: prompt }],
  }, id);
}

function maybeStartMainPrompt() {
  if (!warmupAccepted || !warmupTurnEnded) return;
  setTimeout(startMainPrompt, Math.max(0, warmupSettleMs)).unref();
}

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return; // A malformed line must not take down the whole stream.
  }
  if (frame.id === 1) {
    console.log('RESULT:', JSON.stringify(frame.result ?? frame.error));
    if (frame.error || !prompt) {
      finish(frame.error ? 1 : 0);
      return;
    }
    if (warmupPrompt) {
      phase = 'warmup';
      activeSessionId = `${sessionId}-warmup-${Date.now()}`;
      const id = nextId++;
      pending.set(id, {
        method: 'session/prompt',
        started: Date.now(),
        warmup: true,
      });
      send('session/prompt', {
        sessionId: activeSessionId,
        contentBlocks: [{ type: 'text', text: warmupPrompt }],
      }, id);
    } else {
      startMainPrompt();
    }
    return;
  }
  if (frame.id !== undefined && pending.has(frame.id)) {
    const entry = pending.get(frame.id);
    pending.delete(frame.id);
    console.log(
      `PROMPT_RESULT: ${JSON.stringify(frame.result ?? frame.error)} (${Date.now() - entry.started}ms)`,
    );
    if (frame.error) {
      finish(1);
      return;
    }
    if (entry.warmup) {
      warmupAccepted = true;
      maybeStartMainPrompt();
      return;
    }
    promptAccepted = true;
    if (turnReason) {
      finish(0);
    }
    return;
  }
  if (frame.method === 'session.event') {
    if (frame.params?.sessionId !== activeSessionId) return;
    const event = frame.params?.event;
    const type = event?.type ?? 'unknown';
    const sincePrompt =
      promptStartedAt === null ? '' : ` +${Date.now() - promptStartedAt}ms`;
    process.stderr.write(`[event] ${type}${sincePrompt}\n`);
    if (type === 'request/header') {
      const header = event?.data?.header ?? event?.data;
      if (process.env.KONGGU_DUMP_HEADER) {
        console.log(
          `HEADER_DUMP ${JSON.stringify({
            sessionId: frame.params?.sessionId,
            active: activeSessionId,
            phase,
            header,
          })}`,
        );
      }
      const tools = Array.isArray(header?.tools)
        ? header.tools
        : Array.isArray(header?.toolRegistry)
        ? header.toolRegistry
        : null;
      console.log(
        `REQUEST_HEADER: keys=${Object.keys(header ?? {}).join(',')} tools=${tools?.length ?? '?'}`,
      );
      if (process.env.KONGGU_DEBUG_TOOLS && Array.isArray(tools)) {
        const names = tools.map((tool) =>
          typeof tool === 'string'
            ? tool
            : (tool?.name ?? tool?.function?.name ?? tool?.id ?? '?'),
        );
        console.log(`TOOLS: ${names.join(',')}`);
      }
    }
    const message = event?.data?.message;
    if (type === 'assistant/message' && message?.content) {
      const usage = event?.data?.usage;
      if (usage) console.log(`USAGE: ${JSON.stringify(usage)}`);
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text) {
        if (phase === 'warmup') {
          console.log(`WARMUP_ASSISTANT: ${text}`);
          return;
        }
        if (promptStartedAt !== null && !firstTextReported) {
          firstTextReported = true;
          console.log(`FIRST_TEXT: ${Date.now() - promptStartedAt}ms`);
        }
        console.log('ASSISTANT:', text);
      }
    }
    if (type === 'turn/end') {
      if (phase === 'warmup') {
        warmupTurnEnded = true;
        console.log('WARMUP_TURN_END:', JSON.stringify(event.data?.reason ?? null));
        maybeStartMainPrompt();
        return;
      }
      turnReason = event.data?.reason ?? null;
      console.log('TURN_END:', JSON.stringify(turnReason));
      if (promptAccepted) {
        const error =
          turnReason?.kind === 'error' ||
          turnReason?.kind === 'failed' ||
          turnReason?.kind === 'cancelled';
        finish(error ? 1 : 0);
      }
    }
  }
  if (frame.method && !frame.id) {
    // Requests from the kernel are not needed for this probe.
  }
});

child.stderr.on('data', (bytes) => process.stderr.write(bytes));
child.on('error', (error) => finish(2, `spawn failed: ${error.message}`));
child.on('exit', (code, signal) => {
  if (!settled) finish(1, `kernel exited before initialize: code=${code} signal=${signal}`);
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      cwd: process.cwd(),
      provider,
      model,
    },
  })}\n`,
);

const probeTimeoutMs = warmupPrompt ? 300_000 : 120_000;
setTimeout(() => {
  if (promptAccepted && !turnReason) {
    console.log('TURN_PENDING: no turn/end before probe timeout');
  }
  finish(2, `TIMEOUT ${Math.round(probeTimeoutMs / 1000)}s`);
}, probeTimeoutMs).unref();
