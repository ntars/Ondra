#!/usr/bin/env bash
# 构建 dsh 官方在 Android 上缺失的两个 N-API 绑定。
#
# - node-addon-require-builtin：启动期访问 Node 内部模块必需；
# - @deepseek-ai/node-addon-system：dsh 会话写入锁 flock 必需。
#
# 输入来自已打包的 $DSH_HOME/node_modules、Node 头文件与 Android NDK；
# 产物是可直接塞进 ondra-dsh.zip 的 npm 包目录。仅支持 Android arm64。
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT="${1:-$REPO/build/android-addons}"
NODE_HEADERS_VERSION="${NODE_HEADERS_VERSION:-26.13.1}"
CURL=(curl -sSL --max-time 120)

# CI（Linux）与本机（macOS）的 NDK 路径不同；优先用显式环境变量，
# 其次从 ANDROID_HOME/ANDROID_SDK_ROOT 下取唯一 NDK。
NDK=""
if [[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]]; then
  NDK=$ANDROID_NDK_HOME
else
  SDK_ROOT=""
  for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk"; do
    if [[ -d "$candidate/ndk" ]]; then
      SDK_ROOT=$candidate
      break
    fi
  done
  if [[ -n "$SDK_ROOT" ]]; then
    NDK=$(find "$SDK_ROOT/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)
  fi
fi
HOST_TAG=$(uname -s | grep -qi darwin && echo darwin-x86_64 || echo linux-x86_64)
if [[ -n "$NDK" ]]; then
  CC="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin/aarch64-linux-android26-clang"
else
  CC=""
fi
CXX="${CC}++"

if [[ -z "$CC" || ! -x "$CC" || ! -x "$CXX" ]]; then
  echo "找不到 Android NDK 交叉编译器：$CC" >&2
  echo "请设置 ANDROID_NDK_HOME 或 ANDROID_HOME/ANDROID_SDK_ROOT" >&2
  exit 1
fi

CACHE="$OUT/cache"
mkdir -p "$CACHE" "$OUT"

fetch_tar() {
  local url=$1 dest=$2
  if [[ ! -f "$dest" ]]; then
    "${CURL[@]}" "$url" -o "$dest"
  fi
}

# node_api.h 头文件版本必须与随包 Node 的运行时一致。
NODE_HEADERS="$CACHE/node-v$NODE_HEADERS_VERSION-headers"
if [[ ! -f "$NODE_HEADERS/include/node/node_api.h" ]]; then
  mkdir -p "$NODE_HEADERS"
  fetch_tar "https://nodejs.org/dist/v$NODE_HEADERS_VERSION/node-v$NODE_HEADERS_VERSION-headers.tar.gz" \
    "$CACHE/node-headers.tgz"
  tar -xzf "$CACHE/node-headers.tgz" -C "$NODE_HEADERS" --strip-components=1
fi

# 上游 0.1.9 使用 node-addon-api 8.x；随包闭包的 7.x 缺 std::string_view
# 重载，会编译失败。这里固定与上游 devDependencies 一致的 8.9.0。
NAPI_API="$CACHE/node-addon-api-8.9.0"
if [[ ! -f "$NAPI_API/napi.h" ]]; then
  mkdir -p "$NAPI_API"
  fetch_tar "https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.9.0.tgz" \
    "$CACHE/node-addon-api.tgz"
  tar -xzf "$CACHE/node-addon-api.tgz" -C "$NAPI_API" --strip-components=1
fi

# require-builtin 源码镜像是上游仓库随包提供的最小闭包（52 个文件）。
NARB_SRC="$CACHE/require-builtin-src"
if [[ ! -f "$NARB_SRC/packages/native/binding.gyp" ]]; then
  mkdir -p "$NARB_SRC"
  # GitHub Contents API 对较大文件只给 download_url，不再内嵌 base64
  # content；先跟着下载链接走，只有小文件才回退到 content。
  python3 - "$CACHE/require-builtin-src.zip" <<'PY'
import base64
import json
import subprocess
import sys
url = 'https://api.github.com/repos/kai6666666/deepseek-harness/contents/native/require-builtin-src.zip'
meta = json.loads(subprocess.check_output([
    'curl', '-fsSL', '--max-time', '60',
    '-H', 'Accept: application/vnd.github+json', url,
]))
if meta.get('download_url'):
    subprocess.check_call([
        'curl', '-fsSL', '--max-time', '120', meta['download_url'],
        '-o', sys.argv[1],
    ])
elif 'content' in meta:
    with open(sys.argv[1], 'wb') as f:
        f.write(base64.b64decode(meta['content']))
else:
    raise SystemExit('require-builtin-src.zip 既没有 download_url 也没有 content')
PY
  unzip -q "$CACHE/require-builtin-src.zip" -d "$NARB_SRC"
fi

# 本工程内核闭包：tools/pack_android_kernel.mjs 会把 node_modules 原样打进
# assets，编译期从已解包的闭包装取 node-addon-native-custom-loader 与 flock.c。
CLOSURE="${DSH_CLOSURE:-$REPO/runtime/closure/dsh}"
EXTRACTED="${CLOSURE_EXTRACTED:-$OUT/closure}"
if [[ -d "$CLOSURE/node_modules" ]]; then
  EXTRACTED=$CLOSURE
elif [[ ! -d "$EXTRACTED/node_modules/node-addon-native-custom-loader" ]]; then
  mkdir -p "$EXTRACTED"
  unzip -q -o "$REPO/android/app/src/main/assets/ondra-dsh.zip" -d "$EXTRACTED"
fi

ROOT_COMMON=(
  -shared -fPIC -O2 -fvisibility=hidden
  "-I$NODE_HEADERS/include/node"
)

# 1) node-addon-require-builtin-android-arm64
NARB_PKG="$OUT/node-addon-require-builtin-android-arm64"
mkdir -p "$NARB_PKG/prebuilt"
SRCS=$(find "$NARB_SRC/packages/native/src" -name '*.cc' \
  ! -name 'runtime_compat_nodeabi.cc' | sort)
"$CXX" "${ROOT_COMMON[@]}" -std=c++17 -static-libstdc++ \
  -DNAPI_VERSION=9 -DNAPI_DISABLE_CPP_EXCEPTIONS \
  -DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS -DNARB_BACKEND=1 -DNARB_PRODUCT=1 \
  "-I$NAPI_API" $SRCS -o "$NARB_PKG/prebuilt/android-arm64-napi-v9.node" \
  -lm -ldl
# 打包器会把 $OUT 下所有包一起合并进闭包 node_modules，
# 这里只落平台包，不重复拷 loader 与入口包。
cp -a "$NARB_SRC/LICENSE" "$NARB_PKG/"
cat > "$NARB_PKG/package.json" <<'JSON'
{
  "name": "node-addon-require-builtin-android-arm64",
  "version": "0.1.9",
  "description": "Android arm64 N-API prebuild for node-addon-require-builtin",
  "main": "index.js",
  "os": ["android"],
  "cpu": ["arm64"],
  "license": "MIT"
}
JSON
cat > "$NARB_PKG/index.js" <<'JS'
'use strict';
const { loadPrebuild } = require('node-addon-native-custom-loader');
module.exports = loadPrebuild(__dirname);
JS
cat > "$NARB_PKG/prebuilds.json" <<'JSON'
{
  "platform": "android-arm64",
  "binaries": [
    { "backend": "napi", "abi": "napi-v9", "path": "prebuilt/android-arm64-napi-v9.node" }
  ]
}
JSON

# 2) @deepseek-ai/node-addon-system-android-arm64（flock）
# 上游 C 源码已经随包打在闭包的 entry 包里，仅补 Android 平台包壳。
SYSTEM_SRC="$EXTRACTED/node_modules/@deepseek-ai/node-addon-system/src/flock.c"
SYSTEM_PKG="$OUT/@deepseek-ai/node-addon-system-android-arm64"
mkdir -p "$SYSTEM_PKG/bin"
"$CC" "${ROOT_COMMON[@]}" -std=c11 -DNAPI_VERSION=8 \
  "$SYSTEM_SRC" -o "$SYSTEM_PKG/bin/system.node" -lm -ldl
cat > "$SYSTEM_PKG/package.json" <<'JSON'
{
  "name": "@deepseek-ai/node-addon-system-android-arm64",
  "version": "0.1.2",
  "description": "Android arm64 N-API prebuild for POSIX flock",
  "main": "index.js",
  "os": ["android"],
  "cpu": ["arm64"],
  "license": "BSD-3-Clause"
}
JSON
cat > "$SYSTEM_PKG/index.js" <<'JS'
'use strict';
module.exports = require('./bin/system.node');
JS
cat > "$SYSTEM_PKG/prebuilds.json" <<'JSON'
{
  "platform": "android-arm64",
  "binaries": [
    { "tool": "flock", "kind": "node-api", "napi": 8, "path": "bin/system.node" }
  ]
}
JSON

echo "已生成 Android arm64 原生绑定：$OUT"
