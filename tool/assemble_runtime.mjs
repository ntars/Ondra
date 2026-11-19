#!/usr/bin/env node
//
// 装配随包运行时：Node + dsh 核心 agent + profile 种子（+ Windows 的 sqlite3）。
//
// ## 它做什么
//
// 产出一个可以直接塞进应用包的目录 `runtime/<platform>-<arch>/`：
//
//   runtime/windows-x64/
//   ├── node.exe          ← Node 22 可执行（单平台单架构）
//   ├── sqlite3.exe       ← 只有 Windows 需要（系统里没有）
//   ├── dsh/              ← dsh 核心 agent 的依赖闭包（已裁剪）
//   │   ├── package.json
//   │   ├── lib/bin.js
//   │   └── node_modules/…
//   └── profile/          ← `ondra` 装配层种子（cordis.yml + 77 个插件包）
//
// 应用启动时用它，用户不需要自己装 Node、dsh 或插件。
//
// ## 为什么是 Node 而不是 bash / PowerShell
//
// 三个平台必须有**同一套语义**。上一版是 bash + 内嵌 python3，Windows 上两样
// 都没有，只能另写一份 PowerShell——而两份实现迟早漂移，且 Windows 那份在这台
// 机器上根本跑不了，等于写一段没人验证过的代码。
//
// 这个脚本由 node 自己执行（装配环境本来就必须有 node），所以三个平台走的是
// 逐行相同的逻辑；Windows 的差异被压缩到三处可点数的分支：`node.exe` 名字、
// 目录链接用 junction 而非 symlink、以及 sqlite3.exe 的获取。
//
// ## 为什么 profile 也必须进包
//
// 光有 node + dsh 起不来。内核按 `$DSH_HOME/profiles/<name>` 找装配层
// （`dsh-app-boot` 里 `PROFILES_DIR = "profiles"` 写死，没有搜索路径环境变量），
// 新机器上这个目录不存在就直接抛：
//
//   Error: dsh: profile "ondra" does not exist
//
// 所以包里的 profile 角色是**首次运行的种子**，不是常驻配置：应用只在
// `~/.ondra/dsh/profiles/ondra` 不存在时才铺开它。已有安装的用户仍旧用自己那份。
//
// ## 为什么是「一份裁剪过的副本」而不是装好的整包
//
// 完整安装 @deepseek-ai/dsh 是 **906MB**：里面带 LibreOffice（148MB）、
// 60 个 client-ui 包（46MB）、AWS/Google/Anthropic SDK（39MB）、
// OpenTelemetry（25MB）。空谷的对话层只用 `session/prompt` 这一条 stdio
// JSON-RPC，那些东西一个都用不到。
//
// 所以这里做**依赖闭包**，只保留真正会被 require 到的包：
//
//   1. 从三个根出发：入口 `lib/bin.js` 的依赖 + `dsh-sdk-minimal`
//      + profile 装配层按名字点名的内核包
//   2. 顺着 dependencies/peerDependencies/optionalDependencies 递归
//   3. 遇到明确无关的重型包（LibreOffice、client-ui…）整棵子树剪掉
//   4. 丢掉 .ts/.pdb/.map 等运行时用不到的文件
//   5. 逐字节相同的嵌套副本合并成链接（POSIX 软链 / Windows junction）
//
// ## 为什么只做「依赖闭包」还不够
//
// 内核的模块解析不是 Node 原生那一套：`dsh-app-boot` 装了一层解析拦截
// （`installRuntimeInterception`），它只路由**从内核 package.json 依赖图递归出来的
// 包**。而 profile 挂载插件时是按名字写死的（`cordis.patch.yml` 的 `insert:`），
// 像 `@deepseek-ai/dsh-llm-pi-ai` 这种包**没有任何 package.json 引用它**——
// 于是文件在包里、解析器却不肯路由，表现是一握手就
// `no adapter registered for provider "magpie"`。
//
// 所以脚本做两件事：
//   1. 把 profile 点名的内核包也当作依赖根（闭包里有）
//   2. 把它们补进**拷贝出来的** dsh/package.json（解析器肯路由）
//
// 两者缺一不可，而且 `--dump-config` 一个都验不出来——只有真握手能。
//
// ## 用法
//
//   node tool/assemble_runtime.mjs              # 当前平台当前架构
//   node tool/assemble_runtime.mjs --dry-run    # 只算体积，不落盘
//
// 也可以走 `tool/assemble_runtime.sh`（三行转发，给习惯.sh 的人用）。
//
// 依赖：本机已装 node 与 @deepseek-ai/dsh（与开发环境同一套）。
// 它**不联网拉 npm 包**：内核只从现有安装里拷，产出的东西与开发时跑的是同一份
// 版本。唯一的网络请求是 Windows 缺 sqlite3.exe 时向 sqlite.org 取一次官方
// 二进制（带 SHA3-256 校验），可用 ONDRA_SQLITE3_BIN 或 ONDRA_SKIP_SQLITE=1 绕开。
//
// ## 平台限制：装配必须在目标平台上跑
//
// node 二进制与原生模块（node-pty / koffi）都是平台相关的，所以
// `runtime/windows-x64` 只能在 Windows 上生成，`runtime/macos-arm64` 只能在
// macOS 上生成。CI 里对应两个 job，不是一个 job 交叉产出。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ── 小工具 ──────────────────────────────────────────────────────────────────

const say = (s = '') => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);

function die(msg, hint) {
  warn(`✗ ${msg}`);
  if (hint) warn(`  ${hint}`);
  process.exit(1);
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 目录占用的字节数。不跟随链接——链接本身不占空间，跟随会把去重算成没做。 */
function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      total += st.size;
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) stack.push(path.join(cur, name));
  }
  return total;
}

function sizeOf(p) {
  try {
    return dirSize(p);
  } catch {
    return 0;
  }
}

/** 删目录。Windows 上被杀软/索引器短暂占用是常态，重试几次比直接失败好。 */
function rimraf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * 尽力删除：失败只警告。
 *
 * 用在临时目录上——那里删不掉顶多留一点垃圾，不该让一次已经成功的装配失败。
 * 产物目录（OUT）不用它：那个必须真的删干净，否则会把上次的旧包混进来。
 */
function rimrafQuietly(p, what) {
  try {
    rimraf(p);
  } catch (err) {
    warn(`  ! ${what}没删掉（${err.code || err.message}）：${p}`);
  }
}

// ── 参数 ────────────────────────────────────────────────────────────────────

let dryRun = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '-h' || arg === '--help') {
    say('用法：node tool/assemble_runtime.mjs [--dry-run]');
    say('');
    say('  --dry-run  只算体积，不落盘');
    say('');
    say('环境变量：');
    say('  ONDRA_NODE_BIN     指定 node 可执行（默认用运行本脚本的那个）');
    say('  ONDRA_DSH_PKG      指定 @deepseek-ai/dsh 包目录');
    say('  ONDRA_PROFILE_SRC  指定 profile 源目录');
    say('  ONDRA_PROFILE_NAME profile 名（默认 ondra）');
    say('  ONDRA_SQLITE3_BIN  指定 sqlite3.exe（Windows）');
    say('  ONDRA_SKIP_SQLITE  设为 1 则不去取 sqlite3.exe');
    process.exit(0);
  } else die(`未知参数：${arg}`);
}

// ── 平台标识 ────────────────────────────────────────────────────────────────
// 名字必须与 Dart 的 `Platform.operatingSystem` 一致（macos / windows / linux）：
// lib/app/bundled_runtime_io.dart 是按 `startsWith('<os>-')` 扫目录的。
const PLATFORM = process.platform === 'darwin'
  ? 'macos'
  : process.platform === 'win32'
    ? 'windows'
    : process.platform === 'linux'
      ? 'linux'
      : null;
if (!PLATFORM) die(`不支持的平台：${process.platform}`);

const ARCH = { arm64: 'arm64', x64: 'x64', ia32: 'x86' }[process.arch];
if (!ARCH) die(`不支持的架构：${process.arch}`);

const IS_WIN = PLATFORM === 'windows';
const TARGET = `${PLATFORM}-${ARCH}`;
const NODE_NAME = IS_WIN ? 'node.exe' : 'node';
const SQLITE_NAME = IS_WIN ? 'sqlite3.exe' : 'sqlite3';

// ── 定位源：node 与 dsh ─────────────────────────────────────────────────────
// node 用**正在运行本脚本的那一个**：它必然可执行、版本确定，且与装 dsh 的
// 是同一套环境。用 PATH 里的 `node` 去猜，在 Windows 上还要处理 `node.cmd`。
function findNode() {
  const explicit = process.env.ONDRA_NODE_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return process.execPath;
}

/**
 * 找 @deepseek-ai/dsh 的包目录。
 *
 * 不能只靠 `which dsh` 反推：Windows 上是 `%APPDATA%\npm\dsh.cmd` 这类批处理
 * 垫片，从它反推包目录要靠解析文本。所以列一遍真实安装位置，全都不中再用
 * `npm root -g` 兜底。
 */
function findDshPkg(nodeBin) {
  const explicit = process.env.ONDRA_DSH_PKG;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const nodeDir = path.dirname(nodeBin);
  const candidates = [
    // 官方 Windows 安装包：全局包就装在 node.exe 旁边
    path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh'),
    // POSIX（Homebrew / 发行版 / nvm）：<prefix>/lib/node_modules
    path.join(nodeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh'),
  ];
  const appData = process.env.APPDATA;
  if (appData) {
    // npm 在 Windows 上的默认前缀
    candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    candidates.push(path.join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(path.join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(path.join(home, '.volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh'));
  }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'bin.js')) && fs.existsSync(path.join(c, 'node_modules'))) {
      return path.resolve(c);
    }
  }

  // dry-run 不启动 npm：即使 npm root 也可能写日志/缓存。非常规前缀请显式指定。
  if (dryRun) return null;
  // 最后问一次 npm：非常规前缀（自定义 prefix、pnpm 的怪路径）只有它知道。
  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
  const probe = spawnSync(npmCmd, ['root', '-g'], { encoding: 'utf8', shell: IS_WIN });
  if (probe.status === 0 && probe.stdout) {
    const guess = path.join(probe.stdout.trim(), '@deepseek-ai', 'dsh');
    if (fs.existsSync(path.join(guess, 'lib', 'bin.js'))) return guess;
  }
  return null;
}

const NODE_BIN = findNode();
const DSH_PKG = findDshPkg(NODE_BIN);

// ── profile 源 ──────────────────────────────────────────────────────────────
//
// ## 三选一的顺序，以及为什么仓库快照排在默认位置
//
// `~/.ondra/dsh/profiles/ondra` 是靠「在本机跑过一次应用、且
// `~/Downloads/plugins` 里有插件源码」才存在的。把它当默认值，等于让「出包」
// 依赖本机的偶然状态：CI 干净 runner 上永远没有它，同事的电脑上版本又各不相同，
// 于是同样的提交在不同机器上打出内容不同的包。
//
// 所以默认值改成仓库内的 `plugin-profile/`（由 `tool/sync_plugin_profile.mjs`
// 从真实 profile 固化的产物）。它是一份**文件**，谁在哪台机器上装都读到同一份。
//
// 本机那份仍然保留为兜底：仓库快照万一没同步进来（fork、旧分支），至少还能装上。
// 显式 `ONDRA_PROFILE_SRC` 最优先，用于「立刻试刚改的插件」。
const PROFILE_NAME = process.env.ONDRA_PROFILE_NAME || 'ondra';
const homeDir = process.env.HOME || process.env.USERPROFILE || '';
const REPO_PROFILE = path.join(REPO, 'plugin-profile');
const LOCAL_PROFILE = homeDir
  ? path.join(homeDir, '.ondra', 'dsh', 'profiles', PROFILE_NAME)
  : '';

if (!fs.existsSync(NODE_BIN)) die(`找不到 node：${NODE_BIN}`);
if (!DSH_PKG) {
  die('找不到 @deepseek-ai/dsh', '装一个（npm i -g @deepseek-ai/dsh），或用 ONDRA_DSH_PKG 指定。');
}

/** 一个目录是不是 dsh profile：判据是装配描述文件在不在。 */
function looksLikeProfile(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'cordis.patch.yml'));
}

/**
 * 比较「仓库快照」与「本机 profile」的差异，只比会影响运行行为的东西。
 *
 * 不比文件内容哈希：快照裁掉了 `.ts`/`.map`，逐个比会对每一份快照都报差异，
 * 那种噪音等于没有告警。只比装配描述与包版本——插件改了行为必然伴随版本或
 * 装配结构变化，这是可靠且低噪的判据。
 */
function profileDrift(snapshot, local) {
  const out = [];

  for (const f of ['cordis.yml', 'cordis.patch.yml']) {
    let a = '';
    let b = '';
    try {
      a = fs.readFileSync(path.join(snapshot, f), 'utf8');
    } catch { /* 缺文件等于内容不同 */ }
    try {
      b = fs.readFileSync(path.join(local, f), 'utf8');
    } catch { /* 同上 */ }
    if (a !== b) out.push(`${f} 内容不同`);
  }

  const versions = (root) => {
    const dir = path.join(root, 'node_modules', '@ondra');
    const m = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return m;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let v = '(无版本号)';
      try {
        v = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'package.json'), 'utf8')).version || v;
      } catch { /* 读不到就按无版本号算 */ }
      m.set(e.name, v);
    }
    return m;
  };

  const snap = versions(snapshot);
  const loc = versions(local);
  for (const [name, v] of loc) {
    if (!snap.has(name)) out.push(`本机新增：${name}@${v}`);
    else if (snap.get(name) !== v) out.push(`${name}: 快照 ${snap.get(name)} → 本机 ${v}`);
  }
  for (const name of snap.keys()) {
    if (!loc.has(name)) out.push(`本机没有（快照独有）：${name}`);
  }
  return out;
}

const PROFILE_PICK = (() => {
  const explicit = process.env.ONDRA_PROFILE_SRC;
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!looksLikeProfile(dir)) {
      die(`ONDRA_PROFILE_SRC 指的不是一个 profile：${dir}`,
        '那个目录里应该有 cordis.patch.yml。');
    }
    return { dir, kind: '显式指定（ONDRA_PROFILE_SRC）' };
  }

  // 仓库快照只对应 `ondra` 这一个 profile；换成别的名字时没有快照可用。
  if (PROFILE_NAME === 'ondra' && looksLikeProfile(REPO_PROFILE)) {
    return { dir: REPO_PROFILE, kind: '仓库快照（plugin-profile/）' };
  }

  if (looksLikeProfile(LOCAL_PROFILE)) {
    return {
      dir: LOCAL_PROFILE,
      kind: '本机已装（没有仓库快照，结果取决于这台机器）',
    };
  }

  return null;
})();

if (!PROFILE_PICK) {
  die(`找不到 profile「${PROFILE_NAME}」`,
    '跑一次 `node tool/sync_plugin_profile.mjs` 生成仓库快照，'
    + '或用 ONDRA_PROFILE_SRC 指定一个 profile 目录。');
}

const PROFILE_SRC = PROFILE_PICK.dir;

say(`目标平台 : ${TARGET}`);
say(`node     : ${NODE_BIN}`);
say(`dsh 包   : ${DSH_PKG}`);
say(`profile  : ${PROFILE_SRC}  [${PROFILE_PICK.kind}]`);

// 本机 profile 与仓库快照不一致时要说出来。
//
// 这是「安静地用旧版本」最典型的入口：插件在 `~/Downloads/plugins` 里改完、
// 装进本机 profile 了，但忘了同步快照——打包照样成功，插件却是旧的，只有
// 用户那边才会发现功能没生效。所以不拦，但一定喊一声。
if (PROFILE_PICK.dir === REPO_PROFILE && looksLikeProfile(LOCAL_PROFILE)) {
  const drift = profileDrift(REPO_PROFILE, LOCAL_PROFILE);
  if (drift.length) {
    warn(`本机 profile 与仓库快照不一致（${drift.length} 处），本次打的是**快照**：`);
    for (const line of drift.slice(0, 6)) warn(`    ${line}`);
    if (drift.length > 6) warn(`    …另有 ${drift.length - 6} 处`);
    warn('  想让本机的新插件进包：node tool/sync_plugin_profile.mjs，再提交 plugin-profile/');
  }
}

// ── profile 里按名字挂载的内核包 ────────────────────────────────────────────
// 这一组是整套装配里最容易漏的东西，因为它不出现在任何 `package.json` 里：
// `cordis.patch.yml` 的 `insert:` 用字符串点名 `@deepseek-ai/dsh-llm-pi-ai`，
// 而那个包**没有任何依赖声明引用它**——纯静态依赖遍历永远找不到。
//
// 漏掉的后果不是「功能少一点」，而是内核能装配、一握手就报
// `no adapter registered for provider "magpie"`。
const PROFILE_KERNEL_PKGS = (() => {
  const names = new Set();
  for (const file of ['cordis.yml', 'cordis.patch.yml']) {
    const p = path.join(PROFILE_SRC, file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(/@deepseek-ai\/[A-Za-z0-9._-]+/g)) names.add(m[0]);
  }
  return [...names].sort();
})();

// ── 依赖闭包 ────────────────────────────────────────────────────────────────
//
// ## 为什么有三个根
//
// 单从 `dsh-sdk-minimal` 出发是不够的：真正被启动的是**主包的 `lib/bin.js`**，
// 它自己 import 了 `dsh-app-boot` / `dsh-home-paths` / `commander`。只装
// sdk-minimal 的话，`bin.js` 一跑就 `ERR_MODULE_NOT_FOUND`。
//
// 反过来只从主包 `dependencies` 出发也不行：那是 551 个包、506MB，因为它把
// web 控制台、文档预览、各家 LLM SDK 全算在里面了。
const ENTRY_ROOTS = [
  '@deepseek-ai/dsh-app-boot',   // 从 bin.js 顶部逐个抄下来的，改入口要同步改这里
  '@deepseek-ai/dsh-home-paths',
  'commander',
];
const AGENT_ROOTS = ['@deepseek-ai/dsh-sdk-minimal'];

// 排除清单：明确与「对话内核」无关的重型包。
//
// 为什么需要它：`peerDependencies` 是**松散声明**（宿主与被宿主之间的约定），
// 顺着它递归会把整条应用层依赖链拖进来——最典型的是 LibreOffice：
//   … → dsh-skill-office（peer）→ libreoffice-kit → …-darwin-arm64（148MB）
//
// 判据是「包名」，不是体积：只剔这几类明确无关的，不做「大于多少 MB 就删」
// 那种会误伤核心包的规则。
const PRUNE_PREFIXES = [
  '@deepseek-ai/libreoffice-kit',   // 办公文档转换（含 5 个平台二进制，最大 148MB）
  '@deepseek-ai/dsh-skill-office',  // 办公技能
  '@deepseek-ai/dsh-office-to-pdf',
  '@deepseek-ai/dsh-web-app',       // Web 控制台：空谷自带界面，不用它
  '@deepseek-ai/dsh-client-ui-',    // 桌面/网页 UI 组件：同上
  '@deepseek-ai/dsh-experimental-inspector',   // 调试面板
  '@deepseek-ai/dsh-experimental-liveshare',
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-acp-app',       // ACP 编辑器集成（Zed 等），不是我们的入口
  '@deepseek-ai/dsh-tui-app',       // 终端界面
];

// 精确排除（不是前缀）。
//
// 必须精确的原因：这些名字是别的东西的前缀。`'@deepseek-ai/dsh-tool-pwsh'`
// 如果当前缀用，会连带命中 `@deepseek-ai/dsh-tool-pwsh-persistent`——而后者
// 正是 `dsh-sdk-minimal` 的装配描述里点名的那个（Windows 上的持久终端）。
// 剪掉它，Windows 内核启动时直接 failed to import。
const PRUNE_EXACT = new Set([
  // 非持久版的 PowerShell 工具：内核在 sdk-minimal 里挂的是 persistent 版。
  '@deepseek-ai/dsh-tool-pwsh',
]);

const NODE_MODULES = path.join(DSH_PKG, 'node_modules');
const profileSet = new Set(PROFILE_KERNEL_PKGS);
// 分发仍是「包名 → 一个顶层目录」。不同 importer 若解析到不同实体，明确拒绝，
// 不把嵌套版本偷偷提升/替换成先遇到的版本（同版本号也不代表解析上下文相同）。
const selectedPkgs = new Map();

// NAMED_BY_PATCH 在下面「扫 bundle 的装配描述」时填充，这里先声明：
// isPruned 要认它，否则「被 patch 点名」的包会被排除清单挡在门外。
const NAMED_BY_PATCH = new Set();

/**
 * 从 importer 的真实目录逐级搜索 node_modules，兼容 nested / hoisted / symlink。
 * 不搜索裸父目录，不限制层数，也不借用另一 importer 的缓存结果。
 * 直接读 manifest，避免 package exports 不导出 package.json 时误判缺包。
 */
const pkgDirCache = new Map();
function resolvePkgDir(name, importer) {
  const from = fs.realpathSync(importer);
  const key = JSON.stringify([from, name]);
  if (pkgDirCache.has(key)) return pkgDirCache.get(key);

  let found = null;
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        found = fs.realpathSync(candidate);
        break;
      }
    }
    if (path.dirname(dir) === dir) break;
  }
  pkgDirCache.set(key, found);
  return found;
}

function isPruned(name) {
  // 装配层点名的包一律保留：它真的会被加载，不需要再判断。
  // 排除清单与装配层冲突时，**装配层赢**——那是运行期事实，清单只是预估。
  if (profileSet.has(name) || NAMED_BY_PATCH.has(name)) return false;
  if (PRUNE_EXACT.has(name)) return true;
  return PRUNE_PREFIXES.some((p) => name.startsWith(p));
}

// 缺失按「importer + 包名」记录；可选边先被访问不能掩盖随后出现的必需边。
const unresolved = new Map();

function walk(name, importer, required = true) {
  // 保持原有剪枝规则：装配描述点名的包优先于排除清单。
  if (isPruned(name)) return;
  const dir = resolvePkgDir(name, importer);
  if (!dir) {
    const key = JSON.stringify([importer, name]);
    const previous = unresolved.get(key);
    unresolved.set(key, { name, importer, required: required || !!previous?.required });
    return;
  }
  // 必须先按本次 importer 解析，再判断是否访问过，不能按包名提前返回。
  const selected = selectedPkgs.get(name);
  if (selected && selected !== dir) {
    die(`不兼容的同名依赖来源：${name}`,
      `${selected}\n  ${dir}（importer: ${importer}）\n`
      + '  当前扁平分发不能保证多个源目录的版本/解析上下文一致，请先整理源安装。');
  }
  if (selected) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    die(`依赖 manifest 无法读取：${name}（${dir}）`, err.message);
  }
  selectedPkgs.set(name, dir);
  // optionalDependencies 覆盖同名 dependencies；peer 只有显式 optional 才可缺。
  const optional = data.optionalDependencies || {};
  for (const dep of Object.keys(data.dependencies || {})) {
    if (!Object.hasOwn(optional, dep)) walk(dep, dir);
  }
  for (const dep of Object.keys(data.peerDependencies || {})) {
    walk(dep, dir, data.peerDependenciesMeta?.[dep]?.optional !== true);
  }
  for (const dep of Object.keys(optional)) walk(dep, dir, false);
}

const roots = new Set([...ENTRY_ROOTS, ...AGENT_ROOTS, ...PROFILE_KERNEL_PKGS]);
for (const r of roots) walk(r, DSH_PKG);

// bundle 的装配描述也可能点名没有 manifest 引用的插件。
// 扫到稳定而非限制轮数；每条引用从描述所在包解析，不能丢掉 importer。
const scanned = new Set();
for (;;) {
  const pending = [...selectedPkgs.values()].filter((dir) => !scanned.has(dir));
  if (!pending.length) break;
  for (const pkgRoot of pending) {
    scanned.add(pkgRoot);
    for (const file of ['cordis.yml', 'cordis.patch.yml']) {
      const p = path.join(pkgRoot, file);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/@deepseek-ai\/[A-Za-z0-9._-]+/g)) {
        NAMED_BY_PATCH.add(m[0]);
        walk(m[0], pkgRoot);
      }
    }
  }
}

const NAMED = new Set([...PROFILE_KERNEL_PKGS, ...NAMED_BY_PATCH]);
const missing = [...unresolved.values()];
const requiredMissing = missing.filter((dep) => dep.required);
say(`  装配描述点名的内核包：${NAMED.size} 个`);
if (requiredMissing.length) {
  die(`缺少 ${requiredMissing.length} 个必需依赖（未写入产物，未尝试 npm 补装）`,
    requiredMissing.map(({ name, importer }) => `${name} <- ${importer}`).join('\n  ')
    + '\n  请在源安装中准备匹配版本后重试；不会自动降级到 latest。');
}
if (missing.length) {
  warn(`  ! 缺少 ${missing.length} 个显式可选依赖（不下载）：`
    + missing.map(({ name, importer }) => `${name} <- ${importer}`).join(', '));
}

const CLOSURE = [...selectedPkgs.keys()].sort();
if (!CLOSURE.length) die(`依赖闭包为空：${NODE_MODULES} 里找不到 dsh-sdk-minimal`);
say(`闭包包数 : ${CLOSURE.length}`);

// ── 复制 ────────────────────────────────────────────────────────────────────

// 运行时用不到的文件类型。
//   .ts/.cts/.mts  TypeScript 源码，编译产物才是运行的东西
//   .map           sourcemap，只有调试器要
//   .pdb           Windows 调试符号（npm 包很少带，但自编译的会带）
//   .md            包自带的说明
// 判据来自实测：这些占核心闭包的 61%，删掉后 117MB → 45MB。
const DROP_EXT = new Set([
  '.ts', '.cts', '.mts', '.map', '.pdb', '.md', '.markdown', '.tsbuildinfo', '.flow',
]);

/**
 * 递归复制目录，可按扩展名丢弃，保留符号链接。
 *
 * 不用 `fs.cpSync`：它在处理 `node_modules/.bin` 这类指向不存在目标的链接时
 * 会整棵树报错，而我们要的是「跳过一个坏链接，继续拷其余 5 万个文件」。
 */
function copyTree(src, dst, dropExt, skipLog, skipDirs = new Set()) {
  let kept = 0;
  let dropped = 0;
  const stack = [[src, dst]];
  while (stack.length) {
    const [s, d] = stack.pop();
    fs.mkdirSync(d, { recursive: true });
    let entries;
    try {
      entries = fs.readdirSync(s, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(sp);
          fs.symlinkSync(target, dp);
          kept += 1;
        } catch {
          // 悬空链接、权限、Windows 上无权限建软链：跳过，不影响其余文件。
        }
        continue;
      }
      if (e.isDirectory()) {
        // 计划里已判定为「重复副本」的目录不拷：它稍后由 applyLinks 建成链接。
        // 这样既省掉一次 55MB 的拷贝，也省掉随后的 24 次删除——删除是需要
        // 权限的动作，而拷贝不需要。
        if (skipDirs.has(sp)) continue;
        stack.push([sp, dp]);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (dropExt.has(ext) || (skipLog && ext === '.log')) {
        dropped += 1;
        continue;
      }
      try {
        fs.copyFileSync(sp, dp);
        // 可执行位：插件包里有 shell 脚本与原生小工具，丢了位就跑不起来。
        // Windows 没有这个概念，statSync().mode 判断会直接跳过。
        const mode = fs.statSync(sp).mode;
        if ((mode & 0o111) !== 0) {
          try {
            fs.chmodSync(dp, mode & 0o777);
          } catch {
            /* 改不动就算了，多数文件不需要 */
          }
        }
        kept += 1;
      } catch (err) {
        // Windows 上长路径（>260）会在这里冒出来。报出具体文件，否则只看到
        // 一个 ENAMETOOLONG 根本不知道是哪个包。
        warn(`  ! 复制失败 ${sp}: ${err.code || err.message}`);
      }
    }
  }
  return { kept, dropped };
}

/**
 * 建一个指向目录的链接：POSIX 用相对软链，Windows 用 junction。
 *
 * Windows 上不能照抄软链：`symlink` 需要管理员或开发者模式，而 junction
 * 普通用户就能建（npm 自己也是这么做的）。junction 只支持绝对路径。
 */
function linkDir(targetAbs, linkPath, platform) {
  if (platform === 'windows') {
    fs.symlinkSync(targetAbs, linkPath, 'junction');
  } else {
    fs.symlinkSync(path.relative(path.dirname(linkPath), targetAbs), linkPath);
  }
}

/** 一个包目录的指纹：只算「会被拷走」的文件（相对路径 + 大小 + 内容）。 */
function fingerprint(dir, dropExt) {
  const hash = crypto.createHash('sha1');
  const stack = [dir];
  const files = [];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      // 只对「会被拷走」的文件取指纹：两边各带一份 .ts 的差异不该让一个
      // 本可以合并的副本被跳过。
      else if (e.isFile() && !dropExt.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  }
  files.sort();
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    hash.update(path.relative(dir, f));
    hash.update('\0');
    hash.update(String(st.size));
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(f));
    } catch {
      /* 读不到就不参与内容哈希，但路径与大小仍在 */
    }
  }
  return hash.digest('hex');
}

/**
 * 规划嵌套副本去重。**在拷贝之前**做，不是在拷贝之后。
 *
 * ## 为什么会有几十 MB 的重复
 *
 * npm 安装时，若某个包要求 `zod@4.4.3` 而顶层已被别的包顶到 `4.6.7`，版本冲突
 * 无法提升，npm 就把 4.4.3 **完整嵌套复制**到每个依赖它的包下面。dsh 有 25 个
 * 包 pin 了同一个 `zod@4.4.3`，于是同一份 2.2MB 被复制了 25 遍。
 *
 * ## 为什么先规划再拷贝
 *
 * 上一版是「先拷 55MB、再删掉 40MB 换成链接」。那两条路都要动文件系统，而后
 * 半段（删除）是需要权限的动作：目录被占用、杀软扫描、只读介质上都会失败，
 * 失败一次就留下一份多余的实体——正好是想避免的结果。
 *
 * 先规划则一次多余的文件都不落地。
 *
 * ## 安全边界
 *
 * 只合并**逐字节相同**的副本（全文件指纹判定），保留一份实体，其余用链接。
 * 同内容 ⇒ 行为完全一致，不涉及任何版本判断，所以不存在「用 4.6.7 顶替 4.4.3」
 * 这类语义风险。指纹不同就不合并。
 */
function planNestedDedup(pkgRoots, dropExt) {
  // pkgRoots: [{ name, dir }]。
  //
  // dir 不一定在同一个 node_modules 下——`npm install -g` 会把依赖 hoist 到
  // prefix 根。所以目标路径不能靠「相对某个根目录」算，必须记着每个副本属于
  // 哪个闭包包（rootName），落地时用它拼目标位置。
  const candidates = [];
  // **只从闭包内的包出发遍历。**
  //
  // 从 node_modules 根开始走虽然更简单，但会把已剪掉的子树（LibreOffice、
  // client-ui…）里的副本也算进来：那些目录根本不会被拷走，把它们计入
  // 「省下多少」是虚数，更糟的是 `.dedupe` 会把它们的实体拷进来——净效果
  // 等于把剪掉的东西请回来。
  const stack = pkgRoots.map((p) => ({ dir: p.dir, rootName: p.name }));
  while (stack.length) {
    const { dir: cur, rootName } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    // 遍历从**包目录**出发，所以遇到的任何 node_modules 都是包自带的副本。
    // 上一版用「相对路径的层数 >= 2」当判据，会漏掉非 scoped 包的
    // `pkg/node_modules/...`（层数只有 1）——dsh 的包几乎都是 @deepseek-ai/*，
    // 所以那个漏洞一直没显形。
    if (path.basename(cur) === 'node_modules') {
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const full = path.join(cur, e.name);
        if (e.name.startsWith('@')) {
          let subs;
          try {
            subs = fs.readdirSync(full, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const sub of subs) {
            if (sub.isDirectory() && !sub.isSymbolicLink()) {
              candidates.push({
                name: `${e.name}/${sub.name}`,
                dir: path.join(full, sub.name),
                rootName,
              });
            }
          }
        } else {
          candidates.push({ name: e.name, dir: full, rootName });
        }
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        stack.push({ dir: path.join(cur, e.name), rootName });
      }
    }
  }

  const groups = new Map();
  for (const c of candidates) {
    const fp = fingerprint(c.dir, dropExt);
    const key = `${c.name}@${fp}`;
    if (!groups.has(key)) groups.set(key, { name: c.name, fp, members: [] });
    groups.get(key).members.push({ rootName: c.rootName, dir: c.dir });
  }

  const plan = { skip: new Set(), groups: [], saved: 0 };
  for (const { name, fp, members } of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => (a.dir < b.dir ? -1 : 1));
    let version = 'unknown';
    try {
      version = JSON.parse(
        fs.readFileSync(path.join(members[0].dir, 'package.json'), 'utf8'),
      ).version || version;
    } catch { /* 没有 package.json 就用 unknown */ }

    for (const m of members) plan.skip.add(m.dir);
    plan.groups.push({
      name,
      // 指纹前缀防止「同名同版本但内容不同」的两组撞到同一个实体目录
      key: `${name.replace('/', '+')}@${version}-${fp.slice(0, 8)}`,
      canonicalSrc: members[0].dir,
      members,
    });
    for (const m of members.slice(1)) plan.saved += dirSize(m.dir);
  }
  return plan;
}

/** 按计划落地：先拷一份实体到 `.dedupe/`，再在原位建链接。 */
function applyDedupPlan(pkgRoots, nmDest, plan, dropExt) {
  // `pkgRoots` 是「包名 → 源目录」：源可能分散在 hoist 后的多个 node_modules
  // 下，所以每个副本的绝对路径要靠它的 rootName 翻回产物里的位置。
  const destOf = (m) => path.join(
    nmDest,
    m.rootName,
    path.relative(pkgRoots.get(m.rootName), m.dir),
  );
  let linked = 0;
  let fallback = 0;

  for (const g of plan.groups) {
    const canonicalDest = path.join(nmDest, '.dedupe', g.key);
    const copied = copyTree(g.canonicalSrc, canonicalDest, dropExt, false);
    if (!copied.kept) {
      // 实体一个文件都没拷进来（读不到），整组退回原样拷贝，
      // 否则这一组的每一个位置都会指向一个空目录。
      for (const m of g.members) copyTree(m.dir, destOf(m), dropExt, false);
      fallback += g.members.length;
      continue;
    }
    for (const m of g.members) {
      const dest = destOf(m);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        linkDir(canonicalDest, dest, PLATFORM);
        fs.readdirSync(dest); // 确认能解析：建得出来但解析不了等于没有
        linked += 1;
      } catch {
        // 链接不可用（无权限 / 文件系统不支持 / 跨卷）：原件还在源目录里，
        // 直接拷过来。这一处没省下空间，但包是完整的。
        try {
          fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
        } catch { /* 目标本来就不存在 */ }
        copyTree(m.dir, dest, dropExt, false);
        fallback += 1;
      }
    }
  }
  return { linked, fallback };
}

// ── Windows 的 sqlite3.exe ──────────────────────────────────────────────────
//
// 状态面板、记忆星图、导入导出三处靠 sqlite3 命令行读 `ondra.db`。macOS 自带
// `/usr/bin/sqlite3`，Windows 没有——不随包带一份，那三处在 Windows 上会**安静地
// 显示「没有数据」**，而不是报错。所以 Windows 必须内置。
//
// 来源优先级：显式环境变量 → 本机已有 → sqlite.org 官方二进制（带 SHA3-256 校验）。
// 取不到只警告不中断：内核照常可用，那三页会如实提示缺工具。
async function fetchSqlite(destDir) {
  if (!IS_WIN) return null;
  if (process.env.ONDRA_SKIP_SQLITE === '1') {
    say('  sqlite3 : 已按 ONDRA_SKIP_SQLITE 跳过');
    return null;
  }

  const dest = path.join(destDir, SQLITE_NAME);
  const explicit = process.env.ONDRA_SQLITE3_BIN;
  if (explicit && fs.existsSync(explicit)) {
    fs.copyFileSync(explicit, dest);
    say(`  sqlite3 : 用 ${explicit}`);
    return 'explicit';
  }

  const localCandidates = [
    'C:\\ProgramData\\chocolatey\\bin\\sqlite3.exe',
    'C:\\Program Files\\sqlite\\sqlite3.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'sqlite3.exe')
      : null,
  ].filter(Boolean);
  for (const c of localCandidates) {
    if (fs.existsSync(c)) {
      fs.copyFileSync(c, dest);
      say(`  sqlite3 : 用本机 ${c}`);
      return 'local';
    }
  }

  // sqlite.org 的下载页内嵌了一段机器可读的 CSV（PRODUCT,VERSION,URL,SIZE,SHA3），
  // 官方文档写明了这段格式专供脚本读取、且只会在右侧追加列。所以不写死版本号，
  // 每次取当前发布版；哈希来自同一份数据，校验通过才算数。
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-sqlite-'));
  try {
    const page = await (await fetch('https://www.sqlite.org/download.html')).text();
    const line = page.split('\n').find(
      (l) => l.startsWith('PRODUCT,') && l.includes('sqlite-tools-win-x64-'),
    );
    if (!line) throw new Error('下载页里没找到 sqlite-tools-win-x64 条目');

    const [, version, relUrl, , sha3] = line.split(',');
    const zipPath = path.join(work, 'tools.zip');
    const buf = Buffer.from(await (await fetch(`https://www.sqlite.org/${relUrl}`)).arrayBuffer());
    const actual = crypto.createHash('sha3-256').update(buf).digest('hex');
    if (sha3 && actual !== sha3) {
      throw new Error(`SHA3-256 不匹配（官方 ${sha3}，实得 ${actual}）`);
    }
    fs.writeFileSync(zipPath, buf);

    // 解压：Windows 10 1803+ 自带 bsdtar（%SystemRoot%\System32\tar.exe），
    // macOS / Linux 的 bsdtar 也支持 zip。都没有就退回 PowerShell。
    let unpacked = spawnSync('tar', ['-xf', zipPath, '-C', work], { encoding: 'utf8' });
    if (unpacked.status !== 0) {
      spawnSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${work}' -Force`,
      ], { encoding: 'utf8' });
    }

    const found = [];
    const walkFind = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkFind(p);
        else if (e.name.toLowerCase() === SQLITE_NAME) found.push(p);
      }
    };
    walkFind(work);
    if (!found.length) throw new Error('压缩包里没有 sqlite3.exe');

    fs.copyFileSync(found[0], dest);
    say(`  sqlite3 : 取自 sqlite.org ${version}（SHA3-256 校验通过）`);
    return 'download';
  } catch (err) {
    warn(`  ! sqlite3.exe 没取到：${err.message}`);
    warn('    内核不受影响，但状态面板/记忆星图/导入导出会读不到数据。');
    warn('    可以设 ONDRA_SQLITE3_BIN 指向本机的 sqlite3.exe 后重跑。');
    return null;
  } finally {
    rimrafQuietly(work, '下载中转目录');
  }
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

const OUT = path.join(REPO, 'runtime', TARGET);

// 依赖源在只读预检里已经确定；真实复制和 dry-run 共用同一份去重计划。
const pkgRoots = new Map(CLOSURE.map((name) => [name, selectedPkgs.get(name)]));
const plan = planNestedDedup(
  [...pkgRoots].map(([name, dir]) => ({ name, dir })),
  DROP_EXT,
);

/** 只读估算要复制的普通文件字节数：与 copyTree 使用相同过滤条件，不跟随链接。 */
function copySize(src, dropExt, skipLog = false, skipDirs = new Set()) {
  if (!fs.existsSync(src)) return 0;
  let bytes = 0;
  const stack = [src];
  while (stack.length) {
    const cur = stack.pop();
    const stat = fs.lstatSync(cur);
    if (stat.isSymbolicLink() || skipDirs.has(cur)) continue;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
    } else if (stat.isFile()) {
      const ext = path.extname(cur).toLowerCase();
      if (!dropExt.has(ext) && !(skipLog && ext === '.log')) bytes += stat.size;
    }
  }
  return bytes;
}

async function copyPayload(dest) {
  fs.mkdirSync(dest, { recursive: true });

  // 1) node 可执行。只拷二进制，不拷 npm——应用只把它当解释器用。
  const nodeDest = path.join(dest, NODE_NAME);
  fs.copyFileSync(NODE_BIN, nodeDest);
  if (!IS_WIN) fs.chmodSync(nodeDest, 0o755);

  // 2) dsh 自身的骨架：package.json + lib（bin.js 在这里）。
  const dshDest = path.join(dest, 'dsh');
  fs.mkdirSync(dshDest, { recursive: true });
  fs.copyFileSync(path.join(DSH_PKG, 'package.json'), path.join(dshDest, 'package.json'));
  for (const sub of ['lib', 'dist']) {
    const src = path.join(DSH_PKG, sub);
    if (fs.existsSync(src)) {
      copyTree(src, path.join(dshDest, sub), new Set(), false);
    }
  }

  // 3) 依赖闭包，按 DROP_EXT 过滤。重复副本**一开始就不拷**：先规划，把
  //    要合并的目录排除在拷贝之外，稍后只拷一份实体并建链接。
  const nmDest = path.join(dshDest, 'node_modules');
  let kept = 0;
  let dropped = 0;
  for (const [name, dir] of pkgRoots) {
    const r = copyTree(
      dir,
      path.join(nmDest, name),
      DROP_EXT,
      false,
      plan.skip,
    );
    kept += r.kept;
    dropped += r.dropped;
  }
  say(`  闭包：保留 ${kept} 个文件，丢弃 ${dropped} 个`);

  // 4) 去重落地。
  if (plan.groups.length) {
    const applied = applyDedupPlan(pkgRoots, nmDest, plan, DROP_EXT);
    const tail = applied.fallback
      ? `，${applied.fallback} 处链接不可用已改回实体`
      : '';
    say(`  去重 ${applied.linked} 处重复副本，省下 ${mb(plan.saved)}${tail}`);
  }

  // 5) profile 种子。额外剔掉 .log：那是本机调试留下的，属于数据不属于装配层。
  const p = copyTree(PROFILE_SRC, path.join(dest, 'profile'), DROP_EXT, true);
  say(`  profile：保留 ${p.kept} 个文件，丢弃 ${p.dropped} 个`);

  // 6) 把装配描述点名的内核包补进**拷贝出来的** package.json。
  //
  // 光把文件拷进 node_modules 不够：`dsh-app-boot` 的解析拦截只路由从内核
  // package.json 依赖图递归出来的包。不在表里的，从 profile 目录 import 会落到
  // Node 原生解析，而 profile 的 node_modules 里没有它：
  //
  //   llm-magpie (@deepseek-ai/dsh-llm-pi-ai): failed to import:
  //   Cannot find package '@deepseek-ai/dsh-llm-pi-ai'
  //
  // 版本号照抄拷贝过来的真实值，不猜。产物里没有的（被排除）不补——补一条指向
  // 不存在目录的声明只会把问题推到更晚的地方。
  const manifestPath = path.join(dshDest, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = manifest.dependencies || {};
  const added = [];
  for (const name of NAMED) {
    if (manifest.dependencies[name]) continue;
    try {
      const v = JSON.parse(
        fs.readFileSync(path.join(dshDest, 'node_modules', name, 'package.json'), 'utf8'),
      ).version;
      if (!v) continue;
      manifest.dependencies[name] = v;
      added.push(name);
    } catch {
      /* 产物里没有它，跳过 */
    }
  }
  if (added.length) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    say(`  补声明 ${added.length} 个被点名的内核包：${added.join(', ')}`);
  }

  // 7) Windows 的 sqlite3.exe。
  await fetchSqlite(dest);
}

// dry-run 不碰已有产物：它承诺的是「只看体积」。删了再算，等于把上一次
// 验证过的成品当赌注——中途失败就没得回退。
if (dryRun) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-runtime-'));
  await copyPayload(tmp);
  say('── dry-run 体积 ──');
  for (const item of ['node', 'dsh', 'profile']) {
    const p = path.join(tmp, IS_WIN ? 'node.exe' : 'node');
    const target = item === 'node' ? p : path.join(tmp, item);
    if (fs.existsSync(target)) say(`  ${item.padEnd(8)}: ${mb(sizeOf(target))}`);
  }
  say(`  合计    : ${mb(sizeOf(tmp))}`);
  rimrafQuietly(tmp, 'dry-run 临时目录');
  process.exit(0);
}

// 清掉旧产物：增量拷贝会留下上一次的包，越滚越大。
// 这里失败必须停下：带着上次的残留继续拷，会产出「看起来成功、其实混了两个
// 版本」的运行时，而那种东西只有用户那边才会暴露。
if (fs.existsSync(OUT)) {
  try {
    rimraf(OUT);
  } catch (err) {
    die(`删不掉旧产物 ${OUT}（${err.code || err.message}）`,
      '手动删掉它再重跑：可能有进程正占用里面的 node。');
  }
}

await copyPayload(OUT);

say(`── 产出 ${path.relative(REPO, OUT)} ──`);
for (const item of ['node', 'dsh', 'profile']) {
  const target = item === 'node' ? path.join(OUT, NODE_NAME) : path.join(OUT, item);
  if (fs.existsSync(target)) say(`  ${item.padEnd(8)}: ${mb(sizeOf(target))}`);
}
const sqlitePath = path.join(OUT, SQLITE_NAME);
if (fs.existsSync(sqlitePath)) say(`  sqlite3 : ${mb(sizeOf(sqlitePath))}`);
say(`  合计    : ${mb(sizeOf(OUT))}`);

// ── 自检 ────────────────────────────────────────────────────────────────────
//
// **不能只测 `--version`。** 那只验证「入口脚本能被解析」，而真正会出问题的是
// 某个被裁掉的包在装配插件树时才 require——`--version` 那时早就退出了。
//
// 四步，一层比一层深：
//   1. `--help`           入口能跑
//   2. `--dump-config`    插件树能装配（sdk-minimal）
//   3. 铺种子后 dump      应用真正会用的那个 profile 能装配
//   4. 真握手             initialize 成功且没有插件 import 失败
//
// 第 4 步抓的是前两步**结构上看不到**的那类问题：装配通过、进程能起，第一次
// 选路才报 `no adapter registered for provider "magpie"`。前两个版本的 bug
// 全是靠它抓出来的，所以它不是可选项。

const nodeOut = path.join(OUT, NODE_NAME);
const dshEntry = path.join(OUT, 'dsh', 'lib', 'bin.js');
const envBase = { ...process.env };

function run(args, env, opts = {}) {
  return spawnSync(nodeOut, [dshEntry, ...args], {
    encoding: 'utf8',
    env: { ...envBase, ...env },
    timeout: opts.timeout ?? 120000,
    windowsHide: true,
  });
}

say('── 自检 ──');

const help = run(['--help'], {});
if (help.status !== 0) {
  die(`入口跑不起来：${dshEntry}`, String(help.stderr || help.error || '').split('\n').slice(0, 5).join('\n'));
}
say('  ✓ 入口可执行');

// 用一次性 DSH_HOME 做装配，不碰用户真实的 ~/.ondra/dsh。
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-probe-'));
try {
  const dump = run(['--profile', 'sdk-minimal', '--dump-config'], { DSH_HOME: probeHome });
  if (dump.status !== 0) {
    die('插件树装配失败（sdk-minimal）', String(dump.stderr || '').split('\n').slice(0, 12).join('\n'));
  }
  say('  ✓ 插件树可装配（sdk-minimal）');

  // ondra profile 单独验：这是应用真正启动的那一个。必须走「把种子铺进空
  // DSH_HOME」这条路径，而不是直接读本机已有的 ~/.ondra/dsh/profiles/ondra——
  // 那样验的是本机安装，不是包里的这一份。应用首次启动做的就是这件事
  // （lib/app/runtime_seed_io.dart），这里先替它跑一遍。
  const seedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ondra-seed-'));
  try {
    const profileDest = path.join(seedHome, 'profiles', PROFILE_NAME);
    fs.mkdirSync(path.dirname(profileDest), { recursive: true });
    fs.cpSync(path.join(OUT, 'profile'), profileDest, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });

    const seeded = run(['--profile', PROFILE_NAME, '--dump-config'], { DSH_HOME: seedHome });
    if (seeded.status !== 0) {
      die(`profile 种子装配失败（${PROFILE_NAME}）`,
        String(seeded.stderr || '').split('\n').slice(0, 12).join('\n'));
    }
    let pluginCount = 0;
    try {
      pluginCount = fs.readdirSync(path.join(profileDest, 'node_modules', '@ondra')).length;
    } catch { /* 没有 @ondra 目录不影响结论 */ }
    say(`  ✓ profile 种子可装配（${PROFILE_NAME}，${pluginCount} 个插件包）`);

    // 真握手。provider 用 `deepseek-official`：它是内建兜底，任何环境下都能
    // 选路，这样这条检查只测「加载」，不测「用户配的网关通不通」。
    const hs = await handshake(seedHome, PROFILE_NAME);
    if (!hs.out.includes('"result"')) {
      die('握手失败（stdout 里没有 result）',
        `${hs.out.split('\n').slice(0, 3).join('\n')}\n${hs.err.split('\n').slice(0, 8).join('\n')}`);
    }
    if (hs.err.includes('failed to import')) {
      const lines = hs.err.split('\n');
      const idx = lines.findIndex((l) => l.includes('failed to import'));
      die('有插件没能 import（打包时丢掉或被排除了）', lines.slice(idx, idx + 3).join('\n'));
    }
    say('  ✓ 真握手成功，全部插件 import 通过');
  } finally {
    rimrafQuietly(seedHome, '自检用的种子目录');
  }
} finally {
  rimrafQuietly(probeHome, '自检用的 DSH_HOME');
}

/**
 * 起一次真实内核，发一条 `initialize`，等 `"result"` 或超时。
 *
 * 用 spawn 而不是 spawnSync：要一边发 stdin 一边收 stdout，同步接口做不到。
 */
function handshake(home, profile) {
  return new Promise((resolve) => {
    const req = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { cwd: home, provider: 'deepseek-official', model: 'deepseek-chat' },
    });
    const child = spawn(nodeOut, [dshEntry, '--profile', profile], {
      env: { ...envBase, DSH_HOME: home, MAGPIE_API_KEY: 'local-loopback' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const done = () => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch { /* 已经退了 */ }
      resolve({ out, err });
    };
    // 4 秒够内核把 77 个插件挂完；更久说明卡住了，报超时比一直挂着好。
    const timer = setTimeout(() => {
      resolve({ out, err: `${err}\n[超时] 4 秒内没有收到 result` });
      try {
        child.kill();
      } catch { /* 已经退了 */ }
    }, 4000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"result"')) done();
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', done);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ out, err: `${err}\n[spawn 失败] ${e.message}` });
    });
    child.stdin.write(`${req}\n`);
    child.stdin.end();
  });
}

// 原生模块单独验一次：它们不走 JS 解析，缺了只会在真正调用时炸。
//
// **必须在 `dsh` 目录里跑。** `require('koffi')` 是按当前目录向上找
// `node_modules` 的；在仓库根目录跑会去找 Ondra 自己的 node_modules，找不到
// 就报「加载失败」——这是假阴性，第一版自检就这么误报了两个模块。
for (const native of ['node-pty', 'koffi']) {
  if (!fs.existsSync(path.join(OUT, 'dsh', 'node_modules', native))) continue;
  const probe = spawnSync(nodeOut, ['-e', `require('${native}')`], {
    cwd: path.join(OUT, 'dsh'),
    encoding: 'utf8',
    timeout: 60000,
  });
  if (probe.status === 0) {
    say(`  ✓ 原生模块 ${native} 可加载`);
  } else {
    // 不致命：ondra 的对话链路不用终端与 FFI。但要如实说出来，
    // 免得以后有人以为它在包里就能用。
    say(`  ! 原生模块 ${native} 加载失败（对话链路不依赖它，记录备查）`);
  }
}

say('完成。');
