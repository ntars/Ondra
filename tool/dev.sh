#!/usr/bin/env bash
# 开发用 Web 预览：带热重载，改代码后不用重新构建。
#
#   tool/dev.sh            # 从 9060 起，占用则顺延到下一个可用端口
#   tool/dev.sh 9100       # 指定起始端口，同样会被顺延
#
# 启动后终端里按：
#   r  热重载（保持页面状态，改 UI 用这个，通常 1–2 秒）
#   R  热重启（重置状态，改了 initState / 全局变量用这个）
#   q  退出
#
# 为什么不 `flutter build web` 再起静态服务：release 构建一次要 60 秒以上，
# 调样式时完全等不起。debug 模式下第一次编译约 20 秒，之后每次热重载 1–2 秒。
#
# 端口规则与产品一致：默认 9060（见 lib/app/version.dart 的 ondraDebugPort），
# 被占用就顺延，最多试到 9159。
set -euo pipefail

START="${1:-9060}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

is_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

PORT="$START"
LIMIT=$((START + 99))
while is_busy "$PORT"; do
  if [ "$PORT" -ge "$LIMIT" ]; then
    echo "端口 $START–$LIMIT 全部被占用，放弃启动。" >&2
    exit 1
  fi
  echo "端口 $PORT 已被占用，顺延到 $((PORT + 1))" >&2
  PORT=$((PORT + 1))
done

cd "$ROOT"
echo "预览地址：http://127.0.0.1:$PORT"
exec flutter run -d web-server \
  --web-port="$PORT" \
  --web-hostname=127.0.0.1
