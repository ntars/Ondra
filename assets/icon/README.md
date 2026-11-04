# 空谷 Ondra · macOS 应用图标（分层源）

> 主体沿用项目现用图标（`desktop/apps/desktop/resources/icon-tile.svg` 的手写笔触）。
> 旧的逆戟鲸版本已于 2026-11-03 整体移除：三份 SVG（`resources/icon.svg` / `icon-macos.svg` / `icon-windows.svg`）已在 git 历史中留档，需要追溯用 `git show HEAD~1:desktop/apps/desktop/resources/icon.svg` 取回，不再另存备份包。

---

## 一、目录

```
assets/icon/
├── layers/
│   ├── default/   01-background.svg  02-breakout.svg  03-subject.svg
│   ├── dark/      01-background.svg  02-breakout.svg  03-subject.svg
│   └── tinted/    01-background.svg  02-breakout.svg  03-subject.svg
├── 1024/
│   ├── icon-1024.png                Default 主图（1024，可直接当交付主图）
│   ├── icon-1024-dark.png           Dark
│   ├── icon-1024-tinted.png         Tinted（透明底 + 白色剪影，交给系统着色）
│   ├── icon-1024-tinted-preview.png Tinted 的示意预览（浅灰底，仅用于肉眼判断）
│   └── icon-128/64/32/16.png        Default 的小尺寸抽样
```

文件名前的 `01 / 02 / 03` 就是导入 Icon Composer 的顺序：**从后往前**。

---

## 二、几何（全部为 1024 画布实测值）

| 项 | 数值 | 说明 |
| --- | --- | --- |
| 画布 | 1024 × 1024 | 正方形，不画圆角 |
| 主体外接 | **614 × 697** | 落在中央 820 安全框内，四边留白 **205 / 205 / 163 / 164** |
| 主体位置 | x 205–818，y 163–859 | **与出厂 `icon.png` 逐像素一致**；未缩放、未做光学对中 |
| 破框外接 | **886** | 比 820 框外扩 **66px，占画布 6.45%**（要求 5%–8%） |
| 破框距边 | 69px | 最外缘离画布边 69px，任何元素都不越出 1024 |
| 整体外接 | 886 ≤ 1024 | Dock 里与其它 App 视觉体量一致 |

**为什么主体不放大到 820**：原图笔触是不对称的，视觉重心本来就不在包围盒正中。放大或“纠正”都会破坏已经调好的平衡，所以这里只做「原样搬到去掉圆角的 1024 画布上」。要更强存在感的话，把 `03-subject.svg` 的 `matrix` 整体包一层 `translate(512 512) scale(1.12) translate(-512 -512)` 即可，其余不动。

**破框层是什么**：一道与画布同心的回响环（呼应「于无声处，听见共鸣」）。它必须压在主体**之下**——盖在笔触前面会把笔锋切断。环的线宽 5、透明度很低，在 32px / 16px 下自然消失，不会糊成一团。

---

## 三、三种外观

| 层 | Default | Dark | Tinted |
| --- | --- | --- | --- |
| 01 背景 | `#FFFFFF` 实心满幅 | `#17181A` 实心满幅 | 透明（系统着色） |
| 02 破框 | `#111111` @ 10% | `#FFFFFF` @ 15% | `#FFFFFF` @ 12% |
| 03 主体 | `#111111` 实心 | `#F2F4F5` 实心 | `#FFFFFF` 实心 |

三档都只用了**实心色**，没有渐变、没有投影、没有圆角、没有文字——镜面高光、内阴影、圆角遮罩、层间投影一律由系统施加，烘进去就会叠两遍。

---

## 四、进 Icon Composer

1. 打开 Icon Composer（Xcode 26 起在 `Xcode › Open Developer Tool`），新建文档，平台选 **macOS**。
2. 把 `layers/default/` 里三个 SVG **按 01 → 02 → 03 顺序**拖进画布；Layout 保持 `0, 0, 100%`，不要缩放。
3. 背景层可以两种做法任选：用 `01-background.svg`，或者删掉该层、在检查器里把背景 Fill 设为 Solid `#FFFFFF`。**本项目的白底建议用 SVG 层**，跨外观更好核对。
4. 切到 **Dark**，把三层换成 `layers/dark/` 的对应文件（同名替换）；切到 **Mono / Tinted**，换成 `layers/tinted/`。
5. Liquid Glass 分组建议：01 与 02 同组（背景 + 回响），03 单独一组（主体浮起），这样倾斜时有前后景深。**Shadows 保持系统默认**，不要手动加。
6. 逐个外观预览，确认 32px / 16px 下笔触仍是一笔连贯的形状。
7. 保存 `.icon` → 拖进 `Assets.xcassets` → 让 target 的 App Icon 指向它。

---

## 五、resources/ 扁平清单（同一画稿，多格式平铺）

桌面打包与网站各吃各的格式，全部由同一支笔触派生，不再各画各的：

| 文件 | 规格 | 用途 |
| --- | --- | --- |
| `resources/icon-tile.svg` | 1104 矢量，瓦片 (40,32)，含 `ondra-tile` / `ondra-artwork` 分组 | **扁平资产的唯一画稿来源** |
| `resources/icon.svg` | 1104 矢量，方正白瓦片，无圆角无投影 | 通用矢量主图 |
| `resources/icon-macos.svg` | 1024，824 主体（Apple 栅格）+ 圆角 230 | macOS 概念稿 |
| `resources/icon-windows.svg` | 1024，960 主体 + 圆角 192 | Windows 概念稿 |
| `resources/icon.png` | 1024，满幅圆角 230，透明角 | 通用位图 |
| `resources/icon-macos.png` / `icon-windows.png` | 1024，由同名 SVG 渲染 | electron-builder `mac.icon` / `win.icon` |
| `resources/tray-windows.svg` + `.ico` | 白底圆角徽章（922，留 5% 边）+ 深色笔触；ico 含 16/20/24/32/40/48/64 | Windows 托盘 |
| `resources/tray-macos.svg` + `.png` / `.png@2x` | 白底圆角徽章 + **主体镂空**（露出菜单栏底色）；16 / 32 | macOS 菜单栏 |
| `web/public|dist/favicon.svg` + `-dark.svg` | **裸标记**，无底，`fill="#000"` / `fill="#fff"`，两者仅颜色不同 | 浏览器 favicon（浅色/深色 scheme） |

**托盘两枚的白底理由**：Windows 托盘可能压在深色任务栏上，macOS 菜单栏深色模式同理；裸标记会与底色同色，所以垫白底徽章。macOS 那枚按主人的要求把主体**镂空**——代价是浅色菜单栏上徽章与底几乎同色（白贴白），届时若要两态通吃，改成 `Template` 模板图（纯黑 + 透明，系统自动反色）即可，资产与代码各改一行。

**favicon 契约**（`desktop/apps/web/tests/pwa-manifest.e2e.ts` 钉死）：light 含 `fill="#000"`、dark 含 `fill="#fff"`，且把 dark 的填色替换成 `#000` 后与 light 逐字节相同。两份旧鲸图此前不满足，现已对齐。

---

## 六、还没换的地方（别被误导）

1. `desktop/apps/desktop/scripts/electron-builder-config.mjs:167` 的 `mac.icon` 仍指 `icon-macos.png`（扁平图）。要吃 Liquid Glass，得在 Icon Composer 里存出 `.icon` 再指过去——涉及打包链，**未在本次改动**。
2. `build/空谷 Ondra.app` 的 `icon.icns` / `icon.png` **已换成新稿并重新 adhoc 签名**（`codesign --verify --deep --strict` 通过）。同目录的 `ondra-1.0.1-mac-arm64-unsigned.dmg` 仍是替换前的镜像，**要重新打包**才会带上新图标。
3. 网站 PNG（`web/public/icon-*.png` 等）由 `desktop/apps/web/scripts/render-app-icons.ts` 从 `icon-tile.svg` 生成；改瓦片后跑 `pnpm --filter @ntars/ondra-web-frontend run render:app-icons` 重新出图。

---

## 六、重新生成

三层都是纯 SVG，改颜色直接改 `fill` / `stroke-opacity` 即可，不需要重新导出。
若笔触主体要跟着 `icon-tile.svg` 一起变，注意它内嵌了一串 `translate/scale/matrix`，
`03-subject.svg` 里已把整串合成成一个 `matrix(...)`（含去掉瓦片 (40, 32) 偏移的那一步），
换主体时重算这个矩阵即可，**不要**只替换 `d` 而不换矩阵。
