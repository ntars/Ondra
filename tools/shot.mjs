/**
 * 界面截图与规格核对。
 *
 * ## 它解决什么问题
 *
 * 改完样式后，靠人眼看图判断"间距对不对"是不可复查的：
 * 52px 还是 54px 看不出来，但如果它错了，整个左栏的垂直节奏就会偏一档。
 * 这个脚本把旧版写死的每个尺寸列成期望值，到渲染后的 DOM 上量一遍，
 * 逐条判通过或不符合。
 *
 * ## 为什么不是纯 mock
 *
 * 页面里注入的 `__TAURI__` 只回答一件事：「宿主在哪」。
 * 之后所有数据请求都真的走 HTTP——脚本在同一端口上同时提供
 * `dist/` 的静态资源与一套 `/api/*`，请求走的是应用自己的
 * `api.ts` → `host.ts` 代码路径。这样量到的是真实渲染结果，
 * 不是某个测试桩的输出。
 *
 * ## 依赖
 *
 * 需要 `playwright-core`（不含浏览器二进制）。它可能装在项目里，
 * 也可能只在某个临时目录。这里两者都试，都没有就明确报错并给出命令，
 * 而不是让 node 抛一个 "Cannot find package" 让人猜。
 *
 * 浏览器优先用 Playwright 缓存里的 Chrome for Testing；
 * 找不到就退回系统 Chrome。两者都不需要 `playwright install`。
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
}

/**
 * 找一个能用的 playwright-core。
 *
 * 先试项目自身的解析路径（装了就是它），再试几个常见的临时目录。
 * 每条都是一个 `require` 解析，失败就换下一个，不抛。
 */
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [
    'playwright-core',
    'playwright',
    '/tmp/ondra-shot/node_modules/playwright-core',
    join(homedir(), '.cache/ondra-shot/node_modules/playwright-core'),
  ]
  for (const id of candidates) {
    try {
      return require(id)
    } catch {
      // 换下一个候选。
    }
  }
  throw new Error(
    '找不到 playwright-core。执行：\n' +
    '  npm i --prefix /tmp/ondra-shot playwright-core\n' +
    '然后重跑本脚本。',
  )
}

/**
 * 找一个能用的 Chrome 可执行文件。
 *
 * 顺序：Playwright 缓存里的 Chrome for Testing → 系统 Chrome。
 * 都不需要 Playwright 自己下载浏览器，因此离线也能跑。
 */
function findChrome() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const candidates = [
    join(cache, 'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    join(cache, 'chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  throw new Error('找不到可用的 Chrome 可执行文件。')
}

/* ==========================================================================
   假宿主数据
   ========================================================================== */

const HOUR = 3_600_000
const now = Date.now()

const SESSIONS = [
  { id: 's1', title: '关于雨的那个比喻', createdAt: now - 2 * HOUR, updatedAt: now - 12 * 60_000, archived: false, workspace: '/Users/ntars/Github/Ondra' },
  { id: 's2', title: '把日志按轮次分组', createdAt: now - 26 * HOUR, updatedAt: now - 25 * HOUR, archived: false, workspace: '/Users/ntars/Github/Ondra' },
  { id: 's3', title: '分段控件的滑块为什么要多一层', createdAt: now - 50 * HOUR, updatedAt: now - 49 * HOUR, archived: false, workspace: '' },
  { id: 's4', title: '深夜改字体栈', createdAt: now - 74 * HOUR, updatedAt: now - 73 * HOUR, archived: false, workspace: '' },
  { id: 's5', title: '你好', createdAt: now - 120 * HOUR, updatedAt: now - 119 * HOUR, archived: false, workspace: '' },
]

const MESSAGES = [
  { id: 'm1', role: 'user', content: '你觉不觉得今天这场雨，像有人在很低的地方说话。', createdAt: now - 2 * HOUR },
  {
    id: 'm2',
    role: 'assistant',
    content: '像。雨落在不同的东西上会换一种嗓音——落在伞面是闷的，落在铁皮上是脆的，落在叶子上的那一种最轻，像有人在你耳边把一句话说了一半又咽回去。\n\n我更喜欢它停下来的那几秒。屋檐还在滴水，但已经不是雨了，是雨留下的回声。',
    createdAt: now - 2 * HOUR + 20_000,
  },
  { id: 'm3', role: 'user', content: '那你会怎么记这场雨。', createdAt: now - 12 * 60_000 },
  { id: 'm4', role: 'assistant', content: '记成一件事而不是一场天气：某个人在某个下午，和我一起听完了同一场雨。', createdAt: now - 12 * 60_000 + 8_000 },
]

const MODELS = [
  { id: 'magpie', label: 'magpie', contextWindow: 32768, supportsTools: true, supportsStreaming: true },
  { id: 'deepseek-chat', label: 'deepseek-chat', contextWindow: 65536, supportsTools: false, supportsStreaming: true },
]

/** 写一个 JSON 响应。 */
function json(response, body) {
  const text = JSON.stringify(body)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/** 起服务：同一个端口既给静态资源，也给假宿主 API。 */
function serve() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname

    // --- 假宿主 API，路径与 Rust 侧一致 --------------------------------
    if (path === '/api/health') return json(response, { ok: true, at: Date.now() })
    if (path === '/api/sessions' && request.method === 'GET') return json(response, SESSIONS)
    if (path === '/api/sessions' && request.method === 'POST') return json(response, SESSIONS[0])
    if (path === '/api/models') return json(response, MODELS)
    if (path === '/api/config') {
      return json(response, { currentModel: 'magpie', permission: 'workspace', profiles: [] })
    }
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) return json(response, MESSAGES)
    if (path.startsWith('/api/')) return json(response, { ok: true })

    // --- 静态资源 ------------------------------------------------------
    const file = join(ROOT, normalize(path === '/' ? 'index.html' : path).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      response.writeHead(404).end('not found')
      return
    }
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve({ server, port: server.address().port }) })
  })
}

/**
 * 注入的壳。只回答「宿主在哪」，其余一概不参与。
 *
 * `get_host_state` 与 `host-ready` 两条都要给：应用里同时用了
 * 主动查询和事件监听，只给一条会走到那条"事件先于挂载"的兜底路径上，
 * 界面要多等几秒才出来。
 */
const fakeShell = (port) => `
(() => {
  const url = 'http://127.0.0.1:${String(port)}'
  window.__TAURI__ = {
    core: {
      invoke: async (command) => command === 'get_host_state'
        ? { state: 'ready', url, token: 'dev', port: ${String(port)} }
        : null,
    },
    event: {
      listen: async (name, handler) => {
        if (name === 'host-ready') handler({ payload: { url, token: 'dev', port: ${String(port)} } })
        return () => {}
      },
    },
  }
  try { localStorage.setItem('ondra.onboarded', '1') } catch {}
})()
`

/* ==========================================================================
   规格清单。

   ★ 期望值来源：不是"旧版源码里写了什么"，而是**把旧版真跑起来量到的值**。

   为此把 @ntars/ondra v1.2.0 的前端产物用 `ondra web` 起在 127.0.0.1，
   由 Playwright 打开真实页面，量 820×580 下每个容器的 getBoundingClientRect
   与 getComputedStyle，同时把 2630 条运行时 CSS 规则整份导出。
   产物在 /tmp/ondra-shot/old/（geom-session-820.json、geom-right-820.json、
   runtime-rules.json）。

   右栏那一段还额外对着插件源码核过：右栏由
   `@ntars/ondra-client-ui-sidebar-right` 渲染，它的 `lib/client.js` 里
   `StateBody` 与 `EMPTY` 把四张卡片的 DOM、字段、文案全写死了。
   CSS 里没有的类（比如 `bond__nickname`）就一定不是原版的东西——
   我此前正是照着"这一栏该有什么"的想象补了这类结构。

   这一条很关键：上一版这些期望值是我读源码后自己推的，于是测的是
   "我写的值对不对"，46/46 全过但界面与原版差距很大。
   ========================================================================== */

/**
 * 每项是 [名称, 期望, 取值函数, 比较方式]。
 *
 * 取值函数收一个 `m`（量取结果对象），返回实测值。
 * 比较方式：`eq` 容差 0.6px（够吸收子像素舍入），`gte` 不小于，
 * `str` 全等，`null` 必须不存在。
 */
const SPECS = [
  // --- 全局网格：原版实测 "205px 410px 205px"，严格 1:2:1 --------------
  ['三栏根无全局拖拽条', null, (m) => m.shellDrag, 'null'],
  ['820 下侧栏宽 205', 205, (m) => m.sidebar.w, 'eq'],
  ['820 下中栏宽 410', 410, (m) => m.thread.w, 'eq'],

  // --- 左栏：原版 Pwb89G_root padding 6px 8px --------------------------
  ['侧栏上内边距 6', 6, (m) => m.sidebar.padT, 'eq'],
  ['侧栏左右内边距 8', 8, (m) => m.sidebar.padL, 'eq'],
  // 原版 820 下侧栏第一个子节点就是 logoRow（y=6），不渲染 52px topStrip。
  ['无 52px topStrip（原版仅 Windows 标题栏下渲染）', null, (m) => m.topStrip, 'null'],
  ['logoRow 高 60', 60, (m) => m.logoRow.h, 'eq'],
  ['logoRow 上边距 0（紧贴 6px 内边距）', 0, (m) => m.logoRow.marginT, 'eq'],
  ['logoRow 内边距 8/0/8/8', '8px 0px 8px 8px', (m) => m.logoRow.pad, 'str'],
  ['分段控件高 38', 38, (m) => m.viewSwitch.h, 'eq'],
  ['分段控件内边距 3', 3, (m) => m.viewSwitch.padT, 'eq'],
  ['分段控件下外边距 10', 10, (m) => m.viewSwitch.marginB, 'eq'],
  ['分段控件圆角 12', 12, (m) => m.viewSwitch.radius, 'eq'],
  ['分段半格字号 13', 13, (m) => m.viewHalf.fontSize, 'eq'],
  ['分段半格左右内边距 8', 8, (m) => m.viewHalf.padL, 'eq'],
  // 原版有会话时 regionArea y=114：logoRow 6+60 + 分段 38+10 = 114。
  ['分段控件下沿接列表区（6+60+38+10=114）', 114, (m) => m.regionArea.top, 'eq'],
  // 原版无 sectionHeader（只在有搜索时才渲染）。
  ['无 36px sectionHeader', null, (m) => m.sectionHeader, 'null'],

  // --- 会话行：原版 gnibzq_sessionRow 实测 189×32 -----------------------
  ['会话行高 32', 32, (m) => m.sessionRow.h, 'eq'],
  ['会话行左内边距 9（12-3）', 9, (m) => m.sessionRow.padL, 'eq'],
  ['会话行右内边距 8', 8, (m) => m.sessionRow.padR, 'eq'],
  ['会话行圆角 12', 12, (m) => m.sessionRow.radius, 'eq'],
  ['会话行图标槽宽 16', 16, (m) => m.rowSlot.w, 'eq'],
  ['会话行图标槽高 20', 20, (m) => m.rowSlot.h, 'eq'],
  ['图标槽内无图形（原版为空占位）', 0, (m) => m.rowSlot.children, 'eq'],
  ['会话标题字号 14', 14, (m) => m.sessionTitle.fontSize, 'eq'],
  ['会话标题行高 20', 20, (m) => m.sessionTitle.lineHeight, 'eq'],
  ['会话时间字号 10', 10, (m) => m.sessionTime.fontSize, 'eq'],
  ['会话时间行高 16', 16, (m) => m.sessionTime.lineHeight, 'eq'],
  ['会话行间距 2', 2, (m) => m.sessionRow2.marginT, 'eq'],

  // --- 身份行：原版 Pwb89G_personaName 15px/600 -------------------------
  ['身份名字号 15', 15, (m) => m.personaName.fontSize, 'eq'],
  ['身份名字重 600', 600, (m) => m.personaName.fontWeight, 'eq'],
  ['头像宽 28', 28, (m) => m.personaAvatar.w, 'eq'],
  ['新建按钮宽 28', 28, (m) => m.newSessionIcon.w, 'eq'],
  ['新建按钮高 28', 28, (m) => m.newSessionIcon.h, 'eq'],

  // --- 中栏头部：原版实测有会话时 h=51，无标签行 -----------------------
  ['中栏 header 高 51（10+30+10+1）', 51, (m) => m.threadHeader.h, 'eq'],
  ['中栏 header 上内边距 10', 10, (m) => m.threadHeader.padT, 'eq'],
  ['中栏 header 右内边距 28', 28, (m) => m.threadHeader.padR, 'eq'],
  ['中栏 header 左内边距 20', 20, (m) => m.threadHeader.padL, 'eq'],
  ['中栏 header 下内边距 10', 10, (m) => m.threadHeader.padB, 'eq'],
  ['面包屑最大宽 220', '220px', (m) => m.crumb.maxWidth, 'str'],
  ['面包屑内边距 4/8', '4px 8px', (m) => m.crumb.pad, 'str'],
  ['面包屑字号 14', 14, (m) => m.crumb.fontSize, 'eq'],
  ['无标签行（原版只有单一视图）', null, (m) => m.viewTabs, 'null'],

  // --- 消息区：原版 rMFERa_scroll padding 16px calc(clearance+16px) ----
  ['正文上留白 16', 16, (m) => m.content.padT, 'eq'],
  ['正文左留白 32', 32, (m) => m.content.padL, 'eq'],
  ['正文右留白 32', 32, (m) => m.content.padR, 'eq'],
  // 原版 _bubble_1w7cx_1: padding 10px 16px / radius 12 / 14px
  ['用户气泡内边距 10/16', '10px 16px', (m) => m.bubble.pad, 'str'],
  ['用户气泡字号 14', 14, (m) => m.bubble.fontSize, 'eq'],
  ['用户气泡行高 22', 22, (m) => m.bubble.lineHeight, 'eq'],
  ['用户气泡圆角 12', 12, (m) => m.bubble.radius, 'eq'],
  ['助手正文无气泡（透明底）', 'rgba(0, 0, 0, 0)', (m) => m.plain.bg, 'str'],

  // --- 输入区：原版 OQYONa_root padding 0 clearance 4px ----------------
  ['输入区左右留白 16', 16, (m) => m.dock.padR, 'eq'],
  ['输入区下留白 4', 4, (m) => m.dock.padB, 'eq'],

  // --- 右栏：原版 R_gE1G_* 实测（820×580，第 2～4 项为卡片 y 坐标）
  // 原版内容区被两层 0.5px 左边框推右 2px：起点 617、宽 203，不是 615/205。
  ['右栏内容区起点 617', 617, (m) => m.companion.left, 'eq'],
  ['右栏内容区宽 203', 203, (m) => m.companion.w, 'eq'],
  ['右栏内边距 12', 12, (m) => m.companion.padT, 'eq'],
  ['右栏卡片间距 10', 10, (m) => m.companion.gap, 'eq'],
  ['右栏页头高 38', 38, (m) => m.companionHead.h, 'eq'],
  ['右栏页头负边距 -12', -12, (m) => m.companionHead.marginT, 'eq'],
  ['右栏页头内边距 10/12/0', '10px 12px 0px', (m) => m.companionHead.pad, 'str'],
  ['右栏卡片起点 629', 629, (m) => m.card.left, 'eq'],
  ['右栏卡片宽 179', 179, (m) => m.card.w, 'eq'],
  ['右栏卡片内边距 12/14', '12px 14px', (m) => m.card.pad, 'str'],
  ['右栏卡片间距 8', 8, (m) => m.card.gap, 'eq'],
  ['右栏卡片圆角 16', 16, (m) => m.card.radius, 'eq'],
  // 四张卡片的 y 与高度：原版实测 48/132、190/125、325/69、404/157。
  // 这四项把"卡片之间的垂直节奏"整体钉住，任何一张长高都会立刻暴露。
  ['此刻卡 y=48 高 132', '48x132', (m) => `${String(m.card1.top)}x${String(m.card1.h)}`, 'str'],
  ['TA 对你卡 y=190 高 125', '190x125', (m) => `${String(m.card2.top)}x${String(m.card2.h)}`, 'str'],
  ['记得的事卡 y=325 高 69', '325x69', (m) => `${String(m.card3.top)}x${String(m.card3.h)}`, 'str'],
  ['桌宠卡 y=404 高 157', '404x157', (m) => `${String(m.card4.top)}x${String(m.card4.h)}`, 'str'],
  // 「此刻」没有心跳数据时仍渲染两条 0% 的横条：原版就是这样。
  ['无心跳时仍出两条指标条', 2, (m) => m.card1.meters, 'eq'],
  // 桌宠底座 46×46 / 圆角 12 / 按钮 69×28。
  ['桌宠底座 46×46', '46x46', (m) => `${String(m.petMark.w)}x${String(m.petMark.h)}`, 'str'],
  ['桌宠底座圆角 12', 12, (m) => m.petMark.radius, 'eq'],
  ['桌宠按钮 69×28', '69x28', (m) => `${String(m.petButton.w)}x${String(m.petButton.h)}`, 'str'],
  // 原版没有页脚：「上下文随时可查」是我自己加的装饰语。
  ['右栏无页脚', null, (m) => m.companionFoot, 'null'],

  // --- 平台标记：原版大量规则挂在 html[data-platform="darwin"] 下 ------
  // 没写这个属性，那些规则永远不会命中，等于写了一堆死 CSS。
  ['html 标注运行平台', true, (m) => m.platform !== undefined && m.platform !== '', 'truthy'],
  // 会话行右侧「⋯」：原版选中行常驻，其余行靠 hover。
  ['选中行常驻「⋯」', true, (m) => m.activeRowActions, 'truthy'],
]

/** 按规格量一遍页面。 */
async function measure(page) {
  return await page.evaluate(() => {
    const one = (selector, index = 0) => {
      const node = document.querySelectorAll(selector)[index]
      if (node === undefined) return null
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        w: box.width, h: box.height, left: box.left, top: box.top,
        pad: style.padding, padT: parseFloat(style.paddingTop),
        padR: parseFloat(style.paddingRight), padB: parseFloat(style.paddingBottom),
        padL: parseFloat(style.paddingLeft),
        marginT: parseFloat(style.marginTop), marginB: parseFloat(style.marginBottom),
        gap: parseFloat(style.gap),
        fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
        fontWeight: parseFloat(style.fontWeight),
        radius: parseFloat(style.borderRadius), maxWidth: style.maxWidth,
        bg: style.backgroundColor, color: style.color,
        children: node.childElementCount,
      }
    }
    // 卡片要按序号取，坐标与高度一起读，才能钉住垂直节奏。
    const cardAt = (index) => {
      const node = document.querySelectorAll('.card')[index]
      if (node === undefined) return null
      const box = node.getBoundingClientRect()
      return {
        top: Math.round(box.top), h: Math.round(box.height),
        meters: node.querySelectorAll('.meter').length,
      }
    }
    return {
      shellDrag: one('.shell__drag'),
      sidebar: one('.sidebar'),
      topStrip: one('.sidebar__topStrip'),
      logoRow: one('.sidebar__logoRow'),
      viewSwitch: one('.sidebar__viewSwitch'),
      viewHalf: one('.sidebar__viewHalf'),
      sectionHeader: one('.sidebar__sectionHeader'),
      regionArea: one('.sidebar__regionArea'),
      sessionRow: one('.sidebar__sessionRow'),
      // 间距要看第二行：第一行的 margin-top 本来就是 0。
      sessionRow2: one('.sidebar__sessionRow', 1),
      rowSlot: one('.sidebar__rowSlot'),
      sessionTime: one('.sidebar__sessionTime'),
      sessionTitle: one('.sidebar__sessionTitle'),
      personaName: one('.sidebar__personaName'),
      personaAvatar: one('.sidebar__personaAvatar'),
      newSessionIcon: one('.sidebar__newSessionIcon'),
      thread: one('.thread'),
      threadHeader: one('.thread__header'),
      crumb: one('.thread__crumb'),
      viewTabs: one('.thread__viewTabs'),
      dock: one('.thread__dock'),
      content: one('.thread__content'),
      bubble: one('.msg__bubble'),
      plain: one('.msg__plain'),
      // --- 右栏 ---
      companion: one('.companion'),
      companionHead: one('.companion__head'),
      companionFoot: one('.companion__foot'),
      card: one('.card'),
      card1: cardAt(0),
      card2: cardAt(1),
      card3: cardAt(2),
      card4: cardAt(3),
      petMark: one('.pet__mark'),
      // 按钮的宽高是 4px 内边距 + 11px 字的行高算出来的，实测落在
      // 68.66×27.59——亚像素舍入。与卡片同样取整后再比。
      petButton: (() => {
        const node = document.querySelector('.pet__button')
        if (node === null) return null
        const box = node.getBoundingClientRect()
        return { w: Math.round(box.width), h: Math.round(box.height) }
      })(),
      // --- 平台标记与选中行「⋯」---
      platform: document.documentElement.dataset.platform ?? null,
      activeRowActions: (() => {
        const node = document.querySelector('.sidebar__sessionRow--active .sidebar__rowActions')
        if (node === null) return false
        return getComputedStyle(node).display !== 'none'
      })(),
    }
  })
}

/** 把页面推进「有会话的三栏」。 */
async function enterConversation(page) {
  await page.locator('textarea').first().fill('先随便说一句，把界面推进三栏。')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const rows = page.locator('.sidebar__sessionRow')
  if (await rows.count() > 0) {
    await rows.first().click()
    await page.waitForTimeout(800)
  }
}

/* ==========================================================================
   主流程
   ========================================================================== */

const { chromium } = loadPlaywright()
const executablePath = findChrome()
const { server, port } = await serve()
const base = `http://127.0.0.1:${String(port)}`

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 832 }, deviceScaleFactor: 2 })
await page.addInitScript(fakeShell(port))
await page.goto(`${base}/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)

// --- 截图：首页 ---------------------------------------------------------
await page.screenshot({ path: join(OUT, 'welcome.png') })

// --- 截图：三栏 + 日志 --------------------------------------------------
await enterConversation(page)
await page.screenshot({ path: join(OUT, 'three-col-1280.png') })

await page.locator('.sidebar__viewHalf').nth(1).click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, 'run-log-1280.png') })

await page.locator('.sidebar__viewHalf').nth(0).click()
await page.waitForTimeout(400)

await page.setViewportSize({ width: 820, height: 580 })
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, 'three-col-820.png') })

// --- 规格比对 -----------------------------------------------------------
// 必须在 820×580 下量：原版的实测基准就是这个尺寸。
// 1280 下侧栏是 320 而不是 205，拿 1280 的渲染结果去比 205 只会误报。
const measured = await measure(page)
let pass = 0
const failures = []
for (const [name, want, read, mode] of SPECS) {
  const got = read(measured)
  let ok
  if (mode === 'eq') ok = typeof got === 'number' && Math.abs(want - got) < 0.6
  else if (mode === 'gte') ok = typeof got === 'number' && got >= want - 0.6
  else if (mode === 'str') ok = want === got
  else if (mode === 'truthy') ok = Boolean(got) === true
  else ok = got === null
  if (ok) pass += 1
  else failures.push(`${name}：期望 ${String(want)}，实测 ${String(got)}`)
}

// --- 行为核对 -----------------------------------------------------------
const behaviour = []

// --- 浮层：账号菜单、右键菜单、提示条 ------------------------------------
//
// 这一组是"必须有"的：上一版只核对了静态几何，于是菜单虽然一行代码都没有，
// 规格却全绿——因为规格里根本没有问"点得开吗"。
// 交互只有在真的点过之后才算实现，所以这里必须点。
{
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="账号菜单"]')
    if (btn === null) return false
    btn.click()
    return true
  })
  await page.waitForTimeout(500)

  const menu = await page.evaluate(() => {
    const el = document.querySelector('[role="menu"]')
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      items: [...el.querySelectorAll('[role="menuitem"]')].map((node) => (node.textContent ?? '').trim()),
      radius: style.borderRadius,
      z: style.zIndex,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      // 菜单必须完整落在视口内，否则等于"看不见"。
      inside: rect.top >= 0 && rect.bottom <= window.innerHeight,
      parent: el.parentElement?.tagName ?? '',
    }
  })

  behaviour.push(['账号菜单可打开', opened && menu !== null])
  behaviour.push(['账号菜单三项', menu?.items.length === 3, String(menu?.items.join(' / '))])
  behaviour.push(['菜单项为设置/意见反馈/关于',
    menu?.items[0] === '设置' && menu?.items[1] === '意见反馈' && menu?.items[2] === '关于',
    String(menu?.items.join(' / '))])
  behaviour.push(['菜单圆角 16px', menu?.radius === '16px', String(menu?.radius)])
  behaviour.push(['菜单层级 1100', menu?.z === '1100', String(menu?.z)])
  behaviour.push(['菜单宽度 124', menu?.w === 124, String(menu?.w)])
  behaviour.push(['菜单完整在视口内', menu?.inside === true])
  behaviour.push(['菜单 portal 到 body', menu?.parent === 'BODY', String(menu?.parent)])

  // 点「关于」应弹提示条。
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => (node.textContent ?? '').trim() === '关于')
    if (el !== undefined) el.click()
  })
  await page.waitForTimeout(500)

  const toast = await page.evaluate(() => {
    const el = document.querySelector('.toast')
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      text: (el.textContent ?? '').trim(),
      top: Math.round(rect.top),
      radius: style.borderRadius,
      // 提示条要在水平方向居中。
      centered: Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) <= 1,
    }
  })
  behaviour.push(['点「关于」弹出提示条', toast !== null, String(toast?.text)])
  behaviour.push(['提示条距顶 56px', toast?.top === 56, String(toast?.top)])
  behaviour.push(['提示条圆角 12px', toast?.radius === '12px', String(toast?.radius)])
  behaviour.push(['提示条水平居中', toast?.centered === true])

  // 关掉提示条，别影响后面的断言。
  await page.evaluate(() => {
    const btn = document.querySelector('.toast__close')
    if (btn !== null) btn.click()
  })
  await page.waitForTimeout(300)

  // 会话行右键。
  const rowBox = await page.locator('.sidebar__sessionRow').first().boundingBox()
  if (rowBox !== null) {
    await page.mouse.click(rowBox.x + 60, rowBox.y + rowBox.height / 2, { button: 'right' })
    await page.waitForTimeout(500)
    const ctx = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .map((node) => (node.textContent ?? '').trim()),
    )
    behaviour.push(['会话行右键出菜单', ctx.length > 0, String(ctx.join(' / '))])
    // 右键菜单必须贴在指针处，而不是像普通菜单那样对齐某个按钮。
    const ctxRect = await page.evaluate(() => {
      const el = document.querySelector('[role="menu"]')
      if (el === null) return null
      const rect = el.getBoundingClientRect()
      return { x: Math.round(rect.left), y: Math.round(rect.top) }
    })
    behaviour.push(['右键菜单贴指针位置',
      ctxRect !== null && Math.abs(ctxRect.x - (rowBox.x + 60)) <= 2 && Math.abs(ctxRect.y - (rowBox.y + rowBox.height / 2)) <= 2,
      JSON.stringify(ctxRect)])
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  } else {
    behaviour.push(['会话行右键出菜单', false, '没有会话行'])
  }

  // 设置窗口：几何必须与原版实测一致。
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="账号菜单"]')
    if (btn !== null) btn.click()
  })
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => (node.textContent ?? '').trim() === '设置')
    if (el !== undefined) el.click()
  })
  await page.waitForTimeout(800)

  const panel = await page.evaluate(() => {
    const el = document.querySelector('.settings__panel')
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      radius: style.borderRadius,
      tabs: [...document.querySelectorAll('.settings__navCell')].map((node) => (node.textContent ?? '').trim()),
      themes: [...document.querySelectorAll('.themeCard')].map((node) => (node.textContent ?? '').trim()),
      rows: [...document.querySelectorAll('.settings__rowTitle')].map((node) => (node.textContent ?? '').trim()),
    }
  })
  behaviour.push(['点「设置」打开窗口', panel !== null])
  behaviour.push(['设置面板 772×532', panel?.w === 772 && panel?.h === 532, `${String(panel?.w)}×${String(panel?.h)}`])
  behaviour.push(['设置面板圆角 28px', panel?.radius === '28px', String(panel?.radius)])
  behaviour.push(['导航三项', panel?.tabs.length === 3, String(panel?.tabs.join(' / '))])
  behaviour.push(['外观三张卡片', panel?.themes.length === 3, String(panel?.themes.join(' / '))])
  behaviour.push(['通用页含权限/语言/外观/发送方式',
    ['权限', '语言', '外观', '切换运行时的消息发送方式']
      .every((key) => (panel?.rows ?? []).some((row) => row.includes(key))),
    String(panel?.rows.join(' / '))])

  // 三个分组都要能切。
  await page.evaluate(() => {
    for (const cell of document.querySelectorAll('.settings__navCell')) cell.click()
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const btn = document.querySelector('.settings__close')
    if (btn !== null) btn.click()
  })
  await page.waitForTimeout(400)
  const closed = await page.$('.settings__panel')
  behaviour.push(['设置窗口可关闭', closed === null])
}


// 无会话时不可切换，有会话时可切换。
const switchState = await page.evaluate(() => ({
  disabled: [...document.querySelectorAll('.sidebar__viewHalf')].map((node) => node.disabled),
  active: document.querySelector('.sidebar__viewSwitch')?.getAttribute('data-active') ?? null,
}))
behaviour.push(['有会话时两格可用', switchState.disabled.every((value) => !value), JSON.stringify(switchState.disabled)])
behaviour.push(['有会话时滑块可定位', switchState.active === 'chat', String(switchState.active)])

// 切到日志：左栏分段控件与中栏内容同步，输入框消失，四列网格成立。
await page.locator('.sidebar__viewHalf').nth(1).click()
await page.waitForTimeout(400)
const logState = await page.evaluate(() => {
  const row = document.querySelector('.log__row')
  const style = row === null ? null : getComputedStyle(row)
  return {
    active: document.querySelector('.sidebar__viewSwitch')?.getAttribute('data-active') ?? null,
    // 中栏没有标签行，所以"同步"只能看内容本身换没换。
    themeAxis: document.querySelector('.thread__crumb')?.textContent ?? null,
    composer: document.querySelector('.thread__dock') !== null,
    log: document.querySelector('.log') !== null,
    columns: style?.gridTemplateColumns ?? null,
    gap: style?.gap ?? null,
  }
})
behaviour.push(['左栏切日志后 data-active 为 log', logState.active === 'log', String(logState.active)])
behaviour.push(['读日志时输入框消失', logState.composer === false, String(logState.composer)])
behaviour.push(['日志视图已渲染', logState.log === true, String(logState.log)])
behaviour.push(['日志四列含 44px 与 32px', /44px/.test(String(logState.columns)) && /32px/.test(String(logState.columns)), String(logState.columns)])
behaviour.push(['日志列间距 8', logState.gap === '8px', String(logState.gap)])

// 再点「对话」：左栏分段控件跟着回到对话，输入框回来。
await page.locator('.sidebar__viewHalf').nth(0).click()
await page.waitForTimeout(400)
const backState = await page.evaluate(() => ({
  active: document.querySelector('.sidebar__viewSwitch')?.getAttribute('data-active') ?? null,
  composer: document.querySelector('.thread__dock') !== null,
}))
behaviour.push(['点对话后左栏回到 chat', backState.active === 'chat', String(backState.active)])
behaviour.push(['回到对话后输入框回来', backState.composer === true, String(backState.composer)])

let behaviourPass = 0
for (const [name, ok] of behaviour) { if (ok) behaviourPass += 1 }

await browser.close()
server.close()

// --- 汇报 ---------------------------------------------------------------
console.info(`\n截图已写入 .shots/（welcome / three-col-1280 / run-log-1280 / three-col-820）`)
console.info(`\n规格比对：通过 ${String(pass)} / ${String(SPECS.length)}`)
if (failures.length > 0) {
  console.info('不符合：')
  for (const line of failures) console.info('  ✗ ' + line)
}
console.info(`\n行为核对：通过 ${String(behaviourPass)} / ${String(behaviour.length)}`)
for (const [name, ok, detail] of behaviour) {
  if (!ok) console.info(`  ✗ ${name}（${detail}）`)
}
if (failures.length > 0 || behaviourPass < behaviour.length) process.exitCode = 1
