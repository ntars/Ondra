/**
 * 手机端抽屉诊断：点左上角汉堡之后到底发生了什么。
 *
 * ## 为什么要单开这一个
 *
 * `check-e2e-mobile.mjs` 验的是「界面起得来、话能说通、记忆情绪没丢」，
 * 它从头到尾没点过左上角那个入口。于是「点进去一片空白、退不回来」
 * 这类导航级缺陷完全落在它的视野之外——它全绿，而用户进不去抽屉。
 *
 * 这个脚本只做一件事：在 390×844 的视口里点开汉堡，量抽屉的真实矩形、
 * 可见性、内容节点数、以及能不能关掉。每一项都量真实 DOM，不读源码。
 *
 * 运行：
 * ```
 * node tools/check-mobile-drawer.mjs
 * ```
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * 起手机端 dev server
 * ------------------------------------------------------------------ */

const vite = spawn('npx', ['vite', '--port', '5289', '--strictPort'], {
  cwd: new URL('../src/', import.meta.url).pathname,
  env: { ...process.env, ONDRA_LOCAL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

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
  process.exit(1)
}

const browser = await playwright.chromium.launch({ executablePath: findChromium() })

/**
 * 逐个尺寸跑同一套检查。
 *
 * `hasTouch` 必须显式开：`pointer: coarse` 是「主指针是手指」，而
 * Chromium 默认给的是鼠标指针。不开这个，横屏那条规则（触屏强制手机形态）
 * 永远命中不了，测出来的结论会与真机相反。
 */
const SIZES = [
  { name: '390×844（iPhone 竖屏）', width: 390, height: 844, hasTouch: true },
  { name: '360×740（安卓小屏）', width: 360, height: 740, hasTouch: true },
  { name: '844×390（横屏）', width: 844, height: 390, hasTouch: true },
  { name: '768×1024（平板竖屏）', width: 768, height: 1024, hasTouch: true },
  { name: '320×568（最窄屏）', width: 320, height: 568, hasTouch: true },
]

const pageErrors = []

for (const size of SIZES) {
  console.log(`\n=== ${size.name} ===`)
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    hasTouch: size.hasTouch,
    isMobile: size.hasTouch,
  })
  page.on('pageerror', (error) => { pageErrors.push(`${size.name}: ${error.message.slice(0, 140)}`) })

  await page.goto('http://localhost:5289/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)

  /* 顶栏必须可见，汉堡必须可点——这是手机端唯一入口。 */
  const bar = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar')
    const titlebar = document.querySelector('.titlebar')
    /* 取**可见的**那个汉堡：DOM 里可能有两个（另一份被 CSS 藏起）。 */
    const hits = [...document.querySelectorAll('.topbar__hit')]
    const visibleHit = hits.find((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    const style = topbar === null ? undefined : getComputedStyle(topbar)
    return {
      hasTopbar: topbar !== null,
      topbarVisible: style !== undefined && style.display !== 'none',
      titlebarHidden: titlebar === null
        || getComputedStyle(titlebar).display === 'none',
      hitCount: hits.length,
      hitRect: visibleHit === undefined ? undefined : visibleHit.getBoundingClientRect().toJSON(),
    }
  })
  check('顶栏存在且可见', bar.hasTopbar && bar.topbarVisible)
  check('桌面标题栏已隐藏（两者不同时出现）', bar.titlebarHidden)
  check('左上角入口可点', bar.hitRect !== undefined
    && bar.hitRect.width >= 40 && bar.hitRect.height >= 40,
  bar.hitRect === undefined ? '找不到可见的汉堡' : `${Math.round(bar.hitRect.width)}×${Math.round(bar.hitRect.height)}`)

  if (bar.hitRect === undefined) {
    /* 入口都点不到，后面的检查没有意义，直接记失败并进入下一尺寸。 */
    check('抽屉已打开', false, '入口不可点，无法继续')
    await page.close()
    continue
  }

  /* 点汉堡。用可见的那个元素，避免 strict mode 命中隐藏副本。 */
  await page.locator('.topbar__hit').first().click()
  await page.waitForTimeout(500)

  const opened = await page.evaluate(() => {
    const drawer = document.querySelector('.drawer')
    const panel = document.querySelector('.drawer__panel')
    /* 整棵树是否还在——白屏最硬的判据。 */
    const shellAlive = document.querySelector('.shell') !== null
    if (drawer === null || panel === null) return { missing: true, shellAlive }
    const pr = panel.getBoundingClientRect()
    const cs = getComputedStyle(panel)
    const body = document.querySelector('.drawer__body')
    const tabs = document.querySelector('.drawer__tabs')
    /* 正文里真实可见的文本长度——「一片空白」的最直接判据。 */
    const text = (body?.textContent ?? '').trim()
    return {
      missing: false,
      shellAlive,
      open: drawer.hasAttribute('data-open'),
      panel: { x: pr.x, y: pr.y, width: pr.width, height: pr.height },
      visibility: cs.visibility,
      opacity: Number(cs.opacity),
      bodyTextLength: text.length,
      bodyText: text.slice(0, 60),
      tabsDisplay: tabs === null ? 'none' : getComputedStyle(tabs).display,
      title: (document.querySelector('.drawer__title')?.textContent ?? '').trim(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })

  if (opened.missing === true) {
    check('界面没被异常卸载（不是白屏）', opened.shellAlive === true)
    check('抽屉元素存在', false, 'DOM 里没有 .drawer / .drawer__panel')
  } else {
    check('界面没被异常卸载（不是白屏）', opened.shellAlive === true)
    check('抽屉已打开', opened.open === true)
    check('抽屉可见（不是 visibility:hidden / opacity:0）',
      opened.visibility === 'visible' && opened.opacity > 0.9,
      `${opened.visibility} / ${String(opened.opacity)}`)
    check('抽屉在视口内（左边缘不越界、右边缘不超出）',
      opened.panel.x >= -1
      && opened.panel.x + opened.panel.width <= opened.viewport.width + 1,
    `x=${String(Math.round(opened.panel.x))} 宽=${String(Math.round(opened.panel.width))} 视口=${String(opened.viewport.width)}`)
    check('抽屉有高度（不是 0）', opened.panel.height > 100,
      `${String(Math.round(opened.panel.height))}px`)
    check('抽屉有标题', opened.title !== '', opened.title)
    check('正文有内容（不是空白）', opened.bodyTextLength > 0,
      `${String(opened.bodyTextLength)} 字：${opened.bodyText}`)
    check('窄屏页签可见（日志/扩展的入口）', opened.tabsDisplay !== 'none',
      opened.tabsDisplay)
  }

  /* 能不能关掉——「无法返回」的直接判据。 */
  const closed = await page.evaluate(async () => {
    const close = document.querySelector('.drawer__close')
    if (close === null) return { noButton: true }
    close.click()
    await new Promise((r) => { setTimeout(r, 400) })
    const drawer = document.querySelector('.drawer')
    const panel = document.querySelector('.drawer__panel')
    return {
      noButton: false,
      stillOpen: drawer?.hasAttribute('data-open') === true,
      visibility: panel === null ? '' : getComputedStyle(panel).visibility,
    }
  })
  check('关闭键存在', closed.noButton === false)
  check('点关闭后抽屉收起', closed.noButton === false && closed.stillOpen === false)
  check('收起后不可见（不拦点击）', closed.noButton === false && closed.visibility === 'hidden',
    closed.visibility)

  /* 三个页签都要能打开且不崩。
   *
   * 注意：汉堡是 **toggle**。每次循环都点一次会把它关掉，所以只在
   * 抽屉没打开时才点——判据读 `data-open` 而不是猜。
   */
  const tabResults = []
  for (let index = 0; index < 3; index += 1) {
    const alreadyOpen = await page.evaluate(
      () => document.querySelector('.drawer')?.hasAttribute('data-open') === true,
    )
    if (!alreadyOpen) {
      await page.locator('.topbar__hit').first().click()
      await page.waitForTimeout(350)
    }
    await page.locator('.drawer__tab').nth(index).click()
    await page.waitForTimeout(400)
    const tab = await page.evaluate(() => ({
      alive: document.querySelector('.shell') !== null,
      title: (document.querySelector('.drawer__title')?.textContent ?? '').trim(),
      textLength: (document.querySelector('.drawer__body')?.textContent ?? '').trim().length,
      /* 直出 undefined / NaN 是最常见的「内容异常」。 */
      leaks: /undefined|NaN|\[object Object\]/.test(
        document.querySelector('.drawer__body')?.textContent ?? '',
      ),
    }))
    tabResults.push(tab)
  }
  check('三个页签都能打开且界面不崩', tabResults.every((t) => t.alive),
    tabResults.map((t) => t.title).join(' / '))
  check('三个页签都有正文内容', tabResults.every((t) => t.textLength > 0),
    tabResults.map((t) => String(t.textLength)).join(' / '))
  check('页签正文无 undefined / NaN 直出', tabResults.every((t) => !t.leaks))

  /* 设置入口：左脊在手机上隐藏后，顶栏齿轮是唯一入口。 */
  await page.evaluate(() => {
    const close = document.querySelector('.drawer__close')
    if (close !== null) close.click()
  })
  await page.waitForTimeout(350)

  const settingsEntry = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    const gear = buttons.find((el) => (el.getAttribute('aria-label') ?? '').includes('设置'))
    return {
      hasGear: gear !== undefined,
      gearRect: gear === undefined ? undefined : gear.getBoundingClientRect().toJSON(),
      visibleButtons: buttons.length,
    }
  })
  check('手机上有设置入口（顶栏齿轮）', settingsEntry.hasGear,
    `${String(settingsEntry.visibleButtons)} 个可见按钮`)
  check('设置入口热区够大', settingsEntry.gearRect !== undefined
    && settingsEntry.gearRect.width >= 40 && settingsEntry.gearRect.height >= 40,
  settingsEntry.gearRect === undefined ? '' : `${Math.round(settingsEntry.gearRect.width)}×${Math.round(settingsEntry.gearRect.height)}`)

  if (settingsEntry.hasGear) {
    await page.locator('button[aria-label="打开设置"]').first().click()
    await page.waitForTimeout(700)
    const panel = await page.evaluate(() => {
      const settings = document.querySelector('.settings')
      const main = document.querySelector('.settings__main')
      const nav = document.querySelector('.pref__nav')
      if (settings === null) return { missing: true }
      const sr = settings.getBoundingClientRect()
      const mr = main === null ? undefined : main.getBoundingClientRect()
      return {
        missing: false,
        alive: document.querySelector('.shell') !== null,
        width: sr.width,
        viewport: window.innerWidth,
        /* 内容区宽度：手机上 168 的竖排导航会让它只剩 222，太窄。 */
        contentWidth: mr === undefined ? 0 : mr.width,
        navIsRow: nav === null ? false : getComputedStyle(nav).display === 'flex',
        textLength: (settings.textContent ?? '').trim().length,
        leaks: /undefined|NaN|\[object Object\]/.test(settings.textContent ?? ''),
      }
    })
    if (panel.missing === true) {
      check('设置面板能打开', false, 'DOM 里没有 .settings')
    } else {
      check('设置面板能打开且界面不崩', panel.alive === true)
      check('设置面板占满宽度', panel.width >= panel.viewport - 2,
        `${String(Math.round(panel.width))} / ${String(panel.viewport)}`)
      check('设置导航改成横排（手机上不该留竖排导航）', panel.navIsRow === true)
      check('设置内容区够宽（不是被 168 导航挤剩）',
        panel.contentWidth >= panel.viewport * 0.75,
        `${String(Math.round(panel.contentWidth))}px`)
      check('设置面板有内容', panel.textLength > 0, `${String(panel.textLength)} 字`)
      check('设置面板无 undefined / NaN 直出', panel.leaks === false)
    }
  }

  await page.close()
}

/* 页面级异常：白屏最常见的成因是运行时报错。 */
check('全尺寸无未捕获的页面异常', pageErrors.length === 0,
  pageErrors.length === 0 ? '' : pageErrors.slice(0, 2).join(' | '))

await browser.close()
vite.kill('SIGTERM')

const failed = checks.filter((c) => !c.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${String(failed.length)} 条失败`}（共 ${String(checks.length)} 条）`)
process.exit(failed.length === 0 ? 0 : 1)