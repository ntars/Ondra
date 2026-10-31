#!/usr/bin/env python3
"""把图标索引切成选板（picker）用的按需加载数据文件。

选板本身是静态页 + 虚拟滚动，27xx 个卡片不会同时进 DOM；
数据按图标集切成 19 个小文件，滚到哪套才加载哪套。

输入  ~/Downloads/morphicons-icons/index.json
输出  ~/Downloads/morphicons-icons/picker/data/index.js   全部图标的名字与尺寸（搜索用）
      ~/Downloads/morphicons-icons/picker/data/s-<set>.js 各图标集的 SVG 内容（按需加载）
"""
import json
import os
import re

OUT = os.path.expanduser(os.environ.get("MORPHICONS_OUT", "~/Downloads/morphicons-icons"))
INDEX = os.path.join(OUT, "index.json")
DATA = os.path.join(OUT, "picker", "data")

# 合法的文件名：字母数字，中间可带 . - _ 分隔
SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def main():
    items = json.load(open(INDEX, encoding="utf8"))

    sets = {}
    rows = []
    bodies = {}
    bad = []

    for it in items:
        key = it["set"]
        label = it["label"]
        if not SAFE.match(label):
            bad.append(label)
            continue
        s = sets.setdefault(key, {
            "label": it.get("setLabel") or it["set"],
            "lib": it["library"],
            "style": it["style"],
            "dir": it["file"].rsplit("/", 1)[0],
            "version": it.get("version", ""),
            "license": it.get("license", ""),
            "count": 0,
        })
        s["count"] += 1
        # [图标集, 本地名, 上游名, 宽, 高]，保持紧凑
        rows.append([key, label, it["upstreamName"], it["width"], it["height"]])
        bodies.setdefault(key, {})[label] = [it["upstreamName"], it["width"], it["height"], _body(it["svg"])]

    # 图标集的中文可读名放在 MANIFEST 里（index.json 每条形如 "Bootstrap Icons"）
    manifest_path = os.path.join(OUT, "MANIFEST.json")
    if os.path.exists(manifest_path):
        man = json.load(open(manifest_path, encoding="utf8"))
        for m in man["sets"]:
            if m["set"] in sets:
                sets[m["set"]]["label"] = m["label"]

    os.makedirs(DATA, exist_ok=True)

    head = "window.MC_DATA="
    payload = json.dumps({"sets": sets, "icons": rows}, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(DATA, "index.js"), "w", encoding="utf8") as f:
        f.write(head + payload + ";\n")

    for key, mp in bodies.items():
        txt = json.dumps(mp, ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(DATA, f"s-{key}.js"), "w", encoding="utf8") as f:
            # 立刻赋值，避免 19 个 <script> 的先后顺序影响读取
            f.write(f'window.MC_SETS=window.MC_SETS||{{}};window.MC_SETS["{key}"]={txt};\n')

    print(f"{len(sets)} 个图标集 / {len(rows)} 个图标 → {DATA}")
    if bad:
        print(f"跳过 {len(bad)} 个文件名不合规的图标：{bad[:10]}")


def _body(svg):
    """去掉外层 <svg> 标签，只留内部图形。"""
    m = re.match(r"^<svg[^>]*>(.*)</svg>$", svg, re.S)
    return m.group(1) if m else svg


if __name__ == "__main__":
    main()
