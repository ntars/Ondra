/**
 * 手机端（本地模式）的端到端检查。
 *
 * ## 它验什么
 *
 * 手机端没有 Node 宿主，全部逻辑跑在 WebView 里（`src/lib/local/`）。
 * 这条脚本验三件用户能感觉到的事：
 *
 * 1. **界面起得来**——不是白屏、不卡在骨架屏；
 * 2. **话能说通**——发出去、模型回了、两条都落在时间线上；
 * 3. **核心没丢**——记忆真的记住了、情绪真的变了、两者都进了下一轮的
 *    提示词。
 *
 * ## 为什么不用真实模型
 *
 * 起一个假上游（SSE，固定回两段）。真模型会引入网络、额度、模型版本
 * 三类不确定因素，而这里要验的是**接线**，不是模型能力。
 *
 * ## 为什么必须验「第二轮」的提示词
 *
 * 第一轮的提示词里本来就没有记忆（还没记）也没有情绪（还没推动）。
 * 只看第一轮的话，即使注入整段坏掉也发现不了——**判据必须落在
 * 「上一轮产生的东西，这一轮用上了」**。
 *
 * 运行：
 * ```
 * node tools/check-e2e-mobile.mjs
 * ```
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 找一个能用的 playwright-core。与 `check-ui.mjs` 同一套探测。 */
function loadPlaywright() {
  const candidates = [
    'playwright-core',
    'playwright',
  ]
  for (const id of candidates) {
    try {
      return require(id)
    } catch { /* 换下一个 */ }
  }
  try {
    return require('/tmp/ondra-shot/node_modules/playwright-core')
  } catch { /* 都没有 */ }
  return undefined
}

const playwright = loadPlaywright()
if (playwright === undefined) {
  console.log('跳过：没有 playwright-core（装一份再跑，见 check-ui.mjs 的说明）')
  process.exit(0)
}

/** 浏览器可执行文件。与 check-ui.mjs 同一套探测。 */
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

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * 假上游：SSE，固定回两段
 * ------------------------------------------------------------------ */

let upstreamCalls = 0
let lastBody

const upstream = createServer((request, response) => {
  /* CORS：浏览器直连不同端口的上游时必须给，否则请求发得出去、响应读不到。 */
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
      lastBody = JSON.parse(raw)
    } catch { /* 记不到就记不到，下面的断言会红 */ }
    response.writeHead(200, { ...cors, 'content-type': 'text/event-stream' })
    for (const piece of ['好，', '我记着了。']) {
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
 * 起一个手机端构建的 dev server
 * ------------------------------------------------------------------ */

const vite = spawn(
  'npx',
  ['vite', '--port', '5288', '--strictPort'],
  {
    cwd: new URL('../src/', import.meta.url).pathname,
    env: { ...process.env, ONDRA_LOCAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

/** 等 dev server 起来。最多 20 秒。 */
const ready = await new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(false) }, 20000)
  vite.stdout.setEncoding('utf8')
  vite.stdout.on('data', (chunk) => {
    if (chunk.includes('ready in') || chunk.includes('Local:')) {
      clearTimeout(timer)
      setTimeout(() => { resolve(true) }, 600)
    }
  })
})

if (!ready) {
  console.log('✗ dev server 没起来')
  vite.kill('SIGTERM')
  upstream.close()
  process.exit(1)
}

const browser = await playwright.chromium.launch({
  executablePath: findChromium(),
})
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

const pageErrors = []
page.on('pageerror', (error) => { pageErrors.push(error.message.slice(0, 160)) })

await page.goto('http://localhost:5288/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2600)

/* ---------------------------------------------------------------- *
 * 1. 界面起得来
 * ---------------------------------------------------------------- */

const boot = await page.evaluate(() => ({
  empty: document.querySelector('.timeline__empty') !== null,
  composer: document.querySelector('.composer__card') !== null,
  skeleton: document.querySelector('.skeleton') !== null,
  cardWidth: Math.round(document.querySelector('.composer__card')?.getBoundingClientRect().width ?? 0),
  overflowX: document.documentElement.scrollWidth > window.innerWidth,
  winWidth: window.innerWidth,
}))
check('界面不再是骨架屏', boot.skeleton === false)
check('空态正常显示', boot.empty === true)
check('输入卡渲染出来', boot.composer === true, `${String(boot.cardWidth)}px 宽`)
check('手机宽度下无横向溢出', boot.overflowX === false, `视口 ${String(boot.winWidth)}px`)
check(
  '输入卡随屏宽自适应（不是写死 560）',
  boot.cardWidth > 300 && boot.cardWidth < boot.winWidth,
  `${String(boot.cardWidth)} < ${String(boot.winWidth)}`,
)

/* ---------------------------------------------------------------- *
 * 2. 配模型（直接写本地库，绕过没有的设置页）
 * ---------------------------------------------------------------- */

await page.evaluate(async (port) => {
  const store = await import('/lib/local/store.ts')
  await store.dbPut('config', 'current', {
    currentModel: 'test',
    profiles: [{ id: 'test', label: '测试', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'x' }],
    permission: 'chat',
  })
}, upstreamPort)

/* ---------------------------------------------------------------- *
 * 3. 第一轮：说一句带名字、住址、情绪的话
 * ---------------------------------------------------------------- */

await page.locator('textarea').fill('我叫小玖，住在杭州。今天有点累。')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
await page.waitForTimeout(4200)

const firstRound = await page.evaluate(async () => {
  const memory = await import('/lib/local/memory.ts')
  const emotion = await import('/lib/local/emotion.ts')
  const facts = await memory.listFacts()
  const state = await emotion.loadState(Date.now())
  return {
    articles: document.querySelectorAll('article').length,
    timeline: (document.querySelector('.timeline')?.innerText ?? '').slice(0, 200),
    facts: facts.map((fact) => `${fact.category}:${fact.text}`),
    energy: Number(state.axes.energy.toFixed(1)),
    mood: Number(state.axes.mood.toFixed(2)),
  }
})

check('模型被调用一次', upstreamCalls === 1, `${String(upstreamCalls)} 次`)
check('时间线上有两轮消息（她说 + 她回）', firstRound.articles === 2, `${String(firstRound.articles)} 条`)
check('回复正文落进时间线', firstRound.timeline.includes('我记着了'))
check(
  '日期不是 Invalid Date（NaN 年 NaN 月）',
  !firstRound.timeline.includes('NaN'),
  firstRound.timeline.slice(0, 30),
)
check(
  '记住了名字',
  firstRound.facts.some((fact) => fact.includes('小玖')),
  firstRound.facts.join(' / '),
)
check(
  '记住了住址',
  firstRound.facts.some((fact) => fact.includes('杭州')),
  firstRound.facts.join(' / '),
)
check(
  '情绪被推动（energy 低于基线 60）',
  firstRound.energy < 56,
  `energy=${String(firstRound.energy)}`,
)
check(
  '心情被推动（mood 低于基线 0.5）',
  firstRound.mood < 0.49,
  `mood=${String(firstRound.mood)}`,
)

/* ---------------------------------------------------------------- *
 * 4. 第二轮：验「上一轮产生的东西，这一轮用上了」
 * ---------------------------------------------------------------- */

await page.locator('textarea').fill('我回来了。')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
await page.waitForTimeout(4200)

const systemText = (lastBody?.messages?.[0]?.content) ?? ''
check('第二轮请求带了 system 提示词', systemText.length > 0, `${String(systemText.length)} 字`)
check('提示词含人设段', systemText.includes('你是空谷'))
check('提示词含记忆段（上一轮记的进了这一轮）', systemText.includes('杭州') || systemText.includes('小玖'))
check('提示词含情绪段（上一轮推动的状态进了这一轮）', systemText.includes('你此刻的状态'))
check('提示词不含 undefined / NaN', !/undefined|NaN/.test(systemText))

/* ---------------------------------------------------------------- *
 * 5. 无未捕获错误
 * ---------------------------------------------------------------- */

check('没有未捕获的页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

await browser.close()
vite.kill('SIGTERM')
upstream.close()

const failed = checks.filter((item) => !item.ok)
console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} 通过`)
if (failed.length > 0) {
  console.log('未通过：')
  for (const item of failed) console.log(`  - ${item.name}  ${item.detail}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}