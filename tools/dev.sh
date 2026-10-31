#!/bin/zsh
# Ondra 开发态启动（最快：秒级重启，不打包、不动 /Applications）
#
# 用途：改界面文案、调样式、试插件时用这个。
# 它会直接在 build 目录外跑 Electron，热更新级别的反馈速度。
set -e
cd "$(dirname "$0")/.."

export PATH="$PWD/toolchain/node24/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
export TMPDIR="$PWD/desktop/.tmp"
export COREPACK_HOME="$PWD/toolchain/corepack"
# 关键：清掉把 Electron 变成 Node REPL 的变量，否则窗口起不来
unset ELECTRON_RUN_AS_NODE

mkdir -p "$TMPDIR"
cd desktop

export DSH_DESKTOP_APP_ID=com.ntars.ondra
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0
export CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR=""

echo "→ 开发态启动（Ctrl+C 退出）"
pnpm --filter @deepseek-ai/dsh-desktop run dev "$@"
