#!/usr/bin/env node
//
// 把「本机已装的 dsh profile」固化成仓库内的构建输入 `plugin-profile/`。
//
// ## 为什么需要这一步
//
// 内核的插件树不是从 npm 装的：`~/.ondra/dsh/profiles/ondra` 里那 77 个
// `@ondra/cordis-plugin-*` 是从 `~/Downloads/plugins`（本机的插件开发目录）
// 用 `pnpm install file:...` 铺出来的实体目录，`package.json` 里记的是
// `file:/Users/xxx/Downloads/plugins/...` 这种**绝对路径**。
//
// 于是「出包」被迫依赖三件本机才有的事：跑过一次应用、Downloads 里有那份
// 源码、profile 没被改坏。CI 干净 runner 上一样都没有——这正是不解决它就
// 永远产不出带运行时的 Windows 包的原因。
//
// 把编译产物（`package.json` + `lib/`）裁一份进仓库，装配就变成纯文件操作，
// 三个平台、任何一台机器上都能跑出逐字节相同的 profile 种子。
//
// ## 为什么不连源码（`src/`）一起进仓库
//
// 源码是插件自己的仓库管的事，这里只需要「能被内核 require 的东西」。带上
// `src/` 会让这份快照看上去像可编辑的源码，而它其实只是产物——改它会被下次
// 同步覆盖。
//
// ## 用法
//
//   node tool/sync_plugin_profile.mjs                   # 从默认位置同步
//   node tool/sync_plugin_profile.mjs --from <目录>      # 指定源
//   node tool/sync_plugin_profile.mjs --check           # 只比对，不写（CI 用）
//
// 同步后 `plugin-profile/` 的变化应当**看起来合理**再提交：包数量、包名列表
// 的增减都意味着内核行为变了。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEST = path.join(REPO, 'plugin-profile');

/** 运行时不需要的东西。与 `assemble_runtime.mjs` 的 DROP_EXT 保持一致。 */
const DROP_EXT = new Set([
  '.ts', '.cts', '.mts', '.map', '.pdb', '.md', '.markdown',
  '.tsbuildinfo', '.flow', '.log',
]);

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const fromArg = args.indexOf('--from');

function homeDir() {
  // Windows 不设 HOME。写 `?? '.'` 会让路径跟着「当前在哪」漂移。
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

const SRC = (() => {
  if (fromArg >= 0 && args[fromArg + 1]) return path.resolve(args[fromArg + 1]);
  if (process.env.ONDRA_PROFILE_SRC) return path.resolve(process.env.ONDRA_PROFILE_SRC);
  const name = process.env.ONDRA_PROFILE_NAME || 'ondra';
  return path.join(homeDir(), '.ondra', 'dsh', 'profiles', name);
})();

const say = (s) => process.stdout.write(`${s}\n`);

function die(msg, hint) {
  process.stderr.write(`\n✗ ${msg}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.exit(1);
}

// ── 收集要写出去的文件 ─────────────────────────────────────────────────────

/**
 * 遍历一个目录，跳过 node_modules 之外的无关物。
 *
 * 只对 `node_modules/@ondra/*` 下的包做递归——profile 根上的 `.plugin-manager`
 * 是插件管理器的操作日志（跑一次应用就多一堆），不属于装配层。
 */
function collect(srcRoot) {
  const files = new Map(); // 相对路径 → 绝对路径
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // 点开头的一律跳过：.DS_Store 是噪音，.pnpm/.modules.yaml 这类安装器
      // 元数据带本机绝对路径（见下面 walk(nm) 的注释）。
      if (e.name.startsWith('.')) continue;
      const rel = path.relative(srcRoot, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) {
        // 软链会把仓库外的路径带进来（本机 Downloads、别处的 checkout），
        // 那种东西在别的机器上直接断。同步阶段就拒绝，别等出包才发现。
        die(`profile 里有软链：${rel}`, '先在源目录里改成实体目录再同步。');
      }
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (DROP_EXT.has(ext)) continue;
        files.set(rel, full);
      }
    }
  };

  for (const f of ['cordis.yml', 'cordis.patch.yml', 'package.json']) {
    const full = path.join(srcRoot, f);
    if (!fs.existsSync(full)) die(`源 profile 缺 ${f}：${srcRoot}`);
    files.set(f, full);
  }

  // Exact-version compatibility grants live in profile-local compatibility.json.
  // The bundled runtime pins dsh 0.2.1-rc.3 while profile plugins declare
  // 0.2.2-rc.1 peers; without this file dsh disables the session/agent rows and
  // every first launch fails with "sdk-jsonrpc-server did not activate".
  // Keep the source's file when present, otherwise derive the grants from
  // plugin manifests so a fresh profile snapshot is bootable by the bundled runtime.
  const compatPath = path.join(srcRoot, 'compatibility.json');
  if (fs.existsSync(compatPath)) {
    files.set('compatibility.json', compatPath);
  } else {
    const grants = deriveVersionExemptions(srcRoot);
    files.set('compatibility.json', {
      buf: Buffer.from(`${JSON.stringify(grants, null, 2)}\n`, 'utf8'),
    });
  }

  const nm = path.join(srcRoot, 'node_modules', '@ondra');
  if (!fs.existsSync(nm)) {
    die(`源 profile 里没有 node_modules/@ondra：${srcRoot}`,
      '先用应用跑一次内核，或对 profile 目录执行 pnpm install。');
  }
  // 只收 `@ondra/*`。`node_modules` 根上还有 `.pnpm` / `.modules.yaml` /
  // `.pnpm-workspace-state-*.json`——那是 pnpm 的安装器元数据，记着本机的
  // 绝对路径与依赖树，运行期一个字节都用不到。带上它们等于把本机目录结构
  // 写进 git 历史。
  walk(nm);
  // Versioned persona archives are runtime data, not disposable documentation.
  // Their embedded SKILL.md/references remain intact inside the .skill.zip.
  walk(path.join(srcRoot, 'content', 'personas', 'bundled'));
  return files;
}

// ── 改写顶层 package.json ─────────────────────────────────────────────────

/**
 * 顶层 `package.json` 的 `dependencies` 记的是本机绝对路径
 * （`file:/Users/xxx/Downloads/plugins/...`）。仓库版把它清空，原因有三：
 *
 * 1. 那串路径在别的机器上不存在，提交进 git 等于把本机目录结构泄进历史；
 * 2. 插件包以实体形式已经就位，内核读的是 `node_modules` 与 YAML 的
 *    `insert:` 列表，**不读** dependencies；
 * 3. 留着它会诱使下一个人去 `pnpm install`——那会用旧的源码覆盖掉这份快照。
 *
 * `dsh.profile.bundles` 必须保留：那是内核装配的起点（它决定了
 * `@deepseek-ai/dsh-sdk-minimal` 这一层 bundle 要不要展开）。
 */
function rewriteRootManifest(raw) {
  const d = JSON.parse(raw);
  const names = d['x-ondra-snapshot']?.order
    ?? Object.keys(d.dependencies || {}).sort();
  d.dependencies = {};
  d['x-ondra-snapshot'] = {
    note: '构建输入快照，由 tool/sync_plugin_profile.mjs 生成；'
      + '插件包以实体形式在 node_modules/@ondra 下，不要在此执行 install',
    packages: names.length,
    order: names,
  };
  return `${JSON.stringify(d, null, 2)}\n`;
}

/**
 * Derive exact-version grants from plugin manifests.
 *
 * This runs at sync time only; runtime still reads a plain compatibility.json
 * copied into the profile seed. Only exact dsh peer/dependency versions are
 * granted, against the runtime version this repository bundles.
 */
function deriveVersionExemptions(srcRoot) {
  const runtimeVersion = bundledRuntimeVersion();
  const grants = {};
  const nm = path.join(srcRoot, 'node_modules');
  for (const scope of ['@ondra', '@deepseek-ai']) {
    const base = path.join(nm, scope);
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base)) {
      const manifestPath = path.join(base, dir, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      const requirements = { ...manifest.dependencies, ...manifest.peerDependencies };
      for (const [name, version] of Object.entries(requirements)) {
        if (!name.startsWith('@deepseek-ai/dsh-') || typeof version !== 'string') continue;
        if (!/^[0-9]/.test(version)) continue;
        grants[`${name}@${version}`] = [runtimeVersion];
      }
    }
  }
  return Object.fromEntries(Object.keys(grants).sort().map((key) => [key, grants[key]]));
}

/** Read the pinned runtime version from the packaged dsh manifest, if available. */
function bundledRuntimeVersion() {
  const candidates = [
    path.join(REPO, 'runtime', 'macos-arm64', 'dsh', 'package.json'),
    path.join(REPO, 'runtime', 'windows-x64', 'dsh', 'package.json'),
    path.join(REPO, 'runtime', 'linux-x64', 'dsh', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const version = JSON.parse(fs.readFileSync(candidate, 'utf8')).version;
      if (version) return version;
    } catch { /* try next platform */ }
  }
  die('无法确定随包 dsh 版本', '请先跑一次 tool/assemble_runtime.mjs，再同步 plugin-profile。');
}

const README = `# plugin-profile（构建输入快照）

这份目录**不是源码**，是内核插件树的编译产物快照，由
\`tool/sync_plugin_profile.mjs\` 从本机 dsh profile 生成。

## 它解决什么问题

内核按 \`$DSH_HOME/profiles/<name>\` 找装配层，而那条目录原本只能靠
「在本机跑一次应用、且 \`~/Downloads/plugins\` 里有插件源码」才存在。这意味
着干净机器（CI runner、同事的电脑）永远产不出可用的包。

有了这份快照，装配退化成纯文件操作：\`tool/assemble_runtime.mjs\` 直接把
它拷进 \`runtime/<平台>-<架构>/profile/\`，首次运行时铺到
\`$DSH_HOME/profiles/ondra\`。

## 里面有什么

| 文件 | 作用 |
|---|---|
| \`cordis.yml\` | 装配层根（内容是一个空列表，树由 patch 组合而来） |
| \`cordis.patch.yml\` | 真正的装配描述：哪 77 个插件、什么顺序、什么参数 |
| \`package.json\` | \`dsh.profile.bundles\` 是装配起点；\`dependencies\` 已清空（见文件内注释） |
| \`compatibility.json\` | 精确版本豁免：让 0.2.2-rc.1 的插件在随包 dsh 0.2.1-rc.3 上装载 |
| \`node_modules/@ondra/*\` | 77 个插件包，只保留 \`package.json\` 与 \`lib/\` |

裁剪掉的：\`src/\`（TypeScript 源码）、\`.map\`/\`.md\`/\`.tsbuildinfo\`。
运行时只需要编译产物。

## 怎么更新

插件版本变了之后：

\`\`\`sh
node tool/sync_plugin_profile.mjs            # 从 ~/.ondra/dsh/profiles/ondra 同步
git diff --stat plugin-profile               # 先看变了多少
git diff plugin-profile/cordis.patch.yml     # 装配结构变了没有
\`\`\`

**不要手动改这里的文件。** 它会被下次同步整体覆盖。要改插件行为，改
\`~/Downloads/plugins\` 里的源码、重新装进 profile，再同步。

## 为什么不能省

去掉它，四件事同时坏掉：新机器第一次打开就抛
\`profile "ondra" does not exist\`；CI 无法出带运行时的包；不同机器打出来的
包内容不一致（取决于本机装过什么版本的插件）；插件目录一旦被清理，出包能力
直接消失。
`;

// ── 写出去 ───────────────────────────────────────────────────────────────

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function plan(files) {
  // 顶层 package.json 要改写，先算好内容
  const manifestRaw = fs.readFileSync(files.get('package.json'), 'utf8');
  const manifest = Buffer.from(rewriteRootManifest(manifestRaw), 'utf8');
  files.set('package.json', null); // 标记：内容另给
  return manifest;
}

async function main() {
  if (!fs.existsSync(SRC)) {
    die(`找不到 profile 源：${SRC}`,
      '用 --from 指定，或先用应用跑一次内核把它建出来。');
  }

  say(`源      : ${SRC}`);
  say(`目标    : ${DEST}`);
  say(checkOnly ? '模式    : 只比对（--check）' : '模式    : 同步');

  const files = collect(SRC);
  const rootManifest = plan(files);

  // 计算目标状态：相对路径 → Buffer 或源路径
  const wanted = new Map();
  for (const [rel, abs] of files) {
    if (abs === null) wanted.set(rel, { buf: rootManifest });
    else wanted.set(rel, { src: abs });
  }
  wanted.set('README.md', { buf: Buffer.from(README, 'utf8') });

  let added = 0;
  let changed = 0;
  let same = 0;
  const removed = [];

  if (!checkOnly) {
    if (fs.existsSync(DEST)) {
      // 旧目标里多出来的文件要清掉，否则插件被移除后会留下孤儿包，
      // 而内核会照旧把它挂起来——那种错只在运行期显形。
      const walkDest = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          const rel = path.relative(DEST, full).split(path.sep).join('/');
          if (e.isDirectory()) walkDest(full);
          else if (!wanted.has(rel)) removed.push(rel);
        }
      };
      walkDest(DEST);
    }
    fs.mkdirSync(DEST, { recursive: true });
  }

  for (const [rel, item] of wanted) {
    const dst = path.join(DEST, rel);
    const content = item.buf ?? fs.readFileSync(item.src);
    let existing = null;
    try {
      existing = fs.readFileSync(dst);
    } catch { /* 不存在 */ }

    if (existing === null) {
      added += 1;
      if (!checkOnly) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, content);
      }
    } else if (sha1(existing) !== sha1(content)) {
      changed += 1;
      if (!checkOnly) fs.writeFileSync(dst, content);
    } else {
      same += 1;
    }
  }

  if (!checkOnly) {
    for (const rel of removed) {
      fs.rmSync(path.join(DEST, rel), { force: true });
      // 顺手清掉空目录，免得留下 77 个空壳看起来像还有包
      let dir = path.dirname(path.join(DEST, rel));
      while (dir !== DEST && dir.startsWith(DEST)) {
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
          else break;
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
  }

  say('');
  say(`  新增 ${added}  变更 ${changed}  未变 ${same}  删除 ${removed.length}`);

  if (checkOnly && (added || changed || removed.length)) {
    die('快照与源不一致',
      '跑一次 `node tool/sync_plugin_profile.mjs` 并提交 plugin-profile/。');
  }

  if (changed || added) {
    // 体积只报一次，免得每次同步都得自己 du
    let bytes = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else bytes += fs.statSync(full).size;
      }
    };
    if (fs.existsSync(DEST)) walk(DEST);
    say(`  快照体积 ${(bytes / 1048576).toFixed(1)} MB（${wanted.size} 个文件）`);
    say('');
    say('下一步：git diff --stat plugin-profile，确认包数量与装配结构的变化合理再提交。');
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${err.stack || err.message}\n`);
  process.exit(1);
});
