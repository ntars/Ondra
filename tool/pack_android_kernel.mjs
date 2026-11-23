// 安卓内核打包：把「node 运行时 + dsh 闭包」做成 Android 可直接用的形态。
//
//   android/app/src/main/jniLibs/arm64-v8a/
//     ├── libnode.so            ← node 本体（Termux 编译的 bionic ELF，
//     │                            伪装成 .so 才会被打进 APK 并提取到
//     │                            nativeLibraryDir——那是安卓上唯一允许
//     │                            exec 的位置；app 数据目录被 W^X 禁了）
//     ├── libc++_shared.so      ← node 的 9 个动态依赖（Termux 同源包）
//     └── …
//   android/app/src/main/assets/ondra-dsh.tar.gz
//                               ← dsh 依赖闭包，首次启动解压到应用私有目录
//
// 依赖来自 Termux main 仓库（Node 26.13.1 aarch64，满足 dsh 的 node>=24.9）。
// 这些库全部是安卓 bionic 动态链接，与系统 libc 兼容；node 的 DT_NEEDED
// 走 LD_LIBRARY_PATH=$nativeLibraryDir 兜底。
//
// 用法：node tool/pack_android_kernel.mjs [--closure <闭包目录>]
//   --closure 缺省用 runtime/closure/dsh（assemble_runtime.mjs --closure-only
//   的产物）。产物不进 git，CI 每次现拉现打。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = path.resolve(import.meta.dirname, '..');
const JNILIBS = path.join(REPO, 'android/app/src/main/jniLibs/arm64-v8a');
const ASSETS = path.join(REPO, 'android/app/src/main/assets');
const REPO_MIRROR = 'https://packages.termux.dev/apt/termux-main';

// node 的 DT_NEEDED 清单（2026-11-20 实测 readelf），映射到 Termux 包名。
// libc/libdl/libm 是系统 bionic，不带走。
const PACKAGES = [
  'nodejs',
  'libc++',
  'c-ares',
  'openssl',
  'libffi',
  'libicu',
  'libsqlite',
  'zlib',
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function download(url, dest) {
  execFileSync('curl', ['-sL', '-o', dest, url], { stdio: 'pipe' });
}

function say(msg) {
  console.log(msg);
}

function die(msg, hint) {
  console.error(`✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** 从 Packages 索引里找包对应的 .deb 下载地址与版本。 */
function resolvePackages() {
  say('拉取 Termux 包索引（aarch64）…');
  const indexFile = '/tmp/ondra-termux-index';
  download(`${REPO_MIRROR}/dists/stable/main/binary-aarch64/Packages`, indexFile);
  const index = fs.readFileSync(indexFile, 'utf8');
  const out = {};
  for (const name of PACKAGES) {
    const re = new RegExp(`^Package: ${name.replace(/[+]/g, '\\+')}$([\\s\\S]*?)^\\s*$`, 'm');
    const m = index.match(re);
    if (!m) die(`索引里找不到包 ${name}`);
    const block = m[0];
    const ver = block.match(/^Version: (.+)$/m)?.[1] ?? '?';
    const file = block.match(/^Filename: (.+)$/m)?.[1];
    if (!file) die(`包 ${name} 没有 Filename`);
    out[name] = { url: `${REPO_MIRROR}/${file}`, version: ver, file: path.basename(file) };
  }
  return out;
}

/**
 * 从 deb 里取出 data.tar.xz。deb 是 GNU ar 格式，mac 的 BSD ar 对它
 * 的成员名（尾带 /）不认——手写解析：8 字节 magic + 60 字节成员头。
 */
function extractDataTarXz(deb, dest) {
  const magic = fs.readFileSync(deb);
  if (magic.subarray(0, 8).toString() !== '!<arch>\n') die(`${deb} 不是 ar 包`);
  let off = 8;
  while (off + 60 <= magic.length) {
    const name = magic.subarray(off, off + 16).toString().trim().replace(/\/+$/, '');
    const size = Number(magic.subarray(off + 48, off + 58).toString().trim());
    if (Number.isNaN(size)) die(`${deb} 成员头损坏 @${off}`);
    const body = magic.subarray(off + 60, off + 60 + size);
    if (process.env.ONDRA_DEBUG_AR) {
      say(`  [ar] member: ${JSON.stringify(name)} size=${size}`);
    }
    if (name === 'data.tar.xz') {
      fs.writeFileSync(dest, body);
      return dest;
    }
    off += 60 + size + (size % 2); // 成员按 2 字节对齐
  }
  die(`${deb} 里没有 data.tar.xz`);
}

/** 下载 deb 并把 data.tar.xz 里的给定路径抽出来。 */
function extractFromDeb(tmp, url, wantPath) {
  const deb = path.join(tmp, path.basename(url));
  download(url, deb);
  const tarXz = path.join(tmp, 'data.tar.xz');
  extractDataTarXz(deb, tarXz);
  // 一律全量展开，不用 pattern：deb 的 data.tar.xz 里路径可能带 `./`
  // 前缀（./data/data/…），GNU tar（CI ubuntu）的成员匹配是精确的，
  // pattern 对不上就整个失败；mac 的 bsdtar 宽松所以本地测不出来。
  // 展开后的路径是归一化的（./data → data），按展开后的真实路径找。
  run('tar', ['-xf', tarXz, '-C', tmp]);
  if (wantPath) {
    const exact = path.join(tmp, wantPath);
    if (fs.existsSync(exact)) return exact;
    die(`展开的包里没有 ${wantPath}`);
  }
  // wantPath 是空字符串时 ?? 不会兜底（'' 不是 nullish）——用 ||。
  return path.join(tmp, wantPath || 'data/data/com.termux/files/usr/lib');
}

async function main() {
  // 1) 闭包来源。
  let closure = REPO;
  const flagIdx = process.argv.indexOf('--closure');
  if (flagIdx > 0) closure = path.resolve(process.argv[flagIdx + 1]);
  else closure = path.join(REPO, 'runtime', 'closure', 'dsh');
  if (!fs.existsSync(path.join(closure, 'lib', 'bin.js'))) {
    die(`闭包里没有 lib/bin.js：${closure}`,
      '先跑 node tool/assemble_runtime.mjs --closure-only');
  }

  // 2) 下载 node 与依赖。
  fs.rmSync(JNILIBS, { recursive: true, force: true });
  fs.mkdirSync(JNILIBS, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  const tmp = fs.mkdtempSync('/tmp/ondra-android-');
  const resolved = resolvePackages();
  const manifest = [];
  // node 的 NEEDED（patch 后的名字）白名单：依赖包里同名之外的一律不收
  //（termux 包里还带着 SONAME 变体与调试副本，全拷会多出十几 MB）。
  const keepLibs = [
    'libz.so',
    'libcares.so',
    'libsqlite3.so',
    'libffi.so',
    'libcrypto.so',
    'libssl.so',
    'libicui18n.so',
    'libicuuc.so',
    'libicudata.so',
    'libc++_shared.so',
  ];

  for (const [name, info] of Object.entries(resolved)) {
    say(`下载 ${name} ${info.version} …`);
    const want = name === 'nodejs' ? 'data/data/com.termux/files/usr/bin/node' : '';
    const extracted = extractFromDeb(tmp, info.url, want);
    if (name === 'nodejs') {
      // node 本体：改名 libnode.so 才会被 APK 提取到 nativeLibraryDir。
      const dest = path.join(JNILIBS, 'libnode.so');
      fs.copyFileSync(extracted, dest);
      fs.chmodSync(dest, 0o755);
      // Termux 的 NEEDED 带版本号（libz.so.1 等），APK 只收 lib*.so 结尾——
      // 原地把 NEEDED 改短（patch_android_needed.py 用 pyelftools）。
      run('python3', [path.join(REPO, 'tool', 'patch_android_needed.py'), dest]);
      manifest.push(`libnode.so ← nodejs ${info.version}`);
    } else {
      // 依赖库：extracted 本身就是 lib 目录（依赖包按目录提取），不再 dirname。
      for (const f of keepLibs) {
        const src = path.join(extracted, f);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(JNILIBS, f);
        if (fs.existsSync(dest)) continue; // 同名库取第一个包的
        fs.copyFileSync(src, dest);
        // 依赖库的 NEEDED / SONAME 也可能带 .so.79 这类版本后缀；APK 不收
        // 这些文件，原地改短，与 node 本体的处理保持一致。SONAME 也必须改：
        // linker 会拿 verneed 里的库名与候选库的 SONAME 精确匹配。
        run('python3', [path.join(REPO, 'tool', 'patch_android_needed.py'), dest]);
        manifest.push(`${f} ← ${name} ${info.version}`);
      }
    }
  }

  // 3) 闭包 → assets/ondra-dsh.zip。裁掉各平台 prebuilds 与
  //    原生模块产物：安卓上没有对应编译件，留着只会撑大 APK。
  //    例外：build_android_addons.sh 产出的 Android arm64 绑定必须保留，
  //    它们是 dsh 启动期访问 Node 内部模块与 flock 会话锁的硬依赖。
  let pruned = 0;
  const orig = path.join(tmp, 'closure-src');
  fs.cpSync(closure, orig, { recursive: true });
  const addonRoot = path.resolve(process.env.ONDRA_ANDROID_ADDONS || path.join(REPO, 'build', 'android-addons'));
  if (!fs.existsSync(addonRoot)) {
    die('缺少 Android arm64 原生绑定',
      '先执行 bash tool/build_android_addons.sh');
  }
  const androidPackages = [
    'node-addon-require-builtin-android-arm64',
    '@deepseek-ai/node-addon-system-android-arm64',
  ];
  for (const name of androidPackages) {
    const src = path.join(addonRoot, name);
    if (!fs.existsSync(src)) die(`原生绑定目录不存在：${src}`);
    fs.cpSync(src, path.join(orig, 'node_modules', name), { recursive: true });
  }
  const pruneDirs = [];
  // 安卓专用绑定是刻意打进来的；修剪规则不能把它们的 .node 一起删掉。
  const keepAddonPath = (p) => androidPackages.some((name) => p.includes(`/node_modules/${name}/`));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (keepAddonPath(p)) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'prebuilds' || entry.name === 'prebuilt') {
          pruneDirs.push(p);
          continue;
        }
        if (entry.name === 'build' && fs.existsSync(path.join(p, 'Release'))) {
          pruneDirs.push(p);
          continue;
        }
        walk(p);
      } else if (/\.node$|\.pdb$|\.dll$|\.dylib$/.test(entry.name)) {
        fs.rmSync(p);
        pruned++;
      }
    }
  };
  walk(orig);
  for (const p of pruneDirs) fs.rmSync(p, { recursive: true, force: true });
  // dsh 的 profile 模板必须叫 cordis.yml；plugin-profile 仓库快照在
  // 本机装配时可能只有 cordis.patch.yml（叠加层），单独用它会报
  // `profile "ondra" does not exist`。补一份与插件快照合成后的基文件。
  const packagedProfile = path.join(orig, 'profile', 'cordis.yml');
  if (!fs.existsSync(packagedProfile)) {
    const pluginProfile = path.join(REPO, 'plugin-profile', 'cordis.yml');
    if (!fs.existsSync(pluginProfile)) {
      die('闭包 profile 里没有 cordis.yml',
        '先确认 plugin-profile/cordis.yml 存在，或手工提供 profile 基文件');
    }
    fs.copyFileSync(pluginProfile, packagedProfile);
    manifest.push('cordis.yml ← plugin-profile/cordis.yml');
  }
  // 不能用 .tar.gz：aapt2 会把 assets 里的 .gz 透明解压（APK 里变成
  // 解压后的 .tar，体积翻 7 倍）。zip 无此待遇，且 archive 包解码最简单。
  const zipDest = path.join(ASSETS, 'ondra-dsh.zip');
  fs.rmSync(zipDest, { force: true });
  // cpSync(closure, orig) 把 dsh 的**内容**拷到 orig 根（dest 不存在时
  // cpSync 直接成为副本），所以 zip 的源是当前目录本身。
  // profile 种子跟闭包一起进包：安卓端解压后靠它 seed，来源与桌面同一份
  //（仓库快照 plugin-profile/，CI 上不需要本机 profile）。
  const profileSrc = path.join(closure, '..', 'profile');
  if (fs.existsSync(profileSrc)) {
    fs.cpSync(profileSrc, path.join(orig, 'profile'), { recursive: true });
  }
  run('zip', ['-rqy', zipDest, '.'], {
    cwd: orig,
  });
  manifest.push(`ondra-dsh.zip ← ${closure}（裁掉 ${pruned} 个非安卓产物）`);

  // 4) 清理与清单。
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(JNILIBS, 'ANDROID_KERNEL_MANIFEST.txt'), `${manifest.join('\n')}\n`);
  say(`── 产出 ──`);
  for (const f of fs.readdirSync(JNILIBS)) {
    say(`  jniLibs/arm64-v8a/${f.padEnd(22)} ${mb(fs.statSync(path.join(JNILIBS, f)).size)}`);
  }
  say(`  assets/ondra-dsh.zip           ${mb(fs.statSync(zipDest).size)}`);
  say('完成。');
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((e) => die(e.message, [e.stderr, e.stdout, e.stack?.split('\n').slice(0, 4).join('\n')].filter(Boolean).join('\n---\n')));
