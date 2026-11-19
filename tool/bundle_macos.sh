#!/usr/bin/env bash
#
# 打一个「双击就能用」的 macOS 应用：把随包运行时塞进 .app，重新签名。
#
# ## 为什么需要这一步
#
# `flutter build macos` 只认得 `assets/` 与 Dart 产物，不知道仓库根下还有一份
# `runtime/`。而应用启动时要靠 `lib/app/bundled_runtime_io.dart` 在
# `Ondra.app/Contents/Resources/runtime/<平台>-<架构>/` 找 Node 与内核。
# 不塞进去，用户就得自己装 Node 和 dsh——正是这次要消除的那一步。
#
# 另有一件事不能省：**往 .app 里加文件会让原有签名失效**。macOS 上签名一失效，
# 应用连启动都不行（报「已损坏」或直接闪退）。所以复制完必须重签。
#
# ## 用法
#
#   tool/bundle_macos.sh                        # 构建 + 塞运行时 + ad-hoc 签名
#   tool/bundle_macos.sh --skip-build           # 用已有构建产物，只做塞入与签名
#   tool/bundle_macos.sh --sign "Developer ID Application: Xxx (TEAMID)"
#
# ad-hoc 签名（`-`）够本机运行；要分发给别人，得有 Developer ID 并公证。
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_BUILD=0
IDENTITY="-"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --sign) IDENTITY="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# ── 1. 构建 ────────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "0" ]]; then
  echo "── flutter build macos --release ──"
  flutter build macos --release
fi

APP="$(find build/macos/Build/Products/Release -maxdepth 1 -name '*.app' -type d | head -1)"
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "找不到构建产物（build/macos/Build/Products/Release/*.app）" >&2
  echo "先不带 --skip-build 跑一次。" >&2
  exit 1
fi

# ── 2. 找运行时 ────────────────────────────────────────────────────────────
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac
TARGET="macos-$arch"
SRC="runtime/$TARGET"
if [[ ! -d "$SRC" ]]; then
  echo "没有 $SRC。" >&2
  echo "先跑 tool/assemble_runtime.mjs 生成随包运行时。" >&2
  exit 1
fi

# ── 3. 复制 ────────────────────────────────────────────────────────────────
#
# 目标路径必须与 bundled_runtime_io.dart 的候选一致：
# 可执行在 Contents/MacOS，所以它探的是 `../Resources/runtime`。
DEST="$APP/Contents/Resources/runtime/$TARGET"
echo "── 复制 ${SRC} → ${DEST} ──"
rm -rf "$APP/Contents/Resources/runtime"
mkdir -p "$(dirname "$DEST")"
# ditto 而不是 cp -R：它在 HFS+/APFS 上保留硬链、扩展属性与符号链接，
# 而后两者对「@deepseek-ai/* 软链到 .dedupe」和可执行位都是必需的。
ditto "$SRC" "$DEST"

# 复制后自检：路径算错、复制失败都在这里停下，而不是等用户双击闪退。
for required in "$DEST/node" "$DEST/dsh/lib/bin.js" "$DEST/profile/cordis.yml"; do
  if [[ ! -e "$required" ]]; then
    echo "  缺少 ${required} —— 复制不完整" >&2
    exit 1
  fi
done
chmod +x "$DEST/node"
echo "  运行时已就位（$(du -sh "$DEST" | cut -f1)）"

# ── 4. 重签 ────────────────────────────────────────────────────────────────
#
# **只签外层 .app，不动里面的 node。**
#
# 两个理由：
#   1. node 的代码签名嵌在 Mach-O 里，`ditto` 复制不会破坏它——它本来就能跑。
#      拿 ad-hoc 去覆盖反而有风险：arm64 上 JIT 需要 hardened runtime 的
#      `allow-jit` 豁免，覆盖成不带豁免的签名会让 node 起不来。
#   2. 加文件只会让**外层**签名失效（它记录了每个文件的哈希），修外层就够。
echo "── 签名（identity: ${IDENTITY}）──"
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --sign - "$APP"
else
  # 真身份才开 hardened runtime：ad-hoc + hardened 会把 node 的 JIT 关掉。
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
fi

echo "── 校验 ──"
codesign --verify --deep --strict "$APP" && echo "  ✓ 签名有效"

# ── 5. 结论 ────────────────────────────────────────────────────────────────
echo ""
echo "完成：${APP}"
echo "  运行时：$(du -sh "$DEST" | cut -f1)"
echo "  整包  ：$(du -sh "$APP" | cut -f1)"
if [[ "$IDENTITY" == "-" ]]; then
  echo ""
  echo "当前是 ad-hoc 签名：本机能跑，不能直接分发给别人。"
  echo "要分发，用 --sign \"Developer ID Application: 你的名字 (TEAMID)\" 重跑，再做公证。"
fi
