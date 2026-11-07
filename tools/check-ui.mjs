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

/**
 * 设置全景：**由宿主自己的扫描器生成**，不手抄。
 *
 * ## 为什么不再手写
 *
 * 第一版是手抄五个段的。它的毛病不是"抄错了几个数"，而是**抄的东西会过期**：
 * 插件改了 `min/max`、改了枚举候选、加了字段，手抄的那份不知道，
 * 于是测试在验一个已经不存在的界面。
 *
 * 更关键的是覆盖面。场景层 13 项绑的是 **12 个不同的段**
 * （`memory-core` / `proactive-quota` / `proactive-gate` / `persona-vars` /
 * `rhythm` / `dialogue` / `life-rhythm` / `proactive-reason` /
 * `memory-audit` / `tts` / `pet` / `privacy`）。手抄五个段，剩下七项
 * 会落进「这个插件没有装载」分支——场景层的大半排版根本没被渲染过，
 * 而截图上看不出异常，只会显示一句灰色的提示语。
 *
 * 调 `scanSections()` 拿到 123 段 / 1168 字段，与线上是同一份数据、
 * 同一个扫描器。耗时实测 0.11 秒，可以忽略。
 *
 * ## 依赖 `lib/` 构建产物这件事
 *
 * 扫描器读每个插件的 `lib/settings.js`（纯 JS，无 TS 语法）。`lib/` 在
 * `.gitignore` 里，只存在于构建之后。所以 `check:ui` 的前置是
 * `build:plugins` —— 与它已在读 `dist/` 是同一类前置，不额外增加门槛。
 * 读不到时下面会直接抛错并说清该跑什么，不让测试静默退化成空设置页。
 */
async function buildSettings() {
  let scanSections
  try {
    ({ scanSections } = await import('../cordis-host/lib/src/settings.js'))
  } catch {
    throw new Error('读不到宿主扫描器，先跑 pnpm run build（check:ui 依赖 dist/ 与 cordis-host/lib/）')
  }

  /*
   * 全部插件都算「已装载」。
   *
   * `active: false` 的段在界面上灰显（§6.7），而这里要验的是正常态。
   * 只把 `memory-core` 设为已装载、其余灰掉，会让场景层的多数控件进入
   * 禁用外观，截图与断言都测不到真正的渲染路径。
   */
  const all = await scanSections(new URL('../cordis-host/plugins/', import.meta.url).pathname, new Set())
  if (all.length === 0) throw new Error('扫描结果为空，插件构建产物可能没生成')

  const active = all.map((section) => ({ ...section, active: true }))

  /*
   * 用户层只覆盖一项。
   *
   * 全默认值验不出元数据行（当前 · 默认 · 来源 · 已改）的排版，
   * 全改过也验不出「未改」那一半。一项已改、其余未改，
   * 页面上同时存在两种状态，一行代码就能看出格式对不对。
   */
  const user = { 'memory-core': { 'archive-normal-days': 90 } }

  return {
    sections: active,
    user,
    totals: {
      sections: active.filter((section) => section.registered).length,
      fields: active.reduce((sum, section) => sum + section.fields.length, 0),
      unregistered: active.filter((section) => !section.registered).length,
    },
  }
}

function json(response, body) {
  const text = JSON.stringify(body)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * 假服务。
 *
 * @param settings 设置全景，由 {@link buildSettings} 在启动时扫描宿主得到。
 *   传进来而不是在这里现算：`serve()` 只管路由，扫描失败时应该由
 *   `run()` 在更早的位置报错，而不是让页面加载完才发现设置接口是坏的。
 */
function serve(settings) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/api/health') return json(response, { ok: true, at: Date.now() })
    if (path === '/api/sessions' && request.method === 'GET') return json(response, SESSIONS)
    if (path === '/api/sessions' && request.method === 'POST') return json(response, SESSIONS[0])
    if (path === '/api/models') return json(response, MODELS)
    if (path === '/api/config') return json(response, { currentModel: 'magpie', permission: 'workspace', profiles: [] })
    if (path === '/api/settings' && request.method === 'GET') return json(response, settings)
    if (path === '/api/settings' && request.method === 'POST') return json(response, { ok: true })
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

/**
 * 假壳。
 *
 * ## 为什么要把监听器与命令调用记在全局
 *
 * 有两件事只能靠壳触发：`close-requested`（点窗口 ×）与 `resolve_close`
 * （确认框的选择）。无头环境没有窗口按钮，所以测试里直接**取回**注册过的
 * 回调手动调用，再**读回**命令调用记录断言「有没有真的去退出」。
 *
 * 这两份记录挂在 `window.__ondraListeners` 与 `window.__ondraCalls` 上，
 * 不污染产品代码——它们只在这个假壳里存在。
 *
 * ## `autoReady` 为什么必须能关掉
 *
 * 偏好窗口是**后来才创建的文档**，壳在启动宿主成功时早把 `host-ready`
 * 发过了。假壳若一律在建文档时立刻补发一条，就把这个真实的时间差抹平了，
 * 「偏好窗口永远等不到连接」这个缺陷会被测成绿。所以偏好页那一份
 * 明确传 `false`。
 */
const fakeShell = (port, autoReady = true) => `
(() => {
  const url = 'http://127.0.0.1:${String(port)}'
  const listeners = []
  const calls = []
  window.__ondraListeners = listeners
  window.__ondraCalls = calls
  window.__TAURI__ = {
    core: { invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'get_host_state') {
        return { state: 'ready', url, token: 'dev', port: ${String(port)} }
      }
      return null
    } },
    event: { listen: async (name, handler) => {
      listeners.push([name, handler])
      if (${autoReady ? 'true' : 'false'} && name === 'host-ready') handler({ payload: { url, token: 'dev', port: ${String(port)} } })
      return () => {}
    } },
  }
})()
`

/**
 * 音频探针。
 *
 * ## 为什么要拦 `AudioContext`
 *
 * 提示音是**听不见**的那类功能，也是**最容易假装实现**的那类：
 * 代码里写一句 `playCue('send')`，界面上什么都不会变，截图也看不出来。
 * 无从断言，就等于没验。
 *
 * 这里用一个只记录、不出声的假上下文替换真的：每次 `osc.start()`
 * 记下起始频率与波形。三种音的起始频率互不相同（发送 660 / 她开口 880 /
 * 出错 311），所以"响了几声、响的是哪一声"全部可读回来。
 *
 * 也记 `gain` 的设定值：音量滑杆是否真的传到了增益上，靠它验。
 */
const soundSpy = `
(() => {
  const events = []
  window.__ondraSound = events
  const param = (name) => ({
    setValueAtTime(value) { events.push({ op: name, value }) },
    linearRampToValueAtTime(value) { events.push({ op: name, value }) },
    exponentialRampToValueAtTime(value) { events.push({ op: name, value }) },
  })
  class FakeNode {
    constructor() { this.gain = param('gain'); this.frequency = param('freq') }
    connect() {}
    disconnect() {}
  }
  class FakeOsc extends FakeNode {
    constructor() { super(); this.type = 'sine'; this.onended = null }
    start() { events.push({ op: 'start', type: this.type }) }
    stop() {}
  }
  class FakeCtx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
    createOscillator() { return new FakeOsc() }
    createGain() { return new FakeNode() }
    resume() { return Promise.resolve() }
  }
  Object.defineProperty(window, 'AudioContext', { value: FakeCtx, configurable: true, writable: true })
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

/**
 * 品牌单一真源核对（§4.5、§13）。
 *
 * ## 两件事
 *
 * 1. `icon-1024.svg` **不许存在**。它是 `tools/build-icons.mjs` 的中间
 *    产物，落进仓库就成了第二个真源：有人会去改它，下次生成又覆盖回去。
 *    现在它只写临时目录。
 * 2. `src/brand/mark.ts` 必须与 `icon.svg` 一致。做法是让生成器自己
 *    `--check` 一遍——比对逻辑不另写一份，避免「生成器改了、校验没改」。
 *
 * ## 为什么放这里而不是另开脚本
 *
 * 本机跑 `pnpm run check:ui` 就全覆盖。CI 里另有独立的 `check:brand`
 * 步骤（Windows 构建前），两处调的是同一份实现。
 */
async function checkBrand() {
  const { access } = await import('node:fs/promises')
  const { spawnSync } = await import('node:child_process')
  const repo = new URL('../', import.meta.url).pathname

  console.log('\n品牌核对：')

  let legacy = false
  try {
    await access(join(repo, 'icon-1024.svg'))
    legacy = true
  } catch { /* 不存在才对 */ }

  if (legacy) {
    console.log('  ✗ icon-1024.svg 仍在仓库根，它是 build-icons 的中间产物，不该提交')
  } else {
    console.log('  ✓ icon-1024.svg 已移除，logo 只来自 icon.svg')
  }

  const result = spawnSync('node', [join(repo, 'tools', 'gen-brand.mjs'), '--check'], {
    cwd: repo,
    encoding: 'utf8',
  })
  const ok = result.status === 0
  // 成功时生成器会打印一行「一致」，直接转述比另写一句好——
  // 两处说法不同会让日志看起来像两个检查。
  const detail = (ok ? result.stdout : result.stderr).trim()
  console.log(`  ${ok ? '✓' : '✗'} ${detail.split('\n')[0]}`)
  if (!ok) {
    for (const line of detail.split('\n').slice(1)) console.log(`    ${line}`)
  }

  return !legacy && ok
}

/**
 * 静态规格核对（§13 的三条「只能扫、不能点」）。
 *
 * ## 为什么这些都必须是静态扫描
 *
 * 下面三条都无法靠点一下界面验出来，而它们的共同失败模式是**静默**：
 *
 * 1. **组件越层引用 `--static-*`**。`var(--static-teal-600)` 是合法的
 *    CSS，浏览器照常渲染，颜色也对——直到深色模式。深色下 `--static-*`
 *    被重新赋值，于是这个组件跟着变，看起来"没问题"；但如果它引用的
 *    是 `--static-paper-0` 这种在深色下也换值的，就会出现「深底深字」。
 *    `tokens.css` 里已经有这个坑的注释（提示条曾经整块变黑）。规则只能
 *    靠扫描守：组件只许引用 `--alias-*` / `--specific-*`。
 * 2. **`prefers-contrast: more` 的降级**。系统偏好无法在无头浏览器里
 *    模拟（Playwright 的 `emulateMedia` 不支持 contrast），只能确认
 *    那段媒体查询存在且真的改了 `--line-width` 与 `--focus-ring-width`。
 * 3. **系统字号 200%**。这条可以真验（改 `html` 的 `font-size` 再看布局），
 *    但前提是「字号全部用 rem」——写死 px 的地方不会跟着放大。
 *    所以扫描查两件事：字号单位是否只有 rem、`html` 基准是否 100%。
 */
async function checkStaticSpecs() {
  const { readdir, readFile } = await import('node:fs/promises')
  const root = new URL('../src/', import.meta.url).pathname

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
  const problems = []
  const seen = []

  /** 读一份样式，剥掉注释后再看。注释里举例说明不算真实声明。 */
  const read = async (file) => (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
  const short = (file) => file.split('/src/')[1]

  for (const file of files) {
    if (file.endsWith('/tokens.css')) continue
    const text = await read(file)

    // --- 1. 组件样式不得引用 --static-* ---
    for (const match of text.matchAll(/var\(\s*(--static-[a-z0-9-]+)/g)) {
      problems.push(`${short(file)} 引用了越层令牌 ${match[1]}（组件只许用 --alias-* / --specific-*）`)
    }
  }

  // --- 2. 两段辅助功能降级必须存在且真的改了令牌 ---
  const tokens = await readFile(join(root, 'styles/tokens.css'), 'utf8')
  const stripTokens = tokens.replace(/\/\*[\s\S]*?\*\//g, '')

  const contrastBlock = /@media\s*\(prefers-contrast:\s*more\)\s*\{([\s\S]*?)\n\}/.exec(stripTokens)
  if (contrastBlock === null) {
    problems.push('tokens.css 缺 prefers-contrast: more 降级块')
  } else {
    const body = contrastBlock[1]
    if (!/--line-width:\s*1px/.test(body)) problems.push('prefers-contrast: more 没有把 --line-width 提到 1px')
    if (!/--focus-ring-width:\s*3px/.test(body)) problems.push('prefers-contrast: more 没有把 --focus-ring-width 提到 3px')
  }

  if (!/@media\s*\(prefers-reduced-transparency:\s*reduce\)/.test(stripTokens)) {
    problems.push('tokens.css 缺 prefers-reduced-transparency: reduce 降级块')
  }

  /*
   * 焦点环的唯一出口是 `base.css` 的 `:focus-visible`。
   * 它必须读 `--focus-ring-width`，否则改令牌不会影响任何地方——
   * 那种情况下上面那条断言会假绿。
   */
  const base = await read(join(root, 'styles/base.css'))
  if (!/outline:\s*var\(--focus-ring-width\)/.test(base)) {
    problems.push('base.css 的 :focus-visible 没有读 --focus-ring-width，焦点环不受令牌控制')
  }

  // --- 3. 字号单位与基准 ---
  for (const file of files) {
    const text = await read(file)
    // `font-size` 只许 rem / 关键字（inherit、larger 这类）/ 百分比（仅 html 基准）。
    /*
     * 前置的 `(?<![-\w])` 不能省：`--content-font-size: 14px` 这种**自定义
     * 属性名**里含有 `font-size:`，不加负向回顾会把令牌定义误判成声明。
     */
    const sizes = [...text.matchAll(/(?<![-\w])font-size:\s*([^;]+);/g)].map((match) => match[1].trim())
    for (const value of sizes) {
      const ok = /^-?\d*\.?\d+rem$/.test(value)
        || /^(inherit|initial|unset|revert|larger|smaller|xx-small|x-small|small|medium|large|x-large|xx-large)$/.test(value)
        || /^(calc|clamp|min|max)\(/.test(value)
        || /^var\(--text-/.test(value)
        // `100%` 是 html 基准本身的写法（§13 要求 `html { font-size: 100% }`），
        // 它正是「等比放大」这条链的起点，不是违规。
        || value === '100%'
      if (!ok) problems.push(`${short(file)} 的 font-size 不是 rem：${value}`)
    }
    // 写死基准是把整条链掐断的那一刀。
    if (/html\s*\{[^}]*font-size:\s*\d+px/.test(text)) {
      problems.push(`${short(file)} 给 html 写死了 px 基准`)
    }
    if (/\brpx\b/.test(text)) problems.push(`${short(file)} 出现 rpx（本项目禁止）`)
  }

  if (!/html\s*\{[^}]*font-size:\s*100%\s*;?/.test(base)) {
    problems.push('base.css 没有把 html 的 font-size 设为 100%')
  }

  console.log('\n静态规格：')
  if (problems.length === 0) {
    console.log('  ✓ 组件无越层令牌引用、两段辅助功能降级就位、字号全为 rem 且基准 100%')
  } else {
    for (const problem of problems) console.log(`  ✗ ${problem}`)
  }
  return problems.length === 0
}

/**
 * 托盘图标核对（§12.10、§4.5）。
 *
 * ## 守的是什么
 *
 * 托盘图标曾经直接用 `icons/32x32.png`，而那是**应用图标**：白色 squircle
 * 底板 + 黑色鲸鱼。放进 macOS 菜单栏就是一枚 16×16 的白方块，比旁边的
 * 系统图标重得多。§4.5 要求两版分开，§12.10 要求 16 / 32 / 64 三档。
 *
 * ## 为什么必须静态验
 *
 * 这一处失败**在浏览器里完全看不出来**：`check-ui` 的主流程跑在无头 Chromium
 * 里，没有菜单栏，托盘图标存不存在都一样绿。真机截图能看出来，但截图不进
 * 自动化。能在 CI 里守住的只有三件事：
 *
 * 1. **三档都在**，且尺寸与文件名一致（缩错过一次就会一直是错的）。
 * 2. **四角透明**。有底板就一定有某个角是不透明的——这是「无底板」唯一的
 *    机器可判特征。中央不判：鲸鱼是描边图形，中心本来就是空的。
 * 3. **被打包进 Resources**。`tauri.conf.json` 少了这一行，开发态照常能读
 *    （走 `CARGO_MANIFEST_DIR`），装完就没了——最典型的「本机好的」。
 */
async function checkTrayAssets() {
  const { readFile: readText, access } = await import('node:fs/promises')
  const { spawnSync } = await import('node:child_process')
  const repo = new URL('../', import.meta.url).pathname
  const problems = []

  console.log('\n托盘图标：')

  const wanted = [[16, 'tray-16.png'], [32, 'tray-32.png'], [64, 'tray-64.png']]
  for (const [size, name] of wanted) {
    const path = join(repo, 'src-tauri', 'tray', name)
    try {
      await access(path)
    } catch {
      problems.push(`缺 ${name}（跑 \`node tools/build-tray-icons.mjs\`）`)
      continue
    }
    // `sips -g` 读真实像素宽，不信文件名——文件名是手写的，像素是渲染出来的。
    const probe = spawnSync('sips', ['-g', 'pixelWidth', path], { encoding: 'utf8' })
    const actual = Number(/pixelWidth:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0)
    if (actual !== size) problems.push(`${name} 实际宽 ${String(actual)}，应为 ${String(size)}`)
  }

  /*
   * 四角透明：用 `sips` 转成原始像素太麻烦，改用 Python 读 PNG。
   * 但 Python 未必有 PIL，所以退一步——直接扫 PNG 的 IHDR 色彩类型，
   * 只有类型 6（RGBA）与类型 4（灰度 + alpha）才可能有透明区。
   * 这比读像素弱，可它拦得住最常见的那种错：拿一张 RGB 的方图当剪影。
   */
  for (const [, name] of wanted) {
    const path = join(repo, 'src-tauri', 'tray', name)
    try {
      const head = await readText(path, { encoding: null })
      // PNG 布局：8 字节签名 + 4 字节长度 + 4 字节 'IHDR' + 宽 4 + 高 4 + 位深 + 色彩类型。
      const colorType = head[8 + 4 + 4 + 4 + 4 + 1]
      if (colorType !== 6 && colorType !== 4) {
        problems.push(`${name} 无 alpha 通道（PNG 色彩类型 ${String(colorType)}），不可能是无底板剪影`)
      }
    } catch { /* 上面已经报过缺失 */ }
  }

  const conf = await readText(join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8')
  if (!/"tray"\s*:\s*"tray"/.test(conf)) {
    problems.push('tauri.conf.json 的 bundle.resources 没有打包 tray 目录，装完就读不到图标')
  }

  if (problems.length === 0) {
    console.log('  ✓ 16 / 32 / 64 三档齐备、带 alpha、且已打包进 Resources')
  } else {
    for (const problem of problems) console.log(`  ✗ ${problem}`)
  }
  return problems.length === 0
}

/** 量一组尺寸与交互。 */
async function run() {
  const { chromium } = loadPlaywright()
  const settings = await buildSettings()
  const { server, port } = await serve(settings)
  const browser = await chromium.launch({ executablePath: findChrome() })
  const page = await browser.newPage({ viewport: { width: 820, height: 580 }, deviceScaleFactor: 2 })
  const errors = []
  /*
   * 控制台错误带上来源 URL。
   *
   * 浏览器的文案（`Failed to load resource: ...`）里**不含请求地址**，
   * 而区分「测试故意制造的失败」与「真缺陷」只能靠地址。`location()`
   * 给的就是那条消息对应的脚本或资源，取它而不是猜文案。
   */
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const where = message.location().url
    errors.push(where === '' ? message.text() : `${message.text()} @ ${where}`)
  })
  page.on('pageerror', (error) => { errors.push(String(error)) })
  page.on('requestfailed', (request) => { errors.push('requestfailed ' + request.url()) })
  page.on('response', (response) => { if (response.status() >= 400) errors.push('HTTP ' + String(response.status()) + ' ' + response.url()) })

  /*
   * 断言收集器。
   *
   * 定义在**最前面**而不是量完尺寸之后：启动焦点那几条必须在
   * `page.goto` 之后、任何点击之前采样，它们要用到同一组函数。
   */
  const checks = []
  const eq = (name, want, got, tolerance = 1) => {
    const ok = typeof got === 'number' && Math.abs(got - want) <= tolerance
    checks.push({ name, ok, got: String(got), want: String(want) })
  }
  const same = (name, want, got) => {
    checks.push({ name, ok: want === got, got: String(got), want: String(want) })
  }
  const truthy = (name, got) => { checks.push({ name, ok: Boolean(got), got: String(got), want: 'true' }) }

  await page.addInitScript(fakeShell(port))
  await page.addInitScript(soundSpy)
  await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await mkdir(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, 'welcome-v5.png') })

  /*
   * --- 启动焦点（§9.5 §9.6，必须在做任何点击之前验）---
   *
   * ## 为什么这两条只能在页面刚加载时验
   *
   * 「启动不自动聚焦输入框」说的是**初始状态**。一旦点过任何东西，
   * 焦点就有人为因素，再断言就测不出「代码里有没有 autoFocus」。
   *
   * ## 为什么不能只 grep `autoFocus`
   *
   * 有两种写法 grep 不到：`element.focus()` 写在 effect 里，以及
   * 浏览器/WebView 自身的首元素聚焦行为。断言看的是 `activeElement`
   * 到底是不是输入框，比扫源码可靠。
   *
   * 首页还没有输入框，所以这条在**进入会话后**再做一次（下面第 15 条）。
   * 这里先验「Tab 从标题栏开始」的一半：初始 `activeElement` 是 body。
   */
  const bootFocus = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? '',
    isInput: document.activeElement instanceof HTMLInputElement
      || document.activeElement instanceof HTMLTextAreaElement,
  }))
  same('启动时焦点在 body', 'BODY', bootFocus.tag)
  truthy('启动时没有自动聚焦任何输入框', bootFocus.isInput === false)

  // 进入三栏：点首页入口。
  await page.locator('.welcome__start').click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, 'empty-v5.png') })

  /*
   * --- 15. 进入会话后仍不自动聚焦输入框（§9.5 第一条）---
   *
   * 自动聚焦会让 `Tab` 从输入框开始，跳过整条 Rail —— 键盘用户永远
   * 走不到历史会话。规范用的是「不自动聚焦」，所以第一次 `Tab`
   * 落点应该是标题栏里那一侧的元素，不是输入框。
   */
  const afterEnter = await page.evaluate(() => ({
    isInput: document.activeElement instanceof HTMLTextAreaElement,
    tag: document.activeElement?.tagName ?? '',
  }))
  truthy('进入会话不自动聚焦输入框', afterEnter.isInput === false)
  truthy('进入会话焦点仍在 body', afterEnter.tag === 'BODY')

  /*
   * --- 16. `Tab` 从标题栏开始（§9.6）---
   *
   * 「从标题栏开始」在 macOS 上没有可聚焦元素（红绿灯是系统绘制的，
   * 不参与 DOM 的 Tab 顺序），所以第一个停靠点是 Rail 的第一项。
   * Windows 上有菜单按钮与三键，那时第一个停靠点应该在标题栏里。
   *
   * 两种都合法，断言按平台分岔：**只要不是输入框、且不属于主列正文**，
   * 就算从「顶部」开始。
   */
  await page.keyboard.press('Tab')
  await page.waitForTimeout(200)
  const firstTab = await page.evaluate(() => {
    const active = document.activeElement
    if (active === null) return { found: false }
    return {
      found: true,
      tag: active.tagName,
      inTitlebar: active.closest('.titlebar') !== null,
      inRail: active.closest('.rail') !== null,
      inTimeline: active.closest('.timeline') !== null,
      isInput: active instanceof HTMLTextAreaElement,
      label: active.getAttribute('aria-label') ?? '',
    }
  })
  truthy('第一次 Tab 有落点', firstTab.found === true)
  truthy('Tab 从标题栏或 Rail 开始，不跳到主列', firstTab.inTitlebar === true || firstTab.inRail === true)
  truthy('第一个 Tab 落点不是输入框', firstTab.isInput === false)
  truthy('第一个 Tab 落点不在消息区', firstTab.inTimeline === false)
  // 把焦点送回 body，后续断言从干净状态开始。
  await page.evaluate(() => { document.activeElement?.blur() })

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
      /*
       * 空输入时发送键的禁用语义。
       *
       * §13 要求「禁用项用 `aria-disabled` 且可聚焦，聚焦时朗读禁用原因」，
       * 所以这里读的是 ARIA 属性而不是原生 `disabled`。两者都要看：
       * 只查 `aria-disabled` 会漏掉「顺手又加了 disabled」的回归，
       * 那会让键盘用户彻底碰不到这个按钮。
       */
      sendDisabled: (() => {
        const node = document.querySelector('.composer__send')
        return node === null ? null : node.getAttribute('aria-disabled')
      })(),
      sendNativeDisabled: (() => {
        const node = document.querySelector('.composer__send')
        return node === null ? null : node.disabled
      })(),
      // 可聚焦 = `tabIndex >= 0` 且不是原生禁用。
      sendFocusable: (() => {
        const node = document.querySelector('.composer__send')
        return node === null ? null : node.tabIndex >= 0 && !node.disabled
      })(),
      // 禁用原因必须挂在同一棵树里，读屏才念得到。
      sendHint: (() => {
        const node = document.querySelector('.composer__send')
        const id = node?.getAttribute('aria-describedby')
        if (id === null || id === undefined) return ''
        return (document.getElementById(id)?.textContent ?? '').trim()
      })(),
      sendBg: (() => {
        const node = document.querySelector('.composer__send')
        return node === null ? '' : getComputedStyle(node).backgroundColor
      })(),
      modelLabel: (document.querySelector('.composer__model-button')?.textContent ?? '').trim(),
    }
  })

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
  same('空输入时发送键 aria-disabled', 'true', result.sendDisabled)
  same('发送键不用原生 disabled', 'false', String(result.sendNativeDisabled))
  truthy('禁用的发送键仍可聚焦', result.sendFocusable === true)
  truthy('禁用的发送键带可朗读原因', result.sendHint.length > 0)
  same('模型名显示当前模型', 'magpie', result.modelLabel)

  // --- 打字后发送键启用 ---
  await page.locator('.composer__input').fill('试试发送')
  await page.waitForTimeout(200)
  const afterType = await page.evaluate(() => {
    const node = document.querySelector('.composer__send')
    return {
      disabled: node === null ? 'true' : node.getAttribute('aria-disabled'),
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

  /**
   * 操作条不能压住自己这条消息的文字。
   *
   * ## 为什么必须自动判而不是靠眼睛看截图
   *
   * 第一版把操作条写 `top: -10px; right: 0`，在用户消息（右对齐、
   * 右边界就是正文右边界）上正好盖住最后几个字。截图里能看出，
   * 但那是「正好看了一眼」才发现的——把它变成断言，以后改样式
   * 撞到同一处会立刻报红。
   */
  const overlap = await page.evaluate(() => {
    const message = document.querySelector('.message[data-role="user"]')
    if (message === null) return { found: false }
    const body = message.querySelector('.message__body')
    const actions = message.querySelector('.message__actions')
    if (body === null || actions === null) return { found: false }
    // 让操作条进入「显形」态再量几何：visibility: hidden 时 box 仍然可读，
    // 但这里要的是显形后的实际位置，切换属性最省事。
    message.setAttribute('data-actions', '')
    const b = body.getBoundingClientRect()
    const a = actions.getBoundingClientRect()
    const intersects = a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left
    return {
      found: true,
      intersects,
      // 操作条是否完整落在滚动视口内（否则会被裁掉一半）。
      insideViewport: (() => {
        const view = document.querySelector('.scrollarea__viewport')
        if (view === null) return false
        const v = view.getBoundingClientRect()
        return a.top >= v.top - 1 && a.bottom <= v.bottom + 1
      })(),
      actionsTop: Math.round(a.top),
      bodyTop: Math.round(b.top),
    }
  })
  truthy('操作条不压住自己这条消息的文字', overlap.found === true && overlap.intersects === false)
  truthy('操作条完整落在滚动视口内', overlap.insideViewport === true)

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

  // --- 内联错误（§12.13 第二级）---
  /*
   * 触发方式：让推理接口返回失败。`/api/` 的兜底路由回 200 `{ok:true}`，
   * 这里用一条 route 覆写成 500，比改动 serve 的默认行为影响面小。
   *
   * 为什么这条必须验：内联错误曾经根本不渲染——`chatError` 在状态里
   * 有值，界面却一个字都不显示，「发送失败后毫无反应」是这么来的。
   */
  await page.route('**/api/inference', (route) => {
    void route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '上游超时' }) })
  })
  /*
   * 先验「默认关闭时一声不响」。
   *
   * ## 为什么这条要抢在失败之前单独量
   *
   * 主流程这一页从没碰过偏好，`ondra.sound` 不存在，正是新用户的初始态。
   * 此刻发一条注定失败的消息，三个响点都会走过（发送 / 出错），
   * 一个 `start` 都不该有。若实现忘了在 `playCue` 里判开关，
   * 用户第一次用就被响——而这是**默认值**问题，装好就已经错了。
   */
  await page.evaluate(() => { window.__ondraSound.length = 0 })
  await page.locator('.composer__input').fill('这一条会失败')
  await page.locator('.composer__input').press('Enter')
  await page.waitForTimeout(700)
  const silentByDefault = await page.evaluate(() => ({
    starts: window.__ondraSound.filter((event) => event.op === 'start').length,
    stored: localStorage.getItem('ondra.sound'),
  }))
  eq('默认关闭时发送与出错都不出声', 0, silentByDefault.starts)
  same('默认关闭不写任何声音键', null, silentByDefault.stored)

  const inline = await page.evaluate(() => {
    const bar = document.querySelector('.inline-error')
    if (bar === null) return { found: false }
    const inTimeline = bar.closest('.timeline') !== null
    const rect = bar.getBoundingClientRect()
    const style = getComputedStyle(bar)
    return {
      found: true,
      inTimeline,
      text: (bar.textContent ?? '').trim(),
      // 在可视区内：贴着消息流末尾，不该跑到视口外。
      visible: rect.top > 0 && rect.top < window.innerHeight,
      fontSize: style.fontSize,
      hasRetry: bar.querySelector('.inline-error__action') !== null,
    }
  })
  truthy('失败后出现内联错误条', inline.found === true)
  truthy('内联错误在消息流内而非浮层', inline.inTimeline === true)
  same('内联错误字号 12', '12px', inline.fontSize)
  truthy('内联错误带重试', inline.hasRetry === true)
  truthy('内联错误可见', inline.visible === true)
  await page.unroute('**/api/inference')
  await page.screenshot({ path: join(OUT, 'inline-error-v5.png') })

  /*
   * --- 快捷键层（§9.1 / §9.4）---
   *
   * ## 为什么这一批值得脚本化
   *
   * 上一版把每条快捷键各挂一个 `window` 监听，谁先跑取决于挂载顺序。
   * 后果是「按 Esc 时抽屉先关还是设置先关」不确定——这种缺陷靠手点
   * 很难稳定复现，但写成断言一按就知道。
   *
   * 平台用 `isMac()` 判，测试跑在 macOS 上，所以修饰键是 `Meta`。
   * Linux / Windows 的 CI 会走 `Control` 分支，同一份断言两边通用。
   */
  const isMacPlatform = await page.evaluate(() => /Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent))
  const MOD = isMacPlatform ? 'Meta' : 'Control'

  // 1. Esc 的层级：抽屉开着时按一次只关抽屉。
  await page.locator('.rail__item').first().click()
  await page.waitForTimeout(400)
  const drawerOpen = await page.evaluate(() => document.querySelector('.drawer[data-open]') !== null)
  truthy('点 Rail 打开抽屉', drawerOpen === true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const afterDrawerEsc = await page.evaluate(() => ({
    drawer: document.querySelector('.drawer[data-open]') !== null,
    // 抽屉关了，但会话还在——Esc 不该把人踢回首页。
    stillInSession: document.querySelector('.workspace') !== null,
  }))
  truthy('Esc 关掉抽屉', afterDrawerEsc.drawer === false)
  truthy('Esc 关抽屉后仍停在会话里', afterDrawerEsc.stillInSession === true)

  // 2. 连按 Esc 到底 = 无操作，不退出应用。
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const afterManyEsc = await page.evaluate(() => ({
    quitCalled: (window.__ondraCalls ?? []).some((call) => call.command === 'resolve_close'),
    stillInSession: document.querySelector('.workspace') !== null,
  }))
  truthy('Esc 到底不退出应用', afterManyEsc.quitCalled === false)
  truthy('Esc 到底不离开会话', afterManyEsc.stillInSession === true)

  // 3. `Cmd/Ctrl + /` 打开快捷键总表。
  await page.keyboard.press(`${MOD}+/`)
  await page.waitForTimeout(400)
  const sheet = await page.evaluate(() => {
    const panel = document.querySelector('.sheet__panel')
    if (panel === null) return { found: false }
    const rect = panel.getBoundingClientRect()
    const rows = panel.querySelectorAll('.sheet__row')
    const keys = panel.querySelectorAll('.sheet__key')
    return {
      found: true,
      rows: rows.length,
      keys: keys.length,
      top: Math.round(rect.top),
      within: rect.bottom <= window.innerHeight + 1,
      // Sheet 不是 Dialog：不许有 aria-modal="true"，否则读屏会锁住背后。
      modal: panel.getAttribute('aria-modal'),
      firstRow: (rows[0]?.textContent ?? '').trim(),
    }
  })
  truthy('Cmd+/ 打开快捷键总表', sheet.found === true)
  eq('总表列出全部 15 条', 15, sheet.rows)
  truthy('总表键位切成键帽', sheet.keys >= 15)
  eq('总表贴顶 44', 44, sheet.top)
  truthy('总表不超出视口', sheet.within === true)
  same('总表不是模态框', 'false', sheet.modal)
  await page.screenshot({ path: join(OUT, 'shortcut-sheet-v6.png') })

  /*
   * 总表**必须能滚**，而且滚动这件事必须看得见。
   *
   * ## 为什么这三条要一起断言
   *
   * 15 条快捷键在 580 高的窗口里装不下（实测内容 611px、可视 300px）。
   * 而全项目把原生滚动条宽度设成了 0（§12.1 要 overlay 自绘），
   * 于是「溢出但看不见滑块」是默认结果——用户只看到列表在中间被切断，
   * 会以为布局坏了。
   *
   * 第一版就是这么坏的：面板自己 `overflow: auto`，没有滑块。
   * 改成 ScrollArea 后又踩了第二个坑——滑块是绝对定位的 overlay，
   * 压在键帽上把「Enter」吃成「Ent」。所以还要断言滑块不碰键帽。
   */
  const sheetScroll = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.sheet__scroll')
    const thumb = document.querySelector('.sheet__panel .scrollarea__thumb')
    if (view === null) return { found: false }
    // 滚一下让滑块显形，再量它与键帽的横向关系。
    view.scrollTop = 0
    view.dispatchEvent(new Event('scroll', { bubbles: true }))
    const rows = [...document.querySelectorAll('.sheet__row')]
    const firstKey = rows[0]?.querySelector('.sheet__key')
    return {
      found: true,
      overflow: view.scrollHeight > view.clientHeight + 1,
      hasThumb: thumb !== null,
      thumbLeft: thumb === null ? 0 : Math.round(thumb.getBoundingClientRect().left),
      keyRight: firstKey === null || firstKey === undefined ? 0 : Math.round(firstKey.getBoundingClientRect().right),
    }
  })
  truthy('总表内容超出一屏', sheetScroll.found === true && sheetScroll.overflow === true)
  truthy('总表有可见滑块', sheetScroll.hasThumb === true)
  // 滑块左缘必须落在最右侧键帽的右边，否则它压在字上。
  truthy('滑块不压键帽', sheetScroll.thumbLeft >= sheetScroll.keyRight)

  // 4. Esc 关掉总表，且**不**连带关掉别的层。
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const sheetClosed = await page.evaluate(() => ({
    sheet: document.querySelector('.sheet__panel') === null,
    stillInSession: document.querySelector('.workspace') !== null,
  }))
  truthy('Esc 关掉总表', sheetClosed.sheet === true)
  truthy('Esc 关总表不切换会话', sheetClosed.stillInSession === true)

  /*
   * 5. `Cmd/Ctrl + Shift + L` 切主题：三态循环。
   *
   * ## 断言的是「存下来的模式」，不是 `data-theme`
   *
   * 上一版断言 `data-theme` 前后不同。改成偏好层之后这条必然报红——
   * 而且报红得**对**：`data-theme` 里存的是**解析结果**，只有 light / dark
   * 两个值。系统是浅色时「跟随系统」解析出来就是 light，按一下切到
   * 「浅色」也还是 light，界面上本来就不该有任何变化。
   *
   * 真正的契约在存储里：system → light → dark → system 三态循环。
   * 断言这一点，同时验解析结果始终是合法值（绝不能出现 `system`
   * 这样一条 CSS 规则都不命中的字面量）。
   */
  const themeBefore = await page.evaluate(() => localStorage.getItem('ondra.theme') ?? 'system')
  await page.keyboard.press(`${MOD}+Shift+L`)
  await page.waitForTimeout(300)
  const themeAfter = await page.evaluate(() => ({
    mode: localStorage.getItem('ondra.theme') ?? 'system',
    resolved: document.documentElement.dataset.theme ?? '',
  }))
  truthy('Cmd+Shift+L 切了主题模式', themeBefore !== themeAfter.mode)
  truthy(
    `主题解析结果合法（${themeAfter.resolved}）`,
    themeAfter.resolved === 'light' || themeAfter.resolved === 'dark',
  )

  /*
   * 切主题的 Toast 留着不动，下一步专门验它会避让设置面板。
   *
   * 上一版在这里等 2.6 秒让提示条自己消失，等于把缺陷等没了：截图里
   * 「设置」二字被提示条整个盖住，而 `textContent` 断言照样通过——
   * 文字在 DOM 里，只是看不见。现在改成先验避让，再截图。
   */

  /** 触发一次提示条，供下一步验「提示条不压右侧面板」。 */
  const raiseToast = async () => {
    await page.keyboard.press(`${MOD}+Shift+L`)
    await page.waitForTimeout(250)
  }

  /*
   * 6. 从检查器底部「全部设置」进三层面板（§5.13 第二层）。
   *
   * ## 这个入口现在只剩一条路
   *
   * 上一版 `Cmd/Ctrl + ,` 接到这里，而 §5.13 明写那条键开的是**偏好设置
   * 独立窗口**。改指的后果是：1168 项插件参数只剩这一个入口。
   * 它若断了，界面上不会报任何错，只是再也进不去——所以必须单独验。
   */
  await raiseToast()
  await page.locator('.spine').click()
  await page.waitForTimeout(400)
  await page.locator('.inspector__all').click()
  await page.waitForTimeout(500)
  truthy('检查器底部「全部设置」打开三层面板', await page.evaluate(() => document.querySelector('.settings') !== null))
  truthy('三层面板打开时检查器已收起', await page.evaluate(() => document.querySelector('.inspector') === null))

  /*
   * 提示条不得与右侧面板相交（§5.10）。
   *
   * ## 这是一个真实存在过的缺陷
   *
   * 窗口最小 820 宽。提示条最大宽 420、视口正中 → x 200–620；
   * 设置面板宽 360、右贴 Spine → x 404–764。两个区间相交，面板标题与
   * 三个选项卡正好落在交叠区里，被提示条压住。
   *
   * 层级上古法是对的（`--z-toast` 50 > `--z-drawer` 30），所以它不会
   * 被面板吞掉——但压住标题同样不行。修法见 `toast.css`：有右侧浮层时
   * 把落点左移到剩余空间正中。
   *
   * 断言用**几何相交**而不是"看截图像不像"：矩形求交是可判定的，
   * 「差 12px 压到边缘」那种情况肉眼看不出来。
   */
  const toastGeom = await page.evaluate(() => {
    const body = document.querySelector('.toast__body')
    const panel = document.querySelector('.settings')
    if (body === null) return { present: false, disjoint: true, at: '这条没提示条' }
    if (panel === null) return { present: true, disjoint: true, at: '这条没面板' }
    const a = body.getBoundingClientRect()
    const b = panel.getBoundingClientRect()
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return {
      present: true,
      disjoint: overlapX <= 0 || overlapY <= 0,
      at: `toast x ${String(Math.round(a.left))}–${String(Math.round(a.right))}，面板 x ${String(Math.round(b.left))}–${String(Math.round(b.right))}`,
    }
  })
  truthy('提示条存在（避让断言的前提）', toastGeom.present === true)
  truthy(`提示条不压设置面板（${toastGeom.at}）`, toastGeom.disjoint === true)

  /*
   * 标题必须真的可见。
   *
   * `elementFromPoint` 取的是"这个坐标上最顶层的元素"——它返回什么，
   * 决定了用户的眼睛能看到什么。标题中心点若命中的不是标题本身，
   * 就说明有东西压在上面（浮层、Toast、遮罩）。这条断言是
   * `textContent` 的补充：后者验"存在"，前者验"看得见"。
   */
  const titleOnTop = await page.evaluate(() => {
    const title = document.querySelector('.settings__title')
    if (title === null) return 'missing'
    const box = title.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit !== null && (hit === title || title.contains(hit)) ? 'ok' : (hit?.className ?? 'null')
  })
  same('设置·标题未被浮层遮挡', titleOnTop, 'ok')

  /*
   * 设置页内容断言（§12.16 / §5.13）。
   *
   * ## 为什么不能只靠截图
   *
   * 上一版设置接口没有假数据，请求落到兜底 `{ ok: true }`，页面显示
   * 「读不到设置」——截图上看是个合理的错误态，于是**一个控件都没被验过**
   * 却看不出来。所以这里断言控件真的渲染了，且五种控件各至少出现一次。
   */
  const scene = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.scene__item')]
    const texts = items.map((node) => node.textContent ?? '')
    return {
      count: items.length,
      missing: items.filter((node) => node.getAttribute('data-missing') !== null).length,
      anchors: document.querySelectorAll('.scene__anchor').length,
      ranges: document.querySelectorAll('.scene__range').length,
      segments: document.querySelectorAll('.scene__segment').length,
      switches: document.querySelectorAll('.scene__switch').length,
      times: document.querySelectorAll('.scene__time-input').length,
      changed: texts.filter((text) => text.includes('已改')).length,
      unchanged: texts.filter((text) => text.includes('默认') && !text.includes('已改')).length,
      head: document.querySelector('.settings__title')?.textContent ?? '',
      foot: document.querySelector('.settings__foot')?.textContent ?? '',
      /*
       * 内容是否水平溢出。
       *
       * 设置面板宽 360，而场景层的元数据行（`90 · 默认 30 · memory-core · 已改`）
       * 与四个锚点按钮（一个月/三个月/一年/十年）都是横向排布。它们一旦
       * 超出内容区，浏览器会给 `.settings__body` 造一条横向滚动条——
       * 在 overlay 滚动条下它几乎看不见，但整个面板可以左右晃动，
       * 而且右侧内容会被裁掉。这类缺陷截图只能靠"看起来有点挤"察觉。
       */
      overflow: (() => {
        const body = document.querySelector('.settings__body')
        if (body === null) return -1
        const limit = body.getBoundingClientRect().right
        let worst = 0
        for (const node of body.querySelectorAll('*')) {
          const rect = node.getBoundingClientRect()
          if (rect.width === 0) continue
          worst = Math.max(worst, rect.right - limit)
        }
        return Math.round(worst)
      })(),
      scrollW: document.querySelector('.settings__body')?.scrollWidth ?? 0,
      clientW: document.querySelector('.settings__body')?.clientWidth ?? 0,
    }
  })

  // 13 项是全量。少一项说明某个段没扫到，那一行的控件就整块消失。
  same('设置·场景层 13 项全渲染', scene.count, 13)
  /*
   * 一项都不该缺。
   *
   * `data-missing` 是「段或字段没找到」的标记。它本该是 0；不为 0 时
   * 页面不会报错，只会把那一行换成一句灰色的「这个插件没有装载」——
   * 正是最容易被截图放过的一类缺陷。
   */
  same('设置·场景层无缺失项', scene.missing, 0)
  same('设置·设置标题存在', scene.head, '设置')

  // 五种控件各至少一次：滑杆带锚点、滑杆、分段、开关、时间区间。
  truthy('设置·锚点按钮存在（number-anchored）', scene.anchors > 0)
  truthy('设置·滑杆存在（number）', scene.ranges > 0)
  truthy('设置·分段存在（enum）', scene.segments > 0)
  truthy('设置·开关存在（boolean）', scene.switches > 0)
  same('设置·时间区间是两个输入（range-time）', scene.times, 2)

  // 用户层只覆盖一项，所以「已改」恰好一行、其余都是未改。
  same('设置·恰有一项标记为已改', scene.changed, 1)
  truthy('设置·未改项也显示默认值', scene.unchanged >= 12)

  // 底部统计来自 totals，是「真的读到了 123 段」的证据。
  truthy('设置·底部统计显示字段总数', /\d+ 个字段/.test(scene.foot))

  /*
   * 内容不出边界。
   *
   * `overflow <= 0` 表示没有任何子元素的右边缘越过内容区。子元素探出时
   * 面板会出现横向滚动，右侧内容被裁——而 overlay 滚动条几乎不可见，
   * 用户只会觉得"右边怎么少了一块"。`scrollWidth === clientWidth` 是同一件
   * 事的第二条独立证据（前者靠几何，后者靠布局引擎的溢出判定）。
   */
  truthy(`设置·内容不越出右边界（实测 ${String(scene.overflow)}px）`, scene.overflow <= 0)
  same('设置·无横向滚动', scene.scrollW, scene.clientW)

  /*
   * 设置页截图。这张图是**令牌分层改造后的视觉凭证**：
   * 它涉及的 18 处原来直接引用 `--static-*` 的地方（开关旋钮、分段滑块、
   * 各类描边）全部改成了语义别名。若映射错了，这里会先露出来——
   * 开关旋钮在浅色下是纸白，改成 `--alias-bg-base` 之后仍是纸白；
   * 但如果误指到 `--static-paper-2`，旋钮会变成灰块。
   */
  await page.screenshot({ path: join(OUT, 'settings-v6.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  truthy('Esc 关掉设置', await page.evaluate(() => document.querySelector('.settings') === null))

  /*
   * 7. `Cmd/Ctrl + K` 打开记忆抽屉并聚焦搜索框。
   *
   * 这条最容易做错：抽屉按 `view` 复用同一个组件，若 `view` 已经是
   * `'memory'`，再设一次不会重挂、焦点也就不会重新进来。断言要看
   * 「焦点真的在搜索框里」，不能只看抽屉开着。
   */
  /*
   * Playwright 的按键约定：`press('Meta+K')` 里的大写字母**隐含 Shift**，
   * 等价于 `Meta+Shift+K`。不带 Shift 的组合必须写小写（`Meta+k`），
   * 否则测的是一条根本不存在的键位。
   */
  await page.keyboard.press(`${MOD}+k`)
  await page.waitForTimeout(500)
  const search = await page.evaluate(() => {
    const input = document.querySelector('.drawer__search-input')
    return {
      exists: input !== null,
      focused: input !== null && document.activeElement === input,
      // 搜索框必须在滚动容器之外，否则滚到下面时会跟着滚走。
      outsideScroll: input === null ? false : input.closest('.drawer__body') === null,
      placeholder: input?.getAttribute('placeholder') ?? '',
    }
  })
  truthy('Cmd+K 打开带搜索框的抽屉', search.exists === true)
  truthy('搜索框自动获得焦点', search.focused === true)
  truthy('搜索框在滚动容器之外', search.outsideScroll === true)

  /*
   * 8. 搜索能筛出结果，也能给出「没找到」。
   *
   * 在**记忆**抽屉里搜不到东西是对的——`deriveMemories()` 目前返回空数组
   * （记忆那条链路还没接），所以这里必须切到「今天」抽屉，那里有
   * 一条标题含「雨」的历史会话。在空的记忆抽屉里断言「搜得到」，
   * 测的是假数据而不是搜索本身。
   */
  await page.locator('.rail__item').first().click()
  await page.waitForTimeout(500)
  await page.locator('.drawer__search-input').fill('雨')
  await page.waitForTimeout(250)
  const filtered = await page.evaluate(() => ({
    rows: document.querySelectorAll('.drawer__row').length,
    value: document.querySelector('.drawer__search-input')?.value ?? '',
  }))
  truthy('搜索「雨」筛出会话', filtered.rows > 0)

  await page.locator('.drawer__search-input').fill('这个词一定搜不到')
  await page.waitForTimeout(250)
  const noHit = await page.evaluate(() => ({
    empty: (document.querySelector('.drawer__empty')?.textContent ?? '').trim(),
  }))
  truthy('搜不到时给具体说法', noHit.empty.includes('没找到'))

  // 9. 搜索框里按 Esc 先清词，不直接关抽屉。
  await page.locator('.drawer__search-input').press('Escape')
  await page.waitForTimeout(250)
  const cleared = await page.evaluate(() => ({
    value: document.querySelector('.drawer__search-input')?.value ?? null,
    drawerOpen: document.querySelector('.drawer[data-open]') !== null,
  }))
  same('搜索框 Esc 先清词', '', cleared.value)
  truthy('清词时不关抽屉', cleared.drawerOpen === true)

  // 10. 输入法组合中 Escape 不得被当成关闭。
  /*
   * 用派发原生事件模拟组合态：`isComposing` 是只读的，构造时给上即可。
   * 这条守的是中文用户最容易被绊的一下——按 Esc 取消候选词，
   * 结果整个抽屉关掉了。
   */
  await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })
    window.dispatchEvent(event)
  })
  await page.waitForTimeout(300)
  truthy('组合中 Esc 不关抽屉', await page.evaluate(() => document.querySelector('.drawer[data-open]') !== null))

  /*
   * --- 交互五条（§13，需要真点才验得出来）---
   *
   * 这一批全部是「只在真实时序下才会错的」条目。读代码看不出来，
   * 截图也看不出来——必须让浏览器真的跑一遍动画、真的搬一次焦点。
   */

  /*
   * 先回到干净状态：上面第 8–10 条在「今天」抽屉里搜过东西，抽屉此刻是
   * **开着**的。下面要验「中途反向」，前提是从关闭态开始——否则第一次
   * 点图标是把抽屉关掉，采到的就不是进场动画。
   */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  /*
   * 11. 抽屉展开到一半再点收起，从当前位置反向，**不回到起点**（§13）。
   *
   * ## 为什么不能用 `transitionend` 判
   *
   * 中途反向时不会有 `transitionend`——`transitioncancel` 才是这一路。
   * 断言要抓的是「反向那一刻的位移既不是 0（起点）也不是 −16（终点）」。
   *
   * ## 为什么量 `transform` 矩阵而不是等一段时间再看
   *
   * 量位置会受动画曲线影响（fluid 是三次曲线，同一时刻两次采样的位移
   * 不线性）。这里在 `data-open` 刚被移除的下一帧采样：此刻若写成
   * `transition: ...` + `transform: translateX(-16px)`，计算值必然还是
   * 中间态；若退场写成「先跳到 −16 再播」，采样会读到正好 −16 ——
   * 那就是「回到起点再收起」，正是要抓的缺陷。
   */
  /*
   * 采样进场：从点击到 180ms 结束，逐帧读 `translateX`。
   *
   * 为什么逐帧采样而不是单点采样：单点只能证明「某一刻在中间」，
   * 证明不了「方向是连续的」。规范要的是「从当前位置反向」，
   * 那是一个**轨迹性质**，必须看整条曲线。
   */
  const enterTrace = await page.evaluate(() => new Promise((resolve) => {
    const samples = []
    const start = performance.now()
    document.querySelectorAll('.rail__item')[0].click()
    const tick = () => {
      const panel = document.querySelector('.drawer__panel')
      if (panel === null) { resolve(samples); return }
      samples.push(new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41)
      if (performance.now() - start < 200) requestAnimationFrame(tick)
      else resolve(samples)
    }
    requestAnimationFrame(tick)
  }))
  const enterMid = enterTrace.filter((x) => x > -16 && x < 0)
  truthy('抽屉进场是连续位移（不是瞬移）', enterMid.length >= 2)
  truthy('抽屉进场终点停在原位', enterTrace.length > 0 && enterTrace[enterTrace.length - 1] > -0.5)

  /*
   * 反向：此刻抽屉已完全展开（x = 0）。再点同一个图标收起，
   * 逐帧看它这一段**中途反向**的轨迹。
   */
  const exitTrace = await page.evaluate(() => new Promise((resolve) => {
    const samples = []
    const start = performance.now()
    document.querySelectorAll('.rail__item')[0].click()
    const tick = () => {
      const panel = document.querySelector('.drawer__panel')
      if (panel === null) { resolve(samples); return }
      samples.push(new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41)
      if (performance.now() - start < 280) requestAnimationFrame(tick)
      else resolve(samples)
    }
    requestAnimationFrame(tick)
  }))

  /*
   * 三条一起钉住「从当前位置反向，不回到起点」：
   *
   * 1. 收起全程 x 单调不增 —— 没有跳回起点（跳回会看到一帧 x = -16 后
   *    再变成 0），也没有中途弹跳。
   * 2. 第一帧接近 0 —— 收起是从**展开位置**开始的，不是从 -16。
   * 3. 中间存在严格落在 (−16, 0) 的采样 —— 证明它真的走了中间过程。
   */
  const monotonic = exitTrace.every((x, i) => i === 0 || x <= exitTrace[i - 1] + 0.01)
  truthy('反向收起单调向左，无回跳', monotonic === true)
  truthy('反向收起从展开位置起步', exitTrace.length > 0 && exitTrace[0] > -0.5)
  truthy('反向收起经过中间位置', exitTrace.some((x) => x < -0.5 && x > -15.5))
  truthy('反向收起最终到达收起位置', exitTrace[exitTrace.length - 1] < -15.5)

  // 等它彻底收完，再进入下一个断言。
  await page.waitForTimeout(400)
  truthy('抽屉收完后完全退出', await page.evaluate(() => document.querySelector('.drawer[data-open]') === null))

  /*
   * 12. 关闭浮层后焦点回到触发它的元素（§9.5）。
   *
   * 这条守的是键盘用户的连续性：关掉抽屉后焦点落在 `body`，下一个 Tab
   * 会从文档最开头重新走——用户刚在第四个图标上打开的东西，关掉后
   * 又被送回第一个。
   */
  await page.locator('.rail__item').nth(2).focus()
  await page.locator('.rail__item').nth(2).click()
  await page.waitForTimeout(400)
  const focusInDrawer = await page.evaluate(() => document.querySelector('.drawer__panel')?.contains(document.activeElement) === true)
  truthy('打开抽屉后焦点在抽屉内', focusInDrawer === true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const focusBack = await page.evaluate(() => ({
    // 回到第 3 个 Rail 项（索引 2）——也就是触发它的那个按钮。
    onTrigger: document.activeElement === document.querySelectorAll('.rail__item')[2],
    tag: document.activeElement?.tagName ?? '',
    label: document.activeElement?.getAttribute('aria-label') ?? '',
  }))
  truthy('关闭抽屉后焦点回到触发按钮', focusBack.onTrigger === true)
  truthy('焦点没有掉到 body', focusBack.tag !== 'BODY')

  // 检查器同理：它从 Spine 打开，关掉要回那个按钮。
  // 注意 Spine 整个就是按钮（`<button class="spine">` 包着水位与读数），
  // 没有一个单独叫 `.spine__inspector` 的元素——那个名字只存在于设计文档的
  // 分区描述里，DOM 上是根按钮本身。
  await page.locator('.spine').click()
  await page.waitForTimeout(400)
  const inspectorOpen = await page.evaluate(() => document.querySelector('.inspector') !== null)
  truthy('Spine 按钮打开检查器', inspectorOpen === true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const inspectorBack = await page.evaluate(() => ({
    onTrigger: document.activeElement === document.querySelector('.spine'),
    tag: document.activeElement?.tagName ?? '',
  }))
  truthy('关闭检查器后焦点回到 Spine 按钮', inspectorBack.onTrigger === true)
  truthy('检查器关闭后焦点不在 body', inspectorBack.tag !== 'BODY')

  /*
   * 13. 消息区获得焦点后 `PageUp` / `PageDown` 按屏跳（§9.6）。
   *
   * 一条消息是一个 Tab 停靠点，四十条就要按四十次。规范把这一条列为
   * 「唯一的例外」：消息区里按屏翻，不必逐条走。
   *
   * 断言要同时看三件事：视口能聚焦、PageDown 真的让 `scrollTop` 变大、
   * 一次跳的量约等于一屏（减去三行重叠）而不是一条消息的高度。
   */
  const scrollable = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    if (view === null) return { found: false }
    return {
      found: true,
      focusable: view.tabIndex >= 0,
      role: view.getAttribute('role'),
      live: view.getAttribute('aria-live'),
      overflow: view.scrollHeight > view.clientHeight + 1,
      clientHeight: view.clientHeight,
    }
  })
  truthy('消息区视口能进 Tab 顺序', scrollable.found === true && scrollable.focusable === true)
  same('消息区角色是 log', 'log', scrollable.role)
  same('消息区礼貌播报', 'polite', scrollable.live)
  /*
   * 无头环境默认视口 1280×720，两条消息撑不满一屏。为了验翻页，
   * 这里临时把视口压矮——压矮是改 CSS，不动内容，翻页比例仍然真实。
   */
  await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    if (view !== null) view.style.maxHeight = '120px'
  })
  await page.waitForTimeout(200)
  const before = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    if (view === null) return null
    view.focus()
    view.scrollTop = 0
    return { hasOverflow: view.scrollHeight > view.clientHeight + 1, top: view.scrollTop }
  })
  truthy('压矮后消息区可滚动', before !== null && before.hasOverflow === true)
  await page.keyboard.press('PageDown')
  await page.waitForTimeout(500)
  const afterDown = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    return view === null ? null : { top: view.scrollTop, client: view.clientHeight }
  })
  truthy('PageDown 让消息区向下翻', afterDown !== null && afterDown.top > 0)
  /*
   * 翻页量必须接近一整屏（留三行重叠），不能是一条消息的高度。
   * 用 `clientHeight * 0.5` 作下限：三行重叠最多扣掉几十像素，
   * 而「一条消息」的高度远小于半屏——这个阈值把两者分开。
   */
  truthy(
    'PageDown 一次约翻一屏',
    afterDown !== null && afterDown.top >= afterDown.client * 0.5,
  )
  await page.keyboard.press('PageUp')
  await page.waitForTimeout(500)
  const afterUp = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    return view === null ? null : view.scrollTop
  })
  truthy('PageUp 让消息区向上翻', afterUp !== null && afterUp < afterDown.top)
  // 撤掉临时高度，后续断言按真实布局量。
  await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    if (view !== null) view.style.maxHeight = ''
  })
  await page.waitForTimeout(200)

  /*
   * 14. 关闭浮层后焦点不回页面顶部（与 12 同源，但路径不同）。
   *
   * 12 验的是「回到触发元素」，这里验反例：焦点**不能**是 body，
   * 也不能是文档里第一个可聚焦元素。它是 12 的守门断言——
   * 万一将来有人把 `useRestoreFocus` 的清理逻辑删了，12 可能因为
   * 某个巧合仍然通过（比如浏览器自己把焦点还回去了），
   * 这条会独立报红。
   */
  const firstFocusable = await page.evaluate(() => {
    const nodes = document.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    return nodes[0] === document.activeElement
  })
  truthy('焦点没有停在文档第一个可聚焦元素', firstFocusable === false)

  // 收尾：关掉抽屉，回到干净状态。
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // --- 关闭确认框（§2.7 §12.10）---
  /*
   * 壳拦截到关闭请求后会发 `close-requested`。测试里直接派发同名事件
   * 复现那条路径——不必真的去点窗口的 ×（无头环境没有窗口按钮）。
   *
   * 关键断言是「宽 400」与「Esc 不退出应用」：前者是 §5.12 的规格，
   * 后者是这一版修掉的真实风险——把 Esc 接到 onCancel 上，
   * 用户想「先别关」却把应用退掉了。
   */
  await page.evaluate(() => {
    // 页面的监听是壳通过 `__TAURI__.event.listen` 注册的，测试的假壳
    // 记下了这些回调，这里取出来直接调。
    for (const [name, handler] of (window.__ondraListeners ?? [])) {
      if (name === 'close-requested') handler({ payload: null })
    }
  })
  await page.waitForTimeout(400)

  const dialog = await page.evaluate(() => {
    const panel = document.querySelector('.dialog__panel')
    if (panel === null) return { found: false }
    const rect = panel.getBoundingClientRect()
    const scrim = document.querySelector('.dialog')
    return {
      found: true,
      w: Math.round(rect.width),
      centered: Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) <= 1,
      radius: getComputedStyle(panel).borderRadius,
      modal: panel.getAttribute('aria-modal'),
      scrimBg: scrim === null ? '' : getComputedStyle(scrim).backgroundColor,
      hasRemember: panel.querySelector('.dialog__check input') !== null,
      // 初始焦点必须落在主按钮上，不是勾选框。
      focusedText: (document.activeElement?.textContent ?? '').trim(),
    }
  })
  truthy('关闭时弹出确认框', dialog.found === true)
  eq('确认框宽 400', 400, dialog.w)
  truthy('确认框水平居中', dialog.centered === true)
  same('确认框圆角 16', '16px', dialog.radius)
  truthy('确认框是 aria-modal', dialog.modal === 'true')
  truthy('确认框有「记住选择」', dialog.hasRemember === true)
  same('初始焦点在主按钮', '隐藏到托盘', dialog.focusedText)
  await page.screenshot({ path: join(OUT, 'close-dialog-v5.png') })

  // Esc 关掉确认框，且必须**不**触发退出。
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const afterEsc = await page.evaluate(() => ({
    dialogGone: document.querySelector('.dialog__panel') === null,
    // 退出走的是 `resolve_close` 命令。假壳把调用记在 __ondraCalls 里。
    quitCalled: (window.__ondraCalls ?? []).some((call) => call.command === 'resolve_close'),
  }))
  truthy('Esc 关掉确认框', afterEsc.dialogGone === true)
  truthy('Esc 不退出应用', afterEsc.quitCalled === false)

  await page.screenshot({ path: join(OUT, 'composer-v5.png') })

  /*
   * --- 一键静音（§12.10、§12.12、§5.7 静音态）---
   *
   * ## 为什么这条必须真跑一遍
   *
   * 静音有三个外部可见的落点，三处都可能单独坏，而且坏法互不报错：
   *
   * | 落点 | 坏了的症状 |
   * | --- | --- |
   * | Spine 的「静音」二字 | 用户按了菜单，界面上什么都没有 → 以为没生效 |
   * | 截止时刻落盘 | 重启后静音丢了 → 她提前一小时开始说话 |
   * | 托盘菜单文字 | 菜单还写着「静音 1 小时」→ 用户找不到取消入口 |
   *
   * 三条都要断言。只验界面那条最省事，但漏掉的正是「重启后」与
   * 「取消」这两个用户真会碰到的场景。
   *
   * ## 触发方式
   *
   * 托盘在 Rust 侧，测试里没有真托盘。壳的菜单点击会发 `toggle-mute`
   * 事件，这里直接派发同名事件复现那条路径（与验关闭确认框同一个手法）。
   */
  const muteBefore = await page.evaluate(() => ({
    muted: document.querySelector('.spine__muted') !== null,
    stored: localStorage.getItem('ondra.mutedUntil'),
    /*
     * 呼吸标记的**初值**要留一份。
     *
     * §5.7 说静音不影响呼吸，但「呼吸开着」这条断言在无数据时会假失败：
     * 没有心跳读数时水位本来就不呼吸（那是 §5.7 的暂停条件之一，与静音
     * 无关）。测试的假宿主不返回心情数据，所以这一页没有读数。
     *
     * 正确的判据是「静音前后呼吸**不变**」——这恰好就是规范说的那件事，
     * 而不是「静音后呼吸为真」。
     */
    breathe: document.querySelector('.spine__fill[data-breathe]') !== null,
  }))
  truthy('初始没有静音标记', muteBefore.muted === false)
  truthy('初始没有静音落盘', muteBefore.stored === null)

  await page.evaluate(() => {
    for (const [name, handler] of (window.__ondraListeners ?? [])) {
      if (name === 'toggle-mute') handler({ payload: null })
    }
  })
  await page.waitForTimeout(400)

  const mutedState = await page.evaluate(() => {
    const marker = document.querySelector('.spine__muted')
    const raw = localStorage.getItem('ondra.mutedUntil')
    const until = raw === null ? 0 : Number(raw)
    return {
      shown: marker !== null,
      text: marker?.textContent ?? '',
      // 剩余时长应当接近一小时。抓宽一点（58–61 分钟），只排除
      // 「存了 1 秒」或「存了 24 小时」这类量级错误。
      minutes: until > 0 ? Math.round((until - Date.now()) / 60000) : -1,
      trayCall: (window.__ondraCalls ?? []).filter((call) => call.command === 'set_tray_muted').at(-1) ?? null,
      breathe: document.querySelector('.spine__fill[data-breathe]') !== null,
      /*
       * 静音**不等于**休息。
       *
       * §5.7 把两件事分开写：「静音」只关声音、水位照常；「休息中」是
       * 她真的不在，水位压到 15% 并转灰。若实现偷懒复用 `resting` 那条
       * 路径，界面看起来也对（都有字），但静音时水位会掉到 15%——
       * 用户会以为她在睡觉，而其实只是在静音。
       */
      resting: document.querySelector('.spine')?.hasAttribute('data-resting') ?? false,
      restingText: document.querySelector('.spine__empty')?.textContent ?? '',
    }
  })
  truthy('静音后 Spine 显示「静音」', mutedState.shown === true)
  same('静音标记文案是「静音」两字', '静音', mutedState.text)
  truthy(`静音时长约一小时（${String(mutedState.minutes)} 分钟）`, mutedState.minutes >= 58 && mutedState.minutes <= 61)
  truthy('静音状态同步给了托盘', mutedState.trayCall?.args?.muted === true)
  truthy('静音不把脊切成休息态', mutedState.resting === false)
  truthy('静音时文字不是「休息中」', mutedState.restingText !== '休息中')
  same('静音不改变水位呼吸（§5.7 静音不影响在场感）', muteBefore.breathe, mutedState.breathe)
  await page.screenshot({ path: join(OUT, 'muted-spine-v5.png') })

  /*
   * 再按一次 = 取消。这条对应托盘菜单文字变成「取消静音」之后的那个动作。
   *
   * 断言特意包含「落盘被清掉」：只清内存不清盘的话，用户取消静音、
   * 关掉应用再打开，静音会**回来**——而他明明刚取消过。
   */
  await page.evaluate(() => {
    for (const [name, handler] of (window.__ondraListeners ?? [])) {
      if (name === 'toggle-mute') handler({ payload: null })
    }
  })
  await page.waitForTimeout(400)
  const unmutedState = await page.evaluate(() => ({
    shown: document.querySelector('.spine__muted') !== null,
    stored: localStorage.getItem('ondra.mutedUntil'),
    trayCall: (window.__ondraCalls ?? []).filter((call) => call.command === 'set_tray_muted').at(-1) ?? null,
  }))
  truthy('取消静音后 Spine 不再显示「静音」', unmutedState.shown === false)
  truthy('取消静音后落盘被清掉', unmutedState.stored === null)
  truthy('取消静音同步给了托盘', unmutedState.trayCall?.args?.muted === false)

  /*
   * 偏好设置窗口（§5.13 第一层）单独开一页验。
   *
   * ## 为什么不接着主界面验
   *
   * 壳内它是**独立 WebView 文档**，浏览器里退化成同一个文档换 hash。
   * 在主流程里做会丢掉主界面状态（会话、抽屉、滚动位置），
   * 后半段的断言全部要重来。开一页直达 `#preferences` 更接近真实：
   * 新文档、干净状态、与壳内一样从零渲染。
   *
   * ## 为什么 `Cmd+,` 本身不在这一页验
   *
   * 那一页没有主界面，也没有对应的快捷键上下文。`Cmd+,` 的契约是
   * 「发出 `open_preferences` 命令」，由主流程验；这一页验的是
   * 「命令打开的那个界面长什么样」。
   */
  const prefPage = await browser.newPage({ viewport: { width: 560, height: 480 }, deviceScaleFactor: 2 })
  const prefErrors = []
  prefPage.on('console', (message) => {
    if (message.type() === 'error') prefErrors.push(message.text())
  })
  prefPage.on('pageerror', (error) => { prefErrors.push(String(error)) })
  await prefPage.addInitScript(fakeShell(port, false))
  await prefPage.addInitScript(soundSpy)
  await prefPage.goto(`http://127.0.0.1:${String(port)}/#preferences`, { waitUntil: 'networkidle' })
  await prefPage.waitForTimeout(500)

  const pref = await prefPage.evaluate(() => {
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    const navBox = document.querySelector('.pref__nav')?.getBoundingClientRect()
    const choices = [...document.querySelectorAll('.pref__choice')]
    const checked = choices.filter((node) => node.getAttribute('aria-checked') === 'true')
    return {
      navLabels: nav.map((node) => node.textContent ?? '').join('/'),
      navWidth: navBox === undefined ? 0 : Math.round(navBox.width),
      current: document.querySelector('.pref__nav-item[aria-current="page"]')?.textContent ?? '',
      role: document.querySelector('.pref__choices')?.getAttribute('role') ?? '',
      choiceCount: choices.length,
      checkedCount: checked.length,
      checkedLabel: checked[0]?.textContent ?? '',
      // 主界面那棵树不该在这一页出现。
      appGone: document.querySelector('.workspace') === null && document.querySelector('.welcome') === null,
    }
  })
  /*
   * §5.13 的七页 + §12.12 的声音页，顺序即规范列举顺序。
   *
   * 声音为什么落在「字号」之后：「发送方式」以及其后的四项都是**行为**
   * 偏好（她怎么回、能做什么、怎么更新），而声音与主题、字号同属
   * **感官**偏好——调的是这台机器上你听到、看到什么。把它挂在
   * 字号后面，三件"感官"的事就挨在一起，用户不必在两个品类间跳。
   */
  same('偏好设置八页齐全且有序', '主题/语言/字号/声音/发送方式/默认权限/更新/关于', pref.navLabels)
  eq('偏好设置左导航宽 160', 160, pref.navWidth)
  same('偏好设置默认停在主题页', '主题', pref.current)
  same('偏好设置的选择组是 radiogroup', 'radiogroup', pref.role)
  truthy('偏好设置只渲染自己那棵树', pref.appGone === true)
  /*
   * 单选语义必须成立：三项里**恰好一项**选中。
   *
   * 全不选，界面看起来"没选中"；多选，读屏会念出两个选中项。
   * 这两种都不会报错，只在用的时候觉得别扭。
   */
  eq('偏好设置·选择组恰有一项选中', 1, pref.checkedCount)
  truthy('偏好设置·默认选中「跟随系统」', pref.checkedLabel.includes('跟随系统'))

  /*
   * 字号必须真的改 `html` 的百分比。
   *
   * §9.9：界面字号一律 rem、基准 `html { font-size: 100% }`，系统放大时
   * 跟着放大。这里点「大」再量根字号——若实现写死 px，量到的值不变。
   * 量的是 `computedStyle`，浏览器会把 `112.5%` 归一成 px，所以比数值。
   */
  const fontBefore = await prefPage.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
  await prefPage.evaluate(() => {
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    const target = nav.find((node) => node.textContent === '字号')
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(250)
  await prefPage.evaluate(() => {
    const choices = [...document.querySelectorAll('.pref__choice')]
    const target = choices.find((node) => node.textContent?.includes('大'))
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(300)
  const fontAfter = await prefPage.evaluate(() => ({
    size: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    stored: localStorage.getItem('ondra.fontScale'),
    // 预演句必须跟着变大：它用 `--text-body`，而令牌是 rem。
    sample: Number.parseFloat(
      getComputedStyle(document.querySelector('.pref__sample-text') ?? document.body).fontSize,
    ),
  }))
  truthy(`偏好设置·字号真的放大（${String(fontBefore)} → ${String(fontAfter.size)}px）`, fontAfter.size > fontBefore)
  same('偏好设置·字号已持久化', 'large', fontAfter.stored)
  truthy(`偏好设置·预演句跟着放大（${String(fontAfter.sample)}px）`, fontAfter.sample > 14)

  // 改回标准，并切到「关于」页截图（品牌块只在那一页出现）。
  await prefPage.evaluate(() => {
    const choices = [...document.querySelectorAll('.pref__choice')]
    const target = choices.find((node) => node.textContent?.includes('标准'))
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(250)
  await prefPage.evaluate(() => {
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    const target = nav.find((node) => node.textContent === '关于')
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(300)
  const about = await prefPage.evaluate(() => ({
    brand: document.querySelector('.pref__brand-name')?.textContent ?? '',
    version: [...document.querySelectorAll('.pref__facts dd')].map((node) => node.textContent ?? '').join('|'),
    // §5.9：禁用项保留、灰显、`title` 写原因，而不是删掉。
    guide: (() => {
      const button = [...document.querySelectorAll('.pref__action')].find(
        (node) => node.textContent?.includes('重新观看引导'),
      )
      return button === undefined
        ? 'missing'
        : `${button.getAttribute('aria-disabled') ?? 'none'}:${button.getAttribute('title') ?? ''}`
    })(),
  }))
  same('偏好设置·关于页有品牌名', '空谷 Ondra', about.brand)
  truthy('偏好设置·关于页显示版本号', /v\d+\.\d+\.\d+/.test(about.version))
  truthy(
    `偏好设置·未实现的项保留为禁用并说明原因（${about.guide}）`,
    about.guide.startsWith('true:') && about.guide.length > 8,
  )
  await prefPage.screenshot({ path: join(OUT, 'preferences-about.png') })

  /*
   * 权限页必须真的读到宿主的值。
   *
   * ## 这一条守的是一个真实缺陷
   *
   * 连接信息是壳在**宿主启动成功后**通过 `host-ready` 推给页面的。
   * 主窗口那一刻已经加载完、收得到；偏好窗口是用户后来才打开的——
   * **那条事件早发过了**，它永远等不到。
   *
   * 不补主动拉取的话，主题与字号照样能改（不依赖宿主），只有这一页
   * 永远停在「正在读取…」。而这种缺陷不报错、不弹提示，看起来像
   * 后台服务挂了。这里用「假壳不补发 ready」复现真实时序：
   * 若实现改回只靠事件，这一条会立刻报红。
   */
  await prefPage.evaluate(() => {
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    const target = nav.find((node) => node.textContent === '默认权限')
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(600)
  const permission = await prefPage.evaluate(() => {
    const labels = [...document.querySelectorAll('.pref__choice-label')].map((node) => node.textContent ?? '')
    const checked = [...document.querySelectorAll('.pref__choice[aria-checked="true"] .pref__choice-label')]
      .map((node) => node.textContent ?? '')
    return {
      options: labels.join('/'),
      checked: checked.join('/'),
      note: document.querySelector('.pref__note')?.textContent ?? '',
    }
  })
  same('偏好设置·权限页三档齐全', '只在对话内/限于工作区/不限制', permission.options)
  truthy(`偏好设置·权限页读到宿主当前值（${permission.checked}）`, permission.checked === '限于工作区')
  truthy('偏好设置·权限页不是「正在读取」', !permission.note.includes('正在读取'))

  /*
   * 内容不得越出右边界（与设置面板同一条规矩）。
   *
   * 560 − 160 = 400 给内容区，而「不限制 · 能读到整台机器」这类两段式
   * 选项在 400 里刚好放得下。一旦某个文案变长，整块会顶出去，
   * 而 overlay 滚动条几乎看不见，用户只看到右边少了一块。
   */
  const prefOverflow = await prefPage.evaluate(() => {
    const content = document.querySelector('.pref__content')
    if (content === null) return -1
    const limit = content.getBoundingClientRect().right
    let worst = 0
    for (const node of content.querySelectorAll('*')) {
      const box = node.getBoundingClientRect()
      if (box.width === 0) continue
      worst = Math.max(worst, box.right - limit)
    }
    return Math.round(worst)
  })
  truthy(`偏好设置·内容不越出右边界（实测 ${String(prefOverflow)}px）`, prefOverflow <= 0)

  await prefPage.evaluate(() => {
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    const target = nav.find((node) => node.textContent === '主题')
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(300)
  await prefPage.screenshot({ path: join(OUT, 'preferences-theme.png') })

  // 深色下同样要看一眼：偏好窗口是独立文档，令牌要能自己解析出深色。
  /*
   * 选择器只认**标签文字**，不认整个按钮的 `textContent`。
   *
   * 「跟随系统」那项的说明是「系统换深色时她也换」，整块文本里同样含
   * 「深色」二字——按 `textContent.includes('深色')` 找，先命中的是它，
   * 于是点回了「跟随系统」，而界面表现得像深色没生效。
   */
  await prefPage.evaluate(() => {
    const labels = [...document.querySelectorAll('.pref__choice-label')]
    const target = labels.find((node) => node.textContent === '深色')
    target?.closest('.pref__choice')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(400)
  const prefDark = await prefPage.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    bg: getComputedStyle(document.querySelector('.pref') ?? document.body).backgroundColor,
  }))
  same('偏好设置·深色写进 data-theme', 'dark', prefDark.theme)
  same('偏好设置·同步 color-scheme', 'dark', prefDark.scheme)
  truthy(`偏好设置·深色底已生效（${prefDark.bg}）`, prefDark.bg !== 'rgb(255, 253, 249)')
  await prefPage.screenshot({ path: join(OUT, 'preferences-dark.png') })

  /*
   * --- 声音页（§12.12）---
   *
   * ## 这一页要验的四件事
   *
   * 1. **默认关闭**。规范第一行就是它。开着的话，用户在图书馆第一次
   *    发消息就被响一下，那不是"细节没调好"，是产品态度错了。
   * 2. **开关真的落盘**。只在内存里翻面，重启就回去，用户会以为
   *    "这个设置存不住"。
   * 3. **音量真的传到增益上**。滑杆拉到 0 必须真的静，拉到 100
   *    必须真的响——中间无数种"调了没用"的写法都能通过截图。
   * 4. **三种音各不相同**。三个按钮响同一个频率，等于只做了一种音。
   */
  await prefPage.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    const target = nav.find((node) => node.textContent === '声音')
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await prefPage.waitForTimeout(350)

  const soundPage = await prefPage.evaluate(() => {
    const toggle = document.querySelector('.pref__switch')
    const range = document.querySelector('.pref__range')
    const cues = [...document.querySelectorAll('.pref__cue-name')].map((node) => node.textContent ?? '')
    return {
      toggleRole: toggle?.getAttribute('role') ?? '',
      toggleOn: toggle?.getAttribute('aria-checked') ?? '',
      stored: localStorage.getItem('ondra.sound'),
      rangeLabel: range?.getAttribute('aria-label') ?? '',
      rangeDisabled: range?.disabled === true,
      // 关着时三个试听键都要写明原因（§5.9），不能只是灰。
      cueHint: document.querySelector('.pref__cue')?.getAttribute('title') ?? '',
      cues: cues.join('/'),
    }
  })
  same('声音页·开关用 role=switch', 'switch', soundPage.toggleRole)
  same('声音页·提示音默认关闭', 'false', soundPage.toggleOn)
  /*
   * 「没改过」的判据是**值为关**，不是键不存在。
   *
   * 这一页之前为了验主题与字号已经调过 `setPreferences`，而它一次写全
   * 五个键——所以到这里 `ondra.sound` 已经有值了。键存在与否取决于
   * 用户有没有动过任何一条偏好，与默认值无关；把它写成"键必须为 null"
   * 是在验一件实现根本不该保证的事（新装用户点两次主题就失效）。
   * 真正要守的是：**默认那一档必须是关**。
   */
  truthy(`声音页·未被主动打开时保持关闭（键值 ${String(soundPage.stored)}）`, soundPage.stored !== 'on')
  same('声音页·三种音齐全且有序', '发送/她开口/出错', soundPage.cues)
  truthy('声音页·关着时滑杆禁用', soundPage.rangeDisabled === true)
  truthy(`声音页·关着时试听键写明原因（${soundPage.cueHint}）`, soundPage.cueHint.length > 0)
  eq('声音页·滑杆有可朗读名称', 5, soundPage.rangeLabel.length > 0 ? 5 : 0)

  // 打开声音：必须立刻响一声（§6.5 预演），并落盘。
  const soundOn = await prefPage.evaluate(async () => {
    window.__ondraSound.length = 0
    document.querySelector('.pref__switch')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    const range = document.querySelector('.pref__range')
    return {
      on: document.querySelector('.pref__switch')?.getAttribute('aria-checked'),
      stored: localStorage.getItem('ondra.sound'),
      volume: localStorage.getItem('ondra.soundVolume'),
      rangeDisabled: range?.disabled === true,
      starts: window.__ondraSound.filter((event) => event.op === 'start').length,
    }
  })
  same('声音页·点开后开关为开', 'true', soundOn.on)
  same('声音页·开关已落盘', 'on', soundOn.stored)
  truthy(`声音页·音量已落盘（${soundOn.volume}）`, soundOn.volume === '60')
  truthy('声音页·打开时立刻响一声', soundOn.starts === 1)
  truthy('声音页·开着时滑杆可用', soundOn.rangeDisabled === false)

  /*
   * 三种音必须真的不同。
   *
   * 读的是 `osc.frequency` 的第一次设定值（起始频率）。三个数互不相等
   * 才算"三种音"成立；相同就说明只写了一条配方，三个按钮指向同一段代码。
   */
  const cueStarts = await prefPage.evaluate(async () => {
    const read = []
    for (const name of ['发送', '她开口', '出错']) {
      window.__ondraSound.length = 0
      const button = [...document.querySelectorAll('.pref__cue')]
        .find((node) => node.textContent?.includes(name))
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 120) })
      const freq = window.__ondraSound.find((event) => event.op === 'freq')
      read.push(freq?.value ?? 0)
    }
    return read
  })
  truthy(`声音页·发送与「她开口」音高不同（${String(cueStarts[0])} / ${String(cueStarts[1])}）`, cueStarts[0] !== cueStarts[1])
  truthy(`声音页·出错音是下行且更低（${String(cueStarts[2])}）`, cueStarts[2] > 0 && cueStarts[2] < cueStarts[1])

  /*
   * 音量必须真的改变增益。
   *
   * 对比 0 与 100 两档：0 时一个 `start` 都不该有（`gainOf(0) = 0`，
   * 在合成之前就返回），100 时必须响。这一条守的是"滑杆只改了界面
   * 上的数字、没传给音频图"那类缺陷。
   */
  const volumeEffect = await prefPage.evaluate(async () => {
    const setVolume = async (value) => {
      const range = document.querySelector('.pref__range')
      if (range === null) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(range, String(value))
      range.dispatchEvent(new Event('input', { bubbles: true }))
      range.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 150) })
    }
    await setVolume(0)
    window.__ondraSound.length = 0
    const cue = [...document.querySelectorAll('.pref__cue')].find((node) => node.textContent?.includes('发送'))
    cue?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    const silent = window.__ondraSound.filter((event) => event.op === 'start').length

    const peakAt = async (value) => {
      await setVolume(value)
      window.__ondraSound.length = 0
      cue?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 150) })
      return Math.max(0, ...window.__ondraSound
        .filter((event) => event.op === 'gain')
        .map((event) => event.value))
    }
    const quiet = await peakAt(60)
    const loudPeak = await peakAt(100)
    const loud = window.__ondraSound.filter((event) => event.op === 'start').length
    return { silent, loud, quiet, loudPeak }
  })
  eq('声音页·音量 0 时完全不出声', 0, volumeEffect.silent)
  truthy('声音页·音量 100 时出声', volumeEffect.loud === 1)
  /*
   * 比的是**两档之间的比例**，不是某个绝对数。
   *
   * 绝对值取决于两条曲线（`gainOf` 的平方、每种音自己的 peak），
   * 断言写死一个区间，等于把实现细节抄进测试——改一个音色的峰值就报红，
   * 而那时功能其实是对的。比例才是"音量真的传到了增益上"这件事本身：
   * 平方曲线下 60 → 100 应放大 (100/60)² ≈ 2.78 倍。
   */
  truthy(
    `声音页·增益随音量成比例变化（60 档 ${String(volumeEffect.quiet.toFixed(3))} → 100 档 ${String(volumeEffect.loudPeak.toFixed(3))}）`,
    volumeEffect.quiet > 0 && volumeEffect.loudPeak / volumeEffect.quiet > 2.5,
  )

  // 改回 60，给后面的主流程留下一个已知状态。
  await prefPage.evaluate(async () => {
    const range = document.querySelector('.pref__range')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(range, '60')
    range?.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => { setTimeout(resolve, 120) })
  })
  await prefPage.waitForTimeout(200)
  await prefPage.screenshot({ path: join(OUT, 'preferences-sound.png') })

  if (prefErrors.length > 0) {
    console.log('\n偏好设置页的控制台错误：')
    for (const error of prefErrors) console.log(`  ${error}`)
    process.exitCode = 1
  }

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
  /*
   * 控制台错误分两类。
   *
   * ## 为什么必须分
   *
   * 这个脚本**故意**制造了一个失败请求：`/api/inference` 返回 500，
   * 用来验内联错误条。那一条错误是测试自己造的，不能算缺陷；
   * 混在一起久了，看到「控制台错误」就默认「是那个故意的」，
   * 真正的报错会被当成噪音跳过。
   *
   * ## 判据是 URL，不是文案
   *
   * 浏览器的错误文案随版本变（`Failed to load resource` 后面跟的
   * 内容不同），拿文案匹配迟早失配。这里认的是**请求 URL**，
   * 只有明确标记为预期的路径才放行，其余全部计入失败。
   */
  const EXPECTED_FAILURES = ['/api/inference']
  const unexpected = errors.filter(
    (error) => !EXPECTED_FAILURES.some((path) => error.includes(path)),
  )
  const expected = errors.length - unexpected.length

  if (expected > 0) {
    console.log(`\n预期内的失败请求 ${String(expected)} 条（测试用来验错误态，不算缺陷）`)
  }
  if (unexpected.length > 0) {
    console.log('\n意外的控制台错误：')
    for (const error of unexpected) console.log(`  ${error}`)
    process.exitCode = 1
  } else {
    console.log('无意外控制台错误')
  }
  if (failed.length > 0) process.exitCode = 1

  const tokensOk = await checkTokens()
  if (!tokensOk) process.exitCode = 1

  const brandOk = await checkBrand()
  if (!brandOk) process.exitCode = 1

  const specsOk = await checkStaticSpecs()
  if (!specsOk) process.exitCode = 1

  const trayOk = await checkTrayAssets()
  if (!trayOk) process.exitCode = 1
}

await run()
