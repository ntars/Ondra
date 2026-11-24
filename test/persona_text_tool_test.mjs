import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 直接导入出包快照里的工具模块：这里不启动内核，只证明工具能看到当前
// 人设包的文件白名单，并且不会把模型给的任意路径变成任意文件读取。
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolUrl = pathToFileURL(path.join(
  repo, 'plugin-profile', 'node_modules', '@ondra',
  'cordis-plugin-ondra-persona-core', 'lib', 'persona_text_tool.js',
)).href;
const { registerPersonaTextTools, PERSONA_TEXT_TOOLS } = await import(toolUrl);

function harness({ activeId, files = [], texts = {} } = {}) {
  const currentId = activeId === undefined ? 'oh-jingjing' : activeId;
  const registered = new Map();
  const disposers = [];
  const core = {
    references(id) {
      return files.map(f => ({ path: f.path, doc: f.doc ?? '', bytes: f.bytes ?? 0 }));
    },
  };
  const loader = {
    activeId: () => currentId,
    readText: (id, relPath) => texts[`${id}:${relPath}`],
  };
  const ctx = {
    get(name) {
      return name === 'tools'
        ? {
            register(definition) {
              registered.set(definition.name, definition);
              return () => registered.delete(definition.name);
            },
          }
        : undefined;
    },
    inject(names, fn) {
      assert.deepEqual(names, ['tools']);
      fn({ tools: ctx.get('tools') });
    },
    effect(register) {
      const dispose = register();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  const log = { warn() {} };
  registerPersonaTextTools(ctx, core, () => loader, log);
  return { registered, disposers, core, log };
}

test('persona reference tools list only whitelisted files and read their text', () => {
  const files = [
    { path: 'references/lantern.md', doc: '暗号', bytes: 8 },
    { path: 'assets/logo.png', bytes: 1_000_000 },
  ];
  const h = harness({
    files,
    texts: { 'oh-jingjing:references/lantern.md': '灯里写着空谷暗号' },
  });
  assert.ok(h.registered.has(PERSONA_TEXT_TOOLS.list));
  assert.ok(h.registered.has(PERSONA_TEXT_TOOLS.read));
  const list = h.registered.get(PERSONA_TEXT_TOOLS.list).execute({});
  assert.equal(list.personaId, 'oh-jingjing');
  assert.deepEqual(list.references.map(r => r.path), files.map(f => f.path));
  const read = h.registered.get(PERSONA_TEXT_TOOLS.read).execute({ path: 'references/lantern.md' });
  assert.equal(read.text, '灯里写着空谷暗号');
  const rejected = h.registered.get(PERSONA_TEXT_TOOLS.read).execute({ path: '../../secret.txt' });
  assert.match(rejected.error, /没有这个文件/);
  const large = h.registered.get(PERSONA_TEXT_TOOLS.read).execute({ path: 'assets/logo.png' });
  assert.match(large.error, /超过/);
});

test('persona reference tools report missing active persona without throwing', () => {
  const h = harness({ activeId: null });
  const result = h.registered.get(PERSONA_TEXT_TOOLS.read).execute({ path: 'references/x.md' });
  assert.match(result.error, /当前没有人设/);
});
