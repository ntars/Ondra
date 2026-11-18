#!/usr/bin/env bash
# 重新生成内嵌的 MiSans 子集字体。
#
# ## 为什么字体要本地生成，而不是随仓库走
#
# MiSans 许可协议（https://hyperos.mi.com/font/download/）第 2 条：
#   2) 您不得对 MiSans 字体或其任何单独组件进行改编或二次开发。
#   3) 您不得单独将 MiSans 字体或其组件对外租赁、再许可、给予、出借或
#      进一步分发字体软件或其任何副本以及重新分发或售卖。
# 子集化属于第 2 款的「改编」，把子集放进公开仓库属于第 3 款的「分发副本」。
# 两条都碰，所以仓库只留 assets/fonts/.gitkeep 占位，.ttf 由本脚本在本地生成。
#
# ## 没有字体也不影响用
#
# 不跑本脚本时，`lib/design/font_face.dart` 找不到字体文件会静默降级到
# 系统中文字体（见 tokens.dart 的 ondraFontFallback），构建与功能都正常，
# 只是失去 MiSans 的字形，以及 330 / 380 这类非整数字重档的细腻差别。
#
# ## 为什么要子集
#
# 官网 MiSansVF.ttf 是 19MB / 29414 字，覆盖全部简体与符号；界面实际只用到
# 几百个字。按「用到的字」裁剪是 Web 与移动端的通行做法，体积从 19MB 降到
# 约 460KB，字重轴（wght 150–700）完整保留。
#
# 用法：
#   tool/subset_font.sh                      # 自动在常见位置找 MiSansVF.ttf
#   tool/subset_font.sh /path/to/MiSansVF.ttf
#
# 依赖：fonttools（pip install fonttools），提供 pyftsubset。
# 注意：新增界面文案后要重跑本脚本，否则新字会回退到系统字体。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/fonts/MiSans-Ondra.ttf"

# ── 找源字体 ──────────────────────────────────────────────────
# 显式传参优先；否则按「装过系统字体 > 下载目录」的顺序找，省得每次翻路径。
find_source() {
  if [[ -n "${1:-}" ]]; then
    [[ -f "$1" ]] && { printf '%s' "$1"; return 0; }
    echo "指定的文件不存在：$1" >&2
    return 1
  fi
  local candidates=(
    "$HOME/Library/Fonts/MiSansVF.ttf"                 # macOS 用户字体目录
    "$HOME/.local/share/fonts/MiSansVF.ttf"            # Linux 用户字体目录
    "$HOME/Downloads/MiSansVF.ttf"                     # 下载目录
    "$HOME/Downloads/MiSans/MiSansVF.ttf"
  )
  local f
  for f in "${candidates[@]}"; do
    [[ -f "$f" ]] && { printf '%s' "$f"; return 0; }
  done
  return 1
}

if ! SRC="$(find_source "${1:-}")"; then
  cat >&2 <<'EOF'
找不到 MiSansVF.ttf。

有两种处理方式：

  A. 生成子集（推荐，界面用 MiSans）
     1. 从官网下载完整字体包：
        https://hyperos.mi.com/font/zh/download/
     2. 解压得到 MiSansVF.ttf，放到任一位置，然后重跑：
        tool/subset_font.sh /path/to/MiSansVF.ttf

  B. 不生成（应用会自动降级到系统中文字体）
     什么都不用做。缺字体不影响构建与任何功能，
     只是失去 MiSans 字形以及 330 / 380 这类非整数字重档的细腻差别。
     （降级逻辑见 lib/design/font_face.dart）
EOF
  exit 1
fi

# 校验真的是 MiSans，而不是同名的别的东西。
if ! python3 - "$SRC" <<'PY'
import sys
from fontTools.ttLib import TTFont

path = sys.argv[1]
try:
    font = TTFont(path, lazy=True)
    names = {n.nameID: n.toUnicode() for n in font['name'].names if n.platformID == 3}
except Exception as e:
    print(f'无法读取字体文件：{e}', file=sys.stderr)
    sys.exit(1)

family = names.get(1, '')
if 'MiSans' not in family:
    print(f'这个文件的字体家族是「{family}」，不是 MiSans。', file=sys.stderr)
    sys.exit(1)

cmap = font.getBestCmap()
print(f'源字体：{family} {names.get(5, "")}｜{len(cmap)} 字', file=sys.stderr)
if len(cmap) < 10000:
    print(f'警告：只有 {len(cmap)} 个字，可能下载的是子集而不是完整版。', file=sys.stderr)
PY
then
  exit 1
fi

# ── 收集界面用字 ──────────────────────────────────────────────
TMP="$(mktemp -t ondra_chars)"
trap 'rm -f "$TMP"' EXIT

# 收集源码里出现的所有字符（去掉整行注释，避免把注释里的字也算进去），
# 再补上可打印 ASCII 与常用中文标点——这两组不一定出现在源码里，
# 但运行时可能由数据拼出来（文件名、时间、序号）。
python3 - "$ROOT" >"$TMP" <<'PY'
import glob, os, sys

root = sys.argv[1]
chars = set()
for pat in ('lib/**/*.dart', 'test/**/*.dart'):
    for path in glob.glob(os.path.join(root, pat), recursive=True):
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                if line.lstrip().startswith('//'):
                    continue
                chars.update(line)

ascii_printable = ''.join(chr(i) for i in range(0x20, 0x7F))
cjk_punct = '·—–…「」『』《》〈〉“”‘’、。，；：？！（）【】〔〕％＋－×÷°′″　￥¥'
sys.stdout.write(''.join(sorted(chars | set(ascii_printable + cjk_punct))))
PY

mkdir -p "$ROOT/assets/fonts"
pyftsubset "$SRC" \
  --text-file="$TMP" \
  --output-file="$OUT" \
  --layout-features='*' \
  --no-hinting \
  --name-IDs='*' \
  --drop-tables+=DSIG,VDMX,MATH \
  --recalc-bounds

printf '\n生成 %s\n' "$OUT"
ls -lh "$OUT"
printf '注意：该文件被 .gitignore 排除，不会随仓库分发（MiSans 许可要求）。\n'
