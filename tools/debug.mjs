#!/usr/bin/env node
/**
 * 界面调试接口 —— 让任何 AI（或人）不必手动点界面就能看清、点动、量准。
 *
 * ## 为什么要有这个东西
 *
 * 这一轮改 UI 时，真实的工作循环是这样的：
 *
 *   改 CSS → 重新构建 → 跑一遍完整断言 → 等 40 秒 → 截图 → 肉眼猜
 *
 * 「肉眼猜」那一步是瓶颈。整窗截图缩到 1080 宽之后，0.5px 的内影、
 * 两个灰之间 7% 的色差、发送键的两档状态全部糊在一起——用这种图判断
 * 「细节做没做到」，结论只能靠猜。而想量一个像素的真实颜色，就得去
 * 算 sips 的裁剪偏移（它的 `--cropOffset` 是**相对图片中心**的，
 * 每次都要心算），十次有八次裁错。
 *
 * 这个工具把那一步变成一条命令：`state` 直接给出关键层的几何与颜色，
 * `shot --selector` 直接截某个元素，`eval` 直接读页面里的任何东西。
 *
 * ## 为什么它独立于 `check-ui.mjs`
 *
 * 两个工具都要起浏览器、起假服务、注入假壳，看起来应该合并。**不合并**
 * 是有意的：
 *
 * | | `check-ui.mjs` | 本文件 |
 * | --- | --- | --- |
 * | 目的 | 抓回归 | 支持探索 |
 * | 判据 | 写死期望值，红了就是缺陷 | 不判对错，只报告事实 |
 * | 稳定性 | 必须长期不变（改断言要复核） | 随时可加命令 |
 *
 * 一旦共用一套假数据与假壳，为了让调试更方便而改的那一处，会同时
 * 改掉 CI 眼里的"真相"——那时候断言还是一样绿，但它验的东西已经
 * 不是原来的东西了。**两份实现是这里唯一正确的选择**，代价是几十行
 * 重复代码，收益是两边都能按自己的节奏演进。
 *
 * ## 命令一览
 *
 * ```text
 * node tools/debug.mjs shot   --out a.png [--selector .composer] [--dpr 2]
 * node tools/debug.mjs state                     # 关键层的几何 + 颜色
 * node tools/debug.mjs style  --selector .spine  # 某元素的计算样式
 * node tools/debug.mjs tokens                    # 全部解析后的 CSS 令牌
 * node tools/debug.mjs dom    [--selector] [--depth 4]
 * node tools/debug.mjs eval   --expr "document.title"
 * node tools/debug.mjs click  --selector .composer__input
 * node tools/debug.mjs type   --selector .composer__input --text "你好"
 * node tools/debug.mjs key    --key Enter
 * node tools/debug.mjs run    --steps '[{"fill":{"selector":".composer__input","text":"在吗"}},{"shot":"a.png"}]'
 * ```
 *
 * ## 全局选项
 *
 * | 选项 | 作用 |
 * | --- | --- |
 * | `--theme light\|dark` | 设定主题后再执行（写 `data-theme`） |
 * | `--session` | 先进会话态（点首页入口） |
 * | `--size 820x580` | 视口尺寸，默认 820 × 580（§3.1 基准） |
 * | `--dpr 2` | 设备像素比，默认 2 |
 * | `--url <url>` | 不启假服务，直接连一个已在跑的地址（如 vite dev） |
 *
 * `run` 的步骤里，键名就是命令名，值是该命令的参数；`{"shot": "a.png"}`
 * 是 `{"shot": {"out": "a.png"}}` 的简写。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const ROOT = new URL('../dist/', import.meta.url).pathname

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

/** 找一个可用的 playwright-core（与 check-ui 同一套回退顺序）。 */
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  for (const id of ['playwright-core', 'playwright', '/tmp/ondra-shot/node_modules/playwright-core']) {
    try { return require(id) } catch { /* 换下一个 */ }
  }
  throw new Error('找不到 playwright-core，先 `pnpm add -D playwright-core`')
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

/* ==========================================================================
   假数据
   ========================================================================= */

const now = Date.now()
const MIN = 60_000

const SESSIONS = [
  { id: 's1', title: '关于雨的那个比喻', createdAt: now - 2 * MIN, updatedAt: now - 12 * MIN, archived: false, workspace: '' },
]

/**
 * 一条用户消息 + 一条带满 Markdown 的回复。
 *
 * 刻意覆盖六种块（段落 / 代码 / 表格 / 引用 / 列表 / 行内代码）：
 * 调界面时最常看的就是排版，一条消息里全有，就不用反复改假数据。
 */
const MESSAGES = [
  { id: 'm1', sessionId: 's1', role: 'user', content: '雨的比喻，我想听三种声音的差别', at: now - 11 * MIN },
  {
    id: 'm2', sessionId: 's1', role: 'assistant', at: now - 10 * MIN,
    content: [
      '像。雨落在不同的东西上会换一种噪音——落在伞面是闷的，落在铁皮上是脆的，落在叶子上的那一种最轻。',
      '',
      '## 三种声音',
      '',
      '- **伞面**：闷，像隔着掌心说话',
      '- **铁皮**：脆，每一下都单独成立',
      '- **叶子**：最轻，要停下来才听得见',
      '',
      '我更喜欢它停下来的那几秒。屋檐还在滴水，但已经不是雨了，是雨留下的回声。',
      '',
      '> 雨停之后的那几秒，才是这句话真正的部分。',
      '',
      '| 落点 | 音色 | 余音 |',
      '| --- | --- | --- |',
      '| 伞面 | 闷 | 0.2 秒 |',
      '| 铁皮 | 脆 | 0.8 秒 |',
      '',
      '用 `rain --seconds 3` 可以听见这三层的差别，或者看 [这个比喻](#)。',
      '',
      '```sh',
      'rain --seconds 3 --layers umbrella,tin,leaf',
      '```',
    ].join('\n'),
  },
]

const MODELS = [{ id: 'magpie', label: 'magpie', provider: 'local' }]

/* ==========================================================================
   假服务
   ========================================================================= */

function json(response, body) {
  const text = JSON.stringify(body)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * 静态站 + 假 API。
 *
 * 路由与 `check-ui.mjs` 保持**形状一致**（同一个应用发的同一批请求），
 * 但返回值只求"够用"，不求"覆盖每个分支"——覆盖分支是断言那套的活。
 */
function serve() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/api/health') return json(response, { ok: true, at: Date.now() })
    if (path === '/api/sessions') return json(response, SESSIONS)
    if (path === '/api/models') return json(response, MODELS)
    if (path === '/api/config') return json(response, { currentModel: 'magpie', permission: 'workspace', profiles: [] })
    if (path === '/api/settings') {
      return json(response, {
        sections: [], user: {},
        totals: { sections: 0, fields: 0, unregistered: 0 },
      })
    }
    if (path === '/api/proactive/check') {
      return json(response, {
        allow: true, code: 'pass', reason: '想问你雨停了没',
        remaining: 2, quota: 3, used: 1, deferMs: 0, gateMissing: false,
      })
    }
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) return json(response, MESSAGES)
    if (path.startsWith('/api/')) return json(response, { ok: true })

    const file = join(ROOT, normalize(path === '/' ? 'index.html' : path).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(ROOT) || !existsSync(file)) { response.writeHead(404).end('not found'); return }
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  })
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => { resolvePort({ server, port: server.address().port }) })
  })
}

/**
 * 假壳。
 *
 * 应用启动时会向壳要宿主地址（`get_host_state`）、监听 `host-ready`。
 * 无头浏览器里没有壳，直接跑会停在内核连接失败的界面上——那样截出来的
 * 图不是产品，是错误页。这里给一份最小的壳：立刻回 ready，并补发事件。
 */
const fakeShell = (port) => `
(() => {
  const url = 'http://127.0.0.1:${String(port)}'
  const listeners = []
  const calls = []
  window.__ondraListeners = listeners
  window.__ondraCalls = calls
  window.__TAURI__ = {
    core: { invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'get_host_state') return { state: 'ready', url, token: 'debug', port: ${String(port)} }
      return null
    } },
    event: { listen: async (name, handler) => {
      listeners.push([name, handler])
      if (name === 'host-ready') handler({ payload: { url, token: 'debug', port: ${String(port)} } })
      return () => {}
    } },
  }
})()
`

/* ==========================================================================
   参数
   ========================================================================= */

const USAGE = `界面调试接口。

  node tools/debug.mjs <命令> [选项]

命令：
  shot    --out <png> [--selector <css>]   截图（整窗或某个元素）
  state                                    关键层的几何与颜色
  style   --selector <css>                 某元素的计算样式
  tokens                                   全部解析后的 CSS 令牌
  dom     [--selector <css>] [--depth 4]   精简 DOM 树
  eval    --expr <js>                      在页面里求值
  click   --selector <css>                 点击
  type    --selector <css> --text <文本>    输入
  key     --key <键名>                     按键
  run     --steps <json>                   一次浏览器里执行多步

全局选项：
  --theme light|dark   设定主题
  --session            先进会话态
  --size 820x580       视口尺寸
  --dpr 2              设备像素比
  --url <url>          直接连已运行的地址（不启假服务）
`

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) { options[key] = true } else { options[key] = next; index += 1 }
  }
  return options
}

/* ==========================================================================
   页面侧工具
   ========================================================================= */

/**
 * 关键层快照。
 *
 * 选这七个选择器，是因为它们正好是「三层表面」的每一层加三个控件：
 * 窗身（rail / spine / titlebar）、纸面（column）、输入面（composer，
 * 元素级特写由 `--selector` 另截）。
 *
 * 每层给出 `bg`（计算后的背景色）与 `box`（取整的几何），够判断
 * "谁比谁亮 / 谁多宽 / 谁在哪"这三类问题，而这正好是肉眼最不可靠的三类。
 */
const STATE_SCRIPT = `(() => {
  const box = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const r = node.getBoundingClientRect()
    const s = getComputedStyle(node)
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      bg: s.backgroundColor, color: s.color,
      radius: s.borderRadius, shadow: s.boxShadow,
      z: s.zIndex,
    }
  }
  return {
    theme: document.documentElement.dataset.theme ?? 'light',
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    layers: {
      titlebar: box('.titlebar'),
      rail: box('.rail'),
      spine: box('.spine'),
      column: box('.column'),
      composerCard: box('.composer__card'),
      send: box('.composer__send'),
      emptyMark: box('.timeline__empty-mark'),
    },
    text: {
      title: (document.querySelector('.titlebar__title')?.textContent ?? '').trim(),
      placeholder: document.querySelector('.composer__input')?.getAttribute('placeholder') ?? '',
      model: (document.querySelector('.composer__model-button')?.textContent ?? '').trim(),
      spine: [...document.querySelectorAll('.spine__caption, .spine__empty, .spine__hint')]
        .map((node) => node.textContent.trim()).filter((value) => value !== ''),
    },
    counts: {
      messages: document.querySelectorAll('.message').length,
      railItems: document.querySelectorAll('.rail__item').length,
      toasts: document.querySelectorAll('.toast').length,
    },
  }
})()`

/** 精简 DOM 树。只留标签、类名、可见文本，够定位选择器。 */
const DOM_SCRIPT = (selector, depth) => `(() => {
  const root = ${selector === undefined ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`}
  if (root === null) return null
  const walk = (node, level) => {
    if (level > ${String(depth)}) return null
    if (node.nodeType === 3) {
      const text = node.textContent.trim()
      return text === '' ? null : { text: text.length > 40 ? text.slice(0, 40) + '…' : text }
    }
    if (node.nodeType !== 1) return null
    const children = [...node.childNodes].map((child) => walk(child, level + 1)).filter((child) => child !== null)
    return {
      tag: node.tagName.toLowerCase(),
      class: node.className && typeof node.className === 'string' ? node.className : undefined,
      id: node.id === '' ? undefined : node.id,
      ...(children.length === 0 ? {} : { children }),
    }
  }
  return walk(root, 0)
})()`

/* ==========================================================================
   命令实现
   ========================================================================= */

/** 确保输出目录存在。`--out` 允许写到仓库外的临时目录，所以逐级建。 */
function ensureDir(file) {
  const directory = dirname(resolve(file))
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
}

/**
 * 字符串简写按命令语义落到不同的选项名上。
 *
 * `{"shot": "a.png"}` 里的那个字符串是**输出路径**，`{"eval": "1+1"}`
 * 里的是**表达式**——同一个位置（步骤的值）在不同命令下含义不同。
 * 用一张表说清楚，而不是"把字符串塞进所有选项名"：后者能让简写
 * 意外生效，但也让 `{"click": ".x"}` 同时被当成 `out` 建出一个叫
 * `.x` 的空目录。表格是显式的，出错时也读得懂。
 */
const STRING_ALIAS = {
  shot: 'out',
  state: 'selector',
  style: 'selector',
  dom: 'selector',
  eval: 'expr',
  click: 'selector',
  type: 'selector',
  key: 'key',
  wait: 'ms',
  tokens: 'selector',
}

/** 把 `{"shot": "a.png"}` 这种简写规整成 `{out: "a.png"}`。 */
function normalizeStep(step) {
  const [name, value] = Object.entries(step)[0] ?? []
  if (name === undefined) throw new Error(`步骤格式不对：${JSON.stringify(step)}`)
  if (value === true) return { name, options: {} }
  if (typeof value === 'string') {
    const key = STRING_ALIAS[name]
    if (key === undefined) return { name, options: {} }
    return { name, options: { [key]: value } }
  }
  return { name, options: value ?? {} }
}

/**
 * 执行一步。
 *
 * 返回 `{ done, value }`：`value` 是可打印的结果（截图路径、求值结果、
 * 快照对象），`done` 为 false 表示这一步让页面发生了变化、需要等一帧。
 */
async function runOne(page, name, options) {
  if (name === 'shot') {
    const out = options.out ?? options.path ?? join('.shots', `debug-${String(Date.now())}.png`)
    ensureDir(out)
    if (options.selector === undefined) {
      await page.screenshot({ path: out })
    } else {
      const node = page.locator(options.selector).first()
      if ((await node.count()) === 0) throw new Error(`找不到元素：${options.selector}`)
      await node.screenshot({ path: out })
    }
    return { done: false, value: { shot: out } }
  }

  if (name === 'state') {
    return { done: false, value: await page.evaluate(STATE_SCRIPT) }
  }

  if (name === 'tokens') {
    const tokens = await page.evaluate(`(() => {
      const style = getComputedStyle(document.documentElement)
      const out = {}
      for (const sheet of document.styleSheets) {
        let rules = []
        try { rules = [...sheet.cssRules] } catch { continue }
        for (const rule of rules) {
          if (!rule.style) continue
          for (const property of rule.style) {
            if (!property.startsWith('--')) continue
            out[property] = style.getPropertyValue(property).trim()
          }
        }
      }
      return out
    })()`)
    return { done: false, value: tokens }
  }

  if (name === 'style') {
    if (options.selector === undefined) throw new Error('style 需要 --selector')
    const result = await page.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(options.selector)})
      if (node === null) return null
      const style = getComputedStyle(node)
      const out = {}
      for (const property of style) out[property] = style.getPropertyValue(property)
      const r = node.getBoundingClientRect()
      return { box: { x: r.left, y: r.top, w: r.width, h: r.height }, style: out }
    })()`)
    if (result === null) throw new Error(`找不到元素：${options.selector}`)
    return { done: false, value: result }
  }

  if (name === 'dom') {
    return { done: false, value: await page.evaluate(DOM_SCRIPT(options.selector, Number(options.depth ?? 4))) }
  }

  if (name === 'eval') {
    if (options.expr === undefined) throw new Error('eval 需要 --expr')
    return { done: false, value: await page.evaluate(options.expr) }
  }

  if (name === 'click') {
    if (options.selector === undefined) throw new Error('click 需要 --selector')
    await page.locator(options.selector).first().click()
    return { done: true, value: { clicked: options.selector } }
  }

  if (name === 'type') {
    if (options.selector === undefined) throw new Error('type 需要 --selector')
    if (options.text === undefined) throw new Error('type 需要 --text')
    await page.locator(options.selector).first().fill(options.text)
    return { done: true, value: { typed: options.text.length } }
  }

  if (name === 'key') {
    if (options.key === undefined) throw new Error('key 需要 --key')
    await page.keyboard.press(options.key)
    return { done: true, value: { key: options.key } }
  }

  if (name === 'wait') {
    await page.waitForTimeout(Number(options.ms ?? 300))
    return { done: false, value: { waited: Number(options.ms ?? 300) } }
  }

  throw new Error(`未知命令：${name}`)
}

/* ==========================================================================
   主流程
   ========================================================================= */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === undefined || options.command === 'help' || options.command === '--help') {
    process.stdout.write(USAGE)
    return
  }

  const size = String(options.size ?? '820x580').split('x').map(Number)
  const dpr = Number(options.dpr ?? 2)
  const steps = options.command === 'run'
    ? JSON.parse(String(options.steps ?? '[]')).map((step) => normalizeStep(step))
    : [{ name: options.command, options }]

  let server = null
  let origin = options.url
  if (origin === undefined) {
    const started = await serve()
    server = started.server
    origin = `http://127.0.0.1:${String(started.port)}`
  }

  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: size[0] ?? 820, height: size[1] ?? 580 }, deviceScaleFactor: dpr })
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

    if (options.url === undefined) await page.addInitScript(fakeShell(new URL(origin).port))
    await page.goto(origin, { waitUntil: 'networkidle' })

    if (options.theme !== undefined) {
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(String(options.theme))}`)
      await page.waitForTimeout(250)
    }
    if (options.session === true) {
      /*
       * 首页已删除：启动即三栏。原来这一步是点 `.welcome__gate` 进会话，
       * 现在只等输入框挂载——`--session` 的语义是「确保处于会话态」。
       */
      await page.locator('.composer__input').waitFor()
      await page.waitForTimeout(600)
    }

    const results = []
    for (const step of steps) {
      const outcome = await runOne(page, step.name, step.options)
      results.push({ step: step.name, value: outcome.value })
      if (outcome.done) await page.waitForTimeout(Number(options.gap ?? 250))
    }

    /* 单步直接输出值本身（脚本里 `| jq` 最省事），多步包成 `{step, value}` 数组。
       不能对 `value` 做展开：`eval` 的结果可能是一个字符串，展开会把它拆成
       `{"0":"a","1":"b"}` —— 看起来像"工具坏了"，其实是"结果被拆成了字符"。 */
    const payload = results.length === 1 ? results[0].value : results
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (errors.length > 0) {
      process.stderr.write(`\n页面报错 ${String(errors.length)} 条：\n`)
      for (const error of errors.slice(0, 10)) process.stderr.write(`  ${error}\n`)
    }
  } finally {
    await browser.close()
    if (server !== null) server.close()
  }
}

await main()
