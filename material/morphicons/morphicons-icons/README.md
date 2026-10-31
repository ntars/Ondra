# morphicons Studio 图标全集

共 **2797** 个图标 SVG（另含 17 个品牌 / 库 / 框架标志），19 个图标集，提取自 [morphicons](https://github.com/guillermolg00/morphicons) 官网 [morphicons.com](https://www.morphicons.com) Studio 的实际数据（`website/lib/icon-sets/*.ts`）。

生成时间：2026-10-29T17:06:42+08:00

## 目录结构

```
morphicons-icons/
├── <库>/<风格>/<图标名>.svg   10 个库 × 2 种风格的独立 SVG（含 viewBox）
├── <库>/<风格>/<图标名>.json  同名元数据
├── brand/                     品牌标志 3 个（light / dark / morphicons）
├── library-logos/             10 个图标库自身标志
├── framework-logos/           4 个框架标志（React / Vue / Svelte / Astro）
├── picker/                    可搜索的图标选板（双击 index.html 打开）
│   ├── index.html             页面骨架
│   ├── styles.css             样式（跟随系统深浅色）
│   ├── app.js                 搜索 / 筛选 / 虚拟滚动 / 复制
│   └── data/                  按需加载的数据：index.js + 19 个 s-<set>.js
├── preview.html               全部图标的内联网页画廊（双击打开）
├── index.json                 全量索引（含内联 SVG 字符串）
├── MANIFEST.json              集合清单（数量 / 版本 / 许可）
└── README.md                  本文件
```

## 图标选板

双击 `picker/index.html`，纯本地静态页，不需要起服务，不联网。

- **搜索**：按 `/` 切到搜索框，空格分词，每个词都要命中。例如 `tabler home`、`lucide arrow`、`outline settings` 都能用（检索范围是图标名、上游名、图标集名和库名，都是英文）。
- **筛选**：顶部可按风格（全部 / 线性 / 填充）和图标库过滤。
- **详情**：点任意图标，右侧（窄屏是底部弹出）显示大图、来源、网格、许可、上游名，以及四个动作：复制 SVG、复制 JSX、复制路径 `d`、打开对应 `.svg` 文件。
- **虚拟滚动**：容器按总行数撑开，DOM 里只常驻视口内外的约 130–180 个卡片，滚动到底也不到 200 个节点，不会因为 2797 个图标卡顿。
- **按需加载**：`data/index.js` 只有名字和尺寸（约 130 KB），SVG 内容在 `data/s-<图标集>.js` 里，滚到哪一套才加载哪一套。

复制出来的 JSX 已把 `stroke-width`、`fill-rule`、`clip-path` 这类连字符属性改成驼峰写法，可以直接粘进 React 组件。

## 图标集

| 目录 | 图标集 | 风格 | 数量 | 版本 | 许可 |
| --- | --- | --- | ---: | --- | --- |
| `bi/fill` | Bootstrap Icons | fill | 102 | 1.13.1 | MIT |
| `bi/outline` | Bootstrap Icons | outline | 159 | 1.13.1 | MIT |
| `heroicons/fill` | Heroicons | fill | 137 | 2.2.0 | MIT |
| `heroicons/outline` | Heroicons | outline | 137 | 2.2.0 | MIT |
| `iconoir/fill` | Iconoir | fill | 48 | 7.12.1 | MIT |
| `iconoir/outline` | Iconoir | outline | 149 | 7.12.1 | MIT |
| `lucide/outline` | Lucide | outline | 175 | 未记录 | ISC |
| `material-symbols/fill` | Material Symbols | fill | 173 | 未记录 | Apache-2.0 |
| `material-symbols/outline` | Material Symbols | outline | 173 | 未记录 | Apache-2.0 |
| `mdi/fill` | Material Design Icons | fill | 176 | 未记录 | Apache-2.0 |
| `mdi/outline` | Material Design Icons | outline | 121 | 未记录 | Apache-2.0 |
| `mingcute/fill` | MingCute | fill | 150 | 未记录 | Apache-2.0 |
| `mingcute/outline` | MingCute | outline | 150 | 未记录 | Apache-2.0 |
| `ph/fill` | Phosphor | fill | 171 | 2.1.1 | MIT |
| `ph/outline` | Phosphor | outline | 171 | 2.1.1 | MIT |
| `ri/fill` | Remix Icon | fill | 159 | 4.8.0 | Apache-2.0 |
| `ri/outline` | Remix Icon | outline | 159 | 4.8.0 | Apache-2.0 |
| `tabler/fill` | Tabler | fill | 115 | 3.49.0 | MIT |
| `tabler/outline` | Tabler | outline | 172 | 3.49.0 | MIT |

## 额外素材

| 目录 | 内容 | 来源 | 许可 |
| --- | --- | --- | --- |
| `brand/` | morphicons 品牌标志 3 个 | `assets/`、`website/public/` | 跟随仓库 MIT |
| `library-logos/` | 10 个图标库标志 | `website/lib/library-logos.ts` | CC0 / 各库自有 |
| `framework-logos/` | React / Vue / Svelte / Astro | `website/lib/logos.ts` | CC0（simple-icons） |

## 用法

```html
<!-- <img> 引用：简单，但颜色固定为黑色 -->
<img src="lucide/outline/menu.svg" width="24" height="24" alt="menu">

<!-- 内联：currentColor 跟随父级文字颜色，可任意改色 -->
<span style="color:#0a84ff">
  <svg viewBox="0 0 24 24" width="24" height="24">…</svg>
</span>
```

所有图标用 `currentColor` 着色，作为 `<img>` 引用时会被固定为黑色；
需要跟随主题色请内联 SVG，或用 CSS `mask-image` 把 SVG 当蒙版。

## 许可

各图标集保留上游许可（ISC / MIT / Apache-2.0 等，见上表 `许可` 列与每个 `.json` 的 `license` 字段）。使用前请按对应许可保留署名。

## 复现

```bash
cd ~/Downloads/morphicons-extract
python3 extract_icons.py   # 图标集 → ~/Downloads/morphicons-icons/
python3 extras.py          # 品牌 / 库 / 框架标志
python3 build_picker.py    # 选板的分片数据 → morphicons-icons/picker/data/
```

脚本默认读取 `~/Downloads/morphicons-repo`；该目录不存在时会自动浅克隆
`https://github.com/guillermolg00/morphicons.git`。可用环境变量
`MORPHICONS_REPO` 与 `MORPHICONS_OUT` 改写源目录与输出目录。

更新的上游数据：`cd ~/Downloads/morphicons-repo && git pull` 后重跑两个脚本。
