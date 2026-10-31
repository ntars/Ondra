#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补充提取 morphicons 仓库里的非 Studio 徽标素材：品牌标志、库标志、框架标志。

来源：
  assets/logo-light.svg · assets/logo-dark.svg · website/public/morphicons.svg  品牌标志
  website/lib/library-logos.ts    10 个图标库标志（viewBox + body）
  website/lib/logos.ts            4 个框架标志（React / Vue / Svelte / Astro）
"""
import json
import os
import re
import shutil

REPO = os.environ.get("MORPHICONS_REPO", os.path.expanduser("~/Downloads/morphicons-repo"))
REPO_URL = "https://github.com/guillermolg00/morphicons.git"
OUT = os.environ.get("MORPHICONS_OUT", os.path.expanduser("~/Downloads/morphicons-icons"))
TRAILING_COMMA = re.compile(r",(\s*[}\]])")


def slice_object(src, marker):
    i = src.index(marker)
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
    raise ValueError("未闭合")


def main():
    brand = os.path.join(OUT, "brand")
    libdir = os.path.join(OUT, "library-logos")
    fwdir = os.path.join(OUT, "framework-logos")
    for d in (brand, libdir, fwdir):
        os.makedirs(d, exist_ok=True)

    # 1. 品牌标志：原样复制仓库里的成品 SVG
    named = [
        ("assets/logo-light.svg", "logo-light.svg"),
        ("assets/logo-dark.svg", "logo-dark.svg"),
        ("website/public/morphicons.svg", "morphicons.svg"),
    ]
    for rel, name in named:
        src = os.path.join(REPO, rel)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(brand, name))
            print("brand:", name)

    # 2. 图标库标志
    lsrc = open(os.path.join(REPO, "website/lib/library-logos.ts"), encoding="utf8").read()
    logos = json.loads(TRAILING_COMMA.sub(r"\1", slice_object(lsrc, "export const LIBRARY_LOGOS")))
    for lib, (vb, body) in logos.items():
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="24" height="24">{body}</svg>\n'
        with open(os.path.join(libdir, lib + ".svg"), "w", encoding="utf8") as fh:
            fh.write(svg)
        print("library-logo:", lib)

    # 3. 框架标志
    fsrc = open(os.path.join(REPO, "website/lib/logos.ts"), encoding="utf8").read()
    for m in re.finditer(r'export const (\w+)_LOGO\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)";', fsrc):
        name = m.group(1).lower()
        d = m.group(2).encode().decode("unicode_escape")
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
            f'width="24" height="24"><path fill="currentColor" d="{d}"/></svg>\n'
        )
        with open(os.path.join(fwdir, name + ".svg"), "w", encoding="utf8") as fh:
            fh.write(svg)
        print("framework-logo:", name)


if __name__ == "__main__":
    main()
