/**
 * 从 `icon.svg` 生成全部平台图标。
 *
 * ## 为什么要一个生成脚本
 *
 * 图标此前是"某次手动导出"的结果，散落在 `src-tauri/icons/` 的 19 个文件里。
 * 一旦要改图形，就得有人记得这 19 个都要重新导出、且各自尺寸要对——
 * 那次一定是靠手点的。脚本把这件事变成一条命令，SVG 才是唯一真源。
 *
 * ## 为什么自己画 squircle 而不直接渲染方形底
 *
 * macOS Big Sur 之后的应用图标是**连续曲率**圆角（squircle），
 * 不是普通圆角矩形。区别在于曲率从直边到圆角是渐变的，
 * 普通圆角的曲率在切点突变，放大后能看到一道折。
 * 系统不会替应用补这个形状——图标文件里就得是它。
 * 用 `<rect rx>` 渲染出来的图标在 Dock 里会显得"方正得有点硬"。
 *
 * ## 图形占比
 *
 * Apple 的图标网格里，图形主体应占底板的 60–70%。原图标只有 50%，
 * 在小尺寸（16/32）下会显得空。这里按 68% 重新排版并居中，
 * 用 `getBBox` 实测而不是靠眼睛估——估出来的数在 19 个尺寸里总会偏。
 *
 * ## 依赖
 *
 * 只用 Node 内置模块 + 系统自带的 `sips`（macOS）与 `iconutil`。
 * 不引入 sharp / canvas 这类原生模块：它们要编译，会让
 * `pnpm install` 在没装 Xcode 的机器上失败，而图标生成一年也跑不了几次。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const svgPath = join(repoRoot, 'icon.svg')
const outDir = join(repoRoot, 'src-tauri', 'icons')

/** 图形主体在底板内的目标占比。Apple 图标网格的经验值，取区间中值。 */
const GLYPH_RATIO = 0.68

/** 底板的边长（渲染分辨率）。1024 足够覆盖最大尺寸 icon_512x512@2x。 */
const CANVAS = 1024

/** macOS 图标网格：圆角方形四边各留的比例。 */
const PLATE_INSET = 100

/**
 * Apple 连续曲率圆角路径。
 *
 * 圆角半径取底板边长的 22.5%——macOS Big Sur 之后应用图标的比例。
 * 控制点取 0.44 倍半径，比普通圆弧的 0.5523 更收，
 * 这样曲率从直边平滑过渡到圆角，不会在切点出现折角。
 */
function appleSquircle(size, inset, k = 0.44) {
  const x = inset
  const y = inset
  const w = size - inset * 2
  const r = w * 0.225
  const c = r * k
  const p = (v) => Number(v.toFixed(2))
  const x2 = x + w
  const y2 = y + w

  return [
    `M ${String(p(x + r))},${String(p(y))}`,
    `L ${String(p(x2 - r))},${String(p(y))}`,
    `C ${String(p(x2 - r + c))},${String(p(y))} ${String(p(x2))},${String(p(y + r - c))} ${String(p(x2))},${String(p(y + r))}`,
    `L ${String(p(x2))},${String(p(y2 - r))}`,
    `C ${String(p(x2))},${String(p(y2 - r + c))} ${String(p(x2 - r + c))},${String(p(y2))} ${String(p(x2 - r))},${String(p(y2))}`,
    `L ${String(p(x + r))},${String(p(y2))}`,
    `C ${String(p(x + r - c))},${String(p(y2))} ${String(p(x))},${String(p(y2 - r + c))} ${String(p(x))},${String(p(y2 - r))}`,
    `L ${String(p(x))},${String(p(y + r))}`,
    `C ${String(p(x))},${String(p(y + r - c))} ${String(p(x + r - c))},${String(p(y))} ${String(p(x + r))},${String(p(y))}`,
    'Z',
  ].join(' ')
}

/** 起一个 headless 浏览器做渲染，返回 CDP 客户端。 */
async function launchBrowser() {
  // 优先用 Playwright 缓存的 headless shell，其次系统的 Chrome。
  const candidates = [
    join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  const bin = candidates.find((path) => existsSync(path))
  if (bin === undefined) {
    throw new Error('找不到可用的 Chromium。请安装 Chrome，或运行 `pnpm exec playwright install chromium`。')
  }

  const port = 9500 + Math.floor(Math.random() * 400)
  const child = spawn(bin, [
    '--headless',
    // 沙箱环境常见 GPU 不可用，禁用后仍能软件渲染。
    '--no-sandbox',
    '--disable-gpu',
    '--use-gl=disabled',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${String(port)}`,
    'about:blank',
  ], { stdio: 'ignore' })

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // 等调试端口起来。固定等 1.4 秒比轮询简单，且这个脚本不是热路径。
  await wait(1400)

  const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (page === undefined) throw new Error('浏览器没有可用页面')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  const send = (method, params) => new Promise((done) => {
    seq += 1
    pending.set(seq, done)
    ws.send(JSON.stringify({ id: seq, method, params }))
  })

  await send('Page.enable', {})
  await send('Runtime.enable', {})
  return {
    send,
    close: () => { ws.close(); child.kill() },
  }
}

/** 主流程。 */
async function main() {
  if (!existsSync(svgPath)) throw new Error(`找不到图标真源：${svgPath}`)
  const source = readFileSync(svgPath, 'utf8')

  // 从 SVG 里抠出主体路径与底板颜色，重新组装成 1024 画布。
  // 不直接用原 SVG 缩放：原文件的 viewBox 是 24×24，直接放大会让
  // 圆角与留白跟着一起放大，失去 Apple 网格的对齐。
  const glyphMatch = source.match(/<path[^>]*\/>/u)
  if (glyphMatch === null) throw new Error('icon.svg 里没有 <path> 主体')

  // 必须剥掉路径自带的 transform。
  //
  // 原 SVG 的主体路径带着 `transform="translate(14.006 11.646) scale(0.03781)"`
  // ——它把 -211..106 这个原始坐标系压进 24 视野。而 `getBBox()` **不包含**
  // 元素自身的 transform，量到的是压缩前的坐标；如果留着它，外层再套一个
  // `<g transform>`，两层就会相乘：0.03781 × 1.55 ≈ 0.059，
  // 图形缩成一个看不见的点，整张图只剩白色底板。
  //
  // 这正是第一版渲染出全白的原因。现在统一由脚本按 getBBox 结果算变换，
  // 路径自身不带任何位移与缩放。
  const glyph = glyphMatch[0].replace(/\s*transform="[^"]*"/u, '')
  const plateFill = source.match(/<rect[^>]*fill="([^"]+)"/u)?.[1] ?? '#ffffff'

  const browser = await launchBrowser()
  try {
    // 先量出主体路径在自身坐标系里的边界，据此算出缩放与位移。
    // 硬编码 scale/translate 是原图标的做法，改一次图形就得重算，
    // 用 getBBox 让脚本自己适配任何图形。
    const measureHtml = `<!doctype html><body style="margin:0"><svg id="s" width="24" height="24" viewBox="0 0 24 24">${glyph}</svg></body>`
    writeFileSync(join(tmpdir(), 'ondra-measure.html'), measureHtml)
    await browser.send('Page.navigate', { url: `file://${join(tmpdir(), 'ondra-measure.html')}` })
    await new Promise((r) => setTimeout(r, 600))

    const measured = await browser.send('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('#s path').getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`,
      returnByValue: true,
    })
    const box = measured.result?.result?.value
    if (box === undefined) throw new Error('量取图形边界失败')

    // 缩放：让主体的较长边占底板的 GLYPH_RATIO。
    const plateSize = CANVAS - PLATE_INSET * 2
    const target = plateSize * GLYPH_RATIO
    const scale = target / Math.max(box.w, box.h)

    // 位移：把主体中心对到底板中心。
    const scaledW = box.w * scale
    const scaledH = box.h * scale
    const offsetX = CANVAS / 2 - scaledW / 2 - box.x * scale
    const offsetY = CANVAS / 2 - scaledH / 2 - box.y * scale

    const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(CANVAS)}" height="${String(CANVAS)}" viewBox="0 0 ${String(CANVAS)} ${String(CANVAS)}">
  <path d="${appleSquircle(CANVAS, PLATE_INSET)}" fill="${plateFill}"/>
  <g transform="translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})">
    ${glyph}
  </g>
</svg>`
    writeFileSync(join(repoRoot, 'icon-1024.svg'), finalSvg)

    // 用浏览器渲染成 PNG。透明背景，让 squircle 之外真正透明。
    const renderHtml = `<!doctype html><body style="margin:0;background:transparent">${finalSvg}</body>`
    writeFileSync(join(tmpdir(), 'ondra-render.html'), renderHtml)

    // 让截图真的带 alpha 通道。
    //
    // 只给 <body> 写 `background:transparent` 是不够的：浏览器有一个独立的
    // "画布底色"（默认白），CDP 截图会把它合成到 alpha 上，于是四角变成
    // 不透明的白，PNG 直接退化成 RGB 三通道（实测 ch=3、transparent=0%）。
    // 这个 override 把画布底色也换成全透明，squircle 之外才真的透出 Dock。
    //
    // 必须在 Page.navigate 之前设，否则页面已经用旧底色绘制过一轮。
    await browser.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: CANVAS, height: CANVAS, deviceScaleFactor: 1, mobile: false,
    })
    await browser.send('Page.navigate', { url: `file://${join(tmpdir(), 'ondra-render.html')}` })
    await new Promise((r) => setTimeout(r, 800))

    const shot = await browser.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: CANVAS, height: CANVAS, scale: 1 },
      // 关键：保留透明度。不写这个，透明区域会变成白色，
      // 图标在深色 Dock 里会有一圈白框。
      captureBeyondViewport: false,
    })
    const png = Buffer.from(shot.result.data, 'base64')

    mkdirSync(outDir, { recursive: true })
    const masterPath = join(outDir, 'icon.png')
    writeFileSync(masterPath, png)
    console.log(`主图已渲染：${String(CANVAS)}×${String(CANVAS)}，主体占比 ${String(Math.round(GLYPH_RATIO * 100))}%`)

    // 用 sips 生成各尺寸。系统自带，不必额外装依赖。
    const sips = (args) => new Promise((done, fail) => {
      const proc = spawn('sips', args, { stdio: 'ignore' })
      proc.on('exit', (code) => { code === 0 ? done() : fail(new Error(`sips 失败：${args.join(' ')}`)) })
    })

    const pngSizes = [16, 32, 64, 128, 256, 512]
    for (const size of pngSizes) {
      const out = join(outDir, `${String(size)}x${String(size)}.png`)
      await sips(['-z', String(size), String(size), masterPath, '--out', out])
    }
    // @2x 版本：128 的 @2x 是 256，512 的 @2x 是 1024。Tauri 认这几个名字。
    await sips(['-z', '256', '256', masterPath, '--out', join(outDir, '128x128@2x.png')])
    await sips(['-z', '1024', '1024', masterPath, '--out', join(outDir, 'icon-1024.png')])

    // Windows 的 Store 徽标：Tauri 需要这一组。
    const storeSizes = [
      ['Square30x30Logo.png', 30], ['Square44x44Logo.png', 44],
      ['Square71x71Logo.png', 71], ['Square89x89Logo.png', 89],
      ['Square107x107Logo.png', 107], ['Square142x142Logo.png', 142],
      ['Square150x150Logo.png', 150], ['Square284x284Logo.png', 284],
      ['Square310x310Logo.png', 310], ['StoreLogo.png', 50],
    ]
    for (const [name, size] of storeSizes) {
      await sips(['-z', String(size), String(size), masterPath, '--out', join(outDir, String(name))])
    }

    // .icns：用 iconutil 打包。它要求 iconset 目录里有规范命名的多尺寸。
    const iconsetDir = join(tmpdir(), 'ondra.iconset')
    rmSync(iconsetDir, { recursive: true, force: true })
    mkdirSync(iconsetDir, { recursive: true })
    const iconsetSizes = [
      [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
    ]
    for (const [size, name] of iconsetSizes) {
      await sips(['-z', String(size), String(size), masterPath, '--out', join(iconsetDir, name)])
    }
    await new Promise((done, fail) => {
      const proc = spawn('iconutil', ['-c', 'icns', iconsetDir, '-o', join(outDir, 'icon.icns')], { stdio: 'ignore' })
      proc.on('exit', (code) => { code === 0 ? done() : fail(new Error('iconutil 失败')) })
    })

    // .ico：Windows 用。Tauri 只认一个文件，所以塞多个尺寸进去——
    // 任务栏（32）、资源管理器小图标（16）、大图标（256）各自取合适的那张，
    // 比只放 256 让系统缩放要清楚得多。拼 ico 不需要额外库，见 buildIco。
    const icoParts = []
    for (const size of [16, 32, 48, 64, 128, 256]) {
      await sips(['-z', String(size), String(size), masterPath, '--out', join(tmpdir(), `ondra-ico-${String(size)}.png`)])
      icoParts.push({ size, png: readFileSync(join(tmpdir(), `ondra-ico-${String(size)}.png`)) })
    }
    writeFileSync(join(outDir, 'icon.ico'), buildIco(icoParts))

    console.log(`已生成 ${String(pngSizes.length + storeSizes.length + 4)} 个图标文件到 src-tauri/icons/`)

    // 落地页的 favicon 也走同一份母版。
    //
    // 这几个文件原先各自是"某次单独导出"的，白底方图、无 alpha，
    // 浏览器标签页里就是一块白色方块，和 Dock 里的 squircle 对不上。
    // 现在统一从 icon.png 缩出来，唯一真源仍然只有 icon.svg。
    const siteDir = join(repoRoot, 'assets')
    mkdirSync(siteDir, { recursive: true })
    for (const [size, name] of [[16, 'favicon-16.png'], [32, 'favicon-32.png'], [180, 'favicon-180.png']]) {
      await sips(['-z', String(size), String(size), masterPath, '--out', join(siteDir, name)])
    }
    // favicon.ico：多尺寸合一，16/32/48 各一份，Windows 与旧浏览器认这个。
    //
    // 写在仓库根目录而不是 assets/ 下：edgeone.json 的缓存头与 tools/build-site.mjs
    // 的 STATIC_FILES 都按 /favicon.ico 这个根路径来，浏览器也会在没声明时
    // 主动请求 /favicon.ico。放到子目录会让这两处同时失效。
    const favParts = []
    for (const size of [16, 32, 48]) {
      await sips(['-z', String(size), String(size), masterPath, '--out', join(tmpdir(), `ondra-fav-${String(size)}.png`)])
      favParts.push({ size, png: readFileSync(join(tmpdir(), `ondra-fav-${String(size)}.png`)) })
    }
    writeFileSync(join(repoRoot, 'favicon.ico'), buildIco(favParts))
    console.log(`已同步落地页 favicon：16/32/180 与多尺寸 favicon.ico`)
  } finally {
    browser.close()
  }
}

/**
 * 把若干张 PNG 包成 .ico。
 *
 * ICO 结构很老但很简单：6 字节文件头 + 每张图 16 字节目录项 + 各图数据本体。
 * Vista 之后的 Windows 支持在 ico 里直接嵌 PNG（不必转 BMP），
 * 所以这里不写调色板也不做位深转换。
 *
 * 传单张时就是原来的单尺寸 ico；传多张时按尺寸升序写多个目录项，
 * 让浏览器与资源管理器各自挑合适的那张，而不是靠缩放单张大图。
 *
 * @param {{size: number, png: Buffer}[] | Buffer} input 多尺寸数组，或单张 PNG
 * @param {number} [singleSize] 单张 PNG 时它的边长
 */
function buildIco(input, singleSize) {
  const images = Array.isArray(input)
    ? [...input].sort((a, b) => a.size - b.size)
    : [{ size: singleSize, png: input }]

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)                  // 保留位
  header.writeUInt16LE(1, 2)                  // 类型：1 = 图标
  header.writeUInt16LE(images.length, 4)      // 图像数量

  // 目录项等长（16 字节 × N），数据区紧接其后依次排布。
  let dataOffset = 6 + 16 * images.length
  const entries = []
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)   // 宽，0 表示 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1)   // 高
    entry.writeUInt8(0, 2)                        // 调色板数
    entry.writeUInt8(0, 3)                        // 保留
    entry.writeUInt16LE(1, 4)                     // 颜色平面
    entry.writeUInt16LE(32, 6)                    // 位深
    entry.writeUInt32LE(png.length, 8)            // 数据长度
    entry.writeUInt32LE(dataOffset, 12)           // 数据偏移
    entries.push(entry)
    dataOffset += png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

await main()
