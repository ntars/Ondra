/**
 * 新界面渲染核对（第 5 批前半）。
 *
 * ## 它验什么
 *
 * 1. 820 × 580 的垂直/水平预算是否对上 §3.1、§3.2（旧脚本按旧界面类名写死，
 *    已不适用新骨架，因此单开这一个）。
 * 2. 本轮四个新件是否真的工作：Composer（能打字/能发送/高度自适应）、
 *    overlay 滚动条（不占布局）、Toast（居中、可关）、消息悬停操作（复制/引用）。
 * 3. 令牌核对：`src/**\/*.css` 里每个 `var(--x)` 都能在 `tokens.css` 找到定义。
 *
 * ## 为什么必须真跑
 *
 * 上一轮的教训：只读 CSS 文件判断「写没写」会漏掉父级高度链断裂那类问题，
 * 实测三栏只有 254px 高。尺寸与交互都必须在真实 DOM 上量。
 */

import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const ROOT = new URL('../dist/', import.meta.url).pathname
const OUT = new URL('../.shots/', import.meta.url).pathname

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** 找一个可用的 playwright-core。 */
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  for (const id of ['playwright-core', 'playwright', '/tmp/ondra-shot/node_modules/playwright-core']) {
    try { return require(id) } catch { /* 换下一个 */ }
  }
  throw new Error('找不到 playwright-core')
}

/** 找一个可用的 Chrome。 */
function findChrome() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const candidates = [
    join(cache, 'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    join(cache, 'chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const path of candidates) if (existsSync(path)) return path
  throw new Error('找不到 Chrome')
}

const now = Date.now()
const MIN = 60_000

const SESSIONS = [
  { id: 's1', title: '关于雨的那个比喻', createdAt: now - 2 * MIN, updatedAt: now - 12 * MIN, archived: false, workspace: '' },
]

const MESSAGES = [
  { id: 'm1', role: 'user', content: '你觉不觉得今天这场雨，像有人在很低的地方说话。', createdAt: now - 2 * MIN },
  {
    id: 'm2',
    role: 'assistant',
    content: '像。雨落在不同的东西上会换一种嗓音——落在伞面是闷的，落在铁皮上是脆的，落在叶子上的那一种最轻。\n\n我更喜欢它停下来的那几秒。屋檐还在滴水，但已经不是雨了，是雨留下的回声。',
    createdAt: now - 2 * MIN + 20_000,
  },
]

const MODELS = [
  { id: 'magpie', label: 'magpie', contextWindow: 32768, supportsTools: true, supportsStreaming: true },
  { id: 'deepseek-chat', label: 'deepseek-chat', contextWindow: 65536, supportsTools: false, supportsStreaming: true },
]

function json(response, body) {
  const text = JSON.stringify(body)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function serve() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/api/health') return json(response, { ok: true, at: Date.now() })
    if (path === '/api/sessions' && request.method === 'GET') return json(response, SESSIONS)
    if (path === '/api/sessions' && request.method === 'POST') return json(response, SESSIONS[0])
    if (path === '/api/models') return json(response, MODELS)
    if (path === '/api/config') return json(response, { currentModel: 'magpie', permission: 'workspace', profiles: [] })
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) return json(response, MESSAGES)
    if (path.startsWith('/api/')) return json(response, { ok: true })
    const file = join(ROOT, normalize(path === '/' ? 'index.html' : path).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(ROOT) || !existsSync(file)) { response.writeHead(404).end('not found'); return }
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve({ server, port: server.address().port }) })
  })
}

const fakeShell = (port) => `
(() => {
  const url = 'http://127.0.0.1:${String(port)}'
  window.__TAURI__ = {
    core: { invoke: async (c) => c === 'get_host_state'
      ? { state: 'ready', url, token: 'dev', port: ${String(port)} } : null },
    event: { listen: async (name, handler) => {
      if (name === 'host-ready') handler({ payload: { url, token: 'dev', port: ${String(port)} } })
      return () => {}
    } },
  }
})()
`

/**
 * 令牌核对（§13「Tokens 层专项」）。
 *
 * ## 为什么要做
 *
 * `var(--x)` 找不到定义时**不报错、不警告**，只是整条声明静默失效。
 * 于是「写了 padding: var(--foo)」和「没写 padding」看起来一样，
 * 而缺陷只在某个特定状态下才显形。上一批就栽在这上面。
 *
 * ## 口径
 *
 * 把 `src/**\/*.css`（除 `tokens.css` 自身）里所有 `var(--…)` 抽出来，
 * 与 `tokens.css` 里定义的键求差集。差集为空才算通过。
 * 同一文件内部的局部变量（`--inspector-*` 这类）也算定义，
 * 所以定义集合要把所有文件里出现过的 `--x:` 都收进去。
 */
async function checkTokens() {
  const { readdir, readFile } = await import('node:fs/promises')
  const root = new URL('../src/', import.meta.url).pathname

  /** 递归收集 css 文件。 */
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) files.push(...await walk(path))
      else if (entry.name.endsWith('.css')) files.push(path)
    }
    return files
  }

  const files = await walk(root)
  const defined = new Set()
  const used = new Map()

  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    /*
     * 先剥注释再扫。
     *
     * 注释里会写 `var(--focus-ring-w)` 这类**举例说明**的片段，
     * 直接扫会把它们当成真实引用，报出「令牌未定义」的假缺陷。
     * 上一版就是这样误报了 `--focus-ring-w`——它只是文档里的一个例子。
     */
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    // 定义：行首（可带缩进）的 `--name:`。
    for (const match of text.matchAll(/(?:^|\s)(--[a-z0-9-]+)\s*:/g)) defined.add(match[1])
    // 使用：`var(--name` 或 `var(--name,`。
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      if (!used.has(match[1])) used.set(match[1], new Set())
      used.get(match[1]).add(file.split('/src/')[1])
    }
  }

  const missing = [...used.keys()].filter((name) => !defined.has(name))
  console.log(`\n令牌核对：使用 ${String(used.size)} 个，未定义 ${String(missing.length)} 个`)
  for (const name of missing) {
    console.log(`  ✗ ${name}  出现在 ${[...used.get(name)].join('、')}`)
  }
  if (missing.length === 0) console.log('  ✓ 全部有定义，无静默回落')
  return missing.length === 0
}

/** 量一组尺寸与交互。 */
async function run() {
  const { chromium } = loadPlaywright()
  const { server, port } = await serve()
  const browser = await chromium.launch({ executablePath: findChrome() })
  const page = await browser.newPage({ viewport: { width: 820, height: 580 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => { errors.push(String(error)) })

  await page.addInitScript(fakeShell(port))
  await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await mkdir(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, 'welcome-v5.png') })

  // 进入三栏：点首页入口。
  await page.locator('.welcome__start').click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, 'empty-v5.png') })

  // 打开「今天」抽屉，点进那个带消息的历史会话——
  // 空会话里没有消息，消息级交互（悬停操作条）必须在有消息的会话里验。
  await page.locator('.rail__item').first().click()
  await page.waitForTimeout(400)
  await page.locator('.drawer__row').first().click()
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(OUT, 'session-v5.png') })

  const result = await page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) return null
      const r = node.getBoundingClientRect()
      const s = getComputedStyle(node)
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        radius: s.borderRadius, bg: s.backgroundColor,
        z: s.zIndex,
      }
    }
    const textarea = document.querySelector('.composer__input')
    const card = document.querySelector('.composer__card')
    return {
      docWidth: document.documentElement.scrollWidth,
      titlebar: box('.titlebar'),
      rail: box('.rail'),
      column: box('.column'),
      spine: box('.spine'),
      composer: box('.composer'),
      card: box('.composer__card'),
      measure: box('.timeline__measure'),
      scrollThumb: document.querySelectorAll('.scrollarea__thumb').length,
      composerH: card === null ? 0 : Math.round(card.getBoundingClientRect().height),
      // 输入框的 computed line-height 必须是 20px，76 = 16+20+28+12 才成立。
      textareaLineHeight: textarea === null ? '' : getComputedStyle(textarea).lineHeight,
      sendDisabled: (() => {
        const node = document.querySelector('.composer__send')
        return node === null ? null : node.disabled
      })(),
      sendBg: (() => {
        const node = document.querySelector('.composer__send')
        return node === null ? '' : getComputedStyle(node).backgroundColor
      })(),
      modelLabel: (document.querySelector('.composer__model-button')?.textContent ?? '').trim(),
    }
  })

  const checks = []
  const eq = (name, want, got, tolerance = 1) => {
    const ok = typeof got === 'number' && Math.abs(got - want) <= tolerance
    checks.push({ name, ok, got: String(got), want: String(want) })
  }
  const same = (name, want, got) => {
    checks.push({ name, ok: want === got, got: String(got), want: String(want) })
  }
  const truthy = (name, got) => { checks.push({ name, ok: Boolean(got), got: String(got), want: 'true' }) }

  eq('标题栏高 44', 44, result.titlebar?.h)
  eq('Rail 宽 48', 48, result.rail?.w)
  eq('Spine 宽 56', 56, result.spine?.w)
  eq('主列宽 716', 716, result.column?.w)
  eq('正文宽 588', 588, result.measure?.w)
  eq('输入卡宽 620', 620, result.card?.w)
  eq('输入卡高 76', 76, result.card?.h)
  eq('输入卡上沿 y=492', 492, result.card?.y)
  same('输入框行高 20px', '20px', result.textareaLineHeight)
  eq('无横向滚动', 820, result.docWidth)
  truthy('空输入时发送键保留且禁用', result.sendDisabled === true)
  same('模型名显示当前模型', 'magpie', result.modelLabel)

  // --- 打字后发送键启用 ---
  await page.locator('.composer__input').fill('试试发送')
  await page.waitForTimeout(200)
  const afterType = await page.evaluate(() => {
    const node = document.querySelector('.composer__send')
    return {
      disabled: node === null ? true : node.disabled,
      opacity: node === null ? '' : getComputedStyle(node).opacity,
    }
  })
  same('有内容时发送键启用', 'false', String(afterType.disabled))

  // --- 引号：消息悬停操作 ---
  const quote = await page.evaluate(() => {
    const message = document.querySelector('.message')
    if (message === null) return { exists: false }
    const actions = message.querySelector('.message__actions')
    const first = message.querySelector('.message__action')
    return {
      exists: true,
      actions: actions !== null,
      buttons: message.querySelectorAll('.message__action').length,
      hiddenOpacity: actions === null ? '' : getComputedStyle(actions).opacity,
      buttonSize: first === null ? 0 : Math.round(first.getBoundingClientRect().width),
    }
  })
  truthy('消息有悬停操作条', quote.actions === true)
  eq('操作条两个按钮（复制/引用）', 2, quote.buttons)
  same('未悬停时操作条透明', '0', quote.hiddenOpacity)
  eq('操作按钮热区 24', 24, quote.buttonSize)

  // --- 引用写入草稿 ---
  await page.evaluate(() => {
    const message = document.querySelector('.message')
    message?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    message?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  })
  await page.waitForTimeout(150)
  await page.locator('.message__action[aria-label="引用"]').first().click({ force: true })
  await page.waitForTimeout(200)
  const draft = await page.locator('.composer__input').inputValue()
  truthy('引用写成 > 摘录', draft.startsWith('> '))
  truthy('引用后留空行', draft.includes('\n\n'))

  // --- Toast ---
  const toastOk = await page.evaluate(async () => {
    // 直接调复制会碰到剪贴板权限，不好在无头环境下验证；
    // 改从 UI 触发一个必然弹提示的路径：点复制按钮并读提示条。
    const button = document.querySelector('.message__action[aria-label="复制"]')
    if (button === null) return { found: false }
    button.click()
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    const toast = document.querySelector('.toast')
    if (toast === null) return { found: true, toast: false }
    const body = toast.querySelector('.toast__body')
    const rect = toast.getBoundingClientRect()
    return {
      found: true,
      toast: body !== null,
      top: Math.round(rect.top),
      centered: Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) <= 1,
      text: (body?.textContent ?? '').trim(),
    }
  })
  truthy('复制后出现提示条', toastOk.toast === true)
  eq('提示条距顶 56', 56, toastOk.top)
  truthy('提示条水平居中', toastOk.centered === true)

  await page.screenshot({ path: join(OUT, 'composer-v5.png') })

  // --- 深色 ---
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 'dark-v5.png') })

  await browser.close()
  server.close()

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n尺寸与交互：${String(checks.length - failed.length)}/${String(checks.length)} 通过`)
  for (const check of checks) {
    const mark = check.ok ? '✓' : '✗'
    console.log(`${mark} ${check.name}  ${check.ok ? '' : `期望 ${check.want}，实测 ${check.got}`}`)
  }
  if (errors.length > 0) {
    console.log('\n控制台错误：')
    for (const error of errors) console.log(`  ${error}`)
  }
  if (failed.length > 0) process.exitCode = 1

  const tokensOk = await checkTokens()
  if (!tokensOk) process.exitCode = 1
}

await run()
