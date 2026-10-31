#!/bin/zsh
# Ondra 出包（完整链路：编译 → 准备运行时 → electron-builder → 复制到 build/）
#
# 用途：只在"要交付/要试真实包"时用，约 6-8 分钟。
# 改文案这类小事请用 tools/dev.sh，别用这个。
set -e
cd "$(dirname "$0")/.."

export PATH="$PWD/toolchain/node24/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
export TMPDIR="$PWD/desktop/.tmp"
export COREPACK_HOME="$PWD/toolchain/corepack"
unset ELECTRON_RUN_AS_NODE

mkdir -p "$TMPDIR"
cd desktop

export DSH_DESKTOP_APP_ID=com.ntars.ondra
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0
export CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR=""

echo "→ 1/3 编译（约 100 秒）"
pnpm run build

echo "→ 2/3 打包（约 5 分钟）"
pnpm --filter @deepseek-ai/dsh-desktop run package:mac:arm64:unsigned

echo "→ 3/3 复制产物到 build/"
SRC="$PWD/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts"
OUT="$PWD/../build"
cd ..
mkdir -p "$OUT"
[ -d "$OUT/空谷 Ondra.app" ] && trash "$OUT/空谷 Ondra.app" 2>/dev/null || true
ditto "$SRC/mac-arm64/空谷 Ondra.app" "$OUT/空谷 Ondra.app"
ditto "$SRC/ondra-1.0.0-mac-arm64-unsigned.dmg" "$OUT/ondra-1.0.0-mac-arm64-unsigned.dmg"

echo "✓ 完成：build/空谷 Ondra.app 与 build/ondra-1.0.0-mac-arm64-unsigned.dmg"
