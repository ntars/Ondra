#!/usr/bin/env bash
#
# 转发到 `assemble_runtime.mjs`。
#
# 装配逻辑只有一份（node 实现，三个平台同一套语义），放在 .mjs 里。保留这个
# .sh 入口只是因为习惯与既有 CI 步骤都写着它——它不做事，只转发。
#
# Windows 上没有 bash，那里直接跑：node tool\assemble_runtime.mjs
set -euo pipefail
exec node "$(dirname "$0")/assemble_runtime.mjs" "$@"
