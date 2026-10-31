#!/bin/zsh
# Ondra 快速迭代：编译后把 workspace 包与 Web 前端同步进 build 里的 .app（约 1 分钟）
#
# 原理：窗口界面来自 app.asar 内的 /dsh/node_modules/@deepseek-ai/*（Client 包）
# 与 /dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist（页面外壳），主进程来自 /lib。
# 三者替换后重签名即可，无需整包重打。
#
# 不适用：改了 host 运行时依赖树（Resources/runtime、包清单）时用 tools/pack.sh。
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"

export PATH="$ROOT/toolchain/node24/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
export TMPDIR="$ROOT/desktop/.tmp"
export COREPACK_HOME="$ROOT/toolchain/corepack"
unset ELECTRON_RUN_AS_NODE

APP="$ROOT/build/空谷 Ondra.app"
ASAR="$APP/Contents/Resources/app.asar"
STAGE="$TMPDIR/hot-stage"
WORK="$ROOT/desktop"
ASAR_BIN="$WORK/node_modules/.pnpm/node_modules/.bin/asar"

[ -d "$APP" ] || { echo "✗ 先用 tools/pack.sh 打一次完整包：$APP 不存在"; exit 1 }
[ -x "$ASAR_BIN" ] || ASAR_BIN="npx --yes @electron/asar"

echo "→ 1/5 结束正在运行的实例"
swift "$ROOT/tools/killondra.swift" 2>/dev/null || true
sleep 2

echo "→ 2/5 编译（约 30 秒）"
mkdir -p "$TMPDIR"
cd "$WORK"
export DSH_DESKTOP_APP_ID=com.ntars.ondra
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0
export CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR=""
pnpm run build >/dev/null

echo "→ 3/5 解包 app.asar"
rm -rf "$STAGE" && mkdir -p "$STAGE"
"$ASAR_BIN" extract "$ASAR" "$STAGE"

echo "→ 4/5 同步主进程、Client 包与 Web 前端"
ditto "$WORK/apps/desktop/lib" "$STAGE/lib"
rm -rf "$STAGE/renderer" && ditto "$WORK/apps/desktop/renderer" "$STAGE/renderer"
cp "$WORK/apps/desktop/package.json" "$STAGE/package.json"

# 每个 workspace 包按 package.json 的 name 映射到 asar 内的 node_modules 位置
synced=0
for pkg in "$WORK"/packages/*/*/package.json; do
  dir="${pkg:h}"
  [ -d "$dir/lib" ] || continue
  name=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$pkg")
  target="$STAGE/dsh/node_modules/$name"
  [ -d "$target" ] || continue
  rm -rf "$target/lib"
  ditto "$dir/lib" "$target/lib"
  # 声明式配置是包根目录的独立资源（不在 lib 里），必须一并同步，
  # 否则改了 cordis.patch.yml 的启停/配置不会生效。
  for y in "$dir"/*.yml(N) "$dir"/presets/*.yml(N); do
    rel="${y#$dir/}"
    mkdir -p "$target/${rel:h}"
    cp "$y" "$target/$rel"
  done
  synced=$((synced + 1))
done

WEB="$STAGE/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist"
if [ -d "$WORK/apps/web/dist" ] && [ -d "$WEB" ]; then
  rm -rf "$WEB" && ditto "$WORK/apps/web/dist" "$WEB"
fi

echo "   同步了 $synced 个 Client 包"

echo "→ 5/5 重打包并重启"
"$ASAR_BIN" pack "$STAGE" "$ASAR"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
open -n "$APP"

echo "✓ 完成：改动已生效"
