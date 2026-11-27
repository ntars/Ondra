import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = process.env.FIXTURE_HOME;
if (!root || root !== process.env.HOME) throw new Error('fixture requires isolated HOME');
const tracePath = path.join(root, 'protocol.jsonl');
const sessionsPath = path.join(root, 'sessions.json');
const attemptsPath = path.join(root, 'attempts.json');
const attempt = fs.existsSync(attemptsPath) ? JSON.parse(fs.readFileSync(attemptsPath)) + 1 : 1;
fs.writeFileSync(attemptsPath, JSON.stringify(attempt));
const scenario = process.env.FIXTURE_SCENARIO;
const loaded = new Map();
let initialized = false;
let terminating = false;

function trace(event, fields = {}) {
  fs.appendFileSync(tracePath, JSON.stringify({ event, pid: process.pid, attempt, ...fields }) + '\n');
}
function write(frame) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
}
function result(id, value = {}) {
  write({ id, result: value });
}
function fail(id, message, code = -32000) {
  write({ id, error: { message, code } });
}
function event(sessionId, type, data = {}, time = '2026-01-01T00:00:00Z') {
  write({ method: 'session.event', params: { sessionId, event: { type, time, data } } });
}
function message(sessionId, text, usage) {
  event(sessionId, 'assistant/message', {
    message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }], usage },
  }, '2026-01-01T00:00:02Z');
}
function sessions() {
  return fs.existsSync(sessionsPath) ? JSON.parse(fs.readFileSync(sessionsPath)) : {};
}

trace('start', {
  home: process.env.HOME,
  dshHome: process.env.DSH_HOME,
  path: process.env.PATH,
  marker: process.env.FIXTURE_MARKER,
  cwd: process.cwd(),
  workspaceRoot: process.env.ONDRA_WORKSPACE_ROOT,
  args: process.argv.slice(2),
});
process.on('exit', code => trace('exit', { code }));
process.on('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  trace('terminate');
  setTimeout(() => process.exit(0), Number(process.env.FIXTURE_EXIT_DELAY_MS ?? 0));
});

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  trace('request', { id, method, params });
  if (method === 'initialize') {
    if (scenario === 'reject-initialize-once' && attempt === 1) {
      fail(id, 'initialize rejected');
      return;
    }
    if (scenario === 'hang-initialize-once' && attempt === 1) return;
    if (scenario === 'exit-initialize-once' && attempt === 1) {
      process.stderr.write('fixture initialization crash\n');
      process.exit(23);
    }
    const initialize = () => {
      initialized = true;
      process.stdout.write('not-json\n{"method":42}\n');
      process.stderr.write('(node:1) ExperimentalWarning: fixture warning\n');
      result(id, { protocolVersion: 1 });
    };
    if (scenario === 'delay-initialize') setTimeout(initialize, 120);
    else initialize();
    return;
  }
  if (method === 'shutdown') {
    trace('shutdown');
    if (scenario === 'fail-shutdown') {
      fail(id, 'shutdown rejected');
      return;
    }
    if (scenario === 'hang-shutdown') return;
    result(id, {});
    // A real SDK kernel flushes its final session state after replying and
    // before exiting. Keep a small gap so tests can prove `close()` waits.
    setTimeout(() => process.exit(0), Number(process.env.FIXTURE_SHUTDOWN_DELAY_MS ?? 0));
    return;
  }
  if (!initialized) {
    fail(id, 'initialize must complete first');
    return;
  }
  if (method === 'session/resume') {
    if (scenario === 'reject-resume-once' && attempt === 2) {
      fail(id, 'resume rejected');
      return;
    }
    const history = sessions()[params.sessionId];
    if (!history) {
      fail(id, 'session not found');
      return;
    }
    loaded.set(params.sessionId, history);
    message(params.sessionId, 'replayed history must not become a new reply', { inputTokens: 900, outputTokens: 900 });
    result(id, { sessionId: params.sessionId });
    return;
  }
  if (method === 'session/query') {
    // 模拟 ondra-turn-control 插件的 /cancel-turn：agent.abort 后内核
    // 以 aborted turn/end 收尾（不经过 prompt 事件流）。
    const sid = params.sessionId;
    event(sid, 'turn/end', { reason: { kind: 'aborted' } });
    result(id, { kind: 'command', execution: { kind: 'success', text: '已中断当前轮次' } });
    return;
  }
  if (method !== 'session/prompt') {
    fail(id, `unsupported method: ${method}`, -32601);
    return;
  }
  const sessionId = params.sessionId;
  const saved = sessions();
  if (saved[sessionId] && !loaded.has(sessionId)) {
    fail(id, 'session/resume required after restart');
    return;
  }
  const text = params.contentBlocks.find(block => block.type === 'text')?.text ?? '';
  if (sessionId.startsWith('ondra-warmup-')) {
    result(id, { accepted: true });
    if (scenario === 'warmup-hang') return;
    if (scenario === 'warmup-empty') {
      event(sessionId, 'turn/end', { reason: { kind: 'completed' } });
      return;
    }
    if (scenario === 'warmup-error') {
      event(sessionId, 'turn/end', { reason: { kind: 'error', error: { message: 'warmup failed', code: 'WARMUP_FAILED' } } });
      return;
    }
    message(sessionId, 'warm', { inputTokens: 700, outputTokens: 70 });
    event(sessionId, 'turn/end', { reason: { kind: 'completed' } });
    return;
  }
  const previous = loaded.get(sessionId) ?? [];
  const history = [...previous, text];
  loaded.set(sessionId, history);
  saved[sessionId] = history;
  fs.writeFileSync(sessionsPath, JSON.stringify(saved));
  if (text === 'hang-prompt') return;
  if (text === 'rpc-error') {
    fail(id, 'prompt rejected', 403);
    return;
  }
  if (text === 'exit-prompt') {
    process.stderr.write('fixture prompt crash\n');
    process.exit(17);
  }
  result(id, { accepted: true });
  if (text === 'hang-turn') return;
  if (text === 'partial-hang') {
    message(sessionId, 'partial');
    return;
  }
  if (text === 'exit-turn') {
    message(sessionId, 'partial');
    setTimeout(() => process.exit(19), 30);
    return;
  }
  if (text === 'api-error' || text === 'partial-error') {
    event(sessionId, 'assistant/reasoning', { delta: 'must stay private' });
    if (text === 'partial-error') message(sessionId, 'partial');
    event(sessionId, 'turn/end', { reason: { kind: 'error', error: { message: 'API quota exceeded', code: 'quota_exceeded' } } });
    return;
  }
  if (text === 'usage') {
    event(sessionId, 'step/start');
    event('another-session', 'step/start', {}, '2026-01-01T00:00:01Z');
    message('another-session', 'unrelated reply', { inputTokens: 999, outputTokens: 999 });
    message(undefined, 'missing session', { inputTokens: 888, outputTokens: 888 });
    event('another-session', 'turn/end', { reason: { kind: 'error', error: { message: 'unrelated failure' } } });
    message(sessionId, 'reply:usage', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 });
  } else {
    message(sessionId, text === 'history' ? previous.join('|') : `reply:${text}`);
  }
  event(sessionId, 'turn/end', { reason: { kind: 'completed' } });
  if (text === 'exit-idle') setTimeout(() => process.exit(21), 30);
});
