#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 morphicons 仓库 website/lib/icon-sets/*.ts 提取全部 Studio 图标为独立 SVG 文件。

数据源：每条记录 = 概念标签 label → [上游名 name, 宽 w, 高 h, Iconify body]。

输出（默认 ~/Downloads/morphicons-icons/）：
  <lib>/<style>/<label>.svg   每个图标一个文件（带 viewBox 与 xmlns）
  <lib>/<style>/<label>.json  同名元数据（上游名、viewBox、许可、来源）
  index.json                  机器可读总索引（含内联 SVG 字符串）
  MANIFEST.json               集合清单（数量、版本、许可）
  README.md                   人读索引
"""
import json
import os
import re
import sys
from datetime import datetime

REPO = os.environ.get("MORPHICONS_REPO", os.path.expanduser("~/Downloads/morphicons-repo"))
REPO_URL = "https://github.com/guillermolg00/morphicons.git"
SETS_DIR = os.path.join(REPO, "website", "lib", "icon-sets")
OUT = os.environ.get("MORPHICONS_OUT", os.path.expanduser("~/Downloads/morphicons-icons"))

TRAILING_COMMA = re.compile(r",(\s*[}\]])")
META_RE = re.compile(
    r"^\s*(.+?) v(\S+) \((outline|fill)\), (\S+), via @iconify-json/(\S+)\.", re.M
)


def slice_object(src):
    """截取 `const data ... = { ... }` 的对象字面量，按大括号配平。"""
    i = src.index("const data")
    j = src.index("{", src.index("=", i))
    depth = 0
    for k in range(j, len(src)):
        c = src[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[j : k + 1]
    raise ValueError("对象未闭合")


def parse_meta(src):
    """从生成文件顶部注释里抽出 库名 / 版本 / 许可。"""
    head = src[: src.index("*/")]
    m = META_RE.search(head)
    if not m:
        return {"label": "", "version": "", "license": "", "source": ""}
    version = m.group(2)
    return {
        "label": m.group(1).strip(),
        # 上游 info.json 缺 version 时生成器写成了字符串 "undefined"，如实标注为未记录
        "version": "未记录" if version == "undefined" else version,
        "license": m.group(4),
        "source": "@iconify-json/" + m.group(5),
    }


def main():
    if not os.path.isdir(SETS_DIR):
        # 首次运行：把仓库浅克隆到下载根目录（只读用途，不改动它）
        import subprocess
        print(f"未找到仓库，浅克隆到 {REPO} …")
        subprocess.run(
            ["git", "-c", "http.version=HTTP/1.1", "clone", "--depth", "1", REPO_URL, REPO],
            check=True,
        )

    files = sorted(
        f
        for f in os.listdir(SETS_DIR)
        if f.endswith(".ts") and f not in ("sizes.ts", "defaults.ts")
    )
    if not files:
        sys.exit("未找到任何图标集文件：" + SETS_DIR)

    os.makedirs(OUT, exist_ok=True)
    manifest, index, total = [], [], 0

    for fn in files:
        key = fn[:-3]
        lib, style = key.rsplit("-", 1)
        src = open(os.path.join(SETS_DIR, fn), encoding="utf8").read()
        meta = parse_meta(src)
        data = json.loads(TRAILING_COMMA.sub(r"\1", slice_object(src)))

        target = os.path.join(OUT, lib, style)
        os.makedirs(target, exist_ok=True)

        for label, entry in data.items():
            name, w, h, body = entry
            # Iconify body 是内部标记，外包一层带命名空间的 <svg> 即为可独立打开的图标
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
                f'width="{w}" height="{h}">{body}</svg>'
            )
            stem = os.path.join(target, label)
            with open(stem + ".svg", "w", encoding="utf8") as fh:
                fh.write(svg + "\n")

            item = {
                "id": f"{key}:{label}",
                "set": key,
                "library": lib,
                "style": style,
                "label": label,
                "upstreamName": name,
                "width": w,
                "height": h,
                "file": os.path.relpath(stem + ".svg", OUT),
                "svg": svg,
                "license": meta["license"],
                "version": meta["version"],
                "source": meta["source"],
            }
            with open(stem + ".json", "w", encoding="utf8") as fh:
                json.dump(item, fh, ensure_ascii=False, indent=1)
                fh.write("\n")

            index.append(item)
            total += 1

        manifest.append(
            {
                "set": key,
                "library": lib,
                "style": style,
                "label": meta["label"],
                "version": meta["version"],
                "license": meta["license"],
                "source": meta["source"],
                "count": len(data),
                "dir": f"{lib}/{style}",
            }
        )
        print(f"{key:26s} {len(data):4d}  {meta['label']} v{meta['version']} ({meta['license']})")

    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    with open(os.path.join(OUT, "MANIFEST.json"), "w", encoding="utf8") as fh:
        json.dump(
            {
                "generatedAt": stamp,
                "repo": "https://github.com/guillermolg00/morphicons",
                "site": "https://www.morphicons.com",
                "origin": "website/lib/icon-sets/*.ts (Studio 图标集)",
                "sets": manifest,
                "totalIcons": total,
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )
        fh.write("\n")

    write_readme(manifest, total, stamp)
    write_preview(index, manifest)
    print(f"\n总计 {total} 个 SVG → {OUT}")


def write_readme(manifest, total, stamp):
    lines = [
        "# morphicons Studio 图标全集",
        "",
        f"共 **{total}** 个图标 SVG（另含 17 个品牌 / 库 / 框架标志）"
        f"，{len(manifest)} 个图标集，提取自 "
        "[morphicons](https://github.com/guillermolg00/morphicons) 官网 "
        "[morphicons.com](https://www.morphicons.com) Studio 的实际数据"
        "（`website/lib/icon-sets/*.ts`）。",
        "",
        f"生成时间：{stamp}",
        "",
        "## 目录结构",
        "",
        "```",
        "morphicons-icons/",
        "├── <库>/<风格>/<图标名>.svg   10 个库 × 2 种风格的独立 SVG（含 viewBox）",
        "├── <库>/<风格>/<图标名>.json  同名元数据",
        "├── brand/                     品牌标志 3 个（light / dark / morphicons）",
        "├── library-logos/             10 个图标库自身标志",
        "├── framework-logos/           4 个框架标志（React / Vue / Svelte / Astro）",
        "├── preview.html               全部图标的内联网页画廊（双击打开）",
        "├── index.json                 全量索引（含内联 SVG 字符串）",
        "├── MANIFEST.json              集合清单（数量 / 版本 / 许可）",
        "└── README.md                  本文件",
        "```",
        "",
        "## 图标集",
        "",
        "| 目录 | 图标集 | 风格 | 数量 | 版本 | 许可 |",
        "| --- | --- | --- | ---: | --- | --- |",
    ]
    for m in manifest:
        lines.append(
            f"| `{m['dir']}` | {m['label']} | {m['style']} | {m['count']} "
            f"| {m['version']} | {m['license']} |"
        )
    lines += [
        "",
        "## 额外素材",
        "",
        "| 目录 | 内容 | 来源 | 许可 |",
        "| --- | --- | --- | --- |",
        "| `brand/` | morphicons 品牌标志 3 个 | `assets/`、`website/public/` | 跟随仓库 MIT |",
        "| `library-logos/` | 10 个图标库标志 | `website/lib/library-logos.ts` | CC0 / 各库自有 |",
        "| `framework-logos/` | React / Vue / Svelte / Astro | `website/lib/logos.ts` | CC0（simple-icons） |",
        "",
        "## 用法",
        "",
        "```html",
        '<!-- <img> 引用：简单，但颜色固定为黑色 -->',
        '<img src="lucide/outline/menu.svg" width="24" height="24" alt="menu">',
        "",
        "<!-- 内联：currentColor 跟随父级文字颜色，可任意改色 -->",
        '<span style="color:#0a84ff">',
        '  <svg viewBox="0 0 24 24" width="24" height="24">…</svg>',
        "</span>",
        "```",
        "",
        "所有图标用 `currentColor` 着色，作为 `<img>` 引用时会被固定为黑色；",
        "需要跟随主题色请内联 SVG，或用 CSS `mask-image` 把 SVG 当蒙版。",
        "",
        "## 许可",
        "",
        "各图标集保留上游许可（ISC / MIT / Apache-2.0 等，见上表 `许可` 列与每个 "
        "`.json` 的 `license` 字段）。使用前请按对应许可保留署名。",
        "",
    ]
    with open(os.path.join(OUT, "README.md"), "w", encoding="utf8") as fh:
        fh.write("\n".join(lines))


PREVIEW_TEMPLATE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>morphicons 图标全集 · {total}</title>
<style>
:root{{--bg:#fff;--fg:#1c1c1e;--sub:#8e8e93;--line:#e5e5ea;--card:#f7f7fa;--accent:#0a84ff}}
@media (prefers-color-scheme:dark){{:root{{--bg:#000;--fg:#f5f5f7;--sub:#8e8e93;--line:#2c2c2e;--card:#1c1c1e;--accent:#0a84ff}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}}
header{{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--line);padding:12px 24px}}
h1{{margin:0 0 8px;font-size:15px;font-weight:600;letter-spacing:-.01em}}
h1 span{{color:var(--sub);font-weight:400}}
nav{{display:flex;flex-wrap:wrap;gap:6px;max-height:76px;overflow:auto}}
nav a{{font-size:12px;color:var(--fg);text-decoration:none;padding:3px 9px;border-radius:99px;background:var(--card);white-space:nowrap}}
nav a:hover{{background:var(--accent);color:#fff}}
nav a em{{font-style:normal;font-size:10px;color:var(--sub);border:1px solid var(--line);border-radius:99px;padding:0 5px;margin-left:5px}}
nav a:hover em{{color:rgba(255,255,255,.8);border-color:rgba(255,255,255,.35)}}
nav a span{{color:var(--sub);margin-left:3px}}
nav a:hover span{{color:rgba(255,255,255,.75)}}
main{{padding:8px 24px 96px}}
section{{padding-top:28px}}
h2{{font-size:16px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}}
h2 em{{font-style:normal;font-size:11px;color:var(--sub);border:1px solid var(--line);border-radius:99px;padding:1px 7px;margin-left:6px;vertical-align:2px}}
h2 small{{display:block;font-size:12px;font-weight:400;color:var(--sub);margin-top:3px;letter-spacing:0}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px;margin-top:14px}}
figure{{margin:0;background:var(--card);border-radius:12px;padding:14px 8px 9px;text-align:center;transition:transform .12s ease,background .12s ease}}
figure:hover{{transform:translateY(-1px);background:color-mix(in srgb,var(--accent) 8%,var(--card))}}
.s{{height:34px;display:flex;align-items:center;justify-content:center;color:var(--fg)}}
.s svg{{width:26px;height:26px;max-width:100%;max-height:100%}}
figcaption{{font-size:10px;color:var(--sub);margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
</style></head>
<body>
<header>
<h1>morphicons 图标全集 <span>{total} 个 SVG · 19 个图标集</span></h1>
<nav>{nav}</nav>
</header>
<main>{sections}</main>
</body></html>
"""


def write_preview(index, manifest):
    """生成 preview.html：把 2797 个图标内联成一张可滚动的画廊，双击即看。"""
    import html as _html

    by_set = {}
    for it in index:
        by_set.setdefault(it["set"], []).append(it)

    # 同名的 outline / fill 两套在导航里会看混，标签后带上风格缩写
    nav = "".join(
        f'<a href="#{m["set"]}">{_html.escape(m["label"])}'
        f' <em>{m["style"]}</em> <span>{m["count"]}</span></a>'
        for m in manifest
    )
    sections = []
    for m in manifest:
        cards = "".join(
            f'<figure title="{_html.escape(it["upstreamName"])}">'
            f'<div class="s">{it["svg"]}</div>'
            f'<figcaption>{_html.escape(it["label"])}</figcaption></figure>'
            for it in by_set[m["set"]]
        )
        sections.append(
            f'<section id="{m["set"]}"><h2>{_html.escape(m["label"])} '
            f'<em>{m["style"]}</em><small>{m["count"]} 个 · v{m["version"]} · '
            f'{m["license"]}</small></h2><div class="grid">{cards}</div></section>'
        )

    doc = PREVIEW_TEMPLATE.format(nav=nav, sections="".join(sections), total=len(index))
    with open(os.path.join(OUT, "preview.html"), "w", encoding="utf8") as fh:
        fh.write(doc)


if __name__ == "__main__":
    main()
