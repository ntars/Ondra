#!/usr/bin/env bash
# 重新生成全平台应用图标。
#
#   tool/icons.sh
#
# 真源是 assets/brand/ondra-mark.svg 与 lib/design/brand.dart 里的
# ondraSquircleRatio（185.4 / 824，与 macOS 图标同一套圆角比例）。
# 生成逻辑在 tool/icon_factory_test.dart：借 flutter_test 的引擎画图，
# 一次写全 macOS / iOS / Android / Web / Windows 的图标文件。
#
# 改标记几何、改留白比例、改圆角比例之后都要重跑。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

flutter test tool/icon_factory_test.dart --dart-define=ondra_icons=true

echo
echo "已更新："
echo "  macos/Runner/Assets.xcassets/AppIcon.appiconset/（16–1024）"
echo "  ios/Runner/Assets.xcassets/AppIcon.appiconset/（20–1024）"
echo "  android/app/src/main/res/mipmap-*/ic_launcher.png"
echo "  web/favicon.png、web/icons/*.png"
echo "  windows/runner/resources/app_icon.ico"
