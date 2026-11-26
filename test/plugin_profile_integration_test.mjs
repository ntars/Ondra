import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-plugin-integration-'));
const originalEnv = { ...process.env };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = path.join(home, '.dsh');
process.env.ONDRA_HOME = path.join(home, '.ondra');
const sdk = process.env.ONDRA_TEST_DSH_ROOT || path.join(repo, 'runtime', `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`, 'dsh');
const require = createRequire(path.join(sdk, 'package.json'));
const { Context } = require('@deepseek-ai/cordis');
const { Loader } = require('@deepseek-ai/cordis-plugin-loader');
const { agentEvents, assembleContextFor } = require('@deepseek-ai/dsh-agent');
const { createScope } = require('@deepseek-ai/dsh-scope');
const { createUserMessage, BlockAssembler, LlmAdapter, markAgentLoopRequest } = require('@deepseek-ai/dsh-llm');
const { renderPrompt, renderContextSections, joinContextSections } = require('@deepseek-ai/dsh-system-prompt');
const profile = path.join(home, 'profile');
fs.cpSync(path.join(repo, 'plugin-profile'), profile, { recursive: true });
fs.symlinkSync(path.join(sdk, 'node_modules', '@deepseek-ai'), path.join(profile, 'node_modules', '@deepseek-ai'), 'dir');
const pluginPath = name => path.join(profile, 'node_modules', '@ondra', `cordis-plugin-ondra-${name}`, 'lib', 'index.js');
const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8');
const libUrl = (pkg, name) => pathToFileURL(path.join(profile, 'node_modules', '@ondra', pkg, 'lib', name)).href;
const ttsLib = name => libUrl('cordis-plugin-ondra-tts', name);
const contexts = [];
after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    for (const key of ['HOME', 'USERPROFILE', 'DSH_HOME', 'ONDRA_HOME']) {
        if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
});

async function harness() {
    const ctx = new Context();
    contexts.push(ctx);
    const loader = new Loader(ctx, { baseUrl: pathToFileURL(`${profile}/`).href });
    async function core(name, config = {}) {
        await loader.create({ id: name, name: require.resolve(`@deepseek-ai/${name}`), config });
        await loader.await();
    }
    async function plugin(name, config = {}, inject) {
        await loader.create({ id: name, name: pluginPath(name), config, ...(inject ? { inject } : {}) });
        await loader.await();
        return ctx.get(`ondra-${name}`);
    }
    return { ctx, loader, core, plugin };
}
function user(text) { return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }); }
function fakeAgent(ctx, id) {
    const agent = { id, session: { id }, options: { provider: 'fixture', model: 'local-only' } };
    agent.ctx = createScope(ctx, agent).ctx;
    return agent;
}
function start(ctx, agent, turn) { ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn } }); }
function claim(ctx, agent, turn, message) { agentEvents(ctx, agent).emit('agent/inbox/claimed', { turn, message }); }
function idle(ctx, agent) { agentEvents(ctx, agent).emit('agent/status', { status: 'idle' }); }
const body = assembly => joinContextSections(renderContextSections(assembly));
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
function assembled(chunks) { const a = new BlockAssembler(); for (const chunk of chunks) a.push(chunk); return a; }

// TTS 插件的纯函数回归：这棵 profile 是出包输入，插件源码树不在本仓。
// 用真实装配层路径导入编译产物，防止「只改了工具、忘了同步 profile」。
test('tts snapshot registers Windows SAPI as a built-in system engine', async () => {
    const tts = await import(ttsLib('index.js'));
    const configLayers = await import(libUrl('cordis-plugin-ondra-config-schema', 'layers.js'));
    assert.ok(tts.ENGINE_NAMES.includes('windows-sapi'));
    assert.equal(tts.DEFAULT_CONFIG.enable, false);
    assert.ok(tts.PROVIDER_VALUES.includes('windows-sapi'));
    assert.equal(tts.completeConfig({ enable: true, provider: 'windows-sapi' }).provider, 'windows-sapi');

    const sapi = await import(ttsLib('branches/windows-sapi.js'));
    assert.equal(sapi.sapiRateOf(0.1), 1);
    assert.equal(sapi.sapiRateOf(-0.5), -5);
    assert.equal(sapi.sapiVolumeOf('low'), 60);
    assert.equal(sapi.sapiVolumeOf('normal'), 100);
    const script = sapi.sapiScript({
        textPath: "C:\\a's.txt", outPath: 'C:\\out.wav', voice: "O'Brien", rate: 2, volume: 60,
    });
    assert.match(script, /ReadAllText\('C:\\a''s\.txt'\)/);
    assert.match(script, /SelectVoice\('O''Brien'\)/);

    const exec = await import(ttsLib('exec.js'));
    const found = exec.resolvePowerShell(
        'win32', { SystemRoot: 'C:\\Windows', PATH: '' }, p => p.endsWith('powershell.exe'),
    );
    assert.equal(found, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(exec.resolvePowerShell('darwin', { SystemRoot: 'C:\\Windows' }, () => true), undefined);
    const encoded = exec.encodedPowerShell('中文');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), '中文');

    assert.match(patch, new RegExp(
        "- id: ondra-tts\\n\\s+name: '@ondra/cordis-plugin-ondra-tts'\\n"
        + '(?:\\s+#[^\\n]*\\n)*\\s+config:\\n\\s+enable: false',
    ));

    // 出厂层必须能被用户层覆盖，否则「设置 → 朗读回复」打开后永远不生效。
    let section;
    const noop = () => {};
    const log = { info: noop, warn: noop, error: noop, debug: noop };
    const schema = {
        register(decl) { section = decl; return noop; },
        resolve(id, layers) { return configLayers.resolveSection(section, layers); },
    };
    const ctx = {
        get(key) { return key === 'ondra-config-schema' ? schema : undefined; },
        logger() { return log; },
        effect(effect) { effect(); },
        provide() { return noop; },
    };
    tts.apply(ctx, { enable: false });
    assert.equal(configLayers.resolveSection(section, { factory: { enable: false } }).values.enable, false);
    assert.equal(configLayers.resolveSection(section, {
        factory: { enable: false }, user: { enable: true },
    }).values.enable, true);
});

test('tts Windows SAPI engine synthesizes WAV and removes the text file', async () => {
    const os = await import('node:os');
    const sapi = await import(ttsLib('branches/windows-sapi.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-sapi-'));
    try {
        const outPath = path.join(dir, 'wav.wav');
        const calls = [];
        const engine = new sapi.WindowsSapiEngine({
            platform: 'win32',
            powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            voice: '',
            timeoutMs: 15000,
            exec: async (command, args, options) => {
                calls.push({ command, args, options, text: fs.readFileSync(`${outPath}.txt`, 'utf8') });
                fs.writeFileSync(outPath, Buffer.from('RIFFfake'));
                return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
            },
        });
        assert.equal(engine.present, true);
        assert.equal(engine.configured, true);
        const result = await engine.synth({
            text: '中文（含引号"）', outPath,
            voice: 'zh-CN-XiaoxiaoNeural', rate: 0.1, volume: 'low',
        });
        assert.deepEqual(result, { ok: true, reason: 'ok', ext: 'wav', rateApplied: true, voice: '' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].text, '中文（含引号"）');
        assert.equal(calls[0].args[0], '-NoProfile');
    assert.equal(calls[0].args[2], '-EncodedCommand');
        assert.equal(fs.existsSync(`${outPath}.txt`), false);

        const failure = new sapi.WindowsSapiEngine({
            platform: 'win32',
            powershell: 'powershell.exe',
            voice: 'Not Installed',
            timeoutMs: 15000,
            exec: async () => ({
                ok: false, code: 1, stdout: '', stderr: 'SelectVoice: voice not installed', timedOut: false,
            }),
        });
        const failed = await failure.synth({ text: '测试', outPath, voice: 'x', rate: 0, volume: 'normal' });
        assert.equal(failed.reason, 'voice-unknown');
        assert.equal(fs.existsSync(`${outPath}.txt`), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

async function* textStream(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: text.slice(0, 5) };
    yield { type: 'text-delta', index: 0, text: text.slice(5) };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
}

// The actual Loader, not a fake ctx.get, must wait for late sqlite and bind once.
test('late sqlite releases required dependencies without boot-settle; state survives reload', async () => {
    const h = await harness();
    for (const name of ['emotion-core', 'emotion-stage', 'data-migrate']) {
        const row = patch.match(new RegExp(`- id: ondra-${name}\\n[\\s\\S]*?(?=    - id:|$)`))[0];
        assert.match(row, /inject:\s*\n\s*- ondra-store-sqlite/);
        await h.plugin(name, {}, ['ondra-store-sqlite']);
        assert.equal(h.ctx.get(`ondra-${name}`), undefined);
    }
    const db = path.join(home, 'state.sqlite');
    await h.plugin('store-sqlite', { path: db });
    await h.loader.await();
    const emotion = h.ctx.get('ondra-emotion-core');
    const stage = h.ctx.get('ondra-emotion-stage');
    const migration = h.ctx.get('ondra-data-migrate');
    assert.equal(emotion.stats().reason, undefined);
    assert.equal(stage.stats().reason, undefined);
    assert.equal(migration.available, true);
    emotion.setAxis('mood', 0.8);
    assert.equal(emotion.save(), true);
    stage.touch();
    assert.equal(stage.relation().interactions, 1);
    await h.loader.resolve('store-sqlite').fiber.restart();
    await h.loader.await();
    const restored = h.ctx.get('ondra-emotion-core');
    assert.notEqual(restored, emotion);
    assert.ok(restored.state().axes.mood > 0.79);
    assert.equal(restored.save(), true);
    assert.equal(h.ctx.get('ondra-emotion-stage').relation().interactions, 1);
    assert.equal(h.ctx.get('ondra-data-migrate').available, true);
});

test('factory archive is byte-for-byte UI content and assembles on empty HOME', async () => {
    const h = await harness();
    await h.core('dsh-system-prompt', { includeHarnessIdentity: false });
    const loader = await h.plugin('persona-loader', { bundledDir: 'content/personas/bundled', activePersona: 'oh-jingjing' });
    assert.equal(loader.stats().factoryPresent, true);
    assert.equal(loader.activeId(), 'oh-jingjing');
    assert.equal(loader.stats().issues.length, 0);
    const { openZip } = await import(pathToFileURL(pluginPath('persona-loader')));
    const archive = openZip(fs.readFileSync(path.join(profile, 'content/personas/bundled/oh-jingjing.skill.zip')), 'factory');
    assert.ok(archive.entries.length > 5);
    for (const entry of archive.entries) {
        assert.equal(loader.readText('oh-jingjing', entry.path), fs.readFileSync(path.join(repo, 'assets/personas/oh-jingjing', entry.path), 'utf8'));
    }
    const core = await h.plugin('persona-core');
    await h.plugin('persona-vars');
    const persona = await h.plugin('persona-assemble');
    assert.equal(core.available, true);
    assert.ok(core.boundaries().length > 0);
    assert.ok(persona.assemble().text.includes('鲸'));
    const agent = fakeAgent(h.ctx, 'factory');
    const result = await h.ctx.systemPrompt.assemble(assembleContextFor(agent));
    assert.equal(result.sections.filter(s => s.name === 'ondra:persona').length, 1);
    assert.ok(renderPrompt(result).includes('鲸'));
    await h.loader.resolve('dsh-system-prompt').fiber.restart();
    await h.loader.await();
    assert.equal((await h.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.filter(s => s.name === 'ondra:persona').length, 1);
});

test('real SystemPrompt recalls newly claimed input with agent/turn isolation and late prompt', async () => {
    const h = await harness();
    const calls = [];
    h.ctx.provide('ondra-memory-recall', { available: true, search(input) { calls.push(input.text); return { ok: true, hits: [] }; } });
    h.ctx.provide('ondra-memory-core', { available: true, listFacts: () => [], getFact: () => undefined });
    await h.plugin('prompt-inject');
    await h.core('dsh-system-prompt');
    const a = fakeAgent(h.ctx, 'a'), b = fakeAgent(h.ctx, 'b');
    start(h.ctx, a, 1); start(h.ctx, b, 1);
    claim(h.ctx, a, 1, user('甲会话的本轮原话'));
    claim(h.ctx, b, 1, user('乙会话的本轮原话'));
    await h.ctx.systemPrompt.assemble(assembleContextFor(a));
    await h.ctx.systemPrompt.assemble(assembleContextFor(b));
    assert.deepEqual(calls, ['甲会话的本轮原话', '乙会话的本轮原话']);
    claim(h.ctx, a, 1, createUserMessage({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '不是用户原话' }] }));
    const assembly = await h.ctx.systemPrompt.assemble(assembleContextFor(a));
    h.ctx.systemPrompt.refreshContext(assembly, assembleContextFor(a));
    assert.deepEqual(calls.slice(-2), ['甲会话的本轮原话', '甲会话的本轮原话']);
    start(h.ctx, a, 2);
    await h.ctx.systemPrompt.assemble(assembleContextFor(a));
    assert.equal(calls.length, 4, 'no-message turn cannot reuse old query');
    claim(h.ctx, a, 2, user(''));
    await h.ctx.systemPrompt.assemble(assembleContextFor(a));
    idle(h.ctx, b);
    await h.ctx.systemPrompt.assemble(assembleContextFor(b));
    assert.equal(calls.length, 4);
    await h.loader.resolve('dsh-system-prompt').fiber.restart();
    await h.loader.await();
    claim(h.ctx, a, 2, user('重新挂载'));
    await h.ctx.systemPrompt.assemble(assembleContextFor(a));
    assert.equal(calls.filter(s => s === '重新挂载').length, 1);
});

test('crisis input is assessed once, isolated, required, suspends only roleplay, and propagates failure', async () => {
    const h = await harness();
    await h.core('dsh-system-prompt');
    const guard = await h.plugin('crisis');
    await h.plugin('persona-loader'); await h.plugin('persona-core'); await h.plugin('persona-vars'); await h.plugin('persona-assemble');
    const a = fakeAgent(h.ctx, 'crisis'), b = fakeAgent(h.ctx, 'ordinary');
    start(h.ctx, a, 1); start(h.ctx, b, 1);
    claim(h.ctx, a, 1, user('我已经写好了遗书，今晚就动手。'));
    claim(h.ctx, b, 1, user('今天吃了面包'));
    assert.equal(guard.stats().assessments, 2);
    assert.equal(guard.forAgent(a).holdRoleplay, true);
    const result = await h.ctx.systemPrompt.assemble(assembleContextFor(a));
    assert.match(body(result), /暂停人设/);
    const full = await h.ctx.systemPrompt.assemble(assembleContextFor(b));
    assert.ok(!body(full).includes('暂停人设'));
    assert.ok(renderPrompt(full).length > renderPrompt(result).length);
    assert.ok(result.sections.find(s => s.name === 'ondra:persona').text.length > 0, 'boundaries retained');
    h.ctx.systemPrompt.refreshContext(result, assembleContextFor(a));
    assert.equal(guard.stats().assessments, 2);
    const suppress = h.ctx.systemPrompt.suppressRuntimeContext();
    assert.match(body(await h.ctx.systemPrompt.assemble(assembleContextFor(a))), /暂停人设/);
    suppress();
    start(h.ctx, a, 2);
    assert.equal(guard.forAgent(a), undefined);
    const original = guard.assess;
    guard.assess = () => { throw new Error('fixture safety failure'); };
    claim(h.ctx, a, 2, user('新的用户消息'));
    await assert.rejects(h.ctx.systemPrompt.assemble(assembleContextFor(a)), /fixture safety failure/);
    guard.assess = original;
    idle(h.ctx, a);
    assert.equal(guard.forAgent(a), undefined);
});

test('output waterfall filters once, preserves nontext/errors, excludes auxiliary calls and isolates history', async () => {
    const h = await harness();
    const filter = await h.plugin('filter-chain', { reviewEnabled: false });
    const a = fakeAgent(h.ctx, 'filter-a'), b = fakeAgent(h.ctx, 'filter-b');
    async function request(agent, history = []) {
        const signal = new AbortController().signal;
        await agentEvents(h.ctx, agent).waterfall('agent/pre-step', { turn: 1, step: 1, signal, messages: [] }, () => Promise.resolve({ kind: 'enter', messages: [] }));
        return markAgentLoopRequest({ sessionId: agent.session.id, signal, messages: history });
    }
    const input = '好的，以下是我的回答。今天天气真好，我们出去走走。';
    const req = await request(a);
    const output = await collect(h.ctx.waterfall('llm/stream', req, () => textStream(input)));
    assert.equal(filter.stats().runs, 1);
    assert.equal(assembled(output).blocks()[0].text, '今天天气真好，我们出去走走。');
    const aux = { ...req };
    assert.equal(assembled(await collect(h.ctx.waterfall('llm/stream', aux, () => textStream(input)))).blocks()[0].text, input);
    assert.equal(filter.stats().runs, 1);
    const bOutput = await collect(h.ctx.waterfall('llm/stream', await request(b), () => textStream(input)));
    assert.equal(assembled(bOutput).blocks()[0].text, '今天天气真好，我们出去走走。');
    const repeated = { role: 'assistant', content: [{ type: 'text', text: '今天天气真好，我们出去走走。' }] };
    await assert.rejects(
        collect(h.ctx.waterfall('llm/stream', await request(a, [repeated]), () => textStream(input))),
        error => error.code === 'ONDRA_FILTER_REGENERATE_REQUIRED',
    );
    const before = filter.stats().runs;
    const failure = { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'no model' } } };
    assert.deepEqual(await collect(h.ctx.waterfall('llm/stream', await request(a), () => (async function* () { yield failure; })())), [failure]);
    assert.equal(filter.stats().runs, before);
    await assert.rejects(collect(h.ctx.waterfall('llm/stream', await request(a), () => (async function* () { throw new Error('iterator failure'); })())), /iterator failure/);
    const tool = { type: 'block-end', index: 3, block: { type: 'tool-call', id: 'call-1', name: 'local_fixture', arguments: '{}' } };
    const usage = { type: 'usage', usage: { inputTokens: 7, outputTokens: 8 } };
    const mixed = await collect(h.ctx.waterfall('llm/stream', await request(a), () => (async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'fixture reasoning' } };
        yield { type: 'text-delta', index: 1, text: input };
        yield tool; yield usage;
        yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { opaque: 'unfiltered' } };
    })()));
    assert.ok(mixed.includes(tool)); assert.ok(mixed.includes(usage));
    assert.equal(mixed.at(-1).replayState, undefined);
    assert.equal(assembled(mixed).blocks()[0].type, 'reasoning');
});

test('filter accepts profile kebab keys without schema and keeps one-char replies', async () => {
    const h = await harness();
    // 出厂 profile 用 kebab 段键，而插件实例配置只认 camelCase。真实内核有
    // O-005 配置段做双向映射；这里没有 schema，就必须按真实装配边界转换，
    // 不能在测试里偷偷改 node_modules 的插件源码。
    const profileRow = patch.match(/id: ondra-filter-chain[\s\S]*?config:\n((?:\s+.+\n)+)/)?.[1] ?? '';
    const rawConfig = Object.fromEntries(
        [...profileRow.matchAll(/^\s+([a-z-]+):\s*(\S+)\s*$/gm)]
            .map(([, key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value === 'true' ? true : value === 'false' ? false : Number(value)]),
    );
    const filter = await h.plugin('filter-chain', rawConfig);
    assert.equal(filter.settings.reviewEnabled, false);
    assert.equal(filter.settings.minChars, 1);
    const agent = fakeAgent(h.ctx, 'one-char');
    const signal = new AbortController().signal;
    const message = user('1+1等于几？只回答数字。');
    await agentEvents(h.ctx, agent).waterfall(
        'agent/pre-step',
        { turn: 1, step: 1, signal, messages: [message] },
        () => Promise.resolve({ kind: 'enter', messages: [] }),
    );
    const output = await collect(
        h.ctx.waterfall(
            'llm/stream',
            markAgentLoopRequest({ sessionId: agent.session.id, signal, messages: [message] }),
            () => textStream('2'),
        ),
    );
    assert.equal(assembled(output).blocks()[0].text, '2');
});

test('filtered-empty output fails closed instead of leaking the original reply', async () => {
    const h = await harness();
    await h.plugin('filter-chain', { reviewEnabled: false, minChars: 3 });
    const agent = fakeAgent(h.ctx, 'filter-closed');
    const signal = new AbortController().signal;
    const message = user('只回答一个数字。');
    await agentEvents(h.ctx, agent).waterfall(
        'agent/pre-step',
        { turn: 1, step: 1, signal, messages: [message] },
        () => Promise.resolve({ kind: 'enter', messages: [] }),
    );
    await assert.rejects(
        collect(
            h.ctx.waterfall(
                'llm/stream',
                markAgentLoopRequest({ sessionId: agent.session.id, signal, messages: [message] }),
                () => textStream('2'),
            ),
        ),
        error => error.code === 'ONDRA_FILTER_REGENERATE_REQUIRED',
    );
});

test('review limits are per session/turn; urgent guidance is not truncated or forced into roleplay', async () => {
    const h = await harness();
    const reviewed = [];
    h.ctx.provide('ondra-llm-gateway', { available: true, async complete(input) {
        reviewed.push(input);
        return { text: '分数：90\n反馈：无' };
    } });
    const filter = await h.plugin('filter-chain', { reviewEnabled: true, reviewMaxRounds: 1, maxChars: 80 });
    const guard = await h.plugin('crisis');
    const a = fakeAgent(h.ctx, 'review-a'), b = fakeAgent(h.ctx, 'review-b');
    async function run(agent, turn, text, userText = '正常用户输入') {
        const signal = new AbortController().signal;
        const message = user(userText);
        start(h.ctx, agent, turn); claim(h.ctx, agent, turn, message);
        await agentEvents(h.ctx, agent).waterfall('agent/pre-step', { turn, step: 1, signal, messages: [message] }, () => Promise.resolve({ kind: 'enter', messages: [] }));
        return collect(h.ctx.waterfall('llm/stream', markAgentLoopRequest({ sessionId: agent.session.id, signal, messages: [message] }), () => textStream(text)));
    }
    await Promise.all([run(a, 1, '今天吃了一顿好饭。', '甲轮原话'), run(b, 1, '我们明天见面。', '乙轮原话')]);
    assert.equal(reviewed.length, 2);
    assert.ok(reviewed.some(r => r.messages[1].content.includes('甲轮原话')));
    assert.ok(reviewed.some(r => r.messages[1].content.includes('乙轮原话')));
    await run(a, 1, '这件事以后再慢慢说。');
    assert.equal(reviewed.length, 2, 'same turn limit');
    h.ctx.emit('session/event', a.session, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(filter.rounds.has('review-a:1'), false);
    await run(a, 2, '下次带你尝尝这个。');
    assert.equal(reviewed.length, 3);
    const guidance = `${guard.resources().guidance}我无法真正体会你的痛苦，但我可以陪你联系能到场的人。`;
    const urgent = await run(a, 3, guidance, '我已经写好了遗书，今晚就动手。');
    assert.equal(assembled(urgent).blocks()[0].text, guidance);
    assert.equal(reviewed.length, 3, 'crisis holdRoleplay excludes persona-style review');
    const bad = new Error('fixture filter failure');
    filter.run = () => { throw bad; };
    await assert.rejects(run(b, 2, '不能吞掉的错误。'), error => error === bad);
});

test('organ gate runs before real tool admission; unknown tools and other permissions survive', async () => {
    const h = await harness();
    await h.core('dsh-system-prompt'); await h.core('dsh-tools');
    for (const name of ['read', 'edit', 'bash', 'web_fetch', 'brand_new_capability']) h.ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) });
    const gate = await h.plugin('organ-gate', { mode: 'enforce', minToolsToGate: 1, minKeepTools: 1, maxDenyRatio: 0.9 });
    let toolContext;
    await h.ctx.inject(['tools'], scoped => { toolContext = scoped; }).inertia;
    const a = fakeAgent(toolContext, 'gate-a'), b = fakeAgent(toolContext, 'gate-b');
    const revokePermission = a.ctx.tools.restrict({ deny: ['bash'] });
    start(h.ctx, a, 1);
    claim(h.ctx, a, 1, user('读文件'));
    const signal = new AbortController().signal;
    // dsh-tools 当前版本把“可见性”与“执行准入”统一放在 view() 里；
    // resolve() 是旧版 API，在本机内核里已经不存在。
    const tools = h.ctx.tools.view(a);
    const names = h.ctx.tools.schemas(a).map(t => t.name);
    assert.deepEqual(names.sort(), ['brand_new_capability', 'read']);
    const prompt = await h.ctx.systemPrompt.assemble({ ...assembleContextFor(a, signal), toolSet: tools });
    assert.deepEqual(prompt.tools.map(t => t.name).sort(), names, 'advertised schema equals executable admission');
    assert.equal(h.ctx.tools.resolveExecution('edit', a), undefined);
    assert.ok(h.ctx.tools.resolveExecution('read', a));
    assert.equal(h.ctx.tools.schemas(b).length, 5);
    await agentEvents(h.ctx, a).waterfall('agent/pre-step', { turn: 1, step: 1, signal, messages: [user('读文件')] }, () => Promise.resolve({ kind: 'enter', messages: [] }));
    assert.deepEqual(h.ctx.tools.schemas(a).map(t => t.name).sort(), names);
    assert.equal(gate.stats().enforced, 1);
    start(h.ctx, a, 2);
    assert.equal(h.ctx.tools.get('bash', a), undefined, 'permission guard never lifted');
    assert.ok(h.ctx.tools.get('edit', a));
    revokePermission();
});

test('real loop advertises and executes the same gated tools across a tool continuation', async () => {
    const h = await harness();
    for (const name of ['dsh-agent', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-agent-loop']) await h.core(name);
    let executions = 0;
    const requests = [], errors = [];
    for (const name of ['read', 'edit', 'web_fetch', 'brand_new_capability']) h.ctx.tools.register({
        name, description: `local fixture ${name}`, parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'local fixture result' }] },
        execute: async () => { executions++; return {}; },
    });
    await h.plugin('organ-gate', { mode: 'enforce', minToolsToGate: 1, minKeepTools: 1, maxDenyRatio: 0.9 });
    const filter = await h.plugin('filter-chain', { reviewEnabled: false });
    class Fixture extends LlmAdapter {
        async *stream(request) {
            requests.push(request);
            assert.deepEqual(request.tools.map(t => t.name).sort(), ['brand_new_capability', 'read']);
            if (requests.length === 1) {
                yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-call', name: 'read', arguments: '{}' } };
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
            } else yield* textStream('本地内容看过了。');
        }
    }
    h.ctx.llm.registerAdapter(['fixture'], new Fixture());
    h.ctx.on('agent/error', ({ error }) => errors.push(error));
    const handle = await h.ctx.agents.create({ sessionId: 'real-tool-fixture', agentOptions: { provider: 'fixture', model: 'local-only' } });
    handle.agent.send(user('读文件'), 'next-turn', true);
    await handle.agent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2);
    assert.equal(executions, 1);
    assert.equal(filter.stats().runs, 1, 'tool-only response is not text-filtered');
    const results = handle.agent.session.snapshotEvents(0).filter(e => e.type === 'tool/result');
    assert.equal(results.length, 1);
    await handle.dispose();
});

test('real agent loop claims input, assembles persona/recall and commits only filtered output', async () => {
    const h = await harness();
    for (const name of ['dsh-agent', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-agent-loop']) await h.core(name);
    const queries = [], requests = [], errors = [], frames = [];
    h.ctx.provide('ondra-memory-recall', { available: true, search({ text }) { queries.push(text); return { ok: true, hits: [] }; } });
    h.ctx.provide('ondra-memory-core', { available: true, listFacts: () => [], getFact: () => undefined });
    await h.plugin('prompt-inject'); await h.plugin('crisis');
    await h.plugin('persona-loader'); await h.plugin('persona-core'); await h.plugin('persona-vars'); await h.plugin('persona-assemble');
    const filter = await h.plugin('filter-chain', { reviewEnabled: false });
    class Fixture extends LlmAdapter {
        stream(request) { requests.push(request); return textStream('好的，以下是我的回答。我记住这件事了，明天再聊。'); }
    }
    h.ctx.llm.registerAdapter(['fixture'], new Fixture());
    h.ctx.on('agent/error', ({ error }) => errors.push(error));
    h.ctx.on('agent/assistant-stream', ({ frame }) => frames.push(frame));
    const handle = await h.ctx.agents.create({ sessionId: 'real-loop-fixture', agentOptions: { provider: 'fixture', model: 'local-only' } });
    const agent = handle.agent;
    agent.send(user('本轮唯一的真实用户输入'), 'next-turn', true);
    await agent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    assert.deepEqual(queries, ['本轮唯一的真实用户输入', '本轮唯一的真实用户输入'], 'core assembles once then refreshes runtime context once');
    assert.ok(requests[0].messages.some(m => m.role === 'system' && m.content.some(b => b.type === 'text' && b.text.includes('鲸'))));
    const replies = agent.session.snapshotEvents(0).filter(e => e.type === 'assistant/message');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].data.message.content.find(b => b.type === 'text').text, '我记住这件事了，明天再聊。');
    assert.equal(filter.stats().runs, 1);
    assert.ok(frames.length > 0);
    assert.ok(!JSON.stringify(frames).includes('好的，以下是'), 'unfiltered draft never reaches live UI');
    assert.equal(h.ctx.get('ondra-crisis').stats().assessments, 1);
    // Reload an already-present prompt, then admit another turn: exactly one
    // contribution survives each dependency reload, with no stale input retained.
    await h.loader.resolve('prompt-inject').fiber.restart();
    await h.loader.await();
    const probe = fakeAgent(h.ctx, 'reload-probe');
    claim(h.ctx, probe, 1, user('即时挂载探针'));
    const prompt = await h.ctx.systemPrompt.assemble(assembleContextFor(probe));
    assert.equal(prompt.contexts.filter(c => c.name === 'ondra:injection').length, 1);
    assert.equal(queries.filter(q => q === '即时挂载探针').length, 1);
    await handle.dispose();
});
