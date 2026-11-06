/**
 * 从 `icon.svg` 生成托盘图标三档（16 / 32 / 64）。
 *
 * ## 为什么托盘图标不能直接用 `icons/32x32.png`
 *
 * `32x32.png` 是**应用图标**：白色 squircle 底板 + 黑色鲸鱼。它放在 Dock 里
 * 是对的，放进 macOS 菜单栏就错两层：
 *
 * 1. **底板不该存在。** 菜单栏图标是一枚剪影，系统按 `template` 规则把
 *    不透明像素整体染成黑或白。带底板就是一块 16×16 的实心方块，在菜单栏
 *    里比旁边的系统图标重得多。§4.5 也写明托盘要的是「只有图形、没有底板」
 *    的那一版。
 * 2. **尺寸档位不该只有 32。** §12.10 要求 16 / 32 / 64 三档。只给 32 让系统
 *    缩到 16 时，鲸鱼尾鳍那几条 1px 的细缝会糊成灰团。
 *
 * ## 为什么自己渲染而不改 `build-icons.mjs`
 *
 * 那个脚本产出的是「交付给系统的应用图标」，要 squircle、要留白、要 .icns。
 * 托盘要的是完全是另一件东西（无底板、纯剪影、按模板染色）。把两种语义
 * 塞进一个脚本，改一处必然误伤另一处。两者共用同一个真源 `icon.svg`，
 * 各自渲染，这是最小耦合。
 *
 * ## 输出
 *
 * `src-tauri/tray/` 下三个 PNG。放在 `src-tauri/` 内是因为要随安装包一起
 * 进 `Resources/`：托盘图标是运行时读的，不进 `icons/`（那是打包器的图标源，
 * 不保证被拷进 Resources）。
 *
 * 依赖与 `build-icons.mjs` 相同：Node 内置模块 + 系统 `sips`。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const svgPath = join(repoRoot, 'icon.svg')
const outDir = join(repoRoot, 'src-tauri', 'tray')

/** 三档边长。16 = 1x 菜单栏，32 = 2x，64 = 部分 Linux 桌面的放大场景。 */
const SIZES = [16, 32, 64]

/**
 * 渲染边长。取 512 而不是 1024：托盘最大只到 64，4 倍超采样足够，
 * 且 512 的渲染与 sips 缩放都快得多。
 */
const CANVAS = 512

/**
 * 图形主体占画布的比例。
 *
 * 比应用图标的 0.68 更大：没有底板留白，剪影要撑满才能和系统图标的
 * 视觉重量对齐。0.88 是让路径外接框几乎贴边、只留防抗锯齿裁切的余量。
 */
const GLYPH_RATIO = 0.88

/** 起一个 headless 浏览器做渲染，返回 CDP 客户端。 */
async function launchBrowser() {
  const candidates = [
    join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  const bin = candidates.find((path) => existsSync(path))
  if (bin === undefined) {
    throw new Error('找不到可用的 Chromium。请安装 Chrome，或运行 `pnpm exec playwright install chromium`。')
  }

  const port = 9900 + Math.floor(Math.random() * 400)
  const child = spawn(bin, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--use-gl=disabled',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${String(port)}`,
    'about:blank',
  ], { stdio: 'ignore' })

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
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

  const glyphMatch = source.match(/<path[^>]*\/>/u)
  if (glyphMatch === null) throw new Error('icon.svg 里没有 <path> 主体')

  // 剥掉路径自带的 transform，理由同 `build-icons.mjs`：
  // `getBBox()` 不包含元素自身 transform，留着会与外层变换相乘。
  const glyph = glyphMatch[0].replace(/\s*transform="[^"]*"/u, '')

  // 托盘剪影固定纯黑。模板图标的颜色由系统染，文件里给什么色不重要，
  // 但必须是**不透明**的：alpha 通道才是系统判断「哪里该染色」的依据。
  const silhouette = glyph.replace(/fill="[^"]*"/u, 'fill="#000000"')

  const browser = await launchBrowser()
  try {
    const measureHtml = `<!doctype html><body style="margin:0"><svg id="s" width="24" height="24" viewBox="0 0 24 24">${glyph}</svg></body>`
    writeFileSync(join(tmpdir(), 'ondra-tray-measure.html'), measureHtml)
    await browser.send('Page.navigate', { url: `file://${join(tmpdir(), 'ondra-tray-measure.html')}` })
    await new Promise((r) => setTimeout(r, 600))

    const measured = await browser.send('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('#s path').getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`,
      returnByValue: true,
    })
    const box = measured.result?.result?.value
    if (box === undefined) throw new Error('量取图形边界失败')

    const target = CANVAS * GLYPH_RATIO
    const scale = target / Math.max(box.w, box.h)
    const scaledW = box.w * scale
    const scaledH = box.h * scale
    const offsetX = CANVAS / 2 - scaledW / 2 - box.x * scale
    const offsetY = CANVAS / 2 - scaledH / 2 - box.y * scale

    // 无底板：只有图形，四周全透明。
    const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(CANVAS)}" height="${String(CANVAS)}" viewBox="0 0 ${String(CANVAS)} ${String(CANVAS)}">
  <g transform="translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})">
    ${silhouette}
  </g>
</svg>`

    const renderHtml = `<!doctype html><body style="margin:0;background:transparent">${finalSvg}</body>`
    writeFileSync(join(tmpdir(), 'ondra-tray-render.html'), renderHtml)

    // 画布底色也必须透明，否则截图的四角会合成为不透明白，
    // 剪影变成一个填满画布的黑方块。这条与 `build-icons.mjs` 同理。
    await browser.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: CANVAS, height: CANVAS, deviceScaleFactor: 1, mobile: false,
    })
    await browser.send('Page.navigate', { url: `file://${join(tmpdir(), 'ondra-tray-render.html')}` })
    await new Promise((r) => setTimeout(r, 800))

    const shot = await browser.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: CANVAS, height: CANVAS, scale: 1 },
    })
    const master = Buffer.from(shot.result.data, 'base64')

    mkdirSync(outDir, { recursive: true })
    const masterPath = join(tmpdir(), 'ondra-tray-master.png')
    writeFileSync(masterPath, master)

    const sips = (args) => new Promise((done, fail) => {
      const proc = spawn('sips', args, { stdio: 'ignore' })
      proc.on('exit', (code) => { code === 0 ? done() : fail(new Error(`sips 失败：${args.join(' ')}`)) })
    })

    for (const size of SIZES) {
      await sips(['-z', String(size), String(size), masterPath, '--out', join(outDir, `tray-${String(size)}.png`)])
    }

    // @2x 变体：macOS 会优先找 `tray-16@2x.png`。文件名带尺寸，
    // 由 Rust 侧按 DPI 选，而不是让系统自己缩。
    await sips(['-z', '32', '32', masterPath, '--out', join(outDir, 'tray-16@2x.png')])
    await sips(['-z', '64', '64', masterPath, '--out', join(outDir, 'tray-32@2x.png')])

    console.log(`托盘图标已生成到 src-tauri/tray/：${SIZES.map((size) => String(size)).join(' / ')} 与两档 @2x`)
  } finally {
    browser.close()
  }
}

await main()
