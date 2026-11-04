#!/usr/bin/env bash
#
# 定时任务开局预检：只输出本轮真正需要的上下文，避免把大文件整篇读一遍。
#
# 为什么需要它：
#   台账 2161 行 / 466KB，每轮只需要 §1 批次表 + 当前那 2 个条目；
#   master-plan 854 行 / 64KB，只需要 §9 参数速查、§15 交叉防控、§16 自检清单。
#   整篇读一轮约 530KB。本脚本把这两份文件里「本轮要用的那一小块」按行号窗口切出来，
#   输出控制在 120 行内。
#
# 开发手册（Ondra-dev-handbook.md，5127 行 / 30 万字）不在本任务读取范围：
#   它写的是产品与机制的规范，写插件要的参数 master-plan §9 已速查，故整份不读。
#
# 它不改任何文件，只读。真源仍是那两份文档，本脚本不产生第二真源。
#
# 用法：
#   bash tools/ondra-preflight.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MP="$ROOT/cordis/ondra-master-plan.md"
IDX="$ROOT/cordis/ondra-plugin-index.md"

for f in "$MP" "$IDX"; do
  if [ ! -f "$f" ]; then
    echo "缺少文件：$f"
    echo "停手，不要凭记忆猜规则。"
    exit 1
  fi
done

echo "==================== 1. 真源指纹（变了就说明规范可能更新，需定点复核）===================="
shasum -a 256 "$MP" "$IDX" | awk '{printf "%s  %s\n", substr($1,1,16), $2}'
echo "行数：master-plan $(wc -l < "$MP" | tr -d ' ')｜台账 $(wc -l < "$IDX" | tr -d ' ')"

echo
echo "==================== 2. 台账 §1 执行批次 ===================="
awk '/^## 1\. 执行批次/{f=1} f&&/^---[[:space:]]*$/{exit} f' "$IDX" | sed '/^$/N;/^\n$/D'

echo
echo "==================== 3. 待做条目（只列表格行，含行号）===================="
echo "--- pending ---"
grep -nE '^\| O-[0-9]+ .*\| *(pending|doing)' "$IDX" || echo "（无）"
echo "--- blocked ---"
grep -nE '^\| O-[0-9]+ .*\| *blocked' "$IDX" || echo "（无）"

echo
echo "==================== 4. 各组行号区间与待做数量（决定读哪一段）===================="
awk '
  /^## 第 .* 组/ {
    if (grp != "") printf "%-46s 行 %5d-%-5d 待做 %d\n", grp, start, NR-1, cnt
    grp = $0; start = NR; cnt = 0
  }
  /^\| O-[0-9]+/ && /\| *(pending|doing|blocked)/ { cnt++ }
  END { if (grp != "") printf "%-46s 行 %5d-%-5d 待做 %d\n", grp, start, NR, cnt }
' "$IDX"

echo
echo "==================== 5. master-plan 关键小节行号（用 sed -n A,Bp 定点读）===================="
grep -nE '^## (3\.8|9|11|12|13|14|15|16|17)[. ]' "$MP"
