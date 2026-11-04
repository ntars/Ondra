/**
 * 渲染 Windows 安装器用的品牌位图（brand / brand-dark / uninstaller-sidebar）。
 *
 * 为什么要有这个脚本：NSIS 自定义窗体（`installer/window-frame.cpp`）会把
 * `installer/assets/*.png` 嵌进去当标题区画面。这些图此前是从上游深寻 Harness
 * 直接沿用的，等于把别人的 logo 与英文名印在安装界面上——用户看到的是
 * 「这不是空谷」。图和代码一样属于品牌资产，必须可复现地生成，不能手工 PS。
 *
 * 产物（尺寸与原有素材严格一致，避免改动 window-frame.cpp 的布局假设）：
 * - `brand.png`        600 × 196，浅色标题区
 * - `brand-2x.png`    1200 × 392，同上 @2x
 * - `brand-dark.png`   600 × 196，深色标题区
 * - `brand-dark-2x.png` 1200 × 392，同上 @2x
 * - `uninstaller-sidebar.png` 164 × 314，卸载器侧栏
 *
 * 用法：`pnpm --filter @ntars/ondra-desktop run render:installer-assets`
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** 品牌字（与 `product-name.mjs` 的 PRODUCT_NAME 保持一致）。 */
const BRAND_TEXT = '空谷 Ondra'

/** 浅色/深色两种底色：深色取 NSIS 侧栏同款近黑，避免纯黑发闷。 */
const PALETTE = {
  light: { background: '#FFFFFF', ink: '#111111' },
  dark: { background: '#151517', ink: '#F5F5F7' },
} as const

const ICON_SOURCE = fileURLToPath(new URL('../resources/icon-windows.svg', import.meta.url))
const ASSET_DIR = fileURLToPath(new URL('../installer/assets/', import.meta.url))

/**
 * 标题区画面：左侧留白 + 应用图标徽章 + 右侧品牌字，整体水平居中。
 * @param scale 像素倍率（1 或 2）。
 * @param theme 浅色或深色。
 * @returns 完整 PNG 缓冲。
 */
async function renderBrand(scale: 1 | 2, theme: keyof typeof PALETTE): Promise<Buffer> {
  const { background, ink } = PALETTE[theme]
  const width = 600 * scale
  const height = 196 * scale
  const badge = Math.round(96 * scale)
  const gap = Math.round(20 * scale)
  const fontSize = Math.round(42 * scale)

  // 先量文字宽度，才能把「徽章 + 文字」作为一个整体居中。
  // 探针画布故意开得很大：量完用 trim 裁到墨迹边界，得到的才是文字本身宽度。
  const probe = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="200">
       <text x="0" y="160" font-family="PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, sans-serif"
             font-size="${fontSize}" font-weight="600" fill="${ink}">${BRAND_TEXT}</text>
     </svg>`,
  )
  const measured = await sharp(probe).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true })
  const textWidth = measured.info.width
  const totalWidth = badge + gap + textWidth
  const badgeLeft = Math.max(0, Math.round((width - totalWidth) / 2))
  const textLeft = badgeLeft + badge + gap

  const badgePng = await sharp(ICON_SOURCE).resize(badge, badge).png().toBuffer()
  const textLayer = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <text x="${textLeft}" y="${Math.round(height / 2 + fontSize / 3)}"
             font-family="PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, sans-serif"
             font-size="${fontSize}" font-weight="600" fill="${ink}">${BRAND_TEXT}</text>
     </svg>`,
  )

  return sharp({ create: { width, height, channels: 4, background } })
    .composite([
      { input: badgePng, top: Math.round((height - badge) / 2), left: badgeLeft },
      { input: textLayer, top: 0, left: 0 },
    ])
    .png()
    .toBuffer()
}

/**
 * 卸载器侧栏：竖版窄条，只放徽章，垂直居中偏上（与 NSIS 原生侧栏的视觉重量对齐）。
 * @returns 完整 PNG 缓冲。
 */
async function renderSidebar(): Promise<Buffer> {
  const width = 164
  const height = 314
  const badge = 96
  const badgePng = await sharp(ICON_SOURCE).resize(badge, badge).png().toBuffer()
  return sharp({ create: { width, height, channels: 4, background: PALETTE.light.background } })
    .composite([{ input: badgePng, top: Math.round(height * 0.34), left: Math.round((width - badge) / 2) }])
    .png()
    .toBuffer()
}

await mkdir(ASSET_DIR, { recursive: true })
await writeFile(new URL('brand.png', `file://${ASSET_DIR}`), await renderBrand(1, 'light'))
await writeFile(new URL('brand-2x.png', `file://${ASSET_DIR}`), await renderBrand(2, 'light'))
await writeFile(new URL('brand-dark.png', `file://${ASSET_DIR}`), await renderBrand(1, 'dark'))
await writeFile(new URL('brand-dark-2x.png', `file://${ASSET_DIR}`), await renderBrand(2, 'dark'))
await writeFile(new URL('uninstaller-sidebar.png', `file://${ASSET_DIR}`), await renderSidebar())
console.log(`installer assets written to ${ASSET_DIR}`)
