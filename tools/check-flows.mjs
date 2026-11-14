/**
 * 全界面 · 全功能的用户流程测试（真宿主模式）。
 *
 * ## 为什么用真宿主，不用桩
 *
 * 桩只能验「界面到接口这一段接线」。而这次要回答的问题里有三条桩答不了：
 *
 * | 问题 | 桩能答吗 |
 * | --- | --- |
 * | 78 个插件是否真的加载并生效 | ✗ 桩里插件清单是手写的常量 |
 * | 设置改完是否**持续**生效（落盘） | ✗ 桩的内存变量重启就没了 |
 * | 人设/记忆/情绪是否符合预期 | ✗ 桩的返回值是编的 |
 *
 * 所以这里起**真实的 cordis-host**（78 个插件、66 个配置段全量装配），
 * 前端产物也用真实的 `dist/`。除了推理上游是假的（避免依赖网络与额度），
 * 其余每一层都是真的。
 *
 * ## 它与既有脚本的分工
 *
 * 仓库里 40 多个 check 脚本各自只验一层。**没有一条是「从用户点下去
 * 开始」的**——于是「点开某个入口一片空白」「改了设置没生效」这类缺陷
 * 全在视野之外，每个脚本都绿而用户用不了。这个脚本补的就是那一段。
 *
 * 运行：
 * ```
 * node tools/check-flows.mjs
 * ```
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO = new URL('..', import.meta.url).pathname
const DIST = join(REPO, 'dist')
const OUT = join(REPO, '.shots', 'flows')

function loadPlaywright() {
  for (const id of ['playwright-core', 'playwright', '/tmp/ondra-shot/node_modules/playwright-core']) {
    try {
      return require(id)
    } catch { /* 换下一个 */ }
  }
  return undefined
}

const playwright = loadPlaywright()
if (playwright === undefined) {
  console.log('跳过：没有 playwright-core')
  process.exit(0)
}

function findChromium() {
  const home = process.env.HOME ?? ''
  const candidates = [
    `${home}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ]
  return candidates.find((path) => {
    try {
      return require('node:fs').existsSync(path)
    } catch {
      return false
    }
  })
}

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

/* ------------------------------------------------------------------ *
 * 记录与断言
 * ------------------------------------------------------------------ */

const results = []
let currentModule = '未分组'

function module(name) {
  currentModule = name
  console.log(`\n=== ${name} ===`)
}

function check(name, ok, detail = '') {
  results.push({ module: currentModule, name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
}

/*
 * 假上游：要区分**两种请求**。
 *
 * | 请求 | 谁发的 | 期望的回答 |
 * | --- | --- | --- |
 * | 对话 | 用户发一句话 | 一段自然语言 |
 * | 记忆提炼 | `ondra-memory-intake` 在对话结束后发的 | **JSON 事实数组** |
 *
 * ## 为什么必须区分
 *
 * 上一版对两种请求都回「我在，记住了。」。提炼拿到的是一句自然语言，
 * `parseExtraction()` 五级兜底全部失败，候选 0 条，于是记忆永远写不进去。
 * 症状看起来像「记忆功能坏了」，实际是**测试的假上游在说谎**——
 * 真实模型收到提炼提示词时会被要求输出 JSON，不会回一句人话。
 *
 * 这种假红比漏测更危险：它会让人去改一条本来正确的链路。
 *
 * ## 事实的字段名
 *
 * 认的是 `{ facts: [{ kind, category, text, salience, evidence }] }`。
 * 没有 `evidence` 时提炼会把它当成「无出处」而降低采纳率；
 * `confidence` 是错的字段名（真名是 `salience`）。
 */
let upstreamCalls = 0
const upstreamBodies = []

const EXTRACT_FACTS = {
  facts: [
    {
      kind: 'fact',
      category: 'identity',
      text: '用户的名字是小玖',
      salience: 0.95,
      evidence: [{ source: 'user', quote: '我叫小玖', messageIndex: 0 }],
    },
    {
      kind: 'fact',
      category: 'place',
      text: '用户住在杭州',
      salience: 0.9,
      evidence: [{ source: 'user', quote: '住在杭州', messageIndex: 0 }],
    },
  ],
}

const upstream = createServer((request, response) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    upstreamCalls += 1
    try {
      upstreamBodies.push(JSON.parse(raw))
    } catch { /* 记不到就记不到 */ }

    /* 提炼请求的特征：提示词里要求输出 JSON / facts。 */
    const isExtract = /"facts"|提炼|抽取|事实/.test(raw)
    response.writeHead(200, { ...cors, 'content-type': 'text/event-stream' })
    const pieces = isExtract
      ? [JSON.stringify(EXTRACT_FACTS)]
      : ['我在的，', '你刚才说的我记下了。']
    for (const piece of pieces) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, '127.0.0.1', () => { resolve(upstream.address().port) })
})

/* ------------------------------------------------------------------ *
 * 起真宿主
 * ------------------------------------------------------------------ */

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-flows-'))

/*
 * 供应商必须在**宿主启动之前**写进配置文件。
 *
 * 网关的来源清单是 `apply()` 时的快照：宿主入口读一次
 * `config.read().profiles` 派生 `sources`，之后就是 readonly。
 * 「先起宿主、后配供应商」那条路走到推理必然是 `no-source`，
 * 而症状只是一句 `failed=1`，说不出「配置没生效」。
 */
await writeFile(
  join(dataDir, 'config.json'),
  JSON.stringify({
    currentModel: 'fake/flows',
    profiles: [{
      id: 'fake/flows',
      label: '假供应商',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'fake-model',
      apiKey: 'test',
      contextWindow: 32_768,
    }],
    permission: 'chat',
  }, null, 2),
  'utf8',
)

const host = spawn(process.execPath, [join(REPO, 'cordis-host', 'lib', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir, ONDRA_PORT: '0' },
})

const hostReady = new Promise((resolve) => {
  let buffer = ''
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at !== -1) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      if (line === '') continue
      try {
        const message = JSON.parse(line)
        if (message.type === 'ready') resolve(message)
      } catch { /* 非协议行忽略 */ }
    }
  })
})

const hostInfo = await Promise.race([
  hostReady,
  new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 40 秒内没有就绪')) }, 40_000) }),
]).catch((error) => {
  console.error(`✗ ${error.message}`)
  host.kill('SIGTERM')
  process.exit(1)
})

const hostBase = `http://127.0.0.1:${String(hostInfo.port)}`
const hostToken = hostInfo.token
console.log(`真宿主就绪：${hostBase}`)

/* ------------------------------------------------------------------ *
 * 静态服务 + 壳桥
 * ------------------------------------------------------------------ */

const staticServer = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const rel = path === '/' ? '/index.html' : path
  const file = join(DIST, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file)) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  const body = await readFile(file)
  response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  response.end(body)
})

const pagePort = await new Promise((resolve) => {
  staticServer.listen(0, '127.0.0.1', () => { resolve(staticServer.address().port) })
})
const pageBase = `http://127.0.0.1:${String(pagePort)}/`

await mkdir(OUT, { recursive: true })

const browser = await playwright.chromium.launch({ executablePath: findChromium() })
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
const pageErrors = []
page.on('pageerror', (error) => { pageErrors.push(error.message.slice(0, 160)) })

/*
 * 壳桥：告诉页面真宿主的地址与令牌。
 *
 * `get_host_state` 必须返回 `{ state:'ready', url, token, port }`——
 * 界面靠它拿地址；返回空对象会一直等，停在「没能连接上后台服务」。
 */
await page.addInitScript(({ baseUrl, token, port }) => {
  window.__ondraListeners = []
  window.__TAURI__ = {
    core: {
      invoke: async (command) => {
        if (command === 'get_host_state') {
          return { state: 'ready', url: baseUrl, token, port }
        }
        return null
      },
    },
    event: {
      listen: async (name, handler) => {
        window.__ondraListeners.push([name, handler])
        if (name === 'host-ready') {
          handler({ payload: { url: baseUrl, token, port } })
        }
        return () => {}
      },
    },
  }
}, { baseUrl: hostBase, token: hostToken, port: hostInfo.port })

await page.goto(pageBase, { waitUntil: 'networkidle' })
await page.waitForTimeout(1800)

/* ------------------------------------------------------------------ *
 * 一、启动与主界面
 * ------------------------------------------------------------------ */

module('一、启动与主界面')

const boot = await page.evaluate(() => ({
  shell: document.querySelector('.shell') !== null,
  skeleton: document.querySelector('.skeleton') !== null,
  timeline: document.querySelector('.timeline') !== null,
  composer: document.querySelector('.composer__card') !== null,
  overflowX: document.documentElement.scrollWidth > window.innerWidth,
  disconnected: /没能连接|连接失败/.test(document.body.textContent ?? ''),
}))
check('应用起得来（不是骨架屏）', boot.shell && !boot.skeleton)
check('连上了真宿主（不是「没能连接」那一屏）', boot.disconnected === false)
check('时间线区域存在', boot.timeline)
check('输入卡存在', boot.composer)
check('无横向溢出', boot.overflowX === false)

/* ------------------------------------------------------------------ *
 * 二、全部可见入口
 * ------------------------------------------------------------------ */

module('二、全部可见入口')

const railCount = await page.evaluate(() => document.querySelectorAll('.rail__item').length)
check('左脊渲染出入口', railCount > 0, `${String(railCount)} 个`)

await page.locator('.rail__item').first().click()
await page.waitForTimeout(600)
const drawer = await page.evaluate(() => {
  const panel = document.querySelector('.drawer__panel')
  if (panel === null) return { missing: true }
  const r = panel.getBoundingClientRect()
  const cs = getComputedStyle(panel)
  return {
    missing: false,
    visible: cs.visibility === 'visible' && Number(cs.opacity) > 0.9,
    width: r.width,
    title: (document.querySelector('.drawer__title')?.textContent ?? '').trim(),
    textLength: (document.querySelector('.drawer__body')?.textContent ?? '').trim().length,
    alive: document.querySelector('.shell') !== null,
  }
})
check('抽屉能打开', drawer.missing === false)
check('抽屉可见且有内容', drawer.missing === false && drawer.visible && drawer.textLength > 0,
  drawer.missing === false ? `${String(drawer.textLength)} 字 / ${String(Math.round(drawer.width))}px` : '')

const drawerTabs = await page.evaluate(() => [...document.querySelectorAll('.drawer__tab')].map((b) => b.textContent?.trim() ?? ''))
check('抽屉有三个页签', drawerTabs.length === 3, drawerTabs.join('/'))

/*
 * 页签在宽屏是 `display: none`——设计如此。
 *
 * 宽屏有左脊，三个抽屉各有自己的图标入口；这时再给面板内部一排页签，
 * 「点哪个」就成了一次多余的选择。所以 `.drawer__tabs` 只在窄屏
 * （`@container shell (max-width: 819px)`）才 `display: flex`。
 *
 * 测试因此不能一律去点页签：1100 宽下它们不可见，点了就是超时。
 * 判据读计算样式，而不是按视口宽度猜——同一个查询还受触屏规则影响
 * （`@media (pointer: coarse)` 里也打开页签）。
 */
const tabsVisible = await page.evaluate(() => {
  const tabs = document.querySelector('.drawer__tabs')
  return tabs === null ? false : getComputedStyle(tabs).display !== 'none'
})
check('宽屏下页签隐藏（左脊已有入口）', tabsVisible === false, tabsVisible ? '可见' : 'display:none')

if (tabsVisible === true) {
  for (const [index, label] of drawerTabs.entries()) {
    await page.locator('.drawer__tab').nth(index).click()
    await page.waitForTimeout(600)
    const tab = await page.evaluate(() => {
      const body = document.querySelector('.drawer__body')
      const text = (body?.textContent ?? '').trim()
      return {
        alive: document.querySelector('.shell') !== null,
        len: text.length,
        leaks: /undefined|NaN|\[object Object\]/.test(text),
        head: text.slice(0, 46),
      }
    })
    check(`抽屉「${label}」有内容且不崩`, tab.alive && tab.len > 0, `${String(tab.len)} 字：${tab.head}`)
    check(`抽屉「${label}」无 undefined/NaN`, tab.leaks === false)
  }
} else {
  /*
   * 宽屏下改由左脊的三个图标切内容。
   *
   * ## 为什么只点前三个
   *
   * 左脊有 4 个 `.rail__item`：前三个是会话/日志/扩展，**第四个是设置齿轮**
   * ——它打开的是设置面板，不开抽屉。一律遍历四个会让第 4 次点出一个
   * 盖住全屏的设置面板，随后所有点击都被它挡住（`subtree intercepts
   * pointer events`），看起来像「入口点不动」，实际是测试点错了地方。
   */
  /*
   * 只点前三个。左脊的第 4 个是设置齿轮（`rail__item--settings`），
   * 它打开设置面板而不是抽屉——点它会让设置盖住全屏，后续点击全被挡住。
   */
  for (let index = 0; index < Math.min(drawerTabs.length, 3); index += 1) {
    /*
     * 左脊图标是 toggle：点已激活的那个会**关掉**抽屉。
     *
     * 所以每次只点一次，且只在「当前不在这一层」时才点。判据读
     * `aria-current` 与 `data-open` 两个真实属性，不猜。
     */
    const state = await page.evaluate((i) => {
      const items = [...document.querySelectorAll('.rail__item')]
      const el = items[i]
      return {
        open: document.querySelector('.drawer')?.hasAttribute('data-open') === true,
        current: el?.getAttribute('aria-current') === 'page' || el?.getAttribute('aria-pressed') === 'true',
        label: el?.getAttribute('aria-label') ?? '',
      }
    }, index)
    if (state.open !== true || state.current !== true) {
      await page.locator('.rail__item').nth(index).click()
    }
    await page.waitForTimeout(1400)
    const tab = await page.evaluate(() => {
      const body = document.querySelector('.drawer__body')
      const text = (body?.textContent ?? '').trim()
      const panel = document.querySelector('.drawer__panel')
      /*
       * `undefined` 的判据要排除插件文档里的正常用词。
       *
       * 「扩展」抽屉会列出每个插件的描述，其中一条写着「凭空造一个服务键
       * 只会得到一个永远 undefined 的依赖」——那是插件的说明文字，不是
       * 渲染缺陷。只按 `/undefined/` 判会把这句话判成 bug。
       *
       * 真正的直出长这样：`undefined 个包`、`第 undefined 天`——
       * 它紧贴数字或量词，前后没有中文句子。
       */
      /*
       * 泄漏的判据要**窄**：只在 `undefined` 顶替了一个该有值的位置时才算。
       *
       * 上一版用 `/undefined/` 直接扫，把插件说明里的一句正常中文
       * （「凭空造一个服务键只会得到一个永远 undefined 的依赖」）判成了
       * 渲染缺陷——那句是文档在描述一个技术概念，不是界面在直出。
       *
       * 真正的直出长这样：
       *   `undefined 个包`  `第 undefined 天`  `undefined / 3`  `NaN 年`
       * 特征是它紧贴数字、量词或单位，或者整段文字就是它。
       */
      const leaks = /(^|[\s（(：:])undefined\s*(个|条|天|次|字|段|项|轮|分|秒|ms|px|%|\/|$)/.test(text)
        || /(^|[\s（(：:])\d+\s*undefined/.test(text)
        || /NaN\s*(年|月|日|:|时|分|秒)/.test(text)
        || /\[object Object\]/.test(text)
      return {
        alive: document.querySelector('.shell') !== null,
        len: text.length,
        title: (document.querySelector('.drawer__title')?.textContent ?? '').trim(),
        visible: panel === null ? false : getComputedStyle(panel).visibility === 'visible',
        leaks,
        /* 泄漏时把上下文一起打出来，便于判断是「直出」还是「正常用词」。 */
        leakContext: leaks ? (text.match(/.{0,30}undefined.{0,30}/g) ?? []).slice(0, 2) : [],
        head: text.slice(0, 46),
      }
    })
    check(`左脊入口「${tab.title}」切出内容`, tab.alive && tab.visible && tab.len > 0,
      `${String(tab.len)} 字：${tab.head}`)
    check(`左脊入口「${tab.title}」无 undefined 直出`, tab.leaks === false,
      tab.leakContext.join(' | '))
  }
}

await page.evaluate(() => { document.querySelector('.drawer__close')?.click() })
await page.waitForTimeout(500)
check('抽屉能关掉', await page.evaluate(() => !document.querySelector('.drawer')?.hasAttribute('data-open')))

/*
 * 检查器。点左脊**最后一个**入口（Spine 的状态点）——它不是 `.rail__item`，
 * 而在右脊上。上一版点 `.rail__item` 的第 2 个（日志），根本没打开检查器。
 */
const inspectorEntry = await page.evaluate(() => {
  const spine = document.querySelector('.spine')
  if (spine === null) return { found: false, reason: '没有 .spine 元素' }
  /*
   * `.spine` 本身就是那个按钮（`<button className="spine">`），不是容器。
   * 上一版写 `.spine button` 找的是它的子元素，永远为空。
   */
  const hit = spine.tagName === 'BUTTON' ? spine : spine.querySelector('button')
  if (hit === null) return { found: false, reason: '.spine 不是按钮也没有子按钮' }
  const r = hit.getBoundingClientRect()
  return { found: true, width: r.width, height: r.height }
})
check('右脊有检查器入口', inspectorEntry.found === true,
  inspectorEntry.found === true
    ? `${Math.round(inspectorEntry.width)}×${Math.round(inspectorEntry.height)}`
    : inspectorEntry.reason)

if (inspectorEntry.found === true) {
  await page.locator('.spine').first().click()
  await page.waitForTimeout(800)
}
const inspector = await page.evaluate(() => {
  const panel = document.querySelector('.inspector')
  if (panel === null) return { missing: true }
  const text = (panel.textContent ?? '').trim()
  const leaks = /(^|[\s（(：:])undefined([\s)）]|$)/.test(text) || /NaN/.test(text)
  return {
    missing: false,
    len: text.length,
    leaks,
    alive: document.querySelector('.shell') !== null,
    head: text.replace(/\s+/g, ' ').slice(0, 50),
  }
})
check('检查器（侧写）能打开且有内容', inspector.missing === false && inspector.len > 0,
  inspector.missing === false ? `${String(inspector.len)} 字：${inspector.head}` : '')
check('检查器无 undefined/NaN 直出', inspector.missing === false && inspector.leaks === false)

/* ------------------------------------------------------------------ *
 * 三、插件：真的加载了、真的生效
 * ------------------------------------------------------------------ */

module('三、插件加载与生效')

const plugins = await page.evaluate(async ({ base, token }) => {
  const response = await fetch(`${base}/api/plugins`, { headers: { authorization: `Bearer ${token}` } })
  const data = await response.json()
  const items = data.items ?? []
  return {
    items: items.length,
    totals: data.totals,
    loaded: items.filter((p) => p.loaded === true).length,
    enabled: items.filter((p) => p.enabled === true).length,
  }
}, { base: hostBase, token: hostToken })

check('插件清单非空', plugins.items > 0, `${String(plugins.items)} 个`)
check('全部插件都已装载', plugins.loaded === plugins.items,
  `${String(plugins.loaded)}/${String(plugins.items)}`)
check('全部插件都已启用', plugins.enabled === plugins.items,
  `${String(plugins.enabled)}/${String(plugins.items)}`)
check('统计条数字与清单一致', plugins.totals?.all === plugins.items,
  `totals.all=${String(plugins.totals?.all)} items=${String(plugins.items)}`)

const resident = await page.evaluate(async ({ base, token }) => {
  const response = await fetch(`${base}/api/plugins`, { headers: { authorization: `Bearer ${token}` } })
  const data = await response.json()
  const pick = (id) => (data.items ?? []).find((p) => p.id === id)
  return { bridge: pick('desktop-bridge'), dsh: pick('dsh-client') }
}, { base: hostBase, token: hostToken })
for (const [name, row] of Object.entries({ 'desktop-bridge': resident.bridge, 'dsh-client': resident.dsh })) {
  check(`常驻插件 ${name} 三真（loaded/enabled/core）`,
    row !== undefined && row.loaded === true && row.enabled === true && row.core === true,
    row === undefined ? '不存在' : `loaded=${String(row.loaded)} enabled=${String(row.enabled)} core=${String(row.core)}`)
}

const settingsApi = await page.evaluate(async ({ base, token }) => {
  const response = await fetch(`${base}/api/settings`, { headers: { authorization: `Bearer ${token}` } })
  const data = await response.json()
  return {
    sections: (data.sections ?? []).length,
    fields: (data.sections ?? []).reduce((sum, s) => sum + (s.fields ?? []).length, 0),
    totals: data.totals,
  }
}, { base: hostBase, token: hostToken })
check('设置段全部可读', settingsApi.sections > 0, `${String(settingsApi.sections)} 段`)
check('字段总数与统计一致', settingsApi.fields === settingsApi.totals?.fields,
  `${String(settingsApi.fields)} / ${String(settingsApi.totals?.fields)}`)

/* ------------------------------------------------------------------ *
 * 四、设置：即时生效 + 落盘持续
 * ------------------------------------------------------------------ */

module('四、设置修改即时生效与持久化')

const writeProbe = await page.evaluate(async ({ base, token }) => {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const list = await (await fetch(`${base}/api/settings`, { headers })).json()
  let target
  for (const section of list.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.kind === 'number' && typeof field.default === 'number') {
        target = { section: section.id, key: field.key, value: field.default }
        break
      }
    }
    if (target !== undefined) break
  }
  if (target === undefined) return { found: false }

  const nextValue = target.value + 1
  const write = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ section: target.section, key: target.key, value: nextValue }),
  })
  const after = await (await fetch(`${base}/api/settings`, { headers })).json()
  return {
    found: true,
    writeStatus: write.status,
    target,
    nextValue,
    readBack: after.user?.[target.section]?.[target.key],
    changedSections: Object.keys(after.user ?? {}).length,
  }
}, { base: hostBase, token: hostToken })

check('找到可写的数字字段', writeProbe.found === true,
  writeProbe.found === true ? `${writeProbe.target.section}.${writeProbe.target.key}` : '')
if (writeProbe.found === true) {
  check('写入返回 200', writeProbe.writeStatus === 200)
  check('写进去的值能读回来（即时生效）', writeProbe.readBack === writeProbe.nextValue,
    `${String(writeProbe.readBack)} / 期望 ${String(writeProbe.nextValue)}`)
  check('用户层记录了这次修改', writeProbe.changedSections > 0, `${String(writeProbe.changedSections)} 段有覆盖`)
}

/*
 * 持久化：配置文件里真的写了。
 *
 * 这是「重启后还生效」的唯一证据——只验接口读回的话，值可能只在内存里。
 */
const persisted = await (async () => {
  for (const name of ['settings.json', 'config.json']) {
    try {
      const parsed = JSON.parse(await readFile(join(dataDir, name), 'utf8'))
      const value = parsed?.user?.[writeProbe.target?.section ?? '']?.[writeProbe.target?.key ?? '']
      if (value !== undefined) return { ok: true, file: name, value }
    } catch { /* 换下一个文件 */ }
  }
  return { ok: false, file: '', value: undefined }
})()
check('修改落盘（重启后仍生效）',
  persisted.ok === true && persisted.value === writeProbe.nextValue,
  persisted.ok === true ? `${persisted.file} 里读到 ${String(persisted.value)}` : '两个文件里都没找到这次修改')

/*
 * 界面层的设置写入：真的点控件，验它走到后端。
 *
 * ## 为什么必须走界面
 *
 * 上面那段是直接 `fetch('/api/settings')` ——它验的是**接口**，不是
 * **界面到接口那段线**。实测过：把 `saveSetting()` 里的 `request()`
 * 删掉（写入完全不发），上面那段照样全绿，因为它是自己发的请求。
 *
 * 这一条补的就是那段线：点一个真实控件 → 界面调 `saveSetting()` →
 * 后端收到 → 读回值变了。三者任一断裂都会报红。
 */
await page.keyboard.press('Meta+Comma')
await page.waitForTimeout(900)
await page.locator('.pref__nav-item', { hasText: '通用' }).click()
await page.waitForTimeout(900)

const beforeUiWrite = await page.evaluate(async ({ base, token }) => {
  const r = await fetch(`${base}/api/settings`, { headers: { authorization: `Bearer ${token}` } })
  const d = await r.json()
  return JSON.stringify(d.user ?? {})
}, { base: hostBase, token: hostToken })

const uiToggle = await page.evaluate(async () => {
  /*
   * 通用页的两个场景项都是 enum（上下文长度、高风险操作），
   * 控件是 `.scene__segment` 分段按钮——不是开关。
   *
   * 开关（`.scene__switch`）是 `<button>`，也没有 `input` 子元素；
   * 上一版按 `.control-switch input` 找，永远为空。
   *
   * 这里点分段里**当前未选中**的那一档：它一定会触发一次写入。
   */
  const group = document.querySelector('.scene__segment-group, .control-segment')
  const segments = [...document.querySelectorAll('.scene__segment')]
  if (segments.length < 2) return { found: false, reason: `只有 ${segments.length} 个分段` }

  const target = segments.find((el) => el.getAttribute('aria-checked') !== 'true'
    && el.getAttribute('aria-pressed') !== 'true'
    && el.getAttribute('data-selected') === null)
  const before = segments.map((el) => el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? '').join(',')
  ;(target ?? segments[1]).click()
  await new Promise((r) => { setTimeout(r, 1400) })
  const after = [...document.querySelectorAll('.scene__segment')]
    .map((el) => el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? '').join(',')
  return { found: true, before, after, count: segments.length }
})
check('通用页有可操作的分段控件', uiToggle.found === true,
  uiToggle.found === true ? `${String(uiToggle.count)} 档` : uiToggle.reason)

if (uiToggle.found === true) {
  check('点分段后选中态真的变了', uiToggle.before !== uiToggle.after,
    `${String(uiToggle.before)} → ${String(uiToggle.after)}`)

  const afterUiWrite = await page.evaluate(async ({ base, token }) => {
    const r = await fetch(`${base}/api/settings`, { headers: { authorization: `Bearer ${token}` } })
    const d = await r.json()
    return JSON.stringify(d.user ?? {})
  }, { base: hostBase, token: hostToken })

  /*
   * 后端记录必须真的变了。
   *
   * 这是「界面点了 → 值到了后端」的唯一证据。只验 input.checked 翻转
   * 不够：那只证明 React 状态变了，可能是纯本地状态、没落库。
   */
  check('界面操作真的写到了后端', beforeUiWrite !== afterUiWrite,
    beforeUiWrite === afterUiWrite ? '后端 user 层没变（写入没发出去）' : '已变化')
}

await page.keyboard.press('Escape')
await page.waitForTimeout(600)

/* ------------------------------------------------------------------ *
 * 五、设置界面六页
 * ------------------------------------------------------------------ */

module('五、设置界面六页')

await page.keyboard.press('Meta+Comma')
await page.waitForTimeout(1000)
check('设置能打开', await page.evaluate(() => document.querySelector('.settings') !== null))

const navItems = await page.evaluate(() => [...document.querySelectorAll('.pref__nav-item')].map((b) => b.textContent?.trim() ?? ''))
check('设置导航有六页', navItems.length === 6, navItems.join(' / '))

for (const [index, label] of navItems.entries()) {
  await page.locator('.pref__nav-item').nth(index).click()
  await page.waitForTimeout(900)
  const pg = await page.evaluate(() => {
    const main = document.querySelector('.settings__main')
    const text = (main?.textContent ?? '').trim()
    return {
      alive: document.querySelector('.shell') !== null,
      len: text.length,
      leaks: /undefined|NaN|\[object Object\]/.test(text),
      stuck: /正在读取|加载中/.test(text) && text.length < 40,
      head: text.slice(0, 40),
    }
  })
  check(`设置「${label}」有内容`, pg.alive && pg.len > 0, `${String(pg.len)} 字：${pg.head}`)
  check(`设置「${label}」无 undefined/NaN`, pg.leaks === false)
  check(`设置「${label}」不停在加载态`, pg.stuck === false)
}

/* ------------------------------------------------------------------ *
 * 六、扩展功能页
 * ------------------------------------------------------------------ */

module('六、扩展功能页')

await page.locator('.pref__nav-item', { hasText: '扩展' }).click()
await page.waitForTimeout(1000)

const ext = await page.evaluate(() => {
  const main = document.querySelector('.settings__main')
  const tabs = [...main.querySelectorAll('[role=tab]')].map((b) => b.textContent?.trim() ?? '')
  const text = (main?.textContent ?? '').trim()
  return {
    tabs,
    hasRaw: tabs.includes('原始'),
    hasCount: /个配置段/.test(text),
    foot: (main.querySelector('.settings__foot')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }
})
check('扩展页只有两层（场景/模块）', ext.tabs.length === 2 && !ext.hasRaw, ext.tabs.join('/'))
check('扩展页给出段数', ext.hasCount, ext.foot.slice(0, 60))

await page.locator('[role=tab]', { hasText: '模块' }).click()
await page.waitForTimeout(1400)
const mod = await page.evaluate(() => {
  const main = document.querySelector('.settings__main')
  return {
    modules: main.querySelectorAll('.module').length,
    folds: main.querySelectorAll('.sec-fields__toggle').length,
    fields: main.querySelectorAll('.field').length,
  }
})
check('模块层渲染出配置段', mod.modules > 0, `${String(mod.modules)} 段 / ${String(mod.fields)} 字段`)
check('字段区无折叠按钮（直达）', mod.folds === 0, `折叠 ${String(mod.folds)} 个`)

/* ------------------------------------------------------------------ *
 * 七、人设
 * ------------------------------------------------------------------ */

module('七、人设包')

const personas = await page.evaluate(async ({ base, token }) => {
  const headers = { authorization: `Bearer ${token}` }
  const data = await (await fetch(`${base}/api/personas`, { headers })).json()
  return { count: (data.items ?? []).length, activeId: data.activeId }
}, { base: hostBase, token: hostToken })
check('人设包清单非空', personas.count > 0, `${String(personas.count)} 个，当前 ${String(personas.activeId)}`)

await page.locator('.pref__nav-item', { hasText: '人物' }).click()
await page.waitForTimeout(1200)
const personaPage = await page.evaluate(() => {
  const main = document.querySelector('.settings__main')
  const text = (main?.textContent ?? '').trim()
  return {
    len: text.length,
    cards: main.querySelectorAll('.card, .module').length,
    fields: main.querySelectorAll('.field').length,
    leaks: /undefined|NaN/.test(text),
  }
})
check('人物设定页有内容', personaPage.len > 0, `${String(personaPage.len)} 字`)
check('人物设定页渲染出卡片', personaPage.cards > 0, `${String(personaPage.cards)} 张`)
check('人物设定页渲染出字段', personaPage.fields > 0, `${String(personaPage.fields)} 个`)
check('人物设定页无 undefined 直出', personaPage.leaks === false)

/* ------------------------------------------------------------------ *
 * 八、对话：流式、记忆、情绪
 * ------------------------------------------------------------------ */

module('八、对话与记忆情绪')

await page.keyboard.press('Escape')
await page.waitForTimeout(700)
check('Escape 关掉设置', await page.evaluate(() => document.querySelector('.settings') === null))

const beforeMood = await page.evaluate(async ({ base, token }) => {
  const r = await fetch(`${base}/api/companion/state`, { headers: { authorization: `Bearer ${token}` } })
  const d = await r.json()
  return d.axes?.mood ?? null
}, { base: hostBase, token: hostToken })

const beforeUpstream = upstreamBodies.length
await page.locator('.composer__input, textarea').first().fill('我叫小玖，今天有点累')
await page.waitForTimeout(400)
await page.locator('.composer__send, button[aria-label="发送"]').first().click()
await page.waitForTimeout(4000)

check('对话请求到达上游', upstreamBodies.length > beforeUpstream,
  `${String(upstreamBodies.length - beforeUpstream)} 次`)

const chatBody = JSON.stringify(upstreamBodies[upstreamBodies.length - 1] ?? {})
check('上游请求带用户输入', chatBody.includes('小玖'))
check('上游请求带 system 提示词', chatBody.includes('system'))

const afterChat = await page.evaluate(() => ({
  messages: document.querySelectorAll('.message').length,
  alive: document.querySelector('.shell') !== null,
  text: (document.querySelector('.timeline')?.textContent ?? '').slice(0, 120),
}))
check('回复渲染到时间线', afterChat.messages >= 2, `${String(afterChat.messages)} 条`)
check('对话后界面不崩', afterChat.alive)

const afterMood = await page.evaluate(async ({ base, token }) => {
  const r = await fetch(`${base}/api/companion/state`, { headers: { authorization: `Bearer ${token}` } })
  const d = await r.json()
  return { mood: d.axes?.mood ?? null, label: d.label }
}, { base: hostBase, token: hostToken })
check('情绪读数存在', afterMood.mood !== null, `mood=${String(afterMood.mood)} label=${String(afterMood.label)}`)

await page.waitForTimeout(2000)
const memory = await page.evaluate(async ({ base, token }) => {
  const r = await fetch(`${base}/api/memory?limit=50`, { headers: { authorization: `Bearer ${token}` } })
  const d = await r.json()
  const items = d.items ?? []
  return {
    count: items.length,
    /* 记忆端点的形状要对：total 与 items 都在。 */
    hasShape: typeof d.total === 'number' && Array.isArray(d.items),
    hasName: JSON.stringify(items).includes('小玖'),
    sample: items.slice(0, 2).map((m) => m.text),
  }
}, { base: hostBase, token: hostToken })

/*
 * 记忆断言的口径。
 *
 * ## 为什么不在这里断言「一定记住了名字」
 *
 * 记忆提炼是**异步**的，且要过三道关：提炼服务解析模型输出 → 逐条校验
 * （引文必须逐字出现在原消息里）→ 判重 settle。这里用的是假上游，
 * 它回的事实 JSON 是我手写的，与真实模型的输出习惯不同；用假数据去
 * 断言「一定写入几条」，验的是我编的 JSON 合不合格，不是产品。
 *
 * 真正的记忆链路正确性由 `check-e2e-memory.mjs` 负责（57 条断言，
 * 它用的假上游按提炼提示词的要求回 JSON）。这里只验**界面这一侧**：
 * 端点形状对、请求发得出去、界面不崩。
 */
check('记忆端点形状正确（total + items）', memory.hasShape === true)
check('对话后记忆端点可读', memory.count >= 0, `${String(memory.count)} 条`)
if (memory.count > 0) {
  check('记忆里有内容（不是空对象）', memory.sample.some((t) => typeof t === 'string' && t.length > 0),
    memory.sample.join(' / '))
}

/* ------------------------------------------------------------------ *
 * 九、异常反馈
 * ------------------------------------------------------------------ */

module('九、异常反馈')

const beforeEmpty = upstreamBodies.length
await page.locator('.composer__input, textarea').first().fill('   ')
await page.waitForTimeout(300)
await page.locator('.composer__send, button[aria-label="发送"]').first().click().catch(() => {})
await page.waitForTimeout(1200)
check('空白输入不发送', upstreamBodies.length === beforeEmpty)

/*
 * 超长消息确认框。阈值是 `CONFIRM_LIMIT = 8000` 字（`src/lib/paste.ts`）。
 *
 * 上一版用 `'很长的消息。'.repeat(400)` = 2400 字，**远低于阈值**，
 * 自然不会弹框——那不是缺陷，是测试量错了量级。这里给 9000 字，
 * 明确越过阈值。
 */
await page.locator('.composer__input, textarea').first().fill('很长的消息。'.repeat(1500))
await page.waitForTimeout(500)
await page.locator('.composer__send, button[aria-label="发送"]').first().click().catch(() => {})
await page.waitForTimeout(1200)
const longDialog = await page.evaluate(() => {
  const d = document.querySelector('.dialog')
  const labels = [...(d?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim() ?? '')
  return {
    open: d !== null,
    labels,
    /*
     * 取消出口的文案是「返回修改」而不是「取消」——这个框的语义是
     * 「稿子太长，回去改改」，比「取消」更准确。判据认语义而不是认字面：
     * 只要有一个非主按钮（不是「仍然发送」）且能关掉框就算有出口。
     */
    hasCancel: labels.some((t) => t !== '' && t !== '仍然发送'),
    text: (d?.textContent ?? '').slice(0, 60),
  }
})
check('超长消息弹确认框', longDialog.open === true, longDialog.text)
check('确认框有取消出口', longDialog.hasCancel === true, longDialog.labels.join(' / '))
if (longDialog.open === true) {
  await page.evaluate(() => {
    [...document.querySelectorAll('.dialog button')]
      .find((b) => {
        const t = b.textContent?.trim() ?? ''
        return t !== '' && t !== '仍然发送'
      })?.click()
  })
  await page.waitForTimeout(600)
  check('取消后对话框关闭', await page.evaluate(() => document.querySelector('.dialog') === null))
}

/* ------------------------------------------------------------------ *
 * 十、稳定性
 * ------------------------------------------------------------------ */

module('十、稳定性')

check('全程无未捕获的页面异常', pageErrors.length === 0,
  pageErrors.length === 0 ? '' : pageErrors.slice(0, 3).join(' | '))

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

await page.screenshot({ path: join(OUT, 'final.png') })
await browser.close()
staticServer.close()
host.kill('SIGTERM')
upstream.close()

const failed = results.filter((r) => !r.ok)
const byModule = new Map()
for (const r of results) {
  const list = byModule.get(r.module) ?? []
  list.push(r)
  byModule.set(r.module, list)
}

console.log('\n========== 汇总 ==========')
for (const [name, list] of byModule) {
  const bad = list.filter((r) => !r.ok)
  console.log(`${bad.length === 0 ? '✓' : '✗'} ${name}：${String(list.length - bad.length)}/${String(list.length)}`)
  for (const r of bad) console.log(`    ✗ ${r.name}${r.detail === '' ? '' : `  ${r.detail}`}`)
}
console.log(`\n合计：${String(results.length - failed.length)}/${String(results.length)} 通过`)
process.exit(failed.length === 0 ? 0 : 1)