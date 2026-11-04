#!/bin/zsh
# Ondra 纯产物热推：不编译，直接把 build 里 .app 的界面产物重签并重启（约 40 秒）
#
# 用途：只改了「产物层」的东西——例如直接编辑 app.asar 内已解包目录里的
# lib/client.js（颜色、文案、隐藏元素之类的小改动）。
# 不适用：改了 packages/**/src 下的 TypeScript 源码，那种情况必须走 tools/hot.sh 编译。
#
# 工作方式：把 $STAGE 目录（上次 hot.sh 留下的解包树，或本次手工改动的树）
# 重新打包进 app.asar，重签名后重启应用。
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"

export PATH="$ROOT/toolchain/node24/bin:$PATH"
export TMPDIR="$ROOT/desktop/.tmp"
unset ELECTRON_RUN_AS_NODE

APP="$ROOT/build/空谷 Ondra.app"
ASAR="$APP/Contents/Resources/app.asar"
STAGE="$TMPDIR/hot-stage"
ASAR_BIN="$ROOT/desktop/node_modules/.pnpm/node_modules/.bin/asar"

[ -d "$APP" ] || { echo "✗ 先打一次完整包：$APP 不存在"; exit 1; }
[ -d "$STAGE" ] || { echo "✗ 没有解包树 $STAGE，先跑一次 tools/hot.sh"; exit 1; }
[ -x "$ASAR_BIN" ] || ASAR_BIN="npx --yes @electron/asar"

echo "→ 1/3 结束正在运行的实例"
swift "$ROOT/tools/killondra.swift" 2>/dev/null || true
sleep 2

echo "→ 2/3 重新打包 app.asar（使用现有 $STAGE 目录）"
rm -f "$ASAR"
"$ASAR_BIN" pack "$STAGE" "$ASAR"

echo "→ 3/3 重签名并重启"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
open -n "$APP"

echo "✓ 完成：产物改动已生效（未编译源码）"
