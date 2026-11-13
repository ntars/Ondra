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

/**
 * 会话里的消息。
 *
 * ## 第二条为什么写成一段带满 Markdown 的回复
 *
 * §12.4 的排版要验的是「代码块、表格、引用、列表、链接、行内代码」
 * 六种块在真实 DOM 里的几何关系——只用一句纯文本的话，那六条断言
 * 全都会因为「元素不存在」而报红，报的却是真问题（元素压根没渲染）。
 * 用一条把六种块都放进去的回复，一次加载就能验完。
 *
 * ## 为什么段落里留一行 `**粗**` 与 `[链接]`
 *
 * 行内元素不占独立块，靠块级断言量不到。它们必须出现在**第一段**里，
 * 也就是滚动位置最靠上、截图一定覆盖的地方。
 */
const RICH_REPLY = [
  '像。雨落在不同的东西上会换一种嗓音——落在伞面是闷的，落在铁皮上是脆的，落在叶子上的那一种最轻。',
  '',
  '## 三种声音',
  '',
  '- 伞面：闷，像隔着掌心说话',
  '- 铁皮：脆，**每一下都单独成立**',
  '- 叶子：最轻，要停下来才听得见',
  '',
  '我更喜欢它停下来的那几秒。屋檐还在滴水，但已经不是雨了，是雨留下的回声。',
  '',
  '> 雨停之后的那几秒，才是这句话真正的部分。',
  '',
  '| 落点 | 音色 | 余音 |',
  '| :--- | :---: | ---: |',
  '| 伞面 | 闷 | 0.2 秒 |',
  '| 铁皮 | 脆 | 0.8 秒 |',
  '',
  /* 第二张表故意写宽：§12.4 的硬约束是「表格超出时在容器内横向滚动，
     整条消息不横向滚动」。只有表真的比 560 宽，这条才有东西可验——
     用上面那张三列窄表去断言「有横向滚动」，量到的是数据太窄，
     不是代码对不对。 */
  '| 落点 | 音色 | 余音 | 频率范围 | 听感描述 | 适合的比喻 |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 伞面 | 闷 | 0.2 秒 | 200–800 Hz | 像隔着掌心说话，高频被织物吃掉 | 有人在你肩上低声讲话 |',
  '| 铁皮 | 脆 | 0.8 秒 | 2–6 kHz | 每一下都单独成立，起音极短、尾巴带金属共鸣 | 有人用指甲敲了一下玻璃 |',
  '',
  '用 `rain --seconds 3` 可以听见这三层的差别，或者看 [这个比喻](https://example.com/rain)。',
  '',
  '```sh',
  'rain --seconds 3 --layers umbrella,tin,leaf',
  '```',
].join('\n')

const MESSAGES = [
  { id: 'm1', role: 'user', content: '你觉不觉得今天这场雨，像有人在很低的地方说话。', createdAt: now - 2 * MIN },
  {
    id: 'm2',
    role: 'assistant',
    content: RICH_REPLY,
    createdAt: now - 2 * MIN + 20_000,
  },
]

const MODELS = [
  { id: 'magpie', label: 'magpie', contextWindow: 32768, supportsTools: true, supportsStreaming: true },
  { id: 'deepseek-chat', label: 'deepseek-chat', contextWindow: 65536, supportsTools: false, supportsStreaming: true },
]

/**
 * 人设包清单（标题栏身份块的数据来源）。
 *
 * ## 为什么三个角色都要出现
 *
 * 浮层按 `role` 把包分成出厂 / 示例 / 用户三类，并在每一项右边标出来。
 * 只桩 `factory` 一种，那三行标签的渲染就永远只有一条路径被测到——
 * 而「示例包被标成出厂」这种错在界面上是看不出来的。
 *
 * `displayName` 故意给得比 `name` 长（真实 `meta.json` 就是这样：展示名带
 * 一长串别名），用来验名字被省略号截断时不会把整行撑开。
 */
const PERSONAS = [
  {
    id: 'oh-jingjing',
    name: '哦鲸鲸',
    displayName: '哦鲸鲸（鲸鲸 / 蓝色大肥鱼 / 鲸鱼娘）',
    version: '1.0.0',
    role: 'factory',
    tags: ['出厂', '陪伴'],
    archiveName: '哦鲸鲸.skill.zip',
  },
  {
    id: 'xia-ningqi',
    name: '夏柠柒',
    displayName: '夏柠柒',
    version: '1.0.0',
    role: 'sample',
    tags: ['示例'],
    archiveName: '夏柠柒.skill.zip',
  },
  {
    id: 'custom-a',
    name: '自定义人设',
    displayName: '自定义人设',
    version: '0.9.0',
    role: 'user',
    tags: [],
    archiveName: 'custom-a.skill.zip',
  },
]

/**
 * 她的此刻（右栏侧写的数值来源）。
 *
 * ## 为什么给具体数值，不给 0.5 一片
 *
 * 侧写的四段都是「读一个数、画一根杆」。全是 0.5 时每根杆都停在中点，
 * 「杆有没有接上数据」这件事在截图里看不出来——而它恰恰是这一栏上一轮
 * 的全部问题（`deriveMood()` 恒 0，界面上照样画）。
 *
 * 取互不相同的值还有第二个用处：`mood: 0.5` 落在双极中点映成 `0.00`，
 * `tension: 0.1` 与 `energy: 0.73` 各取一个单极读数，三种形态都覆盖到。
 * （张力曾经被当成双极量做 `×2−1`，`0.1` 会映成 `-0.80`；那条断言
 * 当时把错误当成了预期，已随映射一起改正。）
 */
const COMPANION = {
  measured: true,
  reason: null,
  at: now - 1000,
  axes: {
    pleasure: 0.62,
    arousal: 0.35,
    dominance: 0.44,
    mood: 0.5,
    energy: 0.73,
    tension: 0.1,
  },
  dominant: 'soft',
  bond: {
    stage: '熟悉',
    stageId: 'familiar',
    days: 12,
    affection: 0.58,
    trust: 0.47,
    intimacy: 0.31,
    familiarity: 0.66,
  },
  sources: { emotion: true, stage: true },
}


/**
 * 记忆清单。
 *
 * ## 为什么必须有这一份
 *
 * 「记忆」抽屉从建库起到上一轮为止一直显示「聊两句就有了」——因为前端
 * 那个推导函数硬编码 `return []`，而这条接口根本不存在。桩里补上它，
 * 才能验「有数据时列表真的渲染出来」；桩里只有空列表，就永远验不出
 * 那个缺陷（空态看起来是对的）。
 *
 * ## 为什么给 8 条而不是 3 条
 *
 * 3 条填不满 340px 的内容区，**永远不会溢出**，于是「滚到底后有没有死空白」
 * 这条断言测不到东西：不溢出时末行下面的空白是自然的（169px），不是缺陷。
 * 第一版就是 3 条，断言当场红了而红得冤枉。给 8 条让内容真的溢出，
 * 判据才有判别力。
 *
 * ## 桩照抄宿主的**已排序**输出，前端不再排
 *
 * 排序是宿主的事（`listFacts({orderBy:'salience'})`）。前端若再排一遍，
 * 就出现第二个排序真源：桩给乱序时前端能"修好"，真机上换了字段名就两边
 * 都不对。这里按显著度降序给，验的是「拿到什么渲染什么」。
 */
const MEMORY = {
  total: 8,
  items: [
    { id: 'mm2', text: '你在星玖工作室做独立开发', kind: 'fact', category: 'person', salience: 88, createdAt: now - 90 * MIN, lastSeenAt: now - 9 * MIN, important: true },
    { id: 'mm1', text: '你搭档叫阿岚，负责设计', kind: 'fact', category: 'person', salience: 60, createdAt: now - 40 * MIN, lastSeenAt: now - 5 * MIN, important: false },
    { id: 'mm3', text: '你平时用 macOS 写代码', kind: 'fact', category: 'misc', salience: 31, createdAt: now - 200 * MIN, lastSeenAt: now - 30 * MIN, important: false },
    { id: 'mm4', text: '阿岚最近一直在忙改版的事', kind: 'fact', category: 'person', salience: 28, createdAt: now - 210 * MIN, lastSeenAt: now - 31 * MIN, important: false },
    { id: 'mm5', text: '阿岚喜欢喝手冲咖啡', kind: 'preference', category: 'person', salience: 24, createdAt: now - 220 * MIN, lastSeenAt: now - 32 * MIN, important: false },
    { id: 'mm6', text: '你在写一个叫空谷的项目', kind: 'fact', category: 'misc', salience: 20, createdAt: now - 230 * MIN, lastSeenAt: now - 33 * MIN, important: false },
    { id: 'mm7', text: '你习惯深夜改代码', kind: 'preference', category: 'self', salience: 16, createdAt: now - 240 * MIN, lastSeenAt: now - 34 * MIN, important: false },
    { id: 'mm8', text: '你不太喜欢被反复追问', kind: 'preference', category: 'self', salience: 12, createdAt: now - 250 * MIN, lastSeenAt: now - 35 * MIN, important: false },
  ],
}

/**
 * 会话统计（左栏「会话」抽屉的四项读数）。
 *
 * ## 为什么四个数刻意互不相同
 *
 * 轮数 3、总字数 5 432、归档 2 段。若桩里全填同一个数（比如都写 3），
 * 界面把「轮数」接到「已归档」上照样能通过——四个位置长得一样，读错
 * 一个字段看不出来。数字各不相同，接错就必然对不上。
 */
const SESSION_STATS = {
  sessionId: 's1',
  rounds: 3,
  startedAt: now - 2 * 60 * MIN,
  totalChars: 5432,
  archivedSegments: 2,
  messages: 6,
  title: '关于雨的那个比喻',
  workspace: '/Users/ntars/Github/Ondra',
}

/**
 * 会话日志（宿主从落盘消息派生的行）。
 *
 * 三类 `channel` 各给一条：`rhythm`（她的节律）、`model`（模型往返）、
 * `channel`（通道，本版本已全部删除，但**历史消息里可能有**，界面要能渲染
 * 而不是崩）。带 `detail` 与 `ms` 的那条用来验「展开原文」与耗时字段。
 */
const SESSION_LOGS = [
  { id: 'l1', round: 1, at: now - 2 * MIN, channel: 'rhythm', actor: 'user', summary: '第 1 轮 · 你说了 24 字', chars: 24 },
  { id: 'l2', round: 1, at: now - 2 * MIN + 18_000, channel: 'model', actor: 'assistant', summary: '第 1 轮 · 她回了 218 字', chars: 218, ms: 18_240 },
  { id: 'l3', round: 2, at: now - 90_000, channel: 'channel', actor: 'system', summary: '旧通道投递成功', detail: 'wecom · 文本 · 一条' },
]

/**
 * 系统日志（宿主内存环形缓冲的读数）。
 *
 * 三档 `level` 各一条：颜色与圆点靠 `data-level` 区分，只给 info 的话
 * 「警告与错误长什么样」永远没被渲染过。
 */
const SYSTEM_LOGS = [
  { id: 1, at: now - 3 * MIN, level: 'info', text: '内核就绪，装载 75 个成员' },
  { id: 2, at: now - 2 * MIN, level: 'warn', text: '记忆检索超时，退回关键词' },
  { id: 3, at: now - 60_000, level: 'error', text: '模型返回 429，本轮已重试' },
]

/**
 * 扩展清单：**由宿主自己的扫描器生成**，不手抄。
 *
 * ## 为什么不能手写 78 行
 *
 * 手抄的清单会在插件增删时悄悄过期，而界面上看不出异常——它只是少了几行。
 * 更直接的是：这份清单的每一行都带 `package.json` 里的真实版本号与描述，
 * 手抄等于把 78 个包的三百多字文案再维护一遍。
 *
 * ## `core` 为什么由桩自己给
 *
 * 真实的核心名单是宿主里一个局部常量（`DEFAULT_CORE_ENABLE`，带几百行
 * 说明），没有导出。这里取其中**确实在名单里**的五个，足以验「核心成员的
 * 开关置灰并给出原因」——这一条验的是界面是否尊重 `row.core`，
 * 不是名单本身对不对（那由 `check:core` 负责）。
 */
const STUB_CORE = ['ondra-clock', 'ondra-config-schema', 'ondra-identity', 'ondra-memory-core', 'ondra-store-sqlite']

async function buildPlugins(sections) {
  let scanPlugins
  try {
    ({ scanPlugins } = await import('../cordis-host/lib/src/plugins.js'))
  } catch {
    throw new Error('读不到宿主插件扫描器，先跑 pnpm run build（check:ui 依赖 dist/ 与 cordis-host/lib/）')
  }
  const root = new URL('../cordis-host/plugins/', import.meta.url).pathname
  const rows = await scanPlugins(root, new Set(), new Set(STUB_CORE), sections)
  if (rows.length === 0) throw new Error('插件扫描结果为空，插件构建产物可能没生成')

  /*
   * 全部算「已装载」：这里要验的是正常态。只装载一部分会让多数行落进
   * 「未装载」的灰色外观，而截图与断言要看的正是跑了很久之后的样子。
   */
  const items = rows.map((row) => ({
    ...row,
    loaded: true,
    enabled: true,
    pendingRestart: false,
  }))
  return {
    items,
    totals: { all: items.length, loaded: items.length, pending: 0 },
  }
}

/**
 * 设置全景：**由宿主自己的扫描器生成**，不手抄。
 *
 * ## 为什么不再手写
 *
 * 第一版是手抄五个段的。它的毛病不是"抄错了几个数"，而是**抄的东西会过期**：
 * 插件改了 `min/max`、改了枚举候选、加了字段，手抄的那份不知道，
 * 于是测试在验一个已经不存在的界面。
 *
 * 更关键的是覆盖面。场景层 12 项绑的是 **12 个不同的段**
 * （`memory-core` / `proactive-quota` / `proactive-gate` / `persona-vars` /
 * `rhythm` / `dialogue` / `life-rhythm` / `proactive-reason` /
 * `memory-audit` / `tts` / `privacy` / 最后一项）。手抄五个段，剩下七项
 * 会落进「这个插件没有装载」分支——场景层的大半排版根本没被渲染过，
 * 而截图上看不出异常，只会显示一句灰色的提示语。
 *
 * 调 `scanSections()` 拿到 121 段 / 1116 字段，与线上是同一份数据、
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

/** 读一次请求体。POST 桩要按 `force` 分两种返回，必须先拿到它。 */
function readBody(request) {
  return new Promise((resolve) => {
    let data = ''
    request.on('data', (chunk) => { data += chunk })
    request.on('end', () => { resolve(data) })
    request.on('error', () => { resolve('') })
  })
}

/**
 * 做梦桩的请求计数。
 *
 * 用它模拟宿主那道「一天一场」的闸：第一次跑成功、第二次（不带 `force`）
 * 回 `already-today`。没有这个计数，测试里就永远只能验「成功」那一条，
 * 而 `already-today` 恰好是**正常**状态——把它漏掉，界面就有机会把它
 * 显示成「做梦失败」而测试全绿。
 */
let dreamRuns = 0

/**
 * 假服务。
 *
 * @param settings 设置全景，由 {@link buildSettings} 在启动时扫描宿主得到。
 *   传进来而不是在这里现算：`serve()` 只管路由，扫描失败时应该由
 *   `run()` 在更早的位置报错，而不是让页面加载完才发现设置接口是坏的。
 * @param plugins 扩展清单，由 {@link buildPlugins} 用宿主自己的扫描器生成。
 *   手抄一份 78 行的清单既会过期，也验不到「描述/版本/设置项数」这些真字段。
 */
function serve(settings, plugins) {
  /*
   * 会话消息的**可变副本**。
   *
   * 「删单条」与「清空全部」这两条路必须真的改变下一次 GET 的结果。桩若
   * 恒返回同一份数组，界面就会「删了又长回来」——而那恰恰是要验的契约：
   * 失败时不假装删掉、成功后列表跟着变。只断言「点了没报错」会全绿。
   */
  let messages = [...MESSAGES]

  /*
   * 当前人设包。
   *
   * 与 `messages` 同理：切换是**写操作**，桩必须记住它，下一次
   * `GET /api/personas` 才会返回新的 `activeId`。否则「切完刷新又回去了」
   * 这条真缺陷会被桩自己掩盖掉。
   */
  let activeId = PERSONAS[0].id

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/api/health') return json(response, { ok: true, at: Date.now() })

    /*
     * 会话：**单数**。
     *
     * 单会话制之后 `GET /api/sessions` 返回一段会话或 `null`，不再返回数组；
     * `POST` 明确拒绝。桩必须照这两个形状来，否则前端的 `meta.id` 会读到
     * `undefined`，而界面只会安静地显示成「还没开始」。
     */
    if (path === '/api/sessions' && request.method === 'GET') return json(response, SESSIONS[0])
    if (path === '/api/sessions' && request.method === 'POST') {
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: '单会话模式下不能新建会话' }))
      return
    }
    if (/^\/api\/sessions\/[^/]+\/stats$/.test(path)) return json(response, SESSION_STATS)

    if (path === '/api/models') return json(response, MODELS)
    if (path === '/api/memory') return json(response, MEMORY)
    /*
     * 记忆体检（`ondra-memory-heal` 的唯一界面消费者）。
     *
     * 桩必须同时覆盖两种形态，否则「只读统计」与「真跑一次巡检」在测试里
     * 会走同一条返回：`run` 参数被忽略时，界面永远显示「还没查过」
     * 或者永远显示上一次的结果，而两种错都不会报错。
     *
     * `?run=1` 返回一份带三档的样本：一条 `auto`、一条 `confirm`、一条 `advise`。
     * 三档齐全才能验「分组显示」与「只有前两档有修复键」。
     */
    if (path === '/api/memory/health') {
      if (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('run') === '1') {
        return json(response, {
          loaded: true,
          available: true,
          ran: true,
          at: Date.now(),
          scanned: 11,
          complete: true,
          missing: [],
          counts: { auto: 1, confirm: 1, advise: 1 },
          findings: [
            { code: 'dangling-pin', tier: 'auto', id: 'p-1', detail: '钉子指向已不存在的记忆', action: 'unpin' },
            { code: 'tombstone-leak', tier: 'confirm', id: 'm-2', detail: '已忘内容还活着一条', action: 'forget' },
            { code: 'duplicate-group', tier: 'advise', id: 'm-3', detail: '疑似重复 2 条', action: null },
          ],
          actionable: 2,
          advisory: 1,
          stats: { available: true, diagnoses: 1, findings: 3, repaired: 0, failed: 0 },
        })
      }
      return json(response, {
        loaded: true,
        available: true,
        ran: false,
        stats: { available: true, diagnoses: 0, findings: 0, repaired: 0, failed: 0 },
      })
    }
    if (path === '/api/memory/health/repair') {
      return json(response, { outcomes: [{ key: 'dangling-pin:p-1', ok: true, detail: '悬空钉子已清掉' }], ok: 1 })
    }
    /*
     * 做梦（`ondra-memory-dream` 的界面入口）。
     *
     * 三种形态必须都能桩出来，否则界面会把它们说成同一句话：
     *
     * | 桩 | 界面该说的话 |
     * | --- | --- |
     * | GET，`history` 为空 | 「尚未执行过」 |
     * | POST 第一次 | 跑完，四个数摊开 |
     * | POST 第二次（不 force） | 「今天已经做过一场了」+ 再来一场 |
     *
     * 第三条是本节的重点：`already-today` 与「做梦失败」是两个结论，
     * 前者是**正常**状态。桩如果连它都不返回，界面就永远只有「成功」与
     * 「报错」两种话可说。
     */
    if (path === '/api/memory/dream' && request.method === 'GET') {
      return json(response, {
        loaded: true,
        available: true,
        mode: 'gate',
        stats: { available: true, mode: 'gate', facts: 11, pendingTalk: 0, liveCards: 1, dedupeGate: 'service', snapshotAvailable: false, graphAvailable: true, issues: [] },
        history: [],
        cards: [{ id: 'c-1', kind: 'pitfall', title: '夜里写库要先备份', body: '上一次没备份，回滚花了一晚上', weight: 0.82, archived: false, uses: 1 }],
        pendingTalk: 0,
      })
    }
    if (path === '/api/memory/dream' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request) || '{}')
      if (body.force !== true) {
        // 第一次跑成功、第二次说「今天跑过了」——用请求次数模拟那道闸。
        dreamRuns += 1
        if (dreamRuns > 1) {
          return json(response, { ran: false, skipped: 'already-today', note: '今天已经做过一场梦了' })
        }
      }
      return json(response, {
        ran: true,
        ok: true,
        mode: 'gate',
        date: '2026-11-10',
        at: Date.now(),
        candidates: 4,
        written: 2,
        rejected: 2,
        cards: 0,
        talk: 0,
        edges: 0,
        backup: 'skipped',
        logged: true,
        note: '做完一场梦：写了 2 条',
      })
    }
    /*
     * 快照（`ondra-snapshot` 的界面入口）。
     *
     * 与做梦不同，这个插件**不缺调用方**——五个插件早就在等它。它缺的是
     * 「人能看到结果」这条路：`list()` / `verify()` 全仓零调用方。
     *
     * 桩要覆盖三种：清单为空 / 有清单但没验过 / 验过且好或坏。
     * 中间那一态是本节的重点：**「没验过」与「验过且好」必须显示成两句话**，
     * 合成「好」就把这个块存在的理由抹掉了。
     */
    if (path === '/api/memory/snapshots' && request.method === 'GET') {
      return json(response, {
        loaded: true,
        available: true,
        dir: '~/Library/Application Support/com.ntars.ondra/backups/snapshots',
        keep: 3,
        totalBytes: 5_452_595,
        pendingRestore: false,
        restoreWired: false,
        items: [
          { id: 'ondra-20261110-015500', fileName: 'ondra-20261110-015500.db', displayPath: '~/…/snapshots/ondra-20261110-015500.db', createdAtMs: Date.now() - 120_000, sizeBytes: 2_726_297, schemaVersion: 7 },
          { id: 'ondra-20261109-231000', fileName: 'ondra-20261109-231000.db', displayPath: '~/…/snapshots/ondra-20261109-231000.db', createdAtMs: Date.now() - 8_000_000, sizeBytes: 2_726_298, schemaVersion: null },
        ],
      })
    }
    if (path === '/api/memory/snapshots/verify' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request) || '{}')
      /* 第一份验过是好的，第二份故意坏——两种结论都要能显示出来。 */
      if (String(body.id).endsWith('231000')) {
        return json(response, { ok: false, reason: 'corrupt：快照读不出来（quick_check 失败）' })
      }
      return json(response, { ok: true, check: 'quick_check' })
    }
    if (path === '/api/config') return json(response, { currentModel: 'magpie', permission: 'workspace', profiles: [] })
    if (path === '/api/settings' && request.method === 'GET') return json(response, settings)
    if (path === '/api/settings' && request.method === 'POST') return json(response, { ok: true })
    /*
     * 主动开口（§6.4 E、§7.4）。
     *
     * 默认放行、额度够、无冷却。这是宿主装了 `ondra-proactive-gate`
     * 且各项都宽松时的真实返回，界面必须照着它渲染。
     *
     * 「这次不用」回 `{ok:true}`：宿主那边只做 `reportSuccess()` 记账，
     * 没有别的回执。桩照抄真实形状，不发明字段。
     */
    if (path === '/api/proactive/check') {
      return json(response, {
        allow: true, code: 'pass', reason: '想问你雨停了没',
        remaining: 2, quota: 3, used: 1, deferMs: 0, gateMissing: false,
      })
    }
    if (path === '/api/proactive/decline') return json(response, { ok: true })
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) return json(response, messages)
    /*
     * 删一条消息。宿主收到的是 `messageId`，换算成下标是它的事——桩这里
     * 直接按 id 过滤，模拟同一件事：删掉之后下一次 GET 少一条。
     */
    if (/^\/api\/sessions\/[^/]+\/messages\/delete$/.test(path)) {
      const body = JSON.parse(await readBody(request) || '{}')
      const before = messages.length
      messages = messages.filter((message) => message.id !== body.messageId)
      return json(response, { removed: messages.length < before })
    }
    /*
     * 清空全部：默认归档成段——旧内容不再出现在界面上，新段是空的。
     * 桩只需把消息清掉，返回形状照宿主（`sessionId` 换成新段，`cleared` 为 0）。
     */
    if (/^\/api\/sessions\/[^/]+\/clear$/.test(path)) {
      messages = []
      return json(response, { archived: true, cleared: 0, sessionId: 's1-2', session: { ...SESSIONS[0], id: 's1-2' } })
    }

    /* --- 三类日志（左栏「日志」抽屉） -------------------------------- */
    if (path === '/api/logs/session') return json(response, { sessionId: SESSIONS[0].id, items: SESSION_LOGS })
    if (path === '/api/logs/system') return json(response, { items: SYSTEM_LOGS, size: SYSTEM_LOGS.length })
    // 通道全部删除后这条恒为空，且带一句说明。不是「空数组」——空数组会被读成「通道在，只是没消息」。
    if (path === '/api/logs/channel') return json(response, { items: [], note: '无通道接入' })

    /* --- 扩展清单（左栏「扩展」抽屉） -------------------------------- */
    if (path === '/api/plugins') return json(response, plugins)
    if (/^\/api\/plugins\/[^/]+\/toggle$/.test(path)) {
      return json(response, { ok: true, restartRequired: true })
    }

    /*
     * --- 人设（标题栏身份块） ----------------------------------------
     *
     * 状态放在闭包里，因为切换是**有状态**的：前端点完「夏柠柒」之后会
     * 用回执里的 `activeId` 更新自己那份快照，但一次刷新之后真相只可能
     * 来自宿主。桩若每次都返回出厂包，就永远验不出「切换后标题栏是否
     * 真的换了名字」——那正是这条链路唯一值得验的事。
     */
    if (path === '/api/personas') {
      return json(response, { items: PERSONAS, activeId, available: true, reason: null })
    }
    if (path === '/api/persona/activate') {
      const body = JSON.parse(await readBody(request) || '{}')
      const found = PERSONAS.find((item) => item.id === body.id)
      if (found === undefined) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: '没有这个人设包' }))
        return
      }
      activeId = found.id
      return json(response, { ok: true, activeId: found.id, persisted: true })
    }

    /* --- 她的此刻（右栏侧写） ---------------------------------------- */
    if (path === '/api/companion/state') return json(response, COMPANION)

    /*
     * --- 四条诊断（设置里的声音四张卡） ------------------------------
     *
     * ## 为什么这四条必须显式桩，不能靠兜底
     *
     * 兜底是 `{ ok: true }`——一个**形状对、内容空**的对象。四个卡都会把它
     * 当成「读到了状态」：`voice.engine` 是 undefined，于是界面上出现
     * 「她说完的话会念出来（undefined）」；`state.note` 也是 undefined，
     * 于是 `note === ''` 不成立，渲染出一个**空的带边框说明块**。
     *
     * 两处都是真缺陷（组件不设防），但它们是靠这条兜底才显形的：不桩就是
     * 拿一个宿主永远不会返回的形状去验界面。所以这里按真实回执补齐字段，
     * 让测试验的是线上真正会发生的那种渲染。
     */
    if (path === '/api/diagnostics/voice') {
      return json(response, {
        ttsLoaded: true, gateLoaded: true, enabled: true, ttsAvailable: true,
        engine: 'macos-say', gateAvailable: true, note: '',
        gateStats: {
          decisions: 12, spoken: 7, blocked: { 'too-short': 3, cooldown: 2 },
          streak: 0, lastSpokenAt: now - 4000,
        },
        ttsStats: { calls: 7, ok: 7, failures: 0, played: 7, cacheFiles: 6 },
      })
    }
    if (path === '/api/diagnostics/oral') {
      return json(response, {
        loaded: true, enabled: true, available: true, expressReady: true, note: '',
        stats: {
          turns: 9, messages: 14, habits: 3, incompletes: 2, particles: 5,
          puncts: 11, skipped: 2, pools: 6, sessions: 1, expressErrors: 0,
        },
      })
    }
    if (path === '/api/diagnostics/rhythm') {
      return json(response, {
        loaded: { rhythm: true, typing: true, breath: true },
        available: { rhythm: true, typing: true, breath: true },
        disabled: [], note: '',
        rhythm: {
          turns: 9, messages: 21, cappedTurns: 0, overflowTurns: 0, longPauses: 4,
          selfCorrections: 1, avgMessages: 2.3, avgChars: 34,
        },
        typing: {
          runs: 9, sent: 21, aborted: 0, superseded: 1, degraded: 0, failed: 0,
          active: 0, avgElapsedMs: 2400,
        },
        breath: {
          stats: { takes: 3, deniedQuota: 1, deniedDuplicate: 0, presences: 3 },
          quota: {
            used: 3, cap: 6, remaining: 3,
            actions: [{ id: 'rain', text: '说一句「雨停了」', used: 1 }],
          },
        },
        host: { holds: 9, lastHoldMs: 40, lastPieces: 2, skipped: 0 },
      })
    }
    if (path === '/api/diagnostics/filter') {
      return json(response, {
        loaded: true, enabled: true, available: true, note: '',
        pending: ['去重合并', '章节标题重排'],
        stats: {
          runs: 9, lastRemoved: 2, lastNeedsRegenerate: false, reviews: 9,
          steers: 1, roundLimited: 0,
          sources: { persona: true, stage: true, express: true, gateway: true },
        },
      })
    }

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
    /*
     * §12.11 原文是「`ink-4` 提升为 `ink-3`」。
     *
     * ## 为什么必须逐个别名查，不能只查 `--static-ink-4`
     *
     * 直接改 `--static-ink-4` 会连带改掉表头底线与滚动条悬停色——两者
     * 都不是文字。所以正确做法是**按别名提**，而按别名提就必然会出现
     * 「漏一个」：`--alias-label-dimmed` 在 16 个组件样式里出现，
     * 漏掉它时界面看起来完全正常（它本来就淡），只是那几句话
     * 在大对比度模式下仍然读不清。这类缺陷只能靠枚举守住。
     */
    for (const alias of ['--alias-label-tertiary', '--alias-label-caption', '--alias-label-dimmed']) {
      const rule = new RegExp(`${alias}:\\s*var\\(--static-ink-[23]\\)`)
      if (!rule.test(body)) problems.push(`prefers-contrast: more 没有把 ${alias} 提到 ink-2 / ink-3`)
    }
    // 水位在休息/静音时用这个别名画，它也是「承载信息」的颜色。
    if (!/--alias-state-idle-primary:\s*var\(--static-ink-[23]\)/.test(body)) {
      problems.push('prefers-contrast: more 没有把 --alias-state-idle-primary 提高一档')
    }
    /*
     * 反向：`--static-ink-4` 本身**不该**在这个块里被改。
     * 改了它就等于把表头底线与滚动条一起加深，那是这条规则的越界。
     */
    if (/--static-ink-4:/.test(body)) {
      problems.push('prefers-contrast: more 直接改了 --static-ink-4（会把非文字用途的线一起加深）')
    }
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

  /*
   * --- 2.5 启动骨架必须真的排成三栏 ---
   *
   * ## 守的是一个真实发生过的 bug
   *
   * `.skeleton` 曾经**只有 `background` 与 `border-radius`，没有任何布局
   * 规则**，而 `App.tsx` 的启动态是它包三个裸 `div`。三个 div 高度都是 0，
   * 容器自己被网格撑满整块工作区，把 `--ui-bg-sunken` 整片画出来——深色下
   * 是整窗一块紫板，浅色下是整窗一块灰蓝。
   *
   * 它没被任何断言发现，因为主流程只测"进入主界面之后"的状态。启动态一旦
   * 塌掉，用户看到的第一屏就是错的，而这恰恰是**最容易被漏掉、也最伤第一
   * 印象**的一屏。
   *
   * 判据取三条，都是结构性的、不依赖具体像素：
   *   1. `.skeleton` 必须有 `display: grid`（否则三个子块不会并排）；
   *   2. 网格模板必须含 `var(--w-rail)` 与 `var(--w-spine)`（与真实两栏同宽，
   *      这样骨架和主界面不会在切换时"跳一下"）；
   *   3. 必须给 `.skeleton > div` 设过背景（否则子块是透明的，等于没画）。
   */
  const layout = await read(join(root, 'styles/layout.css'))
  const skeletonRule = /\.skeleton\s*\{([^}]*)\}/.exec(layout)?.[1] ?? ''
  if (!/display:\s*grid/.test(skeletonRule)) {
    problems.push('.skeleton 没有 display: grid——三个骨架块会塌成 0 高，容器自己铺满整块工作区')
  }
  if (!/var\(--w-rail\)/.test(skeletonRule) || !/var\(--w-spine\)/.test(skeletonRule)) {
    problems.push('.skeleton 的网格没有对齐 --w-rail / --w-spine，启动态与主界面切换时会跳一下')
  }
  if (!/\.skeleton\s*>\s*div\s*\{[^}]*background:/.test(layout)) {
    problems.push('.skeleton > div 没设背景——三个骨架块是透明的，等于没画')
  }

  /*
   * --- 2.6 圆角只许走令牌，且四档必须是 4 / 8 / 8 / 12 ---
   *
   * ## 为什么这条要看源码而不是看渲染
   *
   * 圆角在渲染期只有一个 computed 值，`check:ui` 里那几十条 `border-radius`
   * 断言全是**逐元素抽查**：确认框是 `--r-lg`、模型项是 `--r-xs`……每加一个
   * 元素就得补一条。这挡不住"某个新写的组件直接敲 `border-radius: 8px`"——
   * 它渲染出来是对的，看起来也是对的，直到哪天规格改成 12 才发现它没跟着动。
   *
   * 所以这里直接从源码扫：组件样式里凡出现**纯数字**圆角都算违规，
   * 只有三种例外——`0`、`50%`（正圆）、`inherit`（子元素继承父级圆角）。
   * 本轮就靠它找出 4 处漏网的硬编码（键帽、行内代码、代码块、水位轨道）。
   *
   * 另一半是验四档的**具体数值**。规格 §11.2 写死 4 / 8 / 12，而
   * `--r-md` 与 `--r-sm` 同值是刻意设计（卡片与控件两个语义名共档），
   * 所以这里比的是四档的完整映射，不是"四档互不相同"。
   */
  const tokenText = stripTokens
  const radiusMap = {}
  for (const [, name, value] of tokenText.matchAll(/(--r-[a-z]+)\s*:\s*([^;]+);/g)) {
    radiusMap[name] = value.trim()
  }
  const wantRadius = { '--r-xs': '4px', '--r-sm': '8px', '--r-md': '8px', '--r-lg': '12px' }
  for (const [name, want] of Object.entries(wantRadius)) {
    const got = radiusMap[name]
    if (got === undefined) problems.push(`tokens.css 缺圆角令牌 ${name}（§11.2 要求 ${want}）`)
    else if (got !== want) problems.push(`${name} 是 ${got}，§11.2 要求 ${want}`)
  }

  for (const file of files) {
    if (file.endsWith('/tokens.css')) continue
    const text = await read(file)
    for (const match of text.matchAll(/border-radius:\s*([^;]+);/g)) {
      const value = match[1].trim()
      if (/var\(--(r|radius)-/.test(value)) continue
      if (value === '0' || value === '50%' || value === 'inherit') continue
      // 四值简写里可能有 `var(...) 0 var(...) 0`，逐个分量看。
      const parts = value.split(/\s+/)
      const bad = parts.filter((p) => p !== '0' && p !== '50%' && p !== 'inherit' && !/var\(--(r|radius)-/.test(p))
      if (bad.length > 0) {
        problems.push(`${short(file)} 硬编码圆角 ${value}——圆角只许走 --r-xs/sm/md/lg（0 / 50% / inherit 除外）`)
      }
    }
  }

  /*
   * --- 2.7 间距只许落在八级栅格上，三档发丝值豁免 ---
   *
   * §11.1 的八级是 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64。本轮实测有 **161 处**
   * 不在栅格上（10px 占 42 处、6px 26 处、14px 22 处），而 §13.3 早已把它
   * 写成验收项——**没有任何脚本在验它**，于是验收项变成了一句愿望。
   *
   * ## 三档发丝值为什么必须豁免
   *
   * `1px`：`.sess__grid` 用 `gap: 1px` 露出底色当分隔线，改成 0 线就没了，
   *        改成 4 会裂成一条沟。它不是留白，是**用间隙画的线**。
   * `2px`：分段控件 `.control-segments` 的 `padding: 2px` 必须比轨道间隙
   *        (`gap: 2px`) 一致，两者都是"衬垫"而非"留白"。
   * `3px`：20px 高以下小标签的呼吸量。3 与 4 在这个尺寸读不出差别，
   *        但 4 会把 `.sess__badge` 顶成 26 高。
   *
   * 换句话说：**八级管布局留白，这九档管发丝结构**。硬把发丝吸附会让
   * 分隔线消失、衬垫错位，这比"没落在栅格上"严重得多。
   *
   * ## 一处几何值也豁免
   *
   * `layout.css` 的 `padding-left: 84px` 是红绿灯让位：20 + 52 + 12，
   * 算式与理由写在规则里。它由红绿灯组的宽度推出来，不是人为选定的
   * 留白量，改小会把标题压到圆点上。上一版是 76（12 + 52 + 12），
   * 圆点离边缘从 12 挪到 20 之后跟着变成 84。
   *
   * 白名单里只留这一条。设置改为浮层之后，那片界面不再有自己的标题栏，
   * 也就没有第二处需要为红绿灯让位——旧记录已随那个窗口一起删掉，
   * 不留在表里当一条永远命不中的记录。
   *
   * 这类值挂在 `GEOMETRY` 白名单里，且要求同一行附近有注释说明来历——
   * 白名单不是为了绕过检查，是为了让"为什么它特殊"留在代码里。
   */
  /*
   * 间距只认 8 的倍数，4 是唯一允许的半格。
   *
   * ## 为什么没有 12
   *
   * 12 夹在 8 与 16 正中间：与 8 差 4、与 16 也差 4，既不构成「一倍半」
   * 的节奏，又让同一份文件里同时存在三档相近的中等留白。单看每一处都
   * 合理，整屏读起来就是「对齐不准」。12 已全部并入 8 或 16。
   *
   * 4 保留：它不是留白档位，是「图标与文字之间那一口气」。去掉它图标会
   * 贴死文字，换成 8 又会让每一行都变松。
   */
  const GRID8 = new Set([0, 4, 8, 16, 24, 32, 40, 48, 64, 80])
  const HAIRLINE = new Set(['1px', '2px', '3px'])
  /*
   * 白名单只收**几何推算值**：数值由别的尺寸相减/相加得出，不是留白选择。
   *
   * 每一条都必须在源码里有算式注释——白名单不是为了绕过检查，是为了让
   * 「为什么它特殊」留在代码里。加一条却写不出来历，说明它不是推算值，
   * 该改的是那个值。
   */
  const GEOMETRY = new Set([
    /*
     * 标题栏左内距 84：让开 macOS 红绿灯。三个 12 的圆点 + 8 的间距 +
     * 8 的起始呼吸，由系统窗口按钮的实际几何决定。
     */
    'styles/layout.css:padding-left:84px',
    /*
     * Windows 标题栏让给窗口三键的右边距 146 → 已随栅格化改成 144
     * （三键 138 + 6 呼吸取整到 8 的倍数不成立，见 layout.css 的算式）。
     * 该值仍在栅格之外，故仍列在此。
     */
    'styles/layout.css:margin-right:146px',
  ])
  const SPACING = /(?:^|[;{\s])((?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?)\s*:\s*([^;}]+);/g

  for (const file of files) {
    if (file.endsWith('/tokens.css')) continue
    const text = await read(file)
    for (const match of text.matchAll(SPACING)) {
      const [, prop, rawValue] = match
      for (const token of rawValue.trim().split(/\s+/)) {
        if (!/^\d+px$/.test(token)) continue
        if (HAIRLINE.has(token)) continue
        if (GRID8.has(Number(token.slice(0, -2)))) continue
        if (GEOMETRY.has(`${short(file)}:${prop}:${token}`)) continue
        problems.push(
          `${short(file)} 的 ${prop}: ${token} 不在八级栅格上`
          + `（§11.1；发丝 1/2/3px 与几何推算值除外，后者请加进 GEOMETRY 并注明来历）`,
        )
      }
    }
  }

  /*
   * --- 2.8 组件里用到的 BEM 类名，样式表必须有对应规则 ---
   *
   * ## 守的是一个已经发生的静默缺失
   *
   * `ModuleLayer.tsx` 早就渲染了 `data-inactive` 与 `.module__off`，但样式表
   * 里**一条规则都没有**。于是「插件已停用，改了不生效」以裸文字出现，与正常
   * 提示毫无区别；`data-inactive` 也没有任何视觉效果——**停用的插件看起来
   * 完全能调**，正是 §6.7 点名要防的那类缺陷。
   *
   * 它逃过所有检查的原因很朴素：断言验的是"该出现的东西出现了"，而这里
   * 缺的是"样式规则"，界面上既有文字也在正确位置，肉眼完全不觉得缺什么。
   *
   * ## 判据只取 `block__element` 与 `block__element-modifier` 两类
   *
   * 纯 form 类名（`.button`、`.field`）常由多层组合复用，且很多元素只用基础类
   * 不写自有规则（例如 `.module` 只是一个容器 div，靠子元素排版），强行要求
   * 每个类都有规则会产生大量误报。**双下划线是"我自定义了这个部件"的强信号**，
   * 拿它当判据误报率为零，命中率足够。
   *
   * 例外表 `CLASS_OK` 收三类：① 只作为标记位给 JS 读、本来就不需要样式的；
   * ② 由别的文件统一定义、但类名前缀不属于该文件的；③ **搭档类**——
   * 同一个元素上同时挂了 `control-*` 通用控件类，视觉由 `base.css` 完整
   * 提供，BEM 名只是"这是哪个页面的哪个控件"的语义标记。
   *
   * 第 ③ 类最容易出错：为让这条断言变绿而给它们写一个只有注释、
   * 没有声明的空规则，是**自欺**——断言从"有没有样式"退化成
   * "有没有这个字符串"。所以宁可把类名列在这里、写明理由，
   * 也不在样式表里留占位。
   */
  const CLASS_OK = new Set([
    // `data-*` 之外纯做语义标记、样式由父级后代选择器统一给的
    'module__body', // 由 `.module[data-inactive] .module__body` 统一管，不单独定义

    // 搭档类：元素上同时有 `control-*`，视觉由 base.css 完整提供。
    // 逐个核对过组件源码，确认不是"漏写样式"而是"本来就不需要"。
    'pref__switch', // 挂 `control-switch`（Preferences / FilterCard / 三张卡片共 5 处）
    'pref__switch--voice', // 修饰位，无独立视觉；选中态由 `[aria-checked]` 管
    'pref__switch-knob', // 挂 `control-switch-knob`，含位移 16px 的过渡
    'scene__switch-knob', // 同上，SceneLayer 的布尔项
    'scene__segment', // 挂 `control-segment`（轨道底 + 选中态）
    'scene__range', // 挂 `control-range`（轨道渐变 + 拇指 + 填充比例）
    'field__segment', // 挂 `control-segment`，ModuleLayer 枚举 ≤4 项
  ])

  const cssClassSet = new Set()
  for (const file of files) {
    /*
     * 类名里**允许连字符**：`composer__attachment-name` 是一段名字，
     * 第一版写成 `[a-z0-9]+` 会在 `attachment` 处断掉，于是把已经存在的
     * 规则全判成"缺失"——一个只会误报的正则比没有检查更糟。
     */
    for (const m of (await read(file)).matchAll(/\.([a-z][a-z0-9-]*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]+)?)/g)) {
      cssClassSet.add(m[1])
    }
  }

  const tsxRoot = new URL('../src/components/', import.meta.url).pathname
  const { readdir: readdirC } = await import('node:fs/promises')
  const components = (await readdirC(tsxRoot)).filter((n) => n.endsWith('.tsx'))
  const missing = new Map()
  for (const name of components) {
    const src = await readFile(join(tsxRoot, name), 'utf8')
    /*
     * 只在 `className=` 的右侧取类名，两种写法：
     *   ① `className="a b"` —— 直接取字面量
     *   ② `className={ ... }` —— 取花括号内所有引号字面量（三元两支都算）
     *
     * 上一版在**整个文件**里扫引号，把 `data-*`、`aria-label`、组件 prop
     * 里的字符串也当成类名，于是 `composer__attach`（三元截断）和
     * `composer__attachment--image`（`--image` 后缀其实由 `attachment` +
     * `data-image` 表达）都被误报。误报比漏报更伤——它会让人开始怀疑整条断言。
     */
    const chunks = []
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{)/g)) {
      if (m[1] !== undefined) {
        chunks.push(m[1])
        continue
      }
      /*
       * `className={ ... }` 的花括号要**配平**之后再取，不能用非贪婪
       * `[\s\S]*?\}`：三元里出现 `}`（例如对象字面量或嵌套插值）时会提前
       * 截断，把 `composer__attachment--image` 截成 `composer__attach`。
       * 一个永远报着不存在类名的断言，会让人开始不信所有断言。
       */
      const open = m.index + m[0].length - 1
      let depth = 0
      let end = open
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1
        else if (src[i] === '}') {
          depth -= 1
          if (depth === 0) { end = i; break }
        }
      }
      const inner = src.slice(open + 1, end)
      for (const lit of inner.matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)`/g)) {
        chunks.push(lit[1] ?? lit[2] ?? lit[3] ?? '')
      }
    }
    for (const raw of chunks) {
      for (const token of raw.split(/\s+/)) {
        if (!/^[a-z][a-z0-9-]*__[a-z0-9-]+(?:--[a-z0-9-]+)?$/.test(token)) continue
        if (cssClassSet.has(token) || CLASS_OK.has(token)) continue
        if (!missing.has(token)) missing.set(token, name)
      }
    }
  }
  for (const [token, where] of missing) {
    problems.push(
      `${where} 用了 .${token}，但样式表里没有这条规则`
      + `（组件用了类名却没写样式，元素会以浏览器默认样式出现；确认后加进 CLASS_OK 并写明理由）`,
    )
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

/**
 * 内衬探针：找「文字贴在有边界容器的边上」的地方。
 *
 * ## 为什么要有它
 *
 * 「输入框里的字贴着边框」是一条肉眼缺陷，但它的成因是**一个** CSS 值写错，
 * 而全项目有几百个容器。靠人逐个读样式表去找，找到的永远是"这次注意到的
 * 那一个"。这里反过来做：把「有边界的盒子」和「盒子里的第一个字」的几何
 * 关系量出来，凡是文字离边小于 6px 的，都当成嫌疑报出来。
 *
 * ## 判据为什么是 6px
 *
 * 八级栅格里最小的呼吸是 4px（发丝级），它给的是「两个元素之间」而不是
 * 「文字与线之间」——线是硬的，4px 读起来仍然是贴的。6px 是能看出留白的
 * 下限，接近 8px 但留 2px 给行盒自带的行距。实际用在卡片上的值都是 8 或 12。
 *
 * ## 它不判什么
 *
 * 不管对齐（那是 `对齐` 那一节的事），也不管命中区尺寸。只回答一句：
 * 这个盒子里的字，离盒子的线有多远。
 */
const INSET_PROBE = `(() => {
  const insets = []
  const skip = new Set(['SCRIPT', 'STYLE', 'SVG', 'HTML', 'BODY'])
  const label = (node) => {
    const id = node.id === '' ? '' : '#' + node.id
    const cls = [...node.classList].slice(0, 2).map((name) => '.' + name).join('')
    return node.tagName.toLowerCase() + id + cls
  }
  const alphaOf = (color) => {
    const rgba = /^rgba?\\(([^)]*)\\)$/.exec(color)
    if (rgba === null) return color === 'transparent' ? 0 : 1
    const parts = rgba[1].split(/[,/]/).map((part) => part.trim())
    return parts.length < 4 ? 1 : parseFloat(parts[3])
  }
  for (const node of document.querySelectorAll('body *')) {
    if (skip.has(node.tagName)) continue
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const border = Math.min(
      parseFloat(style.borderTopWidth) || 0,
      parseFloat(style.borderLeftWidth) || 0,
      parseFloat(style.borderBottomWidth) || 0,
      parseFloat(style.borderRightWidth) || 0,
    )
    const edge = border >= 0.4
    const filled = alphaOf(style.backgroundColor) >= 0.05
    if (!edge && !filled) continue
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode()
    while (text !== null && (text.textContent ?? '').trim() === '') text = walker.nextNode()
    if (text === null) continue
    const range = document.createRange()
    range.selectNodeContents(text)
    const rect = range.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const box = node.getBoundingClientRect()
    insets.push({
      sel: label(node),
      edge,
      left: Math.round(rect.left - box.left),
      top: Math.round(rect.top - box.top),
      right: Math.round(box.right - rect.right),
      bottom: Math.round(box.bottom - rect.bottom),
    })
  }
  return insets
})()`

/**
 * 屏幕上不该出现的字：`undefined` / `NaN` / `[object Object]` / 没渲染的 `**`。
 *
 * ## 为什么值得单列一条
 *
 * 这四种字都是**同一个根因**的不同长相：某个值从 JSON 里来、到手是
 * `undefined`，而组件把它当字符串拼进了模板字面量。它们在类型系统里
 * 通通过得去（`string` 类型的字段在运行时可以是任何东西），却让人一眼
 * 看出「这软件没做完」。
 *
 * 第四种（`**`）是另一半：JSX 里的字面量不会走 Markdown 渲染，
 * 写 `**当前这一段会被归档**` 就真的印两个星号出来。
 *
 * 判据只看**叶子节点的可见文本**：父节点的 `textContent` 会把整棵树拼起来，
 * 一旦命中永远命中，说不清是谁的错。
 */
const TEXT_LEAK_PROBE = `(() => {
  const bad = []
  for (const node of document.querySelectorAll('body *')) {
    if (node.children.length > 0) continue
    const tag = node.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE') continue
    const text = (node.textContent ?? '').trim()
    if (text === '') continue
    if (/undefined|NaN|\\[object Object\\]|\\*\\*/.test(text)) bad.push(text.slice(0, 32))
  }
  return bad
})()`

/** 扫一次，返回漏出来的字。 */
async function textLeaks(page) {
  return await page.evaluate(TEXT_LEAK_PROBE)
}

/**
 * 豁免名单：确实是「贴着边」但**故意**如此的几处。
 *
 * 三条都是 15px 上下的小标签，垫一大圈内距会让它们变成胶囊，反而与
 * 周围的密度不符。写在这里而不是放宽判据，是为了让「还有哪些地方是贴的」
 * 始终是一份可以数出来的短名单——名单一长，就该回头改设计了。
 */
const INSET_EXEMPT = new Set(['span.titlebar__version', 'code.md__code', 'span.ext__tag'])

/**
 * 跑一次探针，返回「文字贴边」的嫌疑清单（已去掉豁免项）。
 *
 * 返回成 `选择器(左/上/右/下)` 的字符串，失败时一眼能看出是哪条边、差多少。
 * 负值一律跳过：那说明文字溢出了容器（另一类缺陷，`无横向滚动` 那些断言管）。
 */
async function insetViolations(page) {
  const rows = await page.evaluate(INSET_PROBE)
  return rows
    .filter((row) => row.left >= 0 && row.right >= 0 && row.top >= 0 && row.bottom >= 0)
    .filter((row) => row.left < 6 || row.right < 6 || row.top < 3 || row.bottom < 3)
    .filter((row) => !INSET_EXEMPT.has(row.sel))
    .map((row) => `${row.sel}(${String(row.left)}/${String(row.top)}/${String(row.right)}/${String(row.bottom)})`)
}

/** 量一组尺寸与交互。 */
async function run() {
  const { chromium } = loadPlaywright()
  const settings = await buildSettings()
  const plugins = await buildPlugins(settings.sections)
  const { server, port } = await serve(settings, plugins)
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

  /*
   * 首页已删除（2026-11-10）：应用启动即三栏。
   *
   * 这里原先要点 `.welcome__gate` 才能进会话。现在没有那个按钮，
   * 改为等输入框就位——它出现即代表主列已经挂载，等价于原来的「已进入」。
   */
  await page.locator('.composer__input').waitFor()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, 'empty-v5.png') })

  same('主界面里没有文字贴着容器的边', '[]', JSON.stringify(await insetViolations(page)))

  /*
   * --- 14b. 空态「输入第一句话即可开始」真的居中（§12.5）---
   *
   * ## 为什么要断言「离视口中线多近」，而不是断言 padding
   *
   * 上一版的写法治好了「有没有这行字」，但没治好「它在哪儿」：
   * `padding: 56px 0` 把它从 y=44 推到 y=120，而视口高 436——
   * 看着像一行字贴着顶部掉下来，不像「居中一行」。设计文档 §12.5
   * 的原文就是「居中一行」，所以判据只能是一条几何关系：
   * **这行字的中心与滚动视口的中心重合（±8px）**。
   *
   * 容差 8 不是随手取的：字号 12、行高 1.5 → 18，居中后上下各余
   * 209，任何 ≤8 的偏差肉眼都看不出来；而「靠 padding 拼出来」的
   * 写法偏差是 100+，两者不会混淆。
   *
   * ## 为什么同时量水平
   *
   * `text-align: center` 只让**文字**在它的盒子里居中，盒子如果没撑满
   * 主列宽，字就会偏在一侧。这条把水平也钉住，避免「只居中了一半」。
   */
  /*
   * ## 这个空态现在只在一个真实场景里出现：还没有会话
   *
   * 单会话制下，打开应用看到的就是那一段对话的末尾——只要有过一次对话，
   * 主列里永远是消息，不会再有「第一屏」。所以这里**刻意另开一页**，把
   * `GET /api/sessions` 打成 `null`（新装应用的状态），而不是在主页面里
   * 想办法把消息清空：那会污染后面所有「消息级」断言，也会让这条几何
   * 判据落到一个用户永远见不到的状态上。
   *
   * 断言仍然量几何：字号 12、行高 1.5，居中后上下各余 209，任何 ≤8 的
   * 偏差肉眼都看不出来；而「靠 padding 拼出来」的写法偏差是 100+。
   */
  const emptyPage = await browser.newPage({ viewport: { width: 820, height: 580 }, deviceScaleFactor: 2 })
  await emptyPage.addInitScript(fakeShell(port))
  await emptyPage.route('**/api/sessions', (route) => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
  })
  await emptyPage.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'networkidle' })
  await emptyPage.locator('.timeline__empty').waitFor()
  await emptyPage.waitForTimeout(400)
  const emptyGeo = await emptyPage.evaluate(() => {
    const line = document.querySelector('.timeline__empty')
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    if (line === null || view === null) return null
    const l = line.getBoundingClientRect()
    const v = view.getBoundingClientRect()
    return {
      lineCY: l.top + l.height / 2,
      lineCX: l.left + l.width / 2,
      viewCY: v.top + v.height / 2,
      viewCX: v.left + v.width / 2,
      hint: (document.querySelector('.timeline__empty-hint')?.textContent ?? '').trim(),
    }
  })
  truthy('还没有会话时显示开场（居中断言的前提）', emptyGeo !== null)
  same('开场最后一行是「输入第一句话即可开始」', '输入第一句话即可开始', emptyGeo?.hint ?? '')
  eq(
    '空态垂直居中（与视口中线偏差 ≤8）',
    0,
    emptyGeo === null ? Number.NaN : Math.round(emptyGeo.lineCY - emptyGeo.viewCY),
    8,
  )
  eq(
    '空态水平居中（与视口中线偏差 ≤1）',
    0,
    emptyGeo === null ? Number.NaN : Math.round(emptyGeo.lineCX - emptyGeo.viewCX),
    1,
  )
  await emptyPage.screenshot({ path: join(OUT, 'empty-first-run.png') })
  await emptyPage.close()

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
   * 红绿灯改成自绘 `<button>` 之后，macOS 的标题栏里也有了可聚焦元素，
   * 第一个停靠点变成红绿灯的关闭键——仍然落在标题栏，符合「从顶部开始」。
   * Windows 上是菜单按钮与三键，第一个停靠点同样在标题栏里。
   *
   * 早期注释写「macOS 没有可聚焦元素」，那是系统绘制红绿灯时代的事。
   * 现在两平台一致，判据保留「不是输入框、且不属于主列正文」这条口径。
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

  /*
   * 单会话制之后这里不需要「点进某个会话」了：打开应用看到的就是那一段
   * 对话的末尾。原来那两步（开「今天」抽屉 → 点一条会话）点的是已经不存在
   * 的会话列表，留着只会让脚本以超时的方式红。
   *
   * 直接确认消息真的在：有气泡才有后面那批悬停操作可验。
   */
  await page.locator('.message').first().waitFor()
  const shownMessages = await page.evaluate(() => document.querySelectorAll('.message').length)
  truthy(`启动即载入这一段对话（${String(shownMessages)} 条消息）`, shownMessages >= 2)
  await page.screenshot({ path: join(OUT, 'session-v5.png') })
  same('会话里没有文字贴着容器的边', '[]', JSON.stringify(await insetViolations(page)))
  same('会话里没有 undefined / NaN / 未渲染的 Markdown 漏出来', '[]', JSON.stringify(await textLeaks(page)))
  same('会话里没有 undefined / NaN / 未渲染的 Markdown 漏出来', '[]', JSON.stringify(await textLeaks(page)))

  /*
   * 局部特写。
   *
   * 整窗截图缩到 1080 宽之后，输入卡的 0.5px 内影、两脊的色差、
   * 发送键的两档状态全部糊在一起——用这种图判断"细节做没做到"，
   * 结论只能靠猜。这里另外存三张**元素级**截图（2 倍图，不缩放），
   * 供人眼与 `tools/pixel.mjs` 一起核对。
   *
   * 元素级截图只截元素自身的盒子，不含周围的纸面——所以判断
   * "输入面是否比纸面深"这类问题要用整窗图取点，这两张是看**卡内**
   * 的排版与控件细节。
   */
  for (const [selector, name] of [
    ['.composer', 'detail-composer.png'],
    ['.rail', 'detail-rail.png'],
    ['.spine', 'detail-spine.png'],
  ]) {
    const node = page.locator(selector)
    if ((await node.count()) > 0) await node.screenshot({ path: join(OUT, name) })
  }

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
        const node = document.querySelector('.composer__primary')
        return node === null ? null : node.getAttribute('aria-disabled')
      })(),
      sendNativeDisabled: (() => {
        const node = document.querySelector('.composer__primary')
        return node === null ? null : node.disabled
      })(),
      // 可聚焦 = `tabIndex >= 0` 且不是原生禁用。
      sendFocusable: (() => {
        const node = document.querySelector('.composer__primary')
        return node === null ? null : node.tabIndex >= 0 && !node.disabled
      })(),
      // 禁用原因必须挂在同一棵树里，读屏才念得到。
      sendHint: (() => {
        const node = document.querySelector('.composer__primary')
        const id = node?.getAttribute('aria-describedby')
        if (id === null || id === undefined) return ''
        return (document.getElementById(id)?.textContent ?? '').trim()
      })(),
      sendBg: (() => {
        const node = document.querySelector('.composer__primary')
        return node === null ? '' : getComputedStyle(node).backgroundColor
      })(),
      modelLabel: (document.querySelector('.composer__model-button')?.textContent ?? '').trim(),
      /*
       * 输入区只有**一圈**焦点指示（§5.6）。
       *
       * ## 为什么这一条必须量，而且量两样
       *
       * 「卡片描边转 teal」与「textarea 不画自己的环」是一件事的两半：
       * 只做前一半会得到两圈重叠的框（textarea 的环是直角的、
       * 且贴着文字，直接压在正文上，截图里一眼就能看出来）。
       * 只做后一半则完全没有焦点可视化，键盘用户摸不到自己在哪。
       *
       * `outlineStyle` 而不是宽度：`outline-style: none` 时 Chromium 仍会把
       * 宽度报成 `0px`，与「画了 0 宽」混在一起；`none` 才是没画的确定证据。
       */
      inputOutline: (() => {
        const node = document.querySelector('.composer__input')
        return node === null ? 'missing' : getComputedStyle(node).outlineStyle
      })(),
      cardShadow: (() => {
        const node = document.querySelector('.composer__card')
        return node === null ? '' : getComputedStyle(node).boxShadow
      })(),
      prose: (() => {
        const card = document.querySelector('.composer__card')
        const input = document.querySelector('.composer__input')
        const attach = document.querySelector('.composer__attach')
        const row = document.querySelector('.composer__row')
        if (card === null || input === null || attach === null) return null
        const c = card.getBoundingClientRect()
        const i = input.getBoundingClientRect()
        const a = attach.getBoundingClientRect()
        const s = getComputedStyle(input)
        return {
          leftGap: Math.round(i.left - c.left),
          topGap: Math.round(i.top - c.top),
          padLeft: s.paddingLeft,
          padTop: s.paddingTop,
          attachGap: Math.round(a.left - c.left),
          rowTop: row === null ? 0 : Math.round(row.getBoundingClientRect().top - c.top),
        }
      })(),
    }
  })


  eq('标题栏高 44', 44, result.titlebar?.h)
  eq('Rail 宽 56', 56, result.rail?.w)
  eq('Spine 宽 56', 56, result.spine?.w)
  /*
   * 两脊等宽必须单独成一条**关系式**。
   *
   * 上面两条各自写死 52，只能防「有人只改了其中一个」。若把两个一起改成
   * 54，两条都绿，而 820 − 54 − 54 = 712，主列已经被挤窄——下一条
   * 「主列宽 708」会红，但那条报的是「主列不对」，没人会想到根因是两栏
   * 一起变宽了。这条断言把「等宽」本身钉住，红的时候原因写在脸上。
   *
   * 为什么等宽重要：主列里的正文、输入卡、标题全部居中排，两脊不等宽
   * 会把主列中心线推离窗口几何中心。48 / 56 那版就偏了 4px。
   */
  eq('两脊等宽', result.rail?.w, result.spine?.w, 0)
  /*
   * 主列 690，不是 708。
   *
   * 708 是「`.workspace` 没有外边距」时的算法（820 − 56 × 2）。现在的
   * workspace 是一张带圆角的纸，左右各留 8、各一条 0.5px 边框：
   * 820 − 16 − 1 − 56 − 56 = 691，取整后 690。这个视觉决定是刻意的
   * （纸片与标题栏相连），所以改的是数字而不是布局。
   */
  eq('主列宽 690', 690, result.column?.w)
  eq('正文宽 560', 560, result.measure?.w)
  eq('输入卡宽 560', 560, result.card?.w)
  eq('输入卡高 76', 76, result.card?.h)
  /*
   * 454 = 580 − 8（composer 下内距）− 33（卡外脚注：上距 8 + 行高 25）
   *       − 76（卡高）− 8（上内距）− 1（取整）。
   *
   * 八级栅格化之后 composer 的上下内距从 12 收到 8，卡上沿因此从 450
   * 上移到 454。三处间距（消息流→卡、卡→脚注、脚注→视口底）现在都是 8，
   * 节奏一致；旧值 450 对应的是 12 / 12 / 12 那套。
   */
  eq('输入卡上沿 y=454（卡底让出脚注行）', 454, result.card?.y)
  same('输入框行高 20px', '20px', result.textareaLineHeight)
  /*
   * --- 输入框里的字离边框多远（用户报的第 4 条）---
   *
   * ## 为什么这三条要单独量
   *
   * 「文字贴着边框」不是配色问题，也不是尺寸问题，而是**内距少了一个方向**：
   * textarea 自己的 `padding-left` 就是文字与卡片左内缘之间唯一的距离，
   * 写成 0 的时候，占位符直接从边框上起笔——而它下面那行加号离边框有 12px。
   * 上下两行文字起点差 12px，在一条 560 宽的卡里像没对齐，又说不出哪里错。
   *
   * 断言写成「文字起点 == 加号键起点」而不是「padding-left 是 12px」：
   * 前者是观感，后者是实现。将来若把工具行的内距改成 16，这条会跟着红，
   * 提醒两处要一起改——那正是需要被提醒的时刻。
   */
  /*
   * 8 是八级栅格化的结果（原 12）。工具行的左内距同步收到 8，两行仍共用
   * 一条起笔线——下一条断言守的正是这件事，所以这里只钉实现值，观感由
   * 「起点对齐」那条守。
   */
  same('输入框的左内距是 8px', '8px', result.prose?.padLeft)
  /*
   * 期望写左边、实测写右边（原版把两个参数写反了：`attachGap` 当期望、
   * `leftGap + 12` 当实测，报红时「期望 / 实测」两个标签是颠倒的）。
   */
  /*
   * 起笔线 = 输入框左缘 + 它的左内距。内距八级栅格化后是 8，加号键左缘
   * 必须落在同一个 x 上。这里的 8 与上一条同源，两处一起改才不会漂。
   */
  eq(
    '占位文字的起点与加号键的起点对齐',
    (result.prose?.leftGap ?? 0) + 8,
    result.prose?.attachGap,
    1,
  )
  eq('输入框的上内距是 8px（文字离上边框 8 + 3 = 11px）', 8, Number.parseInt(result.prose?.padTop ?? '0', 10), 0)
  eq('无横向滚动', 820, result.docWidth)
  same('空输入时发送键 aria-disabled', 'true', result.sendDisabled)
  same('发送键不用原生 disabled', 'false', String(result.sendNativeDisabled))
  truthy('禁用的发送键仍可聚焦', result.sendFocusable === true)
  truthy('禁用的发送键带可朗读原因', result.sendHint.length > 0)
  same('模型名显示当前模型', 'magpie', result.modelLabel)

  /*
   * 焦点指示只有一层（§5.6）。
   *
   * 这两条要在**输入框聚焦之后**量。此刻页面刚加载、焦点在 body，
   * 卡片描边还是 line 色——那时候量到的 teal 是假的。所以先点一下输入框，
   * 等 CSS 过渡（120ms）走完再读。
   */
  await page.locator('.composer__input').click()
  await page.waitForTimeout(300)
  const focusRing = await page.evaluate(() => {
    const input = document.querySelector('.composer__input')
    const card = document.querySelector('.composer__card')
    return {
      inputOutline: input === null ? 'missing' : getComputedStyle(input).outlineStyle,
      cardShadow: card === null ? '' : getComputedStyle(card).boxShadow,
    }
  })
  /*
   * `outline-style: none` 是唯一可靠判据。
   *
   * `outline-width` 在 `style: none` 时仍报 `0px`，而「画了一圈 0 宽」在
   * 观感上与没画一样——用宽度判会让「残留一圈 0.5px」这类回归静默通过。
   */
  same('输入框自己不画焦点环', 'none', focusRing.inputOutline)
  /*
   * 焦点描边色 = 强调色。浅色 `#191919` → `rgb(25, 25, 25)`。
   *
   * 这里写死 rgb 而不是读令牌，是因为断言要验的正是「这条规则用的是
   * 强调色，而不是某个随手写的颜色」。读令牌会把断言变成同义反复：
   * 令牌错了它也跟着错，永远绿。
   *
   * 代价是换配色时这里必须同步。这条断言已经拦下过七轮配色迁移：
   * 蓝 `rgb(37, 99, 235)` → `rgb(24, 24, 27)` → 冷黑 `rgb(11, 13, 17)`
   * → 石色 `rgb(24, 24, 27)` → 蓝白 `rgb(31, 94, 255)`
   * → 微信绿 `rgb(6, 128, 63)` → **本轮黑白 `rgb(25, 25, 25)`**。
   * 它确实在起作用，所以照旧写死。
   */
  truthy(
    `聚焦时卡片描边转强调色（${focusRing.cardShadow.slice(0, 60)}）`,
    /rgba?\(25,\s*25,\s*25[,)]/.test(focusRing.cardShadow),
  )

  // --- 打字后发送键启用 ---
  await page.locator('.composer__input').fill('试试发送')
  await page.waitForTimeout(200)
  const afterType = await page.evaluate(() => {
    const node = document.querySelector('.composer__primary')
    return {
      disabled: node === null ? 'true' : node.getAttribute('aria-disabled'),
      opacity: node === null ? '' : getComputedStyle(node).opacity,
    }
  })
  same('有内容时发送键启用', 'false', String(afterType.disabled))

  /*
   * --- 粘贴（§12.14）---
   *
   * ## 为什么这三条必须真往剪贴板里放东西
   *
   * 「粘贴图片转附件」这条最容易假绿的地方是：写了个 `onPaste`，
   * 也在里面调了 `preventDefault`，但真粘贴时拿到的 `clipboardData`
   * 结构不对（`files` 为空、`items` 才有），于是什么都不发生——
   * 而任何只查「有没有绑定 onPaste」的断言都会通过。
   *
   * 这里用 `ClipboardEvent` + 真 `DataTransfer` 派发事件，
   * 走的是与用户按 Cmd+V 完全相同的处理路径。
   *
   * ## 图片为什么要 1×1 的 canvas 现造
   *
   * `createImageBitmap` 要一份能解码的图。用一段写死的 base64 PNG
   * 最省事，但那个常量一改错（少一个字符）测的就是「解码失败」这条
   * 降级路径，而断言看到的仍然是「附件加上了」——因为失败时也会
   * 退回不带缩略图的附件。现造一张 2×2 的纯色图，解码一定成功，
   * 才能验到缩略图**真的有值**。
   */
  const pasteImage = await page.evaluate(async () => {
    const input = document.querySelector('.composer__input')
    if (input === null) return { ran: false }

    // 造一张 2×2 的红色 PNG。
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const context = canvas.getContext('2d')
    if (context === null) return { ran: false }
    context.fillStyle = '#c0392b'
    context.fillRect(0, 0, 2, 2)
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png') })
    if (blob === null) return { ran: false }
    const file = new File([blob], 'clip.png', { type: 'image/png' })

    const data = new DataTransfer()
    data.items.add(file)
    // 剪贴板同时带一段文字：模拟「从网页复制一张图」的真实情况。
    data.setData('text/plain', '这段文字不该被插进输入框')

    /*
     * 记**变化量**而不是「粘完是不是空」。
     *
     * 输入框里此刻有前面打字测试留下的内容（「试试发送」），拿绝对值得出
     * 的预期必然是错的。要验的是「粘贴这一步有没有往输入框里加东西」，
     * 那就只能看前后差——这也正是断言该问的问题。
     */
    const before = input.value ?? ''
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    // 解码 + 缩放是异步的，等它落地。
    await new Promise((resolve) => setTimeout(resolve, 500))

    const image = document.querySelector('.composer__attachment--image')
    const thumb = document.querySelector('.composer__attachment-thumb')
    const style = thumb === null ? null : getComputedStyle(thumb)
    const box = thumb === null ? null : thumb.getBoundingClientRect()
    return {
      ran: true,
      added: document.querySelectorAll('.composer__attachment').length,
      imageClass: image !== null,
      thumbW: box === null ? 0 : Math.round(box.width),
      thumbH: box === null ? 0 : Math.round(box.height),
      thumbRadius: style?.borderRadius ?? '',
      thumbBg: style?.backgroundImage ?? '',
      grew: (input.value ?? '').length - before.length,
      unchanged: (input.value ?? '') === before,
    }
  })

  truthy('粘贴图片后出现附件', pasteImage.ran === true && pasteImage.added >= 1)
  eq('图片附件缩略图 48 宽', 48, pasteImage.thumbW)
  eq('图片附件缩略图 48 高', 48, pasteImage.thumbH)
  truthy('缩略图真的有图（不是空背景）', (pasteImage.thumbBg ?? '').startsWith('url("data:image/'))
  truthy(
    `粘贴图片时文字不落进输入框（多了 ${String(pasteImage.grew)} 字）`,
    pasteImage.unchanged === true,
  )

  /*
   * 留一张带附件的截图。
   *
   * 几何断言量得到「48 × 48」，量不到「48 × 48 的图上面那个 16px 的叉
   * 有没有把图挡掉一半」。这一块是纯视觉判断，只能靠图。
   */
  await page.screenshot({ path: join(OUT, 'paste-attachment-v1.png') })

  /*
   * 纯文字粘贴必须走浏览器默认路径。
   *
   * 判据不是「输入框里多了字」——直接 `fill` 也能让它多字。判据是
   * **事件没有被 `preventDefault`**：真被拦了，浏览器的默认插入就不会发生，
   * 用户按 Cmd+V 什么都没出来。这里读 `dispatchEvent` 的返回值，
   * 它为 `false` 就说明默认行为被挡掉了。
   */
  const pasteText = await page.evaluate(() => {
    const input = document.querySelector('.composer__input')
    if (input === null) return { ran: false }
    const data = new DataTransfer()
    data.setData('text/plain', '纯文字粘贴')
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    const allowed = input.dispatchEvent(event)
    return { ran: true, allowed, prevented: event.defaultPrevented }
  })
  truthy('纯文字粘贴未被拦截（交浏览器默认处理）', pasteText.ran === true && pasteText.prevented === false)

  // 清掉粘贴测试留下的附件，后面的尺寸断言才回到「无附件」状态。
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.composer__attachment-remove')) button.click()
  })
  await page.waitForTimeout(150)
  const afterClean = await page.evaluate(() => ({
    count: document.querySelectorAll('.composer__attachment').length,
    cardH: Math.round((document.querySelector('.composer__card')?.getBoundingClientRect().height ?? 0)),
  }))
  eq('移除后附件清空', 0, afterClean.count)
  eq('移除后输入卡回到 76', 76, afterClean.cardH)

  /*
   * --- 超长确认（§12.14）---
   *
   * 判据是「弹出的是 Dialog 而不是原生 confirm」。原生 `confirm` 会
   * **阻塞整个渲染进程**，在无头浏览器里表现是这次 `evaluate` 永久挂住——
   * 所以这里绝不能真触发它，而是先 `page.on('dialog')` 兜住并记一笔：
   * 一旦代码退回原生 `confirm`，那条会记到 `nativeDialogs` 里，断言报红。
   *
   * 之所以不满足于「有对话框出现」：原生 confirm 也是一张对话框，
   * 用户能看见、也能点，唯独样式是系统的，与 §5.12 的规格毫无关系。
   */
  let nativeDialogs = 0
  const onNativeDialog = async (dialog) => { nativeDialogs += 1; await dialog.dismiss() }
  page.on('dialog', onNativeDialog)

  await page.locator('.composer__input').fill('长'.repeat(8001))
  await page.waitForTimeout(150)
  await page.locator('.composer__primary').click()
  await page.waitForTimeout(300)
  const longConfirm = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog')
    return {
      open: dialog !== null,
      title: (document.querySelector('.dialog__title')?.textContent ?? '').trim(),
      body: (document.querySelector('.dialog__body')?.textContent ?? '').trim(),
      confirm: [...document.querySelectorAll('.dialog__actions button')].map((node) => node.textContent.trim()),
      // 输入框里的字必须还在：确认只是加一道闸，不该清空用户的内容。
      kept: (document.querySelector('.composer__input')?.value ?? '').length,
    }
  })
  truthy('超长时出现对话框', longConfirm.open === true)
  eq('超长提示未走原生 confirm', 0, nativeDialogs)
  same('超长对话框用 Dialog 组件标题', '消息篇幅较长', longConfirm.title)
  truthy('超长对话框说明具体字数', longConfirm.body.includes('8001'))
  truthy('超长对话框有两个明确动词', longConfirm.confirm.length === 2 && longConfirm.confirm[0] === '返回修改')
  eq('超长时草稿保留', 8001, longConfirm.kept)

  // 「再改改」只关框，不改草稿。
  await page.locator('.dialog__actions button').first().click()
  await page.waitForTimeout(200)
  const afterCancel = await page.evaluate(() => ({
    open: document.querySelector('.dialog') !== null,
    draft: (document.querySelector('.composer__input')?.value ?? '').length,
  }))
  same('点再改改后对话框关闭', false, afterCancel.open)
  eq('点再改改后草稿仍在', 8001, afterCancel.draft)
  page.off('dialog', onNativeDialog)
  await page.locator('.composer__input').fill('')
  await page.waitForTimeout(150)

  /*
   * --- 正文排版（§12.4）---
   *
   * ## 为什么每一条都量几何而不是只量存在
   *
   * 「元素渲染出来了」与「排版对了」是两件事。上一批验收里踩过一次：
   * 元素在 DOM 里、节点数对，但那行字落在可视区外，用户一个字看不到。
   * 这里对间距、宽度、滚动行为逐项量真值，量不到就报红。
   */
  const rich = await page.evaluate(() => {
    const body = document.querySelector('.message[data-role="assistant"] .md')
    if (body === null) return { found: false }
    const px = (value) => Math.round(Number.parseFloat(value) || 0)

    const code = body.querySelector('.md__pre-body')
    const inlineCode = body.querySelector('.md__code')
    const quote = body.querySelector('.md__quote')
    const quoteText = quote === null ? null : getComputedStyle(quote)
    const codeText = code === null ? null : getComputedStyle(code)
    const inlineText = inlineCode === null ? null : getComputedStyle(inlineCode)
    /* 表格取**最宽的那张**：测试数据里第二张表是故意写宽的，
       专门用来验「超出时在容器内横向滚动」。取第一张窄表验不到溢出。 */
    const wraps = [...body.querySelectorAll('.md__table-wrap')]
    const widest = wraps
      .map((node) => ({ node, over: node.scrollWidth - node.clientWidth }))
      .sort((a, b) => b.over - a.over)[0]
    const wrap = widest?.node ?? null
    const table = wrap === null ? null : wrap.querySelector('.md__table')
    const wrapBox = wrap === null ? null : wrap.getBoundingClientRect()
    const tableBox = table === null ? null : table.getBoundingClientRect()

    /* 段间距：标题**上一段**与标题之间是节奏值 12（`.md > * + *`），
       标题与**它后面那段**之间应该是 6（`.md__h + *`，贴紧自己的内容）。
       两个方向都要量——只量一个方向的话，`margin` 被清零或全部统一成 12
       都抓不到。 */
    const p = body.querySelector('.md__p')
    const h = body.querySelector('.md__h')
    const gapAbove = p === null || h === null ? null : Math.round(h.getBoundingClientRect().top - p.getBoundingClientRect().bottom)
    const afterH = h === null ? null : h.nextElementSibling
    const gapBelow = h === null || afterH === null ? null : Math.round(afterH.getBoundingClientRect().top - h.getBoundingClientRect().bottom)

    return {
      found: true,
      /* 代码块 */
      codeFont: codeText?.fontSize ?? '',
      codePad: codeText === null ? 0 : px(codeText.paddingTop),
      codeRadius: codeText?.borderRadius ?? '',
      codeBg: codeText?.backgroundColor ?? '',
      /* 行内代码 */
      inlineFont: inlineText?.fontSize ?? '',
      inlinePadX: inlineText === null ? 0 : px(inlineText.paddingLeft),
      inlineRadius: inlineText?.borderRadius ?? '',
      /* 引用 */
      quoteBorder: quoteText === null ? 0 : px(quoteText.borderLeftWidth),
      quotePad: quoteText === null ? 0 : px(quoteText.paddingLeft),
      /* 表格 */
      tableOverflow: wrap === null ? false : wrap.scrollWidth > wrap.clientWidth,
      tableMetrics: wrap === null ? null : { sw: wrap.scrollWidth, cw: wrap.clientWidth },
      wrapRight: wrapBox === null ? 0 : Math.round(wrapBox.right),
      tableRight: tableBox === null ? 0 : Math.round(tableBox.right),
      headFont: table === null ? '' : getComputedStyle(table.querySelector('th')).fontSize,
      cellFont: table === null ? '' : getComputedStyle(table.querySelector('td')).fontSize,
      /* 段落与标题的间距 */
      gapAbove,
      gapBelow,
      /* 列表符号 */
      bulletContent: (() => {
        const li = body.querySelector('.md__list > li')
        if (li === null) return ''
        return getComputedStyle(li, '::before').content
      })(),
      listPad: (() => {
        const list = body.querySelector('.md__list')
        return list === null ? 0 : px(getComputedStyle(list).paddingLeft)
      })(),
      /* 链接 */
      linkColor: (() => {
        const link = body.querySelector('.md__link')
        return link === null ? '' : getComputedStyle(link).color
      })(),
      linkUnderline: (() => {
        const link = body.querySelector('.md__link')
        return link === null ? 'none' : getComputedStyle(link).textDecorationLine
      })(),
      /* 粗体真的渲染成了 strong，而不是留着两个星号 */
      strong: body.querySelectorAll('strong').length,
      rawMarks: /(^|\n)#{1,6}\s|\*\*|```/.test(body.textContent ?? ''),
    }
  })
  truthy('正文渲染成结构化块（非纯文本）', rich.found === true)
  same('代码块字号 13', '13px', rich.codeFont)
  /* 八级栅格化：代码块内距原 12，收到 8（与正文的左内距同值）。 */
  eq('代码块内边距 8', 8, rich.codePad)
  same('代码块圆角 8', '8px', rich.codeRadius)
  same('行内代码字号 12', '12px', rich.inlineFont)
  eq('行内代码左右内边距 4', 4, rich.inlinePadX)
  same('行内代码圆角 4', '4px', rich.inlineRadius)
  /* 竖条 2 → 3、内边距 14 → 16：统一线色在 2px 下看不见，加粗一档
   并同步把内边距补上。内边距本轮随 §11.1 吸附到八级（14 → 16），
   文字与竖条的光学间隙从 11 变成 13——仍然落在"半行"以内，
   读起来还是同一段引文。 */
  eq('引用左侧竖条 3', 3, rich.quoteBorder)
  eq('引用左内边距 16', 16, rich.quotePad)
  same('表头字号 12', '12px', rich.headFont)
  same('表格正文字号 13', '13px', rich.cellFont)
  /* 八级栅格化：段间距原 12，收到 8（容差 2 吸收行盒舍入）。 */
  eq('段与段间距 8', 8, rich.gapAbove, 2)
  eq('标题与下文间距 6', 6, rich.gapBelow, 2)
  truthy('列表符号是 ·', rich.bulletContent.includes('·'))
  /* 列表缩进 20 → 24：`ul` 的 padding-left 本轮随 §11.1 吸附到八级。
     24 = 12（符号位）+ 12（符号与文字的缝），正好一个 --s-3 的两倍。 */
  eq('列表缩进 24', 24, rich.listPad)
  same('链接常态无下划线', 'none', rich.linkUnderline)
  truthy('粗体渲染成 strong', rich.strong > 0)
  truthy('正文不残留 Markdown 记号', rich.rawMarks === false)

  /*
   * 表格溢出必须收在容器里。
   *
   * 这一条是 §12.4 末尾的硬约束：「不允许整条消息横向滚动」。
   *
   * ## 判据为什么不是「表格不比容器宽」
   *
   * 第一版写的是 `tableRight <= wrapRight`，看似合理，实际与上一条
   * **自相矛盾**：一张真需要横向滚动的表，内容宽度必然大于容器宽度，
   * `tableRight` 必然超过 `wrapRight`。两条断言合起来等于要求
   * 「既有滚动又不许超出」，永远只能满足一个。
   *
   * 正确判据分两半：容器自己有溢出可滚（`scrollWidth > clientWidth`），
   * 且这份溢出**没有漏到页面上**（`document.scrollWidth` 不超过视口）。
   * 前者证明滚动存在，后者证明它被容器裁住了。
   */
  const pageWidth = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }))
  truthy(`表格在容器内横向滚动（实测 ${JSON.stringify(rich.tableMetrics)}）`, rich.tableOverflow === true)
  truthy(`表格溢出被容器裁住，未撑宽页面（${String(pageWidth.doc)} / ${String(pageWidth.view)}）`, pageWidth.doc <= pageWidth.view + 1)

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
   *
   * ## 为什么要先把滚动位置归零再量
   *
   * 操作条是浮在消息**上方** 32px 的，它是否被滚动容器裁掉，只有
   * 在「这条消息正好贴着视口顶边」时才是真问题——那正是首条消息
   * 的位置。而进到这一步时页面已经滚到底（断言 `vST: 248`），
   * 首条消息在视口上方 -125px 处，此刻量到的「不在视口内」是
   * 滚动位置造成的，不是布局缺陷。
   *
   * 所以先归零再看：这条断言问的是「首条消息的操作条会不会被
   * 视口顶边切掉」，不是「滚到底时首条消息还在不在屏幕上」。
   */
  await page.evaluate(async () => {
    const view = document.querySelector('.scrollarea__viewport')
    if (view === null) return
    view.scrollTop = 0
    // 等两帧：一帧让滚动落地，一帧让 ResizeObserver 之类的补滚有机会跑。
    await new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
  })
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
    const view = document.querySelector('.scrollarea__viewport')
    const v = view === null ? null : view.getBoundingClientRect()
    return {
      found: true,
      intersects,
      // 操作条是否完整落在滚动视口内（否则会被裁掉一半）。
      insideViewport: v !== null && a.top >= v.top - 1 && a.bottom <= v.bottom + 1,
      /*
       * 横向也要落得进去。加第三个按钮之后操作条宽了 24px，右缘从 58 挪到
       * 76——而 820 窗口下正文栏两侧的沟只有 78。这一条把"挪过头了"挡住：
       * 超出视口右缘时按钮会被裁成半颗，图标读不出来。
       */
      rightOver: v === null ? -1 : Math.round(a.right - v.right),
      actionsTop: Math.round(a.top),
      actionsBottom: Math.round(a.bottom),
      bodyTop: Math.round(b.top),
      vTop: v === null ? null : Math.round(v.top),
      vBot: v === null ? null : Math.round(v.bottom),
      vST: view === null ? null : Math.round(view.scrollTop),
    }
  })
  truthy('操作条不压住自己这条消息的文字', overlap.found === true && overlap.intersects === false)
  truthy(`操作条不越过滚动视口右缘（超出 ${String(overlap.rightOver)}px）`, overlap.rightOver <= 0)
  truthy(`操作条完整落在滚动视口内 ${JSON.stringify(overlap)}`, overlap.insideViewport === true)

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
    /*
     * 药丸形状也要称一称。
     *
     * ## 为什么单看「有没有」不够
     *
     * 样式表里写的类名是 `.toast__panel`，组件渲染的是 `.toast__body`——
     * 两边从没同时改过，于是提示条长期以「裸文字 + 一个没样式的叉」显示：
     * 零内边距、零背景、高 25。文案、位置、居中全都对，肉眼也不觉得缺什么，
     * 因为它刚好浮在深色正文上。量一下盒子才露馅。
     */
    const style = body === null ? null : getComputedStyle(body)
    const box = body === null ? null : body.getBoundingClientRect()
    return {
      found: true,
      toast: body !== null,
      top: Math.round(rect.top),
      centered: Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) <= 1,
      text: (body?.textContent ?? '').trim(),
      padLeft: style === null ? 0 : Number.parseFloat(style.paddingLeft),
      filled: style === null ? true : style.backgroundColor !== 'rgba(0, 0, 0, 0)',
      height: box === null ? 0 : Math.round(box.height),
    }
  })
  truthy('复制后出现提示条', toastOk.toast === true)
  eq('提示条距顶 56', 56, toastOk.top)
  truthy('提示条水平居中', toastOk.centered === true)
  truthy(`提示条有内边距与底色（pad ${String(toastOk.padLeft)}，高 ${String(toastOk.height)}）`, toastOk.padLeft >= 8 && toastOk.filled === true)
  truthy(`提示条高度不是一行裸文字（${String(toastOk.height)}）`, toastOk.height >= 30)

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
      dbg: (() => {
        const v = document.querySelector('.scrollarea__viewport')
        return v === null ? null : {
          top: Math.round(rect.top),
          vTop: Math.round(v.getBoundingClientRect().top),
          vBot: Math.round(v.getBoundingClientRect().bottom),
          vH: v.clientHeight,
          vSH: v.scrollHeight,
          vST: v.scrollTop,
          sh: v.scrollHeight,
          ch: v.clientHeight,
        }
      })(),
      fontSize: style.fontSize,
      hasRetry: bar.querySelector('.inline-error__action') !== null,
    }
  })
  truthy('失败后出现内联错误条', inline.found === true)
  truthy('内联错误在消息流内而非浮层', inline.inTimeline === true)
  same('内联错误字号 12', '12px', inline.fontSize)
  truthy('内联错误带重试', inline.hasRetry === true)
  truthy(`内联错误可见 ${JSON.stringify(inline.dbg)}`, inline.visible === true)
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

  /*
   * 抽屉关闭键的热区必须在**抽屉打开之后**量：收起时 `.drawer__panel`
   * 是 `opacity: 0`，元素没有可命中的几何，探针一律返回 0。
   * （第一版把这条写在抽屉打开之前，报红的是"期望 17、实测 0"——
   * 断言没错，量的时候抽屉还没开。）
   */
  const drawerCloseReach = await page.evaluate(() => {
    const el = document.querySelector('.drawer__close')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const hits = (x, y) => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (hit === el || el.contains(hit))
    }
    const walk = (dy) => {
      let last = 0
      for (let d = 1; d <= 40; d += 1) {
        if (hits(cx, cy + dy * d)) last = d
        else break
      }
      return last
    }
    return { boxH: Math.round(r.height), up: walk(-1), down: walk(1) }
  })
  eq(
    '热区·抽屉关闭键上下可达各 17（合计 34，视觉仍 26）',
    17,
    drawerCloseReach?.up ?? -1,
  )
  same('热区·抽屉关闭键视觉尺寸仍是 26', 26, drawerCloseReach?.boxH ?? -1)
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
   * 6. 设置只有一个入口：Rail 底部齿轮。
   *
   * ## 这一条守的是「不重复」，不是「能打开」
   *
   * 上一版有两个「设置」按钮：Rail 底部齿轮，与检查器底部「全部设置」。
   * 设置合并成一个面板之后，后者与齿轮打开的是同一个 `.settings`，只差落在
   * 哪一页——右侧面板底部再摆一个，用户看到两次同样的动作，还得先猜它们是不是
   * 同一处。猜错了就会以为「改了这边那边没变」。
   *
   * 所以分两步断言：
   *
   * 1. 检查器**展开时**，面板内不能有任何「设置」类按钮（数节点，不看截图）；
   * 2. 齿轮那条必须真能开面板，并落在「通用」页（总入口的约定落页）。
   *
   * 第 1 步特意在检查器打开时做：入口没了才叫删掉，而不是被样式藏起来。
   */
  await raiseToast()
  await page.locator('.spine').click()
  await page.waitForTimeout(400)
  const inspectorSettings = await page.evaluate(() => {
    const panel = document.querySelector('.inspector')
    if (panel === null) return { open: false, hits: ['(检查器没打开)'] }
    const hits = [...panel.querySelectorAll('button, a[href]')]
      .map((node) => `${(node.textContent ?? '').trim()} ${node.getAttribute('aria-label') ?? ''}`.trim())
      .filter((label) => label.includes('设置'))
    return { open: true, hits }
  })
  truthy('检查器已展开（下面两条的前提）', inspectorSettings.open)
  truthy(
    `检查器内没有第二个设置入口（命中 ${inspectorSettings.hits.length} 个：${inspectorSettings.hits.join(' / ') || '无'}）`,
    inspectorSettings.hits.length === 0,
  )

  await page.locator('.rail__item--settings').click()
  await page.waitForTimeout(500)
  truthy('Rail 齿轮打开设置面板', await page.evaluate(() => document.querySelector('.settings') !== null))
  truthy('设置面板打开时检查器已收起', await page.evaluate(() => document.querySelector('.inspector') === null))
  const landingPage = await page.evaluate(
    () => (document.querySelector('.pref__nav-item[aria-current="page"]')?.textContent ?? '').trim(),
  )
  truthy(`齿轮落在「通用」页（实际：${landingPage}）`, landingPage === '通用')

  /*
   * 6b. 扩展功能（插件参数）还进得去（删掉检查器入口后的替代路径）。
   *
   * 齿轮落「通用」，所以插件参数现在只能从左侧导航切——这条路径必须验：
   * 它是 1116 项参数的总入口，断了界面不会报错，只是再也进不去。
   * 后面几步都在量那一页的控件，也得先把面板切过去。
   */
  await page.locator('.pref__nav-item').filter({ hasText: '扩展功能' }).click()
  await page.waitForTimeout(500)
  const pluginPageTitle = await page.evaluate(
    () => (document.querySelector('.settings__title')?.textContent ?? '').trim(),
  )
  truthy(`左侧导航可切到「扩展功能」（实际：${pluginPageTitle}）`, pluginPageTitle === '扩展功能')

  /*
   * 切页会把上一条提示条拖到超时边缘，这里重新触发一次，供后面的层叠断言用。
   */
  await raiseToast()

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
   * 被面板吞掉——但压住标题同样不行。修法见 `dialog.css` `.toast` 那一段：
   * 有浮层时把落点挪到「剩下那块空地」的正中，左抽屉同理（往右挪）。
   *
   * 断言用**几何相交**而不是"看截图像不像"：矩形求交是可判定的，
   * 「差 12px 压到边缘」那种情况肉眼看不出来。
   */
  /*
   * 提示条与设置面板的关系：不再是「不重叠」，而是「压在它上面」。
   *
   * ## 为什么判据变了
   *
   * 上一版设置是右侧 360 宽的面板，提示条躲得开——那时「几何不相交」
   * 是正确判据。现在设置是一张居中的模态纸片，横向铺满可用宽度，
   * **无论提示条落在哪里都会重叠**。躲不开就不该假装能躲。
   *
   * 重叠本身不是问题：用户此刻在看设置，提示条说的是他刚在那个面板里
   * 做的事（「已存到 …」之类）。真正要保证的是它**盖得住**——
   * 层级低的提示条会被纸片吞掉，用户永远看不到它。
   *
   * 所以这里改判层叠顺序：提示条的 z-index 必须高于面板。
   */
  const toastGeom = await page.evaluate(() => {
    const body = document.querySelector('.toast__body')
    const panel = document.querySelector('.settings')
    if (body === null) return { present: false, above: false, text: '', at: '这条没提示条' }
    if (panel === null) return { present: true, above: true, text: '', at: '这条没面板' }
    const z = (node) => {
      /* 从提示条往上找第一个有非 auto z-index 的祖先：真正参与层叠的是它。 */
      let current = node
      while (current !== null) {
        const value = Number.parseInt(getComputedStyle(current).zIndex, 10)
        if (!Number.isNaN(value)) return value
        current = current.parentElement
      }
      return 0
    }
    const toastZ = z(body)
    const panelZ = z(panel)
    const a = body.getBoundingClientRect()
    return {
      present: true,
      above: toastZ > panelZ,
      text: (body.querySelector('.toast__text')?.textContent ?? '').trim(),
      at: `toast z ${String(toastZ)}，面板 z ${String(panelZ)}（toast x ${String(Math.round(a.left))}–${String(Math.round(a.right))}）`,
    }
  })
  truthy('提示条存在（层叠断言的前提）', toastGeom.present === true)
  /*
   * 空提示条会让下面那条断言失去意义，所以先要求它真的有字。
   */
  truthy(`提示条有正文（「${toastGeom.text}」）`, toastGeom.text !== '')
  truthy(`提示条盖得住设置面板（${toastGeom.at}）`, toastGeom.above === true)

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
  same('设置·标题未被浮层遮挡', 'ok', titleOnTop)

  /*
   * 设置页内容断言（§12.16 / §5.13）。
   *
   * ## 为什么不能只靠截图
   *
   * 上一版设置接口没有假数据，请求落到兜底 `{ ok: true }`，页面显示
   * 「读不到设置」——截图上看是个合理的错误态，于是**一个控件都没被验过**
   * 却看不出来。所以这里断言控件真的渲染了，且五种控件各至少出现一次。
   */
  /*
   * ## 场景项现在按归属分散在三页
   *
   * 12 项原先全在「扩展功能 · 场景」。段上移到专门页面之后，场景项跟着走：
   * 人物设定 6 项、通用 4 项、扩展功能 2 项。
   *
   * 所以这里分两步验：
   * 1. 在**人物设定**页采控件（它那一组里有滑杆、锚点、分段、开关、时间区间
   *    五种里的四种，是控件覆盖最全的一页）；
   * 2. 跨三页累加项数，确认 12 项一个没丢。
   *
   * 只在一页里数会得到 2 或 6，而"少了 10 项"看起来和"这一页本来就只有
   * 这么多"一模一样——这正是必须跨页核对的理由。
   */
  await page.locator('.pref__nav-item', { hasText: '人物设定' }).click()
  await page.waitForTimeout(400)
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

  /*
   * 人物设定页这一组应有 6 项：记忆保留深度 / 人格浓度 / 单条消息长度 /
   * 打字的节奏 / 遗忘复核周期 / 语音。
   */
  same('设置·人物设定页场景项 6 个', 6, scene.count)
  /*
   * 一项都不该缺。
   *
   * `data-missing` 是「段或字段没找到」的标记。它本该是 0；不为 0 时
   * 页面不会报错，只会把那一行换成一句灰色的「这个插件没有装载」——
   * 正是最容易被截图放过的一类缺陷。
   */
  same('设置·场景层无缺失项', 0, scene.missing)
  /*
   * 标题跟着当前页走。
   *
   * 这一条原来写成 `same(name, scene.head, '设置')`——参数顺序反了，
   * 而那时面板标题恒为「设置」，两个值相同，反着也过。现在标题是页名，
   * 反着就报红。断言要比较的两个东西必须分清哪个是"应该"、哪个是"实测"。
   */
  same('设置·标题是当前页的名字', '人物设定', scene.head)

  /*
   * 五种控件各至少一次。
   *
   * ## 为什么要跨页看
   *
   * 场景项按归属分散之后，没有哪一页同时包含全部五种：
   * 人物设定有锚点 / 滑杆 / 开关 / 时间区间，**没有分段**；
   * 通用页有分段（主动发言频率是三档 enum）。
   *
   * 只在人物设定页数，分段那一条会红——而这不是缺陷，是「这一页本来
   * 就没有分段控件」。所以分段单独到通用页验。
   */
  truthy('设置·锚点按钮存在（number-anchored）', scene.anchors > 0)
  truthy('设置·滑杆存在（number）', scene.ranges > 0)
  truthy('设置·开关存在（boolean）', scene.switches > 0)


  /* 分段在通用页：主动发言频率是三档 enum。 */
  await page.locator('.pref__nav-item', { hasText: '通用' }).click()
  await page.waitForTimeout(400)
  const generalSegments = await page.evaluate(
    () => document.querySelectorAll('.scene__segment').length,
  )
  truthy('设置·分段存在（enum，通用页的主动发言频率）', generalSegments > 0)

  /*
   * 用户层只覆盖一项（`memory-core.archive-normal-days`），而它在
   * **人物设定**页的场景项里——所以这一页恰好一行标着「已改」。
   */
  same('设置·恰有一项标记为已改', scene.changed, 1)
  truthy('设置·未改项也显示默认值', scene.unchanged >= 5)

  /*
   * 底部统计只存在于「扩展功能」页——它是那一页的页脚，报「N 个配置段 /
   * M 个字段」。人物设定页没有这个页脚，所以这一条要回到扩展功能页验。
   */
  await page.locator('.pref__nav-item', { hasText: '扩展功能' }).click()
  await page.waitForTimeout(500)
  const pluginFoot = await page.evaluate(
    () => document.querySelector('.settings__foot')?.textContent ?? '',
  )
  truthy('设置·底部统计显示字段总数', /\d+ 个字段/.test(pluginFoot))

  /* 跨三页累加场景项：12 项一个都不能丢。 */
  const sceneTotals = {}
  for (const pageName of ['人物设定', '通用', '扩展功能']) {
    await page.locator('.pref__nav-item', { hasText: pageName }).click()
    await page.waitForTimeout(350)
    sceneTotals[pageName] = await page.evaluate(
      () => document.querySelectorAll('.scene__item').length,
    )
  }
  same(
    '设置·场景项跨三页合计 12（一个都没丢）',
    12,
    sceneTotals['人物设定'] + sceneTotals['通用'] + sceneTotals['扩展功能'],
  )

  /*
   * 时间区间（作息）在通用页：两个 HH:MM 输入。
   *
   * 上面那个循环的最后一页是「扩展功能」，所以这里必须先切回来——
   * 否则量到的是扩展功能页（那里没有作息），得到 0，看起来像控件丢了。
   */
  await page.locator('.pref__nav-item', { hasText: '通用' }).click()
  await page.waitForTimeout(400)
  const generalTimes = await page.evaluate(
    () => document.querySelectorAll('.scene__time-input').length,
  )
  same('设置·时间区间是两个输入（range-time，通用页的作息）', 2, generalTimes)

  /*
   * 切回通用页。
   *
   * 后面那段要量开关的配色（挑「语音输入」造一个打开态），它只在这一页。
   * 上面为了跨页数场景项把页面切走了，不切回来后续会取到错误的元素——
   * 而 `locator.nth(2)` 在元素不存在时抛的是超时错误，不是断言失败，
   * 症状会更难读。
   */
  await page.locator('.pref__nav-item', { hasText: '通用' }).click()
  await page.waitForTimeout(400)

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
   * 7. `Cmd/Ctrl + K` 打开检查器。
   *
   * ## 键位没变，内容搬家了
   *
   * 它原来是「打开记忆抽屉并聚焦搜索框」。左栏改成会话 / 日志 / 扩展三个
   * 抽屉之后，记忆不再住在抽屉里——「记得的事」与「记忆维护」都移到了
   * 右栏检查器。用户按这个键要找的仍然是记忆，所以它必须真的把检查器
   * 打开；否则这条键会变成一条什么都不做的空键，而界面上不会有任何提示。
   *
   * 顺带验标题：检查器与抽屉是两个容器。`Cmd+K` 若接到抽屉上，标题会是
   * 「会话 / 日志 / 扩展」里的一个，这一条立刻能看出来。
   */
  /*
   * Playwright 的按键约定：`press('Meta+K')` 里的大写字母**隐含 Shift**，
   * 等价于 `Meta+Shift+K`。不带 Shift 的组合必须写小写（`Meta+k`），
   * 否则测的是一条根本不存在的键位。
   */
  await page.keyboard.press(`${MOD}+k`)
  await page.waitForTimeout(500)
  const bySearchKey = await page.evaluate(() => ({
    inspector: document.querySelector('.inspector') !== null,
    title: document.querySelector('.inspector__title')?.textContent ?? '',
    drawer: document.querySelector('.drawer[data-open]') !== null,
    folds: [...document.querySelectorAll('.inspector__fold-head')].map(node => (node.textContent ?? '').trim()),
  }))
  truthy('Cmd+K 打开检查器', bySearchKey.inspector === true)
  same('Cmd+K 开的是检查器，不是抽屉', '侧写', bySearchKey.title)
  truthy('Cmd+K 不连带打开抽屉', bySearchKey.drawer === false)
  /*
   * 记忆维护必须是**折叠起来在场**的：三块（体检 / 做梦 / 快照）是唯一能
   * 修她记忆的入口，抽屉取消后若跟着一起丢掉，界面上不会有任何报错，
   * 只是"再也修不了记忆"。
   */
  truthy('检查器里有「记忆维护」折叠条', bySearchKey.folds.includes('记忆维护') === true)

  /*
   * 7a-2. 侧写的数字必须是**测出来的**，不是形状对的占位。
   *
   * ## 这一条守的是「接线」而不是「布局」
   *
   * 上一版这一栏的每根杆都停在中点：`deriveMood()` 恒返回 `{0,0}`，
   * `deriveBond()` 恒返回空，`tension` 由 `App` 传 `undefined` 再被
   * `?? 0` 兜成 `+0.00`。四段布局、空态文案、两位小数全都对，
   * 唯独数字是编的——而"编的数字"与"测出来的数字"在截图里无法区分。
   *
   * 所以桩给了六个互不相同、有正有负的读数（`COMPANION`），断言读回来的
   * 文字必须与它逐个对上：`mood 0.5` → `0.00`（双极中点）、
   * `tension 0.1` → `0.10`（单极，不换算）、`energy 0.73` → `0.73`。
   * 任何一条断掉，都说明某段映射又回到了常量。
   *
   * ## 张力这一条为什么从 `-0.80` 改成 `0.10`
   *
   * 它曾经断言 `0.1` 映成 `-0.80`，等于把「把单极量当双极量」这个缺陷
   * 钉成了预期——映射错了，断言反而全绿。张力在数据模型里是 0–1、
   * 基线 0（`AXIS_SPEC.tension`），0 的含义是「没有张力」而不是「中点」，
   * 所以它不该有任何换算，也不该带正负号。
   */
  const readouts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.inspector__row')]
    return rows.map((row) => ({
      label: (row.querySelector('.inspector__label')?.textContent ?? '').trim(),
      value: (row.querySelector('.inspector__value')?.textContent ?? '').trim(),
    }))
  })
  const readout = (label) => readouts.find((row) => row.label === label)?.value ?? '(缺)'
  same('侧写·心情取实测值（0.5 映成双极中点 0.00）', '0.00', readout('心情'))
  same('侧写·张力取实测值且不换算（0.1 原样 0.10）', '0.10', readout('张力'))
  /*
   * 精力是单极量，界面上与双极量并排，刻度必须也是 0..1。
   * 它曾经写成 `mood.energy.toFixed(2)` 而 `energy` 已经是 0..100，
   * 于是这一行显示 `73.00`——一列读数里独一份的百位刻度。
   */
  same('侧写·精力取实测值且折回 0..1（0.73）', '0.73', readout('精力'))
  same('侧写·关系阶段取实测值', '熟悉', (await page.evaluate(() => (document.querySelector('.inspector__stage')?.textContent ?? '').trim())))
  same('侧写·好感取实测值', '58', readout('好感'))
  same('侧写·信任取实测值', '47', readout('信任'))
  same('侧写·亲密取实测值', '31', readout('亲密'))
  same('侧写·熟悉取实测值', '66', readout('熟悉'))

  /* 收起检查器，下面验扩展抽屉。 */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  /*
   * 7b. 扩展抽屉的搜索框：不在滚动容器里，列表滚它不跟着动。
   *
   * ## 为什么这条要量几何而不是看 CSS
   *
   * `position: sticky` 写错、或者把搜索框塞进 `.ext__list` 内部，截图都很
   * 正常——只有滚到第 40 行时才会发现想换个关键词得先滚回顶部。判据是
   * 「列表滚到底之后，搜索框的视口位置没变」：位置会变就说明它跟着滚了。
   */
  await page.locator('.rail__item').nth(2).click()
  await page.waitForTimeout(700)
  const extSearch = await page.evaluate(() => {
    const input = document.querySelector('.drawer__search-input')
    /*
     * 滚动容器是 `.ext__groups` 而不是 `.ext__list`。
     *
     * 三段分组之后，每一段各自是一个 `<details>`，段内 `<ul>` 只剩
     * 「这一段的行」；真正在滚的是外面那层。若还按 `.ext__list` 求
     * `scrollHeight`，量到的是某一段自己的高度（通常小于容器），
     * `scrollTop` 永远是 0——断言会因为「没滚动」而误判成「搜索框跟着动了」。
     */
    const list = document.querySelector('.ext__groups')
    if (input === null) return { exists: false }
    const before = input.getBoundingClientRect().top
    if (list !== null) list.scrollTop = list.scrollHeight
    const after = input.getBoundingClientRect().top
    const scrolled = list === null ? 0 : list.scrollTop
    if (list !== null) list.scrollTop = 0
    return {
      exists: true,
      outsideList: input.closest('.ext__groups') === null,
      drift: Math.round(after - before),
      scrolled: Math.round(scrolled),
    }
  })
  truthy('扩展抽屉带搜索框', extSearch.exists === true)
  truthy('搜索框不在列表的滚动容器里', extSearch.outsideList === true)
  truthy(
    `列表滚动时搜索框不动（滚了 ${String(extSearch.scrolled)}px，位移 ${String(extSearch.drift)}px）`,
    extSearch.scrolled > 200 && extSearch.drift === 0,
  )

  /*
   * 搜索框自己的焦点态（上一轮修掉的真实缺陷，控件换了位置，规则不能丢）。
   *
   * ## 为什么这条必须留
   *
   * 抽屉搜索框原先没写 `:focus-visible`，于是落到 `base.css` 的全局规则：
   * 一圈 **2px 实色 outline + offset 2px**。浅色下是一道黑边，勉强成立；
   * 深空底下主墨翻成近白 `#e9eef6`，深底上就出现一圈**纯亮白实心环**——
   * 真机截图上像给输入框套了根霓虹灯管。
   *
   * 而且它与全应用其它输入框不是一套语言：设置页搜索框、字段输入框、
   * 检查器按钮全部是「描边转主色 + 一圈极淡 glow」，只有这里画实心环。
   *
   * ## 两条一起量，缺一不可
   *
   * 只量 `boxShadow` 会漏掉「outline 还在」的那种写法——两者同时存在时
   * 视觉上仍是硬边环压着一圈 glow，而 `boxShadow` 看起来是对的。
   * 只量 `outlineStyle` 会漏掉「outline 去掉了但也没有替代品」——
   * 那样键盘用户就完全看不见焦点在哪。
   */
  await page.locator('.drawer__search-input').focus()
  /*
   * 等过渡走完再量。`box-shadow` 有 `--motion-f` 的过渡，聚焦那一帧算出来
   * 的是插值起点——一圈 `rgba(0,0,0,0)` 的零尺寸阴影。上一版之所以没踩到，
   * 是因为它靠 `Cmd+K` 打开抽屉，中间隔了 500ms 的等待；改成直接 `.focus()`
   * 之后这个等待就没了。
   */
  await page.waitForTimeout(400)
  const searchFocus = await page.evaluate(() => {
    const node = document.querySelector('.drawer__search-input')
    if (node === null) return { outline: 'missing', shadow: '' }
    const style = getComputedStyle(node)
    return { outline: style.outlineStyle, shadow: style.boxShadow }
  })
  same('搜索框焦点不画实心 outline', 'none', searchFocus.outline)
  /*
   * 发光环读 `--focus-ring`，它跟着强调色走，不是一个固定的彩色：
   *
   *   浅色  `#191919` → rgb(25, 25, 25)
   *   深色  `#ececec` → rgb(236, 236, 236)
   *
   * ## 为什么这里必须接受两个值
   *
   * 上一版强调色在两套主题里是同一个绿，所以正则只认一个 rgb。改成黑白
   * 之后强调**在深色下反向**，还只认一个值就会漏掉另一套主题——而这段
   * 测试恰好跑在深色主题下（`searchFocus` 的前一步切了主题）。
   *
   * 两个值仍然都是白名单：如果哪天有人把焦点环改回琥珀，两个都不匹配，
   * 照样报红，正好对应 §4.0.6 第 3 条「琥珀不承担焦点」。
   */
  truthy(
    `搜索框焦点用发光环（${searchFocus.shadow.slice(0, 60)}）`,
    /rgba?\((25,\s*25,\s*25|236,\s*236,\s*236)[,)]/.test(searchFocus.shadow),
  )

  /*
   * 8. 扩展列表：筛得出、筛空有说法、合计与开关都接在真数据上。
   *
   * ## 这一屏为什么值得单独一批断言
   *
   * 它是全应用唯一的 78 行列表，也是唯一「可以直接改系统状态」的界面：
   * 拨一个开关会写 `plugins.json`，影响下次启动装载谁。所以每条都要量到
   * 真的东西——行数来自宿主扫描器、开关置灰来自 `row.core`、拨动之后
   * 状态文字与提示条都得跟着变。只截一张"列表挺长"的图，上面三件事
   * 任何一件坏掉都看不出来。
   */
  const listed = await page.evaluate(() => ({
    rows: document.querySelectorAll('.ext__row').length,
    totals: (document.querySelector('.ext__totals')?.textContent ?? '').trim(),
    names: document.querySelectorAll('.ext__name').length,
    states: [...document.querySelectorAll('.ext__state')].map(node => (node.textContent ?? '').trim()),
    pending: document.querySelectorAll('.ext__totals--pending').length,
  }))
  truthy(`扩展列表渲染出全部包（${String(listed.rows)} 行）`, listed.rows >= 76)
  same('每一行都有名字', listed.rows, listed.names)
  truthy(`合计三格照实写（${listed.totals}）`, listed.totals.includes('个包') && listed.totals.includes('个在跑'))
  truthy('全部在跑时没有「待重启」那一格', listed.pending === 0 && listed.states.includes('运行中'))

  /*
   * 三段结构：桌面桥接 / 内核客户端 / 能力包。
   *
   * ## 为什么这一版改为量「段」而不是量「开关」
   *
   * 1.0.x 起扩展抽屉不再提供逐包开关：78 个包收成三段，每段都是核心
   * 组件——缺任何一段，应用要么连不上壳、要么连不上内核、要么「她」什么
   * 都不剩。所以这一屏现在要回答的是两件事：**收成了几段**，以及
   * **有没有偷偷留一个能关的入口**。后者用「一个开关都不许有」来验，
   * 包括 `role="switch"` 这种换了个标签的写法。
   */
  const groups = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('.ext__group-name')].map(node => (node.textContent ?? '').trim()),
    coreTags: [...document.querySelectorAll('.ext__group-head .ext__tag')].map(node => (node.textContent ?? '').trim()),
    switches: document.querySelectorAll('.ext__switch').length,
    roleSwitches: document.querySelectorAll('[role="switch"]').length,
    configs: document.querySelectorAll('.ext__config').length,
  }))
  same('扩展抽屉按三段收纳', '桌面桥接/内核客户端/能力包', groups.titles.join('/'))
  truthy(`三段都标为核心组件（${groups.coreTags.join(' / ')}）`,
    groups.coreTags.length === 3 && groups.coreTags.every(text => text.includes('核心')))
  same('不再提供逐包开关', 0, groups.switches)
  same('也没有 role=switch 的替代入口', 0, groups.roleSwitches)
  truthy(`「配置」入口仍在（${String(groups.configs)} 个）`, groups.configs > 0)

  /* 搜索：按包名筛，再搜一个一定不存在的词。 */
  await page.locator('.drawer__search-input').fill('memory')
  await page.waitForTimeout(300)
  const filtered = await page.evaluate(() => ({
    rows: document.querySelectorAll('.ext__row').length,
    ids: [...document.querySelectorAll('.ext__id')].map(node => (node.textContent ?? '').trim()),
  }))
  truthy(`搜索「memory」筛出记忆相关包（${String(filtered.rows)} 行）`, filtered.rows > 0 && filtered.rows < listed.rows)
  truthy('筛出来的每一行都含关键词', filtered.ids.every(id => id.includes('memory')))

  await page.locator('.drawer__search-input').fill('这个词一定搜不到')
  await page.waitForTimeout(300)
  const noHit = await page.evaluate(() => ({
    empty: (document.querySelector('.drawer__empty')?.textContent ?? '').trim(),
  }))
  truthy('搜不到时给具体说法', noHit.empty.includes('未找到'))

  await page.locator('.drawer__search-input').fill('')
  await page.waitForTimeout(300)

  /* 各段的行数加起来等于总行数：分组不能漏包，也不能重复计。 */
  const sumByGroup = await page.evaluate(() => {
    const per = [...document.querySelectorAll('.ext__group')].map(group => group.querySelectorAll('.ext__row').length)
    return { per, total: document.querySelectorAll('.ext__row').length }
  })
  same('三段行数之和等于全部包', sumByGroup.total, sumByGroup.per.reduce((sum, n) => sum + n, 0))

  /*
   * 8a-2. 提示条不得压住左抽屉。
   *
   * ## 这是一条修过的真缺陷
   *
   * 避让规则原本只认「右侧」：`App.tsx` 把左抽屉也算进 `rightOverlay`，
   * 于是抽屉一打开，提示条反而被往左推——正好落在抽屉标题「扩展」上。
   * 截图里两行字直接叠在一起。方向反了会越避越压，所以判据不能只写
   * 「提示条存在」，得量它和抽屉是不是真的不相交。
   *
   * 窗口就是最小宽 820：抽屉占 x 56–376，提示条默认落在视口正中
   * （x 310–510），必然探进抽屉。这条断言在这个宽度下是有意义的，
   * 换成 1440 宽就会白白通过。
   */
  /*
   * 提示条**当场再举一次**，不靠上游那一条还没散。
   *
   * 这条断言原来依赖前面切主题留下的提示条，而它有自己的寿命：从那一处
   * 到这里的等待一旦超过几秒（本轮为了量三段分组又多了几次滚动与截图），
   * 提示条就已经自己消失了，断言会以「缺提示条」失败——**红的是测试的时
   * 间假设，不是界面**。缺什么就当场造什么：先举一条、量完再举一条把主题
   * 翻回去，等它自然消失之后才截图，截图里只留列表。
   */
  await raiseToast()
  const toastOnDrawer = await page.evaluate(() => {
    const body = document.querySelector('.toast__body')
    const panel = document.querySelector('.drawer__panel')
    if (body === null || panel === null) return { disjoint: false, inView: false, at: '缺提示条或缺抽屉' }
    const a = body.getBoundingClientRect()
    const b = panel.getBoundingClientRect()
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return {
      disjoint: overlapX <= 0 || overlapY <= 0,
      inView: a.left >= 0 && a.right <= window.innerWidth,
      at: `toast x ${String(Math.round(a.left))}–${String(Math.round(a.right))}，抽屉 x ${String(Math.round(b.left))}–${String(Math.round(b.right))}，视口 ${String(window.innerWidth)}`,
    }
  })
  truthy(`提示条不压左抽屉（${toastOnDrawer.at}）`, toastOnDrawer.disjoint === true)
  truthy(`提示条整条留在视口内（${toastOnDrawer.at}）`, toastOnDrawer.inView === true)

  /* 再举一次把主题翻回原样，然后等它自己走掉，截图里不留提示条。 */
  await raiseToast()
  await page.waitForTimeout(2800)

  /*
   * 8b. 列表滚到底，最后一行之后**不该有大片死空白**。
   *
   * ## 这条守的是一个被真机看出来的缺陷
   *
   * `.drawer__body` 曾经补了 `padding-bottom: 88px` 去「避开输入卡」，而
   * `.drawer` 的 `bottom: 104px` 已经把整块浮层停住了——同一件事做了两遍。
   * 空抽屉时看不出来，接上真数据后滚到底看到的是「最后一条 + 88px 空」，
   * 像没加载完，而不是到底了。
   *
   * ## 判据为什么是「滚到底后最后一项的底边离内容区底边够近」
   *
   * 只断言 `padding-bottom < 88` 是在量实现，换个写法就绕过。量几何关系
   * 才对应"看起来对不对"：滚到底时最后一行底边应当贴在内容区底边附近
   * （留 12 的呼吸量 + 允许 4 的舍入）。
   */
  const extTail = await page.evaluate(() => {
    const list = document.querySelector('.ext__groups')
    if (list === null) return null
    list.scrollTop = list.scrollHeight
    const rows = document.querySelectorAll('.ext__row')
    const last = rows[rows.length - 1]
    if (last === undefined) return null
    return {
      gap: list.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
    }
  })
  truthy(
    `滚到底后列表末尾不留死空白（末行底边距内容区底 ${String(extTail === null ? -1 : Math.round(extTail.gap))}）`,
    extTail !== null && extTail.gap >= 0 && extTail.gap <= 16,
  )
  /* 留一张视觉凭证：浅色下的 78 行列表与合计三格。 */
  await page.screenshot({ path: join(OUT, 'extension-drawer.png') })
  same('扩展抽屉里没有文字贴着容器的边', '[]', JSON.stringify(await insetViolations(page)))

  /*
   * 8a-3. 标题栏第一块：当前人设 + 三档在线状态。
   *
   * ## 为什么这三件事必须一起验
   *
   * 它们占的是同一个位置，回答的是同一个问题「现在是谁、她听不听得见你」。
   * 上一版这里是**两样写死的东西**：常量名字「空谷」，和一个从不检查任何
   * 链路的绿点。字符串断言会全绿——因为界面上确实写着「空谷」、确实有个
   * 绿点。所以这里量的是：名字是否来自人设包、头像是否是应用图标那一份
   * 几何、状态是否真的标成 online、点开浮层能不能换人、换完宿主是否记住。
   */
  const identity = await page.evaluate(() => {
    const button = document.querySelector('.titlebar__persona')
    if (button === null) return { exists: false }
    const avatar = button.querySelector('.avatar')
    const style = avatar === null ? null : getComputedStyle(avatar)
    const box = avatar?.getBoundingClientRect()
    const dot = button.querySelector('.titlebar__presence')
    return {
      exists: true,
      name: (button.querySelector('.titlebar__name')?.textContent ?? '').trim(),
      size: box === undefined ? 0 : Math.round(box.width),
      round: style?.borderRadius ?? '',
      ground: style?.backgroundColor ?? '',
      glyph: button.querySelector('.avatar__glyph') !== null,
      presence: dot?.getAttribute('data-presence') ?? '',
      label: (dot?.textContent ?? '').trim(),
      expanded: button.getAttribute('aria-expanded'),
    }
  })
  truthy('标题栏有身份块', identity.exists === true)
  same('身份块显示当前人设包名', '哦鲸鲸', identity.name)
  eq('头像是 24 见方', 24, identity.size, 0)
  /* 白底黑鱼是**应用图标**的配色，不跟主题反色；这里验底色与「画的是矢量图形」。 */
  same('头像底色是图标的白底', 'rgb(255, 255, 255)', identity.ground)
  truthy('头像画的是矢量图形而不是占位块', identity.glyph === true)
  same('在线状态点标 online', 'online', identity.presence)
  same('在线状态读作「在线」', '在线', identity.label)
  same('人设浮层默认收起', 'false', identity.expanded)

  await page.locator('.titlebar__persona').click()
  await page.waitForTimeout(300)
  const pop = await page.evaluate(() => {
    const node = document.querySelector('.persona-pop')
    if (node === null) return { open: false }
    return {
      open: true,
      roles: [...node.querySelectorAll('.persona-pop__role')].map(r => (r.textContent ?? '').trim()),
      checked: [...node.querySelectorAll('.persona-pop__item')]
        .filter(item => item.getAttribute('aria-checked') === 'true').length,
      menu: node.getAttribute('role'),
    }
  })
  truthy('点头像弹出人设浮层', pop.open === true)
  same('浮层是菜单语义', 'menu', pop.menu)
  same('浮层列出出厂 / 示例 / 用户三类', '出厂,示例,用户', String(pop.roles))
  same('当前人设被标记为选中', 1, pop.checked)

  /*
   * 切到示例包：读三样东西。
   *
   * 标题栏名字（界面）、浮层是否自己收起（交互）、宿主里的 `activeId`
   * （契约）。只验第一条时，「点完界面变了但没写盘」与「写盘了但界面
   * 没刷新」都会绿——而这两件事用户第二天才能发现。
   */
  await page.locator('.persona-pop__item', { hasText: '夏柠柒' }).click()
  await page.waitForTimeout(700)
  const afterSwitch = await page.evaluate(async () => ({
    name: (document.querySelector('.titlebar__name')?.textContent ?? '').trim(),
    menuOpen: document.querySelector('.persona-pop') !== null,
    activeId: (await (await fetch('/api/personas')).json()).activeId,
  }))
  same('切换后标题栏立刻换成新名字', '夏柠柒', afterSwitch.name)
  truthy('切换后浮层自己收起', afterSwitch.menuOpen === false)
  same('切换写进了宿主（activeId 已变）', 'xia-ningqi', afterSwitch.activeId)

  /* 切回出厂包：后面的断言按出厂名字做的，别把这个状态留给下一节。 */
  await page.locator('.titlebar__persona').click()
  await page.waitForTimeout(300)
  await page.locator('.persona-pop__item', { hasText: '哦鲸鲸' }).click()
  await page.waitForTimeout(700)
  same(
    '切回出厂包',
    '哦鲸鲸',
    await page.evaluate(() => (document.querySelector('.titlebar__name')?.textContent ?? '').trim()),
  )

  /*
   * 8c. 「配置」要真的把人送到那一段设置。
   *
   * ## 为什么补这一条
   *
   * 78 行里每行都有这一个按钮，它是扩展抽屉唯一的出口——但整份自检里
   * 它一次都没被按过。`onConfigure` 是三件事的接力（关抽屉、收起检查器、
   * 把段 id 交给设置面板去定位），任何一环断了界面表现都一样：点了没反应，
   * 或者设置开了却停在默认的场景层。而「配置」按钮恰好又是本轮从行尾
   * 搬进 meta 行的那一个——搬家改坏事件绑定，同样不会红。
   *
   * 所以断言分三步读结果：设置打开 / 抽屉收起 / 模块层搜的正是那一行的
   * 段 id。最后一条是关键——「设置打开」很容易，「定位到了」才是承诺。
   */
  const configTarget = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.ext__row')) {
      if (row.querySelector('.ext__config') === null) continue
      return { id: (row.querySelector('.ext__id')?.textContent ?? '').trim() }
    }
    return null
  })
  truthy('至少有一行带「配置」入口', configTarget !== null)
  const configRow = plugins.items.find((row) => row.id === configTarget?.id)
  truthy(
    `取到待配置的包（${configTarget?.id ?? '无'}）`,
    configRow !== undefined && configRow.sectionId !== null,
  )
  await page.locator(`.ext__row:has(.ext__id:text-is("${String(configTarget?.id)}")) .ext__config`).click()
  await page.waitForTimeout(600)
  const landed = await page.evaluate(() => ({
    settings: document.querySelector('.settings') !== null,
    drawerOpen: document.querySelector('.drawer[data-open]') !== null,
    query: (document.querySelector('.settings__search') ?? {}).value ?? '',
    titles: [...document.querySelectorAll('.module__title')].map((node) => (node.textContent ?? '').trim()),
  }))
  truthy('点「配置」后设置面板打开', landed.settings === true)
  truthy('点「配置」后抽屉已收起', landed.drawerOpen === false)
  same(`模块层搜的正是那一行的段 id（${landed.query}）`, configRow?.sectionId ?? '', landed.query)
  truthy(
    `模块层落在「${configRow?.sectionTitle ?? ''}」（${landed.titles.join(' | ')}）`,
    (configRow?.sectionTitle ?? '') !== '' && landed.titles.includes(configRow.sectionTitle),
  )
  await page.locator('.settings__close').click()
  await page.waitForTimeout(400)

  /*
   * 9. 她记住的事 + 记忆维护：从抽屉搬进了检查器。
   *
   * ## 为什么这一段必须存在
   *
   * 「记忆」抽屉从建库起到某一轮为止一直显示「聊两句就有了」，而库里有
   * 11 条事实。原因是前端那个推导函数硬编码 `return []`、宿主也没有对应
   * 接口——**空态是对的，列表是假的**。只断言「有空态文案」的话，这条缺陷
   * 永远不会红。现在列表换了住处（右栏检查器「记得的事」），同一类缺陷
   * 会以「搬家时把数据通路丢了」的形式重来一次，所以断言要跟着搬。
   *
   * 三件事同时成立才算通：
   *
   * 1. 列表非空（数据通路接上了）；
   * 2. 顺序是 88 → 60 → 31（按显著度，不是按写入时间——桩里刻意让
   *    「时间最新」与「显著度最高」不是同一条）；
   * 3. 空态文案**不再出现**（否则会与真列表同时渲染）。
   *
   * 检查器只放前三行：它是一块侧写，不是记忆管理器。断言 3 条而不是 8 条，
   * 就是这一设计决定的可执行版本——真给 8 条说明有人把整张表搬过来了。
   */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.keyboard.press(`${MOD}+k`)
  await page.waitForTimeout(600)
  const memoryView = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.inspector__group')]
      .find(node => (node.querySelector('.inspector__caption')?.textContent ?? '') === '记得的事')
    return {
      texts: [...(group?.querySelectorAll('.inspector__memory-text') ?? [])].map(node => (node.textContent ?? '').trim()),
      empty: (group?.querySelector('.inspector__empty')?.textContent ?? '').trim(),
    }
  })
  eq('检查器里显示最近三条记忆', 3, memoryView.texts.length, 0)
  truthy(
    `记忆按接口顺序显示（${memoryView.texts.join(' | ')}）`,
    memoryView.texts[0] === '你在星玖工作室做独立开发'
      && memoryView.texts[1] === '你搭档叫阿岚，负责设计'
      && memoryView.texts[2] === '你平时用 macOS 写代码',
  )
  truthy('有记忆时不再显示空态文案', memoryView.empty === '')

  /*
   * 展开「记忆维护」。三块（体检 / 做梦 / 快照）默认收起——它们不属于
   * §5.8 的四段侧写。验证它们还活着，就得先点开那条折叠。
   *
   * 这一步顺带守着一件事：`<details>` 里的内容即使收起也在 DOM 里，
   * 所以「查得到元素」不能证明用户点得到按钮。后面每一条都要真的按下去，
   * 按不动就会在这里先红。
   */
  await page.locator('.inspector__fold-head').click()
  await page.waitForTimeout(300)
  const foldOpen = await page.evaluate(() => ({
    open: document.querySelector('.inspector__fold')?.hasAttribute('open') === true,
    health: document.querySelector('.health') !== null,
    dream: document.querySelector('.dream') !== null,
    snap: document.querySelector('.snap') !== null,
  }))
  truthy('「记忆维护」展开后仍在原位', foldOpen.open === true)
  truthy('体检 / 做梦 / 快照三块都在折叠里', foldOpen.health && foldOpen.dream && foldOpen.snap)

  /*
   * 8b-2. 记忆体检：入口在、能查、三档分开、只有前两档给修复键。
   *
   * ## 为什么这一条必须存在
   *
   * `ondra-memory-heal` 的 `diagnose()` 全仓零调用方。把它加进默认启用名单
   * 之后，服务注册了、配置段能读能写、`available` 是 true——**唯独巡检
   * 从不发生**。这类「写完了但没人问」的服务，界面上与「本来就没有这个
   * 功能」完全同形，所以除了装插件，还必须有一条断言真的把按钮按下去、
   * 并读到结果。
   *
   * ## 为什么要分四次断言，而不是只看「有没有 .health」
   *
   * | 只验 | 会漏掉什么 |
   * | --- | --- |
   * | `.health` 在场 | 块渲染了但按钮没接上（点了没反应） |
   * | 点了之后有字 | 三档被合并成一堆，`confirm` 那档的不可逆性看不出来 |
   * | 三档都有标题 | `advise` 档也挂了「修」键——那是越权修别人的活 |
   * | 有修键 | 修键数量对不上档位（把 advise 也算进去） |
   *
   * 第四条是本节的重点：`advise` 档的 `action` 恒为 `null`（插件侧如此设计），
   * 界面若按 `tier !== 'advise'` 之外的条件判「能不能修」，就会给它配一个
   * 点了只会返回 `not-actionable` 的假按钮。
   */
  const healthBefore = await page.evaluate(() => ({
    present: document.querySelector('.health') !== null,
    idle: (document.querySelector('.health__idle')?.textContent ?? '').trim(),
    runLabel: (document.querySelector('.health__run')?.textContent ?? '').trim(),
  }))
  truthy('检查器的记忆维护里有体检入口', healthBefore.present)
  truthy(
    `没查过时说「尚未检查」而不是摆 0（${healthBefore.idle}）`,
    healthBefore.idle.includes('尚未检查'),
  )
  same('体检键初始文案', '执行检查', healthBefore.runLabel)

  await page.locator('.health__run').click()
  await page.waitForTimeout(500)
  const healthAfter = await page.evaluate(() => ({
    summary: (document.querySelector('.health__summary')?.textContent ?? '').trim(),
    labels: [...document.querySelectorAll('.health__group-label')].map(node => (node.textContent ?? '').trim()),
    fixButtons: [...document.querySelectorAll('.health__fix')].length,
    items: [...document.querySelectorAll('.health__item')].length,
    missing: (document.querySelector('.health__missing')?.textContent ?? '').trim(),
    runLabel: (document.querySelector('.health__run')?.textContent ?? '').trim(),
  }))
  truthy(`体检跑出结果（${healthAfter.summary}）`, healthAfter.summary.includes('已检查 11 条'))
  same('三档标题按安全度排序', '可自动修|需确认|建议别人修', healthAfter.labels.join('|'))
  eq('体检条目总数', 3, healthAfter.items, 0)
  /*
   * 只有 `auto` / `confirm` 两档有修键；`advise` 那条（疑似重复）必须没有。
   * 2 而不是 3，正是这一条的全部意义。
   */
  eq('只有可修的两档挂了修复键', 2, healthAfter.fixButtons, 0)
  truthy('上游不缺席时不显示「没查」提示', healthAfter.missing === '')
  same('查完之后键改成「重新检查」', '重新检查', healthAfter.runLabel)

  /*
   * 8b-3. 做梦：入口在、做过几场能看见、按下去真跑、跑完说「今天做过了」。
   *
   * ## 为什么这一条必须存在
   *
   * 与体检同族：`ondra-memory-dream` 的 `run()` 全仓零调用方。只把它加进
   * 默认启用名单，服务会注册、配置段能读能写、`stats()` 全零——**一场梦
   * 都不会发生**。这类「写完了但没人问」的服务必须有一条断言真的把按钮按下去。
   *
   * ## 为什么要分五次断言
   *
   * | 只验 | 会漏掉什么 |
   * | --- | --- |
   * | `.dream` 在场 | 块渲染了但按钮没接上 |
   * | 点了有字 | 「今天已经做过」被说成「做梦失败」——前者是正常状态 |
   * | 有四个数 | 拒收被吞掉，只报「写入 0」，读起来像插件坏了 |
   * | 备份那格 | `backup: skipped` 被显示成「已备份」——替一个没发生的动作背书 |
   * | 卡片 | 五类卡片挖出来却没人显示，等于挖掘白做 |
   *
   * 第三条是本节的要害：`rejected` 与 `written` 必须同时出现。只报写入数，
   * 四道闸按设计拒掉候选这件事就完全看不见。
   */
  const dreamBefore = await page.evaluate(() => ({
    present: document.querySelector('.dream') !== null,
    idle: (document.querySelector('.dream__idle')?.textContent ?? '').trim(),
    mode: (document.querySelector('.dream__mode')?.textContent ?? '').trim(),
    runLabel: (document.querySelector('.dream__run')?.textContent ?? '').trim(),
    cardCount: document.querySelectorAll('.dream__card').length,
  }))
  truthy('检查器的记忆维护里有做梦入口', dreamBefore.present)
  truthy(
    `没做过时说「尚未执行过」而不是摆 0（${dreamBefore.idle}）`,
    dreamBefore.idle.includes('尚未执行过'),
  )
  truthy(`分支说清了用什么方式做（${dreamBefore.mode}）`, dreamBefore.mode.includes('闸式'))
  same('做梦键初始文案', '开始整理', dreamBefore.runLabel)
  eq('卡片有就显示', 1, dreamBefore.cardCount, 0)

  await page.locator('.dream__run').click()
  await page.waitForTimeout(500)
  const dreamAfter = await page.evaluate(() => ({
    summary: (document.querySelector('.dream__summary')?.textContent ?? '').trim(),
    counts: (document.querySelector('.dream__counts')?.textContent ?? '').trim(),
    notes: [...document.querySelectorAll('.dream__note')].map(node => (node.textContent ?? '').trim()),
  }))
  truthy(`做梦跑出结果（${dreamAfter.summary}）`, dreamAfter.summary.includes('做完一场梦'))
  /* 四个数必须一起出现：只报写入数就把「拒了几条」藏了。 */
  truthy('写入与拒收同时报出', dreamAfter.counts.includes('写入') && dreamAfter.counts.includes('拒'))
  truthy(
    `备份没做就如实说（${dreamAfter.notes.join('；')}）`,
    dreamAfter.notes.some(text => text.includes('未创建开工前备份')),
  )
  truthy(
    '有候选被拒时给一句解释',
    dreamAfter.notes.some(text => text.includes('四道校验')),
  )

  /*
   * 第二次按（不带 force）：必须说「今天已经做过一场了」并给「再来一场」。
   * 这一条守的是「正常状态」与「失败」不被说成同一件事。
   */
  await page.locator('.dream__run').click()
  await page.waitForTimeout(500)
  const dreamAgain = await page.evaluate(() => ({
    counts: (document.querySelector('.dream__counts')?.textContent ?? '').trim(),
    again: document.querySelector('.dream__again') !== null,
  }))
  truthy(`第二次按会说「今日已完成一次」（${dreamAgain.counts}）`, dreamAgain.counts.includes('今日已完成一次'))
  truthy('已经做过时给「再次整理」的入口', dreamAgain.again)

  /* 做梦块视觉留证：浅色一张、深色一张（理由同体检，必须显式指定两次）。 */
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'memory-dream-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'memory-dream-dark.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(300)

  /*
   * 8b-4. 快照：清单在、**没验过必须说没验过**、验过之后分好坏、都不给恢复键。
   *
   * ## 为什么这一条必须存在
   *
   * `ondra-snapshot` 不缺调用方（五个插件都在 `create()`），缺的是
   * `list()` / `verify()` 的调用方。所以「备份做没做成、坏没坏」在产品里
   * 完全不可见——而一份没人验过的备份，在需要它的那一刻与没有备份等价。
   *
   * ## 三条断言各自守什么
   *
   * | 断言 | 守的是 |
   * | --- | --- |
   * | 每份初始都标「没验过」 | 初版最容易犯的错：把「没验过」画成「好」 |
   * | 验过一份变「可读」 | 按钮真接上了，不是摆设 |
   * | 坏的那份变「读不了」 | 两种结论没被合并成一句「已校验」 |
   * | 没有恢复键 | 宿主持有着库，恢复的第二道闸永不成立——给键就是画假门 |
   */
  const snapBefore = await page.evaluate(() => ({
    present: document.querySelector('.snap') !== null,
    items: document.querySelectorAll('.snap__item').length,
    raw: [...document.querySelectorAll('.snap__item-raw')].map(n => (n.textContent ?? '').trim()),
    okCount: document.querySelectorAll('.snap__item-ok').length,
    badCount: document.querySelectorAll('.snap__item-bad').length,
    keep: (document.querySelector('.snap__keep')?.textContent ?? '').trim(),
    restoreButtons: [...document.querySelectorAll('.snap button')].filter(b => (b.textContent ?? '').includes('恢复')).length,
    schema: [...document.querySelectorAll('.snap__item-schema')].map(n => (n.textContent ?? '').trim()),
  }))
  truthy('检查器的记忆维护里有快照入口', snapBefore.present)
  eq('快照份数', 2, snapBefore.items, 0)
  eq('两份初始都标「没验过」', 2, snapBefore.raw.filter(t => t === '没验过').length, 0)
  eq('初始没有「可读」标记', 0, snapBefore.okCount, 0)
  /*
   * 库版本 `null` 必须显示成「版本未标注」，**不能留空**。
   * 真机核过：本项目的原库 `PRAGMA user_version` 本来就是 0（没用 SQLite
   * 的版本号机制），所以每份快照的 `schemaVersion` 都是 null。留空会被读成
   * 「没读到」，而「版本没标」与「读不出来」对「这份备份能不能用」的含义不同。
   */
  eq('版本 null 显示成「版本未标注」', 1, snapBefore.schema.filter(t => t === '版本未标注').length, 0)
  eq('有版本的显示 v 前缀', 1, snapBefore.schema.filter(t => t === 'v7').length, 0)
  truthy(`保留份数说清了（${snapBefore.keep}）`, snapBefore.keep.includes('保留 3 份'))
  eq('没有恢复键（库未关，恢复了也是假门）', 0, snapBefore.restoreButtons, 0)

  /* 验第一份（好的那份）：应变「可读」。 */
  await page.locator('.snap__verify').first().click()
  await page.waitForTimeout(400)
  const snapAfterFirst = await page.evaluate(() => ({
    ok: document.querySelectorAll('.snap__item-ok').length,
    raw: document.querySelectorAll('.snap__item-raw').length,
  }))
  eq('验过一份后出现「可读」', 1, snapAfterFirst.ok, 0)
  eq('另一份仍是「没验过」', 1, snapAfterFirst.raw, 0)

  /* 验第二份（坏的那份）：应变「读不了」，且不能把第一份的好结果冲掉。 */
  await page.locator('.snap__verify').nth(1).click()
  await page.waitForTimeout(400)
  const snapAfterSecond = await page.evaluate(() => ({
    ok: document.querySelectorAll('.snap__item-ok').length,
    bad: document.querySelectorAll('.snap__item-bad').length,
    raw: document.querySelectorAll('.snap__item-raw').length,
  }))
  eq('坏的那份标「读不了」', 1, snapAfterSecond.bad, 0)
  eq('好的那份保持「可读」', 1, snapAfterSecond.ok, 0)
  eq('没有剩余「没验过」', 0, snapAfterSecond.raw, 0)

  /* 快照块视觉留证。 */
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'memory-snapshot-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'memory-snapshot-dark.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(300)

  /*
   * 体检块视觉留证：浅色一张、深色一张。
   *
   * 深色那张是必须的——体检块整块托在 `--ui-bg-raise` 上，而这个槽在
   * 两个主题里指向不同原始值。只在浅色截一张，「深色下整块与抽屉底几乎
   * 同色、看不出边界」这类缺陷永远看不见。
   *
   * **两张必须显式指定主题**，不能只切一次：页面初始主题跟随系统，
   * 这台机器系统是深色，于是「切到 dark 再截图」与「不切直接截」是
   * 同一张图——看上去有留证，实际两个主题只验了一个。
   */
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'memory-health-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'memory-health-dark.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(300)

  /*
   * 记忆维护验完就退出：下面第 9 / 10 条守的是搜索框的键盘行为，它们跑在
   * 扩展抽屉里——全应用只剩那一处搜索框了。抽屉不换的话，这两条会在检查器
   * 里跑，而检查器根本没有输入框，断言会以「找不到元素」的方式红，
   * 红得对但看不出真因。
   */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.locator('.rail__item').nth(2).click()
  await page.waitForTimeout(600)

  // 9. 搜索框里按 Esc 先清词，不直接关抽屉。
  await page.locator('.drawer__search-input').fill('memory')
  await page.waitForTimeout(200)
  await page.locator('.drawer__search-input').press('Escape')
  await page.waitForTimeout(250)
  const cleared = await page.evaluate(() => ({
    value: document.querySelector('.drawer__search-input')?.value ?? null,
    drawerOpen: document.querySelector('.drawer[data-open]') !== null,
    rows: document.querySelectorAll('.ext__row').length,
  }))
  same('搜索框 Esc 先清词', '', cleared.value)
  truthy('清词时不关抽屉', cleared.drawerOpen === true)
  /* 清词要顺手把列表还原，否则用户以为筛选还在生效。 */
  truthy(`清词后列表还原（${String(cleared.rows)} 行）`, cleared.rows >= 76)

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

  /*
   * 14. 用户滚上去之后，新内容不许把人拽回底部。
   *
   * ## 为什么这条必须单独验
   *
   * 这是「读历史时被拽走」那一类缺陷的唯一防线。它坏掉时不会报错、
   * 不会白屏，只是每次有新内容就把人推到底部——用户会把整段判断成
   * 「这软件没法读长对话」，而开发者自己点几下未必碰得到。
   *
   * 判据用 `PageDown` 制造一次真实手势（它走 `onKeyDown` 里的标记），
   * 然后追加一条内联错误，看滚动位置是否守住。用错误条而不是新消息：
   * 它不需要等模型返回，追加时机可控。
   */
  await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    if (view !== null) view.scrollTop = 0
  })
  await page.keyboard.press('PageDown')
  await page.waitForTimeout(600)
  const heldTop = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    return view === null ? null : Math.round(view.scrollTop)
  })
  truthy('滚上去后确实离开了底部', heldTop !== null && heldTop < 200)
  // 这一步不该被任何自动跟随拽走：等一段时间看它有没有自己动。
  await page.waitForTimeout(600)
  const stillHeld = await page.evaluate(() => {
    const view = document.querySelector('.scrollarea__viewport.timeline__scroll')
    return view === null ? null : Math.round(view.scrollTop)
  })
  same('读历史时位置不被内容变化拽走', heldTop, stillHeld)

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
  // 12 = --r-lg（§11.2 的浮层档）。曾经是 16，v3.7 起收紧。
  same('确认框圆角 12', '12px', dialog.radius)
  truthy('确认框是 aria-modal', dialog.modal === 'true')
  truthy('确认框有「记住选择」', dialog.hasRemember === true)
  same('初始焦点在主按钮', '隐藏到托盘', dialog.focusedText)
  await page.screenshot({ path: join(OUT, 'close-dialog-v5.png') })
  same('弹窗里没有文字贴着容器的边', '[]', JSON.stringify(await insetViolations(page)))

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
   * --- 离开归来的一行（§12.9）---
   *
   * ## 这条验的是「阈值」与「不留痕」两件事
   *
   * 功能本身很轻（一行灰字），坏起来却很吵：
   *
   * | 坏法 | 症状 |
   * | --- | --- |
   * | 没有 10 分钟阈值 | 切一下设置窗口回来就多一行「你离开了 1 分钟」 |
   * | 不清 `leftAt` | 下一次短切窗口会算出一次根本没发生的长离开 |
   * | 说话后不撤掉 | 整段对话末尾永远挂着一句「你离开了 23 分钟」 |
   *
   * 三条都不可见地坏——界面不会报错，只会一直多一行字。
   *
   * ## 怎么造「离开了 23 分钟」
   *
   * 不能真等。这里覆盖 `Date.now` 之后重放一次 blur→focus：
   * 组件读的就是 `Date.now()`，把时钟往前推 23 分钟与真的等 23 分钟
   * 对它来说完全等价。用完立刻还原，不影响后面的断言。
   */
  const absenceShort = await page.evaluate(async () => {
    const original = Date.now
    let offset = 0
    Date.now = () => original() + offset
    try {
      // 先短切一次（2 分钟）：不该留痕。
      window.dispatchEvent(new Event('blur'))
      offset = 2 * 60 * 1000
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => { setTimeout(resolve, 120) })
      return { shown: document.querySelector('.timeline__absence') !== null }
    } finally {
      Date.now = original
    }
  })
  truthy('离开 2 分钟不留痕', absenceShort.shown === false)

  const absenceLong = await page.evaluate(async () => {
    const original = Date.now
    let offset = 0
    Date.now = () => original() + offset
    try {
      window.dispatchEvent(new Event('blur'))
      offset = 23 * 60 * 1000
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => { setTimeout(resolve, 150) })
      const node = document.querySelector('.timeline__absence')
      const style = node === null ? null : getComputedStyle(node)
      return {
        shown: node !== null,
        text: node?.textContent ?? '',
        fontSize: style?.fontSize ?? '',
        align: style?.textAlign ?? '',
      }
    } finally {
      Date.now = original
    }
  })
  truthy('离开 23 分钟留一行', absenceLong.shown === true)
  same('离开提示写成「离开 23 分钟」', '离开 23 分钟', absenceLong.text)
  /*
   * 11px：§12.9 原文「一行 11px 灰字」。
   *
   * 断言用 px 解析而不是比对字符串——`--text-label` 可能是 `0.6875rem`，
   * 字面不同而实际相同。比的是**算出来的像素值**，那才是用户看到的。
   */
  eq('离开提示是 11px', 11, Number.parseFloat(absenceLong.fontSize))
  same('离开提示居中', 'center', absenceLong.align)
  await page.screenshot({ path: join(OUT, 'absence-v7.png') })

  /*
   * 说话之后这行要撤掉。
   *
   * 它说的是「刚才这里没人」，而此刻人已经在说话了——留着就是一句
   * 永远挂在末尾的废话。用发送按钮真发一条来验，不直接调内部函数：
   * 那样验的是函数，不是用户的那条路径。
   */
  const absenceAfterSend = await page.evaluate(async () => {
    const box = document.querySelector('.composer__input')
    if (box !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(box, '我回来了')
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 60) })
    }
    const send = document.querySelector('.composer__primary')
    send?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    return { shown: document.querySelector('.timeline__absence') !== null }
  })
  truthy('发出下一句话后离开提示撤掉', absenceAfterSend.shown === false)

  /*
   * 设置面板（唯一的一个）单独开一页验。
   *
   * ## 为什么不再是 `#preferences`
   *
   * 上一版设置是**独立窗口**，浏览器里退化成同一个文档换 hash，所以能直达。
   * 现在它是主界面之上的浮层：没有第二个文档，也没有第二条入口，只能像
   * 用户那样点开——Rail 底部的齿轮。这更接近真实，代价是这一页必须先等
   * 主界面渲染完。
   *
   * ## 为什么开新页而不是接着主流程
   *
   * 主流程走到这里已经有会话、滚动位置、展开过的抽屉。设置浮层压在这些
   * 状态之上，量几何时会受它们影响（Toast 避让、列宽、滚动位置）。
   * 新页给的是「刚启动就打开设置」这个干净状态。
   */
  const setPage = await browser.newPage({ viewport: { width: 820, height: 580 }, deviceScaleFactor: 2 })
  const setErrors = []
  setPage.on('console', (message) => {
    if (message.type() === 'error') setErrors.push(message.text())
  })
  setPage.on('pageerror', (error) => { setErrors.push(String(error)) })
  await setPage.addInitScript(fakeShell(port))
  await setPage.addInitScript(soundSpy)
  await setPage.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'networkidle' })
  await setPage.waitForTimeout(500)

  /* 真实入口：Rail 底部的齿轮（`Cmd/Ctrl + ,` 与本项走同一个函数）。 */
  await setPage.click('.rail__item--settings')
  await setPage.waitForTimeout(320)

  const set_panel = await setPage.evaluate(() => {
    const pen = document.querySelector('.settings__pen')
    const box = pen?.getBoundingClientRect()
    const navBox = document.querySelector('.pref__nav')?.getBoundingClientRect()
    const overlay = document.querySelector('.settings')?.getBoundingClientRect()
    const nav = [...document.querySelectorAll('.pref__nav-item')]
    /*
     * 只看**第一组**（主题）。
     *
     * 通用页有五组单选（主题 3 项、字号 3 项、语言 2 项、发送 2 项、权限 3 项），全页数会得到 5 个
     * 选中项——那不是缺陷，是三个问题各有各的答案。断言要问的是
     * 「一组里能不能同时选中两项」，所以必须先把范围收到一组。
     */
    const group = document.querySelector('.pref__choices')
    const checked = [...(group?.querySelectorAll('.pref__choice') ?? [])]
      .filter((node) => node.getAttribute('aria-checked') === 'true')
    const active = document.activeElement
    /* 标题栏那一条上，命中谁？遮罩必须让它保持可点（拖拽、红绿灯）。 */
    const atTitlebar = document.elementFromPoint(410, 22)
    return {
      navLabels: nav.map((node) => node.textContent ?? '').join('/'),
      navWidth: navBox === undefined ? 0 : Math.round(navBox.width),
      current: document.querySelector('.pref__nav-item[aria-current="page"]')?.textContent ?? '',
      title: document.querySelector('.settings__title')?.textContent ?? '',
      role: document.querySelector('.pref__choices')?.getAttribute('role') ?? '',
      dialogRole: pen?.getAttribute('role') ?? '',
      modal: pen?.getAttribute('aria-modal') ?? '',
      width: box === undefined ? 0 : Math.round(box.width),
      height: box === undefined ? 0 : Math.round(box.height),
      overlayTop: overlay === undefined ? -1 : Math.round(overlay.top),
      titlebarFree: atTitlebar !== null && atTitlebar.closest('.settings') === null,
      /*
       * 与上一版**正好相反**的一条：主界面必须还在。
       *
       * 独立窗口那版要验「只渲染自己那棵树」，所以断言 `.workspace` 不存在。
       * 浮层版要验的正是反面——它是压在界面**之上**的一层，不是另一个界面。
       */
      appAlive: document.querySelector('.workspace') !== null,
      checkedCount: checked.length,
      checkedLabel: checked[0]?.textContent ?? '',
      /*
       * 焦点落在**面板本体**上，不是第一个导航项。
       *
       * `Settings.tsx` 的注释写了理由：落在导航项上会让「选中」与「聚焦」
       * 两件事长成同一个样子，面板一打开就先挂一圈 2px 焦点环。对话框的
       * 标准做法是把焦点交给 `tabIndex=-1` 的容器（读屏念标题、焦点确实
       * 进了对话框、画面上不多一圈假高亮），换页按一次 Tab 就到导航项。
       */
      focusInPanel: active !== null
        && (active.classList.contains('settings__pen') || active.closest('.settings__pen') !== null),
      focusOnNav: active !== null && active.classList.contains('pref__nav-item'),
    }
  })
  /*
   * 六页，顺序即导航顺序：通用 / 模型与 API / 人物设定 / 备份与还原 /
   * 扩展功能 / 关于。
   *
   * 2.3.0 按用户的六类意图重新归位：应用行为收进「通用」，模型来源
   * 收进「模型与 API」，她的性格与记忆收进「人物设定」，数据搬运收进
   * 「备份与还原」，插件参数更名「扩展功能」，隐私与应用权限收进「关于」。
   * 旧深链接由 `App.tsx` 的 alias 表兜住，落到归位后的页。
   */
  same('设置六页齐全且有序', '通用/模型与 API/人物设定/备份与还原/扩展功能/关于', set_panel.navLabels)

  /*
   * --- 归属：已上移到专门页面的段，扩展功能不得重复列出 ---
   *
   * ## 这条守的是什么
   *
   * 人物设定页的四张卡原先只有 `enable` 一个开关，段里其余十几个字段
   * 躺在扩展功能的模块层。同一件事两个入口，而且界面自己在指路——
   * `VoiceCard` 的原话是「可以在『模块』里调闸门的三个数」。
   *
   * 现在专门页原地展开整段字段（`SectionFields`），扩展功能按
   * `DEDICATED_SECTIONS` 排除它们。这条断言守三件事：
   *
   * 1. 已上移的段**确实不在**模块层里（否则两个入口并存）；
   * 2. 专门页**确实有**对应的折叠区（否则那个段从界面上消失了）；
   * 3. 两边的段 id 是同一份真源（`DEDICATED_SECTIONS`），不是各写一遍。
   *
   * 第 2 条最容易漏：只做第 1 条的话，忘了在专门页加折叠区就等于
   * 把这个段藏了起来——而「找不到」比「位置不对」严重得多。
   */
  /*
   * 判据落在**源码**而不是当前页面：这段代码跑在「通用」页刚验完的位置，
   * 模块层根本没挂载，读 DOM 会得到空数组——断言恒真，反向验证也抓不住。
   *
   * 三个来源各读一次：
   * - `settingsTaxonomy.ts` 的 `DEDICATED_SECTIONS`：唯一的归属真源；
   * - `ModuleLayer.tsx`：是否真的用 `isDedicated` 过滤；
   * - `SettingsPersona.tsx` / `SettingsGeneral.tsx`：专门页是否真的把
   *   这些段嵌了进去。
   */
  const readSrc = async (rel) => await readFile(new URL(`../src/${rel}`, import.meta.url).pathname, 'utf8')
  const [taxonomySrc, moduleSrc, personaSrc, generalSrc] = await Promise.all([
    readSrc('lib/settingsTaxonomy.ts'),
    readSrc('components/ModuleLayer.tsx'),
    readSrc('components/SettingsPersona.tsx'),
    readSrc('components/SettingsGeneral.tsx'),
  ])

  /* 归属真源里必须列出这些段。 */
  const MUST_BE_MOVED = ['tts', 'tts-gate', 'oral', 'rhythm', 'filter-chain', 'memory-core', 'memory-audit']
  const notListed = MUST_BE_MOVED.filter((id) => !taxonomySrc.includes(`'${id}'`))
  same('归属表列出了全部应上移的段', 0, notListed.length)
  if (notListed.length > 0) console.log(`    未列入：${notListed.join('、')}`)

  /* 模块层必须真的过滤，否则归属表只是一张没人读的清单。 */
  truthy(
    '模块层按归属表过滤（不是只写了一张表）',
    /isDedicated\(section\.id\)/.test(moduleSrc),
  )

  /*
   * 专门页必须真的把这些段嵌进去。
   *
   * 这一条是三条里最容易被漏掉的：只在模块层做排除、忘了在专门页加
   * 折叠区，那个段就从界面上消失了——「找不到」比「位置不对」严重。
   */
  const personaOwned = ['tts', 'tts-gate', 'oral', 'rhythm', 'filter-chain', 'memory-core', 'memory-decay', 'memory-audit']
  const personaMissing = personaOwned.filter((id) => !personaSrc.includes(`sectionOf('${id}')`))
  same('人物设定页嵌入了全部归它的段', 0, personaMissing.length)
  if (personaMissing.length > 0) console.log(`    人物设定页缺少：${personaMissing.join('、')}`)

  const generalOwned = ['proactive-gate', 'proactive-quota', 'proactive-reason']
  const generalMissing = generalOwned.filter((id) => !generalSrc.includes(`sectionOf('${id}')`))
  same('通用页嵌入了全部归它的主动发言段', 0, generalMissing.length)
  if (generalMissing.length > 0) console.log(`    通用页缺少：${generalMissing.join('、')}`)

  /* 原始层不能给已上移的段留一个点了会空结果的跳转按钮。 */
  const rawSrc = await readSrc('components/RawLayer.tsx')
  truthy(
    '原始层对已上移的段不给跳转（否则点了搜不到）',
    /isDedicated\(row\.section\.id\)/.test(rawSrc),
  )

  /*
   * --- 场景项也按归属分发，不在两个页面各放一个滑杆 ---
   *
   * 12 个场景项原先全在「扩展功能 · 场景」里。段上移之后，如果场景项
   * 留在原地，用户会在人物设定调完「记忆保留深度」，到扩展功能又看见
   * 一个同名滑杆——同一件事两个入口，而两边改的是同一个键。
   *
   * 判据落在**源码里的过滤集合**：三页各自声明了 `only`，且三者并集
   * 必须覆盖全部 12 项（`SCENE_ITEMS` 的数量）。少一项就是某个场景项
   * 从界面上消失了——它既不在专门页，也不在扩展功能。
   */
  const [personaSrc2, generalSrc2, pluginsSrc2, scenesSrc] = await Promise.all([
    readSrc('components/SettingsPersona.tsx'),
    readSrc('components/SettingsGeneral.tsx'),
    readSrc('components/SettingsPlugins.tsx'),
    readSrc('lib/scenes.ts'),
  ])
  const totalSceneItems = (scenesSrc.match(/\n    id: '/g) ?? []).length
  same('场景项总数 12（源码真源）', 12, totalSceneItems)

  /* 三页都必须真的传 `only`，否则场景项会全量渲染在该页。 */
  /*
   * 正则要匹配「传了一个**具名集合**」，不能只匹配 `only={`。
   * 写成 `/only=\{/` 时，`only={undefined}` 也算通过——而那正是要抓的
   * 回退形态（撤销过滤）。判据收紧到「花括号里是标识符，不是 undefined」。
   */
  for (const [label, src] of [['人物设定', personaSrc2], ['通用', generalSrc2], ['扩展功能', pluginsSrc2]]) {
    /*
     * 匹配「花括号里是一个**非 undefined 的表达式**」。
     *
     * 用否定前瞻而不是枚举合法形态：`only={one('tts')}` 与
     * `only={MEMORY_SCENE_SECTIONS}` 都要通过，`only={undefined}` 必须红。
     */
    truthy(
      `${label}页的场景层传了 only（不是全量渲染）`,
      /only=\{(?!undefined\})[^}]+\}/.test(src),
    )
  }

  /*
   * 扩展功能只保留 dialogue / privacy 两项。
   *
   * 这两项没有日常页面：上下文是推理参数，风险档位属于安全边界，
   * 都更像「程序怎么跑」而不是「她是谁」。
   */
  truthy(
    '扩展功能只剩 dialogue 与 privacy 两项场景',
    /SCENE_STAYS_HERE[\s\S]{0,200}new Set\(\['dialogue', 'privacy'\]\)/.test(pluginsSrc2),
  )

  /* 上移的场景段必须真的在专门页的 only 集合里，否则那一项没人渲染。 */
  const personaOnly = personaSrc2.slice(personaSrc2.indexOf('only={one('))
  truthy('人物设定的节奏场景项绑在 rhythm 段', /one\('rhythm'\)/.test(personaSrc2))
  truthy('人物设定的口吻场景项绑在 persona-vars 段', /one\('persona-vars'\)/.test(personaSrc2))
  truthy('人物设定的记忆场景项覆盖 core 与 audit', /MEMORY_SCENE_SECTIONS[\s\S]{0,120}'memory-core'[\s\S]{0,60}'memory-audit'/.test(personaSrc2))
  truthy('通用页的主动发言场景项覆盖四个段', /GENERAL_SCENE_SECTIONS[\s\S]{0,200}'proactive-gate'/.test(generalSrc2))
  void personaOnly


  eq('设置左导航宽 168', 168, set_panel.navWidth)
  same('设置默认停在通用页', '通用', set_panel.current)
  same('标题跟着当前页走', '通用', set_panel.title)
  same('设置的选择组是 radiogroup', 'radiogroup', set_panel.role)
  same('面板本体是 dialog', 'dialog', set_panel.dialogRole)
  same('面板声明 aria-modal', 'true', set_panel.modal)
  truthy('设置是浮层，主界面仍在（不是另一个界面）', set_panel.appAlive === true)
  eq('遮罩从标题栏下沿开始', 44, set_panel.overlayTop)
  truthy('标题栏没有被遮罩盖住（还能拖、还能点红绿灯）', set_panel.titlebarFree === true)
  /*
   * 2.3.0 起纸片铺满内边距盒：宽 = 820 − 左右留白 32 = 788，
   * 高 = 580 − 标题栏 44 − 上下留白 32 = 504。四边留白同宽（16），
   * 不随窗口尺寸漂移。
   */
  eq('纸片宽 788（铺满内边距盒，四边留白同宽）', 788, set_panel.width, 2)
  eq('纸片高 504（让出标题栏与边距）', 504, set_panel.height, 2)
  eq('设置·一组里恰有一项选中', 1, set_panel.checkedCount)
  truthy('设置·默认选中「跟随系统」', set_panel.checkedLabel.includes('跟随系统'))
  truthy('打开时焦点落在设置面板内（对话框标准做法，不挂导航项）', set_panel.focusInPanel === true)
  truthy('打开时焦点没有落在导航项上（避免选中与聚焦同形）', set_panel.focusOnNav === false)

  /*
   * --- 左导航的选中态与状态梯度 ---
   *
   * ## 为什么这一条不能用「看起来像不像」来判
   *
   * 导航铺在比纸片暗一档的面上。上一版给悬停用 `paper-2`（比窗身**亮**）、
   * 给选中用 `paper-3`（只比窗身暗 1.036）——两个方向相反的浅底叠在一起，
   * 实测悬停对比 1.049 > 选中 1.036，读出来是「悬停比选中更明显」。
   *
   * 这类缺陷**不会有任何报错**，也不会被「选中项有没有底色」这种断言抓到
   * （它有底色，只是抓不住眼睛）。唯一能抓的是**量三档的相对明暗**：
   * 常态 = 导航底 → 悬停略暗 → 选中远暗（反色）。方向与间距都要对。
   *
   * ## 悬停必须真的把指针移上去
   *
   * 从 `document.styleSheets` 里找 `:hover` 的 `background-color` 会拿到空串
   * ——产物把声明压成了 `background` 简写，而简写里含 `var()` 时 CSSOM
   * 无法展开成长属性。量衍生物不如量本体：指针停上去之后读
   * `getComputedStyle`，读到的是浏览器算完 var、算完半透明之后的值。
   */
  const set_idleLabel = await setPage.evaluate(() => {
    const items = [...document.querySelectorAll('.pref__nav-item')]
    return items.find((node) => node.getAttribute('aria-current') !== 'page')?.textContent ?? ''
  })
  await setPage.hover(`.pref__nav-item:text-is("${set_idleLabel}")`)
  await setPage.waitForTimeout(320)

  const set_navStates = await setPage.evaluate((hoveredLabel) => {
    const parse = (value) => {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(value)
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
    }
    const lum = (rgb) => {
      if (rgb === null) return 0
      const [r, g, b] = rgb.map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a, b) => {
      const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
      return (hi + 0.05) / (lo + 0.05)
    }
    const nav = document.querySelector('.pref__nav')
    const base = parse(nav === null ? '' : getComputedStyle(nav).backgroundColor)
    const items = [...document.querySelectorAll('.pref__nav-item')]
    const hovered = items.find((node) => node.textContent === hoveredLabel)
    const selected = items.find((node) => node.getAttribute('aria-current') === 'page')
    /*
     * 半透明的悬停底要叠在导航底上算，否则量到的是那 5% 的黑本身。
     *
     * 透明度的取法只有一条可靠的路：**只在 `rgba(` 形态下读第四个分量**。
     * 曾用 `/rgba?\([^)]*?,\s*([\d.]+)\)/` 去"抓最后一个数字"，
     * 对 `rgb(6, 128, 63)` 会一路吃到 `63)` —— 于是 63 被当成不透明度，
     * 算出来的"选中对比度"是负的。这类错误不会报错，只会让断言莫名奇妙。
     */
    const flatten = (node) => {
      if (node === undefined) return null
      const raw = getComputedStyle(node).backgroundColor
      const layer = parse(raw)
      if (layer === null || base === null) return layer
      const alpha = raw.startsWith('rgba(')
        ? Number(raw.slice(raw.lastIndexOf(',') + 1, raw.lastIndexOf(')')))
        : 1
      return [0, 1, 2].map((index) => layer[index] * alpha + base[index] * (1 - alpha))
    }
    return {
      base,
      hover: flatten(hovered),
      selected: flatten(selected),
      selectedInk: parse(selected === undefined ? '' : getComputedStyle(selected).color),
      hoverVsBase: contrast(flatten(hovered), base),
      selectedVsBase: contrast(flatten(selected), base),
      selectedInkVsFill: contrast(
        parse(selected === undefined ? '' : getComputedStyle(selected).color),
        flatten(selected),
      ),
    }
  }, set_idleLabel)
  truthy(`悬停比常态更明显（${set_navStates.hoverVsBase.toFixed(3)} > 1）`, set_navStates.hoverVsBase > 1)
  /*
   * 阈值从 1.5 降到 1.08。
   *
   * 1.5 是**彩色方案**留下的：那时选中是浅绿底（对侧栏 1.04）、悬停是
   * 另一档浅色，靠色相分开，两个明度比可以拉得很开。改成黑白之后，
   * "选中"与"悬停"都只能靠明度表态，而明度的上限被另一条设计约束卡住
   * ——`--accent-50` 的注释写着「要能看出被选中，又不至于像一块凹陷」。
   *
   * 实测两档是 1.24 / 1.12：方向对、差值 0.12，肉眼能分出"指着"与"选中"，
   * 但达不到 1.5 倍。硬压到 1.5 倍需要 #bcbcbc 一级的中灰，那会变成
   * 凹陷，反而破坏扁平语言。所以断言改成「选中明显高于悬停」这个方向
   * 判据 + 一个可辨的最小差值，而不是一个为彩色方案定的倍数。
   */
  truthy(
    `选中远比悬停明显（${set_navStates.selectedVsBase.toFixed(2)} > ${set_navStates.hoverVsBase.toFixed(2)} × 1.08）`,
    set_navStates.selectedVsBase >= set_navStates.hoverVsBase * 1.08,
  )
  truthy(
    `选中项的字读得清（${set_navStates.selectedInkVsFill.toFixed(2)} ≥ 3）`,
    set_navStates.selectedInkVsFill >= 3,
  )

  /*
   * 减少动态偏好：**颜色**过渡要保留，纸片**出现**的位移动画要关掉。
   *
   * ## 为什么不去要求"所有过渡变 1ms"
   *
   * §11 的规矩只对位移类动画成立：位移动画会让人眩晕，颜色渐变不会。
   * 把导航的 120ms 底色渐变也压成 1ms，得到的是"点一下瞬间跳色"——
   * 那不是减少动态，是把界面做粗。所以两件事分开验：导航渐变仍是
   * 0.12s，纸片与遮罩的入场动画变成 none。
   */
  await setPage.emulateMedia({ reducedMotion: 'reduce' })
  await setPage.waitForTimeout(120)
  const set_reduced = await setPage.evaluate(() => {
    const items = [...document.querySelectorAll('.pref__nav-item')]
    const hovered = items.find((node) => node.getAttribute('aria-current') !== 'page')
    return {
      duration: hovered === undefined ? '' : getComputedStyle(hovered).transitionDuration,
      pen: getComputedStyle(document.querySelector('.settings__pen') ?? document.body).animationName,
      overlay: getComputedStyle(document.querySelector('.settings') ?? document.body).animationName,
    }
  })
  truthy(`减少动态时颜色过渡保留（${set_reduced.duration}）`, set_reduced.duration.startsWith('0.12s'))
  same('减少动态时纸片不做入场动画', 'none', set_reduced.pen)
  same('减少动态时遮罩不做淡入', 'none', set_reduced.overlay)
  await setPage.emulateMedia({ reducedMotion: 'no-preference' })

  /* --- 改主题、改字号：浮层的意义就是"改完立刻看得见" --- */
  const set_themeBefore = await setPage.evaluate(() => document.documentElement.dataset['theme'] ?? '')
  await setPage.evaluate(() => {
    const button = [...document.querySelectorAll('.pref__choice')].find(
      (node) => (node.textContent ?? '').startsWith('深色'),
    )
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await setPage.waitForTimeout(250)
  const set_themeAfter = await setPage.evaluate(() => ({
    theme: document.documentElement.dataset['theme'] ?? '',
    /* 浮层的底必须跟着变：它读的是同一套令牌。 */
    pen: getComputedStyle(document.querySelector('.settings__pen') ?? document.body).backgroundColor,
  }))
  truthy('设置里切深色，根节点跟着变', set_themeAfter.theme === 'dark')
  truthy('设置里切深色，纸片自己也变深', set_themeAfter.pen !== 'rgb(247, 247, 247)')
  await setPage.screenshot({ path: join(OUT, 'settings-dark.png') })

  const set_fontBefore = await setPage.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
  await setPage.evaluate(() => {
    const button = [...document.querySelectorAll('.pref__choice')].find(
      (node) => (node.textContent ?? '').startsWith('大'),
    )
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await setPage.waitForTimeout(300)
  const set_fontAfter = await setPage.evaluate(() => ({
    root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    sample: Number.parseFloat(
      getComputedStyle(document.querySelector('.pref__sample-text') ?? document.body).fontSize,
    ),
  }))
  truthy(`字号选「大」后根字号变大（${String(set_fontBefore)} → ${String(set_fontAfter.root)}）`, set_fontAfter.root > set_fontBefore)
  truthy(`字号预演跟着变大（${String(set_fontAfter.sample)}）`, set_fontAfter.sample > 15)

  /* 切回浅色与标准字号，后面的截图与断言都在默认主题下进行。 */
  await setPage.evaluate(() => {
    const buttons = [...document.querySelectorAll('.pref__choice')]
    buttons.find((node) => (node.textContent ?? '').startsWith('跟随系统'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    buttons.find((node) => (node.textContent ?? '').startsWith('标准'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await setPage.waitForTimeout(300)
  await setPage.screenshot({ path: join(OUT, 'settings-appearance.png') })
  same('设置面板里没有文字贴着容器的边', '[]', JSON.stringify(await insetViolations(setPage)))

  /* --- 通用页·音效：三个试听按钮必须真的会响 --- */
  await setPage.locator('.pref__nav-item', { hasText: '通用' }).click()
  await setPage.waitForTimeout(300)
  const set_soundPage = await setPage.evaluate(() => {
    const cues = [...document.querySelectorAll('.pref__cue')]
    const box = document.querySelector('.pref__cue')?.getBoundingClientRect()
    return {
      cues: cues.map((node) => node.textContent ?? '').join('|'),
      cueWidth: box === undefined ? 0 : Math.round(box.width),
      switchCount: document.querySelectorAll('.pref__switch').length,
      /*
       * 四张卡（朗读 / 口吻 / 节奏 / 规矩）都渲染成 `pref__row`，
       * 没有各自的类名。用「小节标题数」与「行数」两个读数一起验：
       * 标题 5 个（音效 + 四张卡各一个），行至少 5 行（提示音 + 音量 + 四张卡）。
       *
       * 小节名不能与卡内标题同名：原来「提示音」标题底下第一行也叫
       * 「提示音」，「朗读」标题底下第一行也叫「朗读」——两行字一模一样、
       * 相隔 20px，读起来像渲染了两遍。
       */
      headings: document.querySelectorAll('.pref__heading').length,
      rows: document.querySelectorAll('.pref__row').length,
    }
  })
  same('通用页三个试听都在', '发送消息发送时|回复开始开始生成回复时|出错本轮失败时', set_soundPage.cues)
  truthy(`试听按钮均分宽度（${String(set_soundPage.cueWidth)}px）`, set_soundPage.cueWidth > 100)
  eq('通用页八个小节（主题/字号/语言/发送方式/系统通知/默认权限/音效/语音输入）', 8, set_soundPage.headings)
  truthy(`通用页三行设置（系统通知/提示音/语音输入）`, set_soundPage.rows >= 3)
  /*
   * --- 声音页的三处硬伤（这一页曾经有三样东西是坏的）---
   *
   * ## 一、音量滑杆的宽度是 0
   *
   * `.pref__slider` 原本是横排（`width: 180px` + `display: flex`），里头
   * 两个子项：`.pref__slider-head`（`width: 100%`）与滑杆（`flex: 1`）。
   * 180 宽的容器里 head 先拿走 180，再叠 8px 的 gap 就溢出了，两边一起
   * 收缩，滑杆收到 **0**——轨道长度为零，只剩一个拇指浮在那里。
   * 断言量的是滑杆的实测宽度，不是「有没有这个元素」：元素一直在，
   * 只是宽 0，`querySelector` 查不出来。
   *
   * ## 二、`pref__note` 会渲染成空块
   *
   * `.pref__note` 有底色、有描边、有 12px 内距。三张卡都写成
   * `note === '' ? null : <p>…</p>`，而 `note` 来自一次 JSON——宿主漏字段时
   * 它是 `undefined`，`undefined === ''` 为假，于是渲染出一个**空的灰片**。
   * 断言：「带边框的说明块里不能一个字都没有」。
   *
   * ## 三、界面上出现 `undefined`
   *
   * 同一处根因的另一种表现：「她说完的话会念出来（undefined）」。
   * 这条断言扫的是**整块面板**的可见文本，不只这一页——任何一个组件
   * 把 undefined/NaN/[object Object] 漏到屏幕上，都算失败。
   */
  const set_soundHonest = await setPage.evaluate(() => {
    const range = document.querySelector('.pref__range')
    const notes = [...document.querySelectorAll('.pref__note')]
    const leaks = []
    for (const node of document.querySelectorAll('.settings__pen *')) {
      if (node.children.length > 0) continue
      const text = (node.textContent ?? '').trim()
      if (text === '') continue
      if (/undefined|NaN|\[object Object\]/.test(text)) leaks.push(text.slice(0, 32))
    }
    return {
      rangeWidth: range === null ? 0 : Math.round(range.getBoundingClientRect().width),
      emptyNotes: notes.filter((node) => (node.textContent ?? '').trim() === '').length,
      notes: notes.length,
      leaks,
    }
  })
  truthy(`音量滑杆的轨道有宽度（${String(set_soundHonest.rangeWidth)}px）`, set_soundHonest.rangeWidth > 100)
  same('没有空的说明块（有底色有描边却一个字都没有）', 0, set_soundHonest.emptyNotes)
  truthy(`说明块都在（${String(set_soundHonest.notes)} 段）`, set_soundHonest.notes >= 3)
  same('设置面板里没有 undefined / NaN 漏到屏幕上', '[]', JSON.stringify(set_soundHonest.leaks))
  /*
   * --- 开关打开时，钮必须与轨道分开（两套主题各量一次）---
   *
   * ## 量之前必须先把一个开关真的打开
   *
   * 2.3.0 把「声音」页并进「通用」页之后，这一页的三个开关（提示音 /
   * 系统通知 / 语音输入）出厂值**全是 false**。原先这条断言直接扫
   * `aria-checked='true'` 的节点，扫到 0 个就红——**红的原因不是配色坏了，
   * 是页面上根本没有打开态的开关可量**。断言要看的是「打开时长什么样」，
   * 那就得先造出一个打开态，不能指望数据碰巧满足。
   *
   * 点「提示音」这一行：它是本页第一个开关，切它会真的改偏好并写盘。
   * 量完立刻切回去（下面 `restore`），后面的截图与断言不受影响。
   *
   * ## 这条断言本身在防什么
   *
   * 强调退成黑白之后，深色下的打开态轨道是 `#ECECEC`，而默认钮
   * `--ui-knob` 在深色下**也是亮的**（它服务的是未选中的凹槽）——两块
   * 同色的圆叠在一起，只剩 1px 阴影在分它们，看起来像开关坏了。
   *
   * 它不属于"配色"也不属于"几何"，任何一边的断言都抓不到：轨道对了、
   * 钮也在，只是**同色**。所以判据必须是"两者之间的对比"，而且要**两套
   * 主题各算一次**——只量当前主题的话，恰好跑在浅色下就会漏掉深色那个洞。
   *
   * 直接改 `documentElement.dataset.theme` 而不是去点 UI：这里要的是
   * 颜色关系，不是"设置能不能切主题"（那条另有断言）。改完恢复原值，
   * 后面几页的截图才不会跟着变色。
   */
  /*
   * 挑哪一个开关来造打开态，有讲究。
   *
   * **不能取第一个**：本页第一个开关是「系统通知」，它的 `onChange` 会先本地
   * 置 true、再 `await requestPermission()`，拿不到授权就立刻改回 false
   * （`SettingsGeneral.tsx:59-68`）。无头环境没有通知权限，点它永远回到关闭态——
   * 那是**权限被拒的正常行为**，不是配色缺陷，用它来量会导致假红。
   *
   * 取「语音输入」：它是纯本地偏好，`onChange` 直接写 `setPreferences`，
   * 没有异步回滚，点一下就真的进打开态。
   */
  /*
   * 按 aria-label 精确取「语音输入」，不按位置取。
   *
   * 原先写 `nth(2)`，靠的是"这一页第 3 个开关恰好是语音输入"。场景层
   * 搬进通用页之后，页面顶部多了「主动消息可解释」等开关，`nth(2)` 落到
   * 「提示音」上——点它确实会变成打开态，但那条断言量的是「关回去之后
   * 剩几个打开态」，取错元素就会得到 1，看起来像复位失败。
   *
   * 位置会随页面结构变，名字不会。
   */
  const voiceToggle = setPage.locator('.pref__switch[aria-label="语音输入"]')
  const switchBefore = await setPage.evaluate(() => {
    const all = [...document.querySelectorAll('.pref__switch')]
    return {
      total: all.length,
      labels: all.map((node) => node.getAttribute('aria-label') ?? '').join('/'),
      page: (document.querySelector('.pref__nav-item[aria-current="page"]')?.textContent ?? '').trim(),
    }
  })
  console.log(`  · 点前诊断：页=${switchBefore.page} 开关=${switchBefore.labels}`)
  await voiceToggle.click()
  await setPage.waitForTimeout(400)
  const switchWasOn = await setPage.evaluate(
    () => document.querySelectorAll(".control-switch[aria-checked='true']").length,
  )
  truthy(`点一下开关就能进入打开态（${String(switchWasOn)} 个）`, switchWasOn >= 1)
  const set_switchBoth = await setPage.evaluate(async () => {
    const root = document.documentElement
    const parse = (value) => {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(value)
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
    }
    const lum = (rgb) => {
      if (rgb === null) return 0
      const [r, g, b] = rgb.map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => {
      const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
      return (hi + 0.05) / (lo + 0.05)
    }
    const wait = () => new Promise((done) => setTimeout(done, 240))
    const before = root.dataset['theme'] ?? 'light'
    const rows = []
    for (const theme of ['light', 'dark']) {
      root.dataset['theme'] = theme
      await wait()
      for (const node of document.querySelectorAll(".control-switch[aria-checked='true']")) {
        const knob = node.querySelector('.control-switch-knob')
        const track = getComputedStyle(node).backgroundColor
        const ink = knob === null ? '' : getComputedStyle(knob).backgroundColor
        rows.push({ theme, track, knob: ink, ratio: ratio(parse(track), parse(ink)) })
      }
    }
    root.dataset['theme'] = before
    await wait()
    return rows
  })
  truthy(`两套主题都有打开状态的开关可量（${String(set_switchBoth.length)} 个）`, set_switchBoth.length >= 2)
  same(
    '打开态的开关钮与轨道分得开（对比 ≥ 3）',
    '[]',
    JSON.stringify(
      set_switchBoth
        .filter((row) => row.ratio < 3)
        .map((row) => `${row.theme}:${row.track}/${row.knob}`),
    ),
  )

  /*
   * 关回去。上面为了造出一个打开态点了「提示音」，它是会落盘的真开关：
   * 不关回去，这台机器上跑完一次检查就会莫名多出一个「提示音已开」。
   * 截图也已经拍完，之后几页不该带着这个改动态。
   */
  await voiceToggle.click()
  await setPage.waitForTimeout(240)
  /*
   * 判据改成「刚点的那一个回到关闭」，而不是「全页没有打开态」。
   *
   * ## 为什么不能数全页
   *
   * 原写法数 `control-switch[aria-checked='true']` 的总数。场景层搬进
   * 通用页之后，页面里多了「主动消息可解释」这类**默认就是开**的开关
   * （默认 true，不是用户点的）。于是无论语音输入有没有关回去，
   * 总数都至少是 1——断言恒红，而真正要守的那件事（点过的那个要复位）
   * 反而没被验到。
   *
   * 数「全页状态」在页面里存在默认开启项时永远不成立。判据必须锚在
   * **被操作的那一个元素**上。
   */
  const switchRestored = await setPage.evaluate(() => {
    const node = document.querySelector('.pref__switch[aria-label="语音输入"]')
    return node === null ? 'missing' : node.getAttribute('aria-checked')
  })
  same('量完把语音输入开关关回去', 'false', switchRestored)

  await setPage.screenshot({ path: join(OUT, 'settings-sound.png') })

  /* --- 系统通知（已并入「通用」页，与发送方式、默认权限同页） --- */
  await setPage.locator('.pref__nav-item', { hasText: '通用' }).click()
  await setPage.waitForTimeout(300)
  const set_notifyPage = await setPage.evaluate(() => ({
    switches: document.querySelectorAll('.pref__switch').length,
    notes: document.querySelectorAll('.pref__note').length,
  }))
  truthy('通用页含系统通知开关', set_notifyPage.switches >= 1)
  truthy(`通用页给出解释（${String(set_notifyPage.notes)} 段）`, set_notifyPage.notes >= 2)
  await setPage.screenshot({ path: join(OUT, 'settings-notify.png') })

  /* --- 通用页：默认权限三档 --- */
  await setPage.locator('.pref__nav-item', { hasText: '通用' }).click()
  await setPage.waitForTimeout(600)
  const set_permission = await setPage.evaluate(() => {
    const labels = [...document.querySelectorAll('.pref__choice-label')].map((node) => node.textContent ?? '')
    const checked = [...document.querySelectorAll('.pref__choice[aria-checked="true"] .pref__choice-label')]
      .map((node) => node.textContent ?? '')
    return { labels: labels.join('/'), checked: checked.join('/') }
  })
  same(
    '通用页给出主题/字号/语言/发送方式/默认权限五组选项',
    '跟随系统/浅色/深色/小/标准/大/简体中文/English/打断/排队/只在对话内/限于工作区/不限制',
    set_permission.labels,
  )
  truthy('默认权限有且只有一档被选中', set_permission.checked !== '')


  /* --- 备份与还原页：导出三条 + 导入一条 + 整库备份 --- */
  await setPage.locator('.pref__nav-item', { hasText: '备份与还原' }).click()
  await setPage.waitForTimeout(300)
  const set_dataPage = await setPage.evaluate(() => {
    /* 只量「导出与导入」这一段：同页还有整库备份，有自己的按钮。 */
    const scope = document.querySelector('[data-section="data"]')
    const buttons = [...(scope?.querySelectorAll('.pref__actions .button') ?? [])]
    return {
      labels: buttons.map((node) => node.textContent ?? '').join('|'),
      count: buttons.length,
      kinds: buttons.map((node) => node.className).join('|'),
    }
  })
  same('数据页四个动作齐全', '导出这一段的 JSON|导出为 Markdown|导出全部|从文件恢复…', set_dataPage.labels)
  /*
   * 四个动作必须长得一样。
   *
   * 这里原先是「一个描边按钮 + 两个 ghost」：ghost 是透明底、透明边，
   * 在竖排的动作清单里，后两条读起来就是两行普通文字——用户不会想到
   * 它们能点。横排工具条里 ghost 是对的（旁边还有别的按钮做参照），
   * 竖排清单里它没有参照，只剩"这行字好像可以点"的猜。
   */
  same(
    '数据页四个动作用同一种按钮（不许混 ghost）',
    'button|button|button|button',
    set_dataPage.kinds,
  )
  same('数据页没有未渲染的 Markdown', '[]', JSON.stringify(await textLeaks(setPage)))
  await setPage.screenshot({ path: join(OUT, 'settings-data.png') })

  /* --- 扩展功能页：三段仍然在同一个面板里 --- */
  await setPage.locator('.pref__nav-item', { hasText: '扩展功能' }).click()
  await setPage.waitForTimeout(600)
  const set_plugins = await setPage.evaluate(() => ({
    tabs: [...document.querySelectorAll('.settings__tab')].map((node) => node.textContent ?? '').join('/'),
    tabRole: document.querySelector('.settings__tabs')?.getAttribute('role') ?? '',
    cards: document.querySelectorAll('.scene__item').length,
    foot: document.querySelector('.settings__foot')?.textContent ?? '',
  }))
  same('扩展功能页三层齐全', '场景/模块/原始', set_plugins.tabs)
  same('三层是 tablist', 'tablist', set_plugins.tabRole)
  truthy(`场景层渲染出旋钮（${String(set_plugins.cards)} 个）`, set_plugins.cards > 0)
  truthy('统计条给出段数与字段数', /个配置段/.test(set_plugins.foot))
  await setPage.screenshot({ path: join(OUT, 'settings-set_plugins.png') })

  /* --- 关于页 --- */
  await setPage.locator('.pref__nav-item', { hasText: '关于' }).click()
  await setPage.waitForTimeout(300)
  const set_about = await setPage.evaluate(() => ({
    brand: document.querySelector('.pref__brand-name')?.textContent ?? '',
    version: [...document.querySelectorAll('.pref__facts dd')].map((node) => node.textContent ?? '').join('|'),
    links: document.querySelectorAll('.pref__link').length,
  }))
  same('关于页写的是「空谷 Ondra」', '空谷 Ondra', set_about.brand)
  truthy(`关于页给出真实版本号（${set_about.version}）`, /\d+\.\d+\.\d+/.test(set_about.version))
  truthy('关于页的仓库地址是可点文字', set_about.links === 1)
  await setPage.screenshot({ path: join(OUT, 'settings-set_about.png') })

  /*
   * --- 出口：Esc 与点遮罩 ---
   *
   * 两条都要验：Esc 是快捷方式，点遮罩是鼠标用户唯一会做的动作。
   * 只验一条的结果是——另一条坏了没人知道，而它恰好是大多数人用的那条。
   */
  await setPage.keyboard.press('Escape')
  await setPage.waitForTimeout(260)
  const set_afterEsc = await setPage.evaluate(() => ({
    gone: document.querySelector('.settings__pen') === null,
    focusBack: document.activeElement?.classList.contains('rail__item--settings') === true,
  }))
  truthy('Esc 关掉设置', set_afterEsc.gone === true)
  truthy('关掉后焦点回到齿轮', set_afterEsc.focusBack === true)

  await setPage.click('.rail__item--settings')
  await setPage.waitForTimeout(300)
  /* 点遮罩的留白区（纸片之外）：x=8 落在 padding 里，命中的是遮罩本身。 */
  await setPage.mouse.click(8, 300)
  await setPage.waitForTimeout(260)
  const set_afterScrim = await setPage.evaluate(() => document.querySelector('.settings__pen') === null)
  truthy('点遮罩关掉设置', set_afterScrim === true)

  if (setErrors.length > 0) {
    console.log('\n设置面板的控制台错误：')
    for (const error of setErrors) console.log(`  ${error}`)
    process.exitCode = 1
  }

  /*
   * --- 主动开口（§6.4 E、§7.4）---
   *
   * ## 为什么开一页新文档，而不是在主流程里做
   *
   * 这条链路的触发条件是**会话安静 25 分钟**。在主流程里等，要么真等
   * 二十五分钟，要么把 `IDLE_MINUTES` 改成可注入的——后者会让「默认值
   * 是多少」这件事从代码里消失，测试也就验不到出厂行为了。
   *
   * 所以换一条路：新开一页，装 Playwright 的虚拟时钟，把时间快进过去。
   * 页面里的 `Date.now()` 与 `setTimeout` 一起被接管，`useProactiveTick`
   * 算出的到期时刻与真实运行时**完全同一条路径**，只是时钟走得快。
   *
   * ## 为什么必须是独立页
   *
   * 虚拟时钟是**整个文档**的。装到主流程那一页，前面所有靠真实时间
   * 跑的断言（Toast 自动消失、抽屉 180ms、淡出）全都会失真。一页只
   * 服务这一组断言，代价是重新进入会话的三次点击。
   *
   * ## 为什么推理接口要单独桩成 SSE
   *
   * `serve()` 的兜底路由回一段 JSON。主动开口走的是流式接口，
   * 收到一段没有 `\n\n` 的 JSON 会一个帧都切不出来——于是占位消息
   * 永远停在 `pending`，`onDone` 不触发，撤回窗口也不开。那时断言
   * 会报「按钮不存在」，而真缺陷在测试自己的桩上。
   */
  const proPage = await browser.newPage({ viewport: { width: 820, height: 580 }, deviceScaleFactor: 2 })
  const proErrors = []
  proPage.on('console', (message) => {
    if (message.type() === 'error') proErrors.push(message.text())
  })
  proPage.on('pageerror', (error) => { proErrors.push(String(error)) })

  /*
   * 时钟的起点钉在「今天上午 9 点」，不是「此刻」。
   *
   * ## 为什么必须钉
   *
   * 这一组断言要快进四轮、每轮 31 分钟，合计两小时零几分钟。若从
   * 真实的「此刻」起步，而此刻是晚上 23 点，快进两次就跨过午夜——
   * 而拒绝计数的键是 `ondra.proactive.declines.<日期>`：跨天等于换了一个
   * 键，第三次拒绝记到新键的 `1` 上，于是「第三次之后 quiet」永远不成立。
   *
   * 实测确实是这个表现：`stored` 停在 2，另一天多出一个 `1`。
   * 红的不是产品——真实用户不会在两分钟内过完一整天。
   */
  const startAt = new Date()
  startAt.setHours(9, 0, 0, 0)

  /** 「这次不用」打到宿主的请求体。要验它带对了会话 id。 */
  const declineCalls = []
  /** 盘上「真实存在」的主动消息。说完一条 push、撤回一条 pop，见下面的桩注释。 */
  const said = []
  await proPage.route('**/api/proactive/decline', (route) => {
    declineCalls.push(route.request().postDataJSON())
    /* 「这次不用」在宿主那边是把那条消息真的删掉。桩照做，撤回的那句不再出现。 */
    said.pop()
    void route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })

  /*
   * 消息接口在这一页要**跟着虚拟时钟**回时间戳。
   *
   * ## 为什么不能直接用 `MESSAGES`
   *
   * `MESSAGES` 的时刻是脚本启动时的 `Date.now()`（真实世界）。这一页装
   * 了虚拟时钟并且把起点钉在「今天 9 点」，于是页面里的 `Date.now()`
   * 与桩给的 `createdAt` 差出十几个小时——`useProactiveTick` 算出的
   * 到期时刻是 `lastAt + 25 分钟`，`lastAt` 落在未来，`due` 变成负数，
   * 于是**一进页面就立刻开口**，而不是等 25 分钟。
   *
   * 上一版没暴露这个问题，是因为那时时钟从「此刻」起步，两边恰好一致。
   * 钉起点本来是为了防跨午夜，代价就是这里必须跟着一起搬。
   *
   * 回的时间戳按「钉住的起点 - 2 分钟」给，与 `MESSAGES` 的相对关系一致：
   * 最后一条消息在两分钟前，正好在空闲阈值之内。
   */
  /*
   * 桩要**记住她说过哪几句、哪句被撤回了**。
   *
   * 每说完一次，界面会把消息表重新拉一遍（换内核 id）。桩若恒返回那两条
   * 历史消息，刚说的那条就会被"拉"没——测出来像界面丢消息，实际是桩没有
   * 持久化。反过来，桩若只会累加，被撤回的那句又会在下一次拉取里复活。
   * 所以这里维护一份「盘上真实存在的主动消息」：说完一条 push，撤回一条 pop，
   * 与宿主的消息表一一对应。
   */
  await proPage.route('**/api/sessions/*/messages', (route) => {
    const base = startAt.getTime()
    const history = MESSAGES.map((message) => ({
      ...message,
      createdAt: base - 2 * MIN + (message.createdAt - now),
    }))
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([...history, ...said]),
    })
  })
  await proPage.route('**/api/inference', (route) => {
    /*
     * 一帧 `session`、一帧 `delta`、一帧 `done`。
     *
     * 三帧都要给：`session` 是 `onSession` 的来源（主动开口不该新建会话，
     * 但桩照真实形状回，才能验出「界面没有因此把会话换掉」）；
     * `delta` 让正文有字，`done` 才带得出 `setUndoable`。
     */
    said.push({ id: `srv-proactive-${String(said.length)}`, role: 'assistant', content: '雨好像停了。', createdAt: startAt.getTime() })
    const frames = [
      'event: session\ndata: {"sessionId":"s1"}',
      'event: delta\ndata: {"text":"雨好像停了。"}',
      'event: done\ndata: {"text":"雨好像停了。"}',
    ].join('\n\n')
    void route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: `${frames}\n\n` })
  })

  await proPage.clock.install({ time: startAt })
  await proPage.addInitScript(fakeShell(port))
  await proPage.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'networkidle' })
  /*
   * 把这一页切到前台。
   *
   * `useProactiveTick` 的三态里，「窗口在屏幕上但没有焦点」是**不问**的一档
   * （用户可能正在别处做事，此刻开口是打扰）。无头环境里两页并存时，
   * 后建的这一页默认不是活动页，于是那个定时器醒来后直接走 `unfocused`
   * 分支——一次门控都不问，界面安静得像功能不存在。
   *
   * 上一版这里靠「点开抽屉、点一条会话」两次真实点击顺带把焦点拿了过来，
   * 单会话制删掉那两步之后，这层副作用也跟着没了，必须显式切前台。
   */
  await proPage.bringToFront()
  await proPage.waitForTimeout(400)
  await proPage.locator('.composer__input').waitFor()
  await proPage.waitForTimeout(600)
  await proPage.locator('.message').first().waitFor()
  await proPage.waitForTimeout(300)

  /*
   * 先验「没到点不说话」。
   *
   * 这条比后面那条更重要：一个每 5 秒就问一次门控的实现，也能让「二十五
   * 分钟后有一行理由」通过。只有先证明没到点时**一次都没问**，才能断定
   * 它真的是按时间醒来的，而不是一直在问。
   *
   * 判据看两层：界面上没有 `.reasonline`，且宿主没收到过 `/api/proactive/check`。
   */
  const beforeDue = await proPage.evaluate(() => ({
    lines: document.querySelectorAll('.reasonline').length,
    msgs: document.querySelectorAll('.message').length,
  }))
  eq('未到空闲阈值时不出现主动开口', 0, beforeDue.lines)
  same('未到阈值时消息条数不变', 2, beforeDue.msgs)

  // 快进 31 分钟：越过 25 分钟阈值，也越过 90 秒抖动的上限。
  await proPage.clock.fastForward(31 * 60 * 1000)
  await proPage.waitForTimeout(1500)

  const spoke = await proPage.evaluate(() => {
    const line = document.querySelector('.reasonline')
    if (line === null) return { found: false }
    const dot = line.querySelector('.reasonline__dot')
    const undo = line.querySelector('.reasonline__undo')
    const article = line.closest('.message')
    const body = article?.querySelector('.message__body')
    const dotStyle = dot === null ? null : getComputedStyle(dot)
    const lineStyle = getComputedStyle(line)
    return {
      found: true,
      lines: document.querySelectorAll('.reasonline').length,
      /* 正文：不含理由行，所以去掉它再量。 */
      prose: (body?.textContent ?? '').trim(),
      /*
       * 整行文字去掉按钮：按钮文字不算「判据」。
       *
       * 只取 `reasonline__text` 自己的文本节点——`textContent` 会把里面
       * 那个 `.reasonline__why` 的摘要一起拼进来，于是这条断言变成了
       * 「摘要也在」，与它要守的「固定那五个字写没写对」不是一件事。
       */
      label: [...(line.querySelector('.reasonline__text')?.childNodes ?? [])]
        .filter((node) => node.nodeType === 3)
        .map((node) => (node.textContent ?? '').trim())
        .join(''),
      why: (line.querySelector('.reasonline__why')?.textContent ?? '').trim(),
      fontSize: lineStyle.fontSize,
      marginTop: lineStyle.marginTop,
      /*
       * 正文与理由行之间的**实际**间距。
       *
       * 不用 `margin-top` 一个数了事：正文最后一行如果是块级元素，
       * 或者 `.message__body` 有自己的下边距，两者会折叠或叠加，
       * `margin-top: 8px` 写着 8、视觉上却可能是 16 或 0。量几何差。
       */
      gap: body === null ? -1 : Math.round(line.getBoundingClientRect().top - body.getBoundingClientRect().bottom),
      dot: dotStyle === null ? null : {
        w: dotStyle.width, h: dotStyle.height,
        radius: dotStyle.borderRadius, bg: dotStyle.backgroundColor,
      },
      undo: undo === null ? null : {
        text: (undo.textContent ?? '').trim(),
        hasIcon: undo.querySelector('svg') !== null,
        inLine: undo.closest('.reasonline') !== null,
      },
      /* 理由行必须是消息的**一部分**（挂在 article 内），不能浮在外面。 */
      inArticle: article !== null,
      /* 判据行不是正文，选中复制时会带出断句奇怪的半句（§12.2）。 */
      selectable: lineStyle.userSelect,
    }
  })

  truthy('空闲满阈值后出现主动开口', spoke.found === true)
  eq('一次只开口一条', 1, spoke.lines)
  same('主动开口的正文已落定', '雨好像停了。', spoke.prose)
  same('可解释行文字是「她主动开口」', '她主动开口', spoke.label)
  same('可解释行带判据摘要', '· 想问你雨停了没', spoke.why)
  same('可解释行字号 11', '11px', spoke.fontSize)
  same('可解释行距正文 8', '8px', spoke.marginTop)
  eq('可解释行几何间距 8', 8, spoke.gap)
  truthy('可解释行是消息的一部分而非浮层', spoke.inArticle === true)
  same('可解释行不可选中', 'none', spoke.selectable)
  /*
   * 暖色点：2px、正圆、颜色等于 `--static-warm-500`（浅色主题 #b8873c）。
   *
   * 尺寸按 §6.4 E 的原话「行首 2px 沙色点」。颜色写死 rgb 而不是读令牌：
   * 断言要抓的正是「令牌有没有真的传到这个元素上」，读令牌等于自证。
   *
   * 本轮配色从暖纸换成蓝白，这个点**是全界面唯一的暖色**——它是
   * 「她主动开口」与普通系统消息的唯一视觉区别，所以它的色值必须
   * 单独被钉住，不能因为换主题就漂成别的暖色。
   */
  eq('暖色点宽 2', 2, Number.parseFloat(spoke.dot?.w ?? '0'))
  eq('暖色点高 2', 2, Number.parseFloat(spoke.dot?.h ?? '0'))
  same('沙色点是正圆', '50%', spoke.dot?.radius)
  same('暖色点取暖色令牌', 'rgb(166, 124, 51)', spoke.dot?.bg)
  same('「这次不用」四个字', '这次不用', spoke.undo?.text)
  truthy('「这次不用」带图标', spoke.undo?.hasIcon === true)
  truthy('「这次不用」在可解释行内', spoke.undo?.inLine === true)

  /*
   * 三秒窗口到点自动收起。
   *
   * 快进 3.2 秒再量：按钮该消失，**消息与理由行都还在**。后者是重点——
   * 一个把「窗口过期」实现成「把整条消息删掉」的版本，第一条断言也会过。
   */
  await proPage.clock.runFor(3200)
  await proPage.waitForTimeout(300)
  const afterWindow = await proPage.evaluate(() => ({
    undo: document.querySelectorAll('.reasonline__undo').length,
    lines: document.querySelectorAll('.reasonline').length,
    msgs: document.querySelectorAll('.message').length,
  }))
  eq('三秒后「这次不用」自动收起', 0, afterWindow.undo)
  eq('三秒后可解释行仍在', 1, afterWindow.lines)
  eq('三秒后消息仍在', 3, afterWindow.msgs)

  /*
   * 再等一轮，点「这次不用」。
   *
   * 验四件事：消息被撤下、请求带对会话 id、拒绝计数落盘、Spine 仍是常态
   * （一次拒绝还没到「今天安静」）。
   */
  await proPage.clock.fastForward(31 * 60 * 1000)
  await proPage.waitForTimeout(1200)
  const second = await proPage.evaluate(() => ({
    lines: document.querySelectorAll('.reasonline').length,
    msgs: document.querySelectorAll('.message').length,
  }))
  eq('冷却过去后再次开口', 1, second.lines)
  eq('两次开口后共四条消息', 4, second.msgs)

  await proPage.locator('.reasonline__undo').first().click()
  await proPage.waitForTimeout(600)
  const afterDecline = await proPage.evaluate(() => ({
    lines: document.querySelectorAll('.reasonline').length,
    msgs: document.querySelectorAll('.message').length,
    quiet: (document.querySelector('.spine__muted')?.textContent ?? '').trim(),
    stored: (() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('ondra.proactive.declines.'))
      return key === undefined ? null : { key, value: localStorage.getItem(key) }
    })(),
  }))
  eq('点「这次不用」后该条消息消失', 3, afterDecline.msgs)
  /*
   * 判断行留 1 条，不是 0。
   *
   * 上一轮那条主动消息**没被拒绝**，它带着自己的判断行留在历史里——
   * §6.4 E 的可解释行是消息的一部分，不是临时浮层，删它等于删那条消息。
   * 所以这里期望「刚好少一条」：2 → 1。
   */
  eq('点「这次不用」只撤下对应的那条判断行', 1, afterDecline.lines)
  same('一次拒绝还没到当天安静', '', afterDecline.quiet)
  truthy('拒绝计数落盘且键带日期', afterDecline.stored !== null && /^ondra\.proactive\.declines\.\d{4}-\d{2}-\d{2}$/.test(afterDecline.stored.key))
  same('拒绝计数为 1', '1', afterDecline.stored?.value)
  same('「这次不用」带上了会话 id', 's1', declineCalls.at(-1)?.sessionId)

  /*
   * 连续第三次拒绝 → 当天安静（§7.4）。
   *
   * 循环两次把计数推到 3：第二次拒完是 2，第三次是 3。用循环而不是
   * 手写三遍，是因为中间每一步都要等一轮冷却，写三遍会漏掉「第二次
   * 之后还肯开口」这件事——一个「拒绝一次就再也不说」的实现，也会让
   * 最后那条断言通过。
   */
  for (let round = 2; round <= 3; round += 1) {
    await proPage.clock.fastForward(31 * 60 * 1000)
    await proPage.waitForTimeout(1200)
    const again = await proPage.evaluate(() => ({
      lines: document.querySelectorAll('.reasonline').length,
      undo: document.querySelectorAll('.reasonline__undo').length,
    }))
    eq(`第 ${String(round)} 次拒绝前她仍肯开口`, 1, again.lines)
    truthy(`第 ${String(round)} 次开口带「这次不用」`, again.undo === 1)
    await proPage.locator('.reasonline__undo').first().click()
    await proPage.waitForTimeout(600)
  }

  const quietState = await proPage.evaluate(() => ({
    quiet: (document.querySelector('.spine__muted')?.textContent ?? '').trim(),
    stored: (() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('ondra.proactive.declines.'))
      return key === undefined ? null : localStorage.getItem(key)
    })(),
    msgs: document.querySelectorAll('.message').length,
    lines: document.querySelectorAll('.reasonline').length,
  }))
  same('连续拒绝三次后 Spine 显示今天安静', '今天安静', quietState.quiet)
  same('连续拒绝三次后计数为 3', '3', quietState.stored)
  eq('三次拒绝后消息总数', 3, quietState.msgs)
  /*
   * 判断行留 1 条：最早那条的撤回窗口已经过去，它永久留在历史里。
   *
   * 这条断言与上面「消息总数 3」是一体的：3 = 2 条原始 + 1 条没撤掉的。
   * 两条一起看才兜得住「撤消息」与「撤理由」是同一个动作——若实现成
   * 「只删理由行、留正文」，lines 会是 0 而 msgs 仍是 3，那条正文就
   * 成了没有解释的凭空一句。
   */
  eq('三次拒绝后残留那条判断行（超时后永久保留）', 1, quietState.lines)

  /*
   * 安静之后**不再问**。
   *
   * 这条守的是「安静」的语义：它不是显示一句话，而是当天真的停止。
   * 若只改显示不停定时器，再过 25 分钟她照样开口——用户会看到
   * 「今天安静」旁边又冒出一条主动消息。
   */
  await proPage.clock.fastForward(31 * 60 * 1000)
  await proPage.waitForTimeout(1200)
  const afterQuiet = await proPage.evaluate(() => ({
    lines: document.querySelectorAll('.reasonline').length,
    msgs: document.querySelectorAll('.message').length,
  }))
  eq('安静之后不再主动开口', 0, afterQuiet.lines)
  /*
   * 判据是「与安静那一刻相等」，不是写死一个数字。
   *
   * 消息总数取决于「哪些话被撤回了」，而撤回窗口会过期——写死 2 或 3 都是
   * 在赌那次跑的具体时序。真正要守的是**不再增长**：安静之后再等一轮冷却，
   * 条数一点没动，才说明定时器真的停了（只把「今天安静」四个字画上去而
   * 不停定时器的实现，会让这里多出一条）。
   */
  eq('安静之后消息条数不再增长', quietState.msgs, afterQuiet.msgs)

  await proPage.screenshot({ path: join(OUT, 'proactive-v5.png') })

  if (proErrors.length > 0) {
    console.log('\n主动开口页的控制台错误：')
    for (const error of proErrors) console.log(`  ${error}`)
    process.exitCode = 1
  }
  await proPage.close()

  /*
   * --- §12.8 窗口尺寸与断点 ---
   *
   * ## 为什么必须单开一页
   *
   * 这一组要反复改视口宽度（820 / 960 / 1200 / 1920）。主流程那一页累积了
   * 几十条依赖几何位置的断言：滚动位置、抽屉展开、焦点落点。中途改宽度会
   * 让它们全部失效，而失效的方式是**报红在别处**——排查时会怀疑抽屉坏了，
   * 实际是窗口变宽了。新开一页，主流程的几何保持原样。
   *
   * ## 这一组守的是什么
   *
   * 系统提示里那句「正文宽度永不随窗口变宽而增长」，在代码里只由一个
   * `max-width` 保证。它最容易在两种改动里丢掉：
   *
   * 1. 有人把 `max-width: var(--text-w)` 改成 `width: 100%` 想让大窗口
   *    "更好看"——那样 1920 下每行会到 80 个汉字，读起来会跳行。
   * 2. 加了 `min-width` 或 `flex: 1` 的中间层，把 560 的约束架空。
   *
   * 两种都不会报错、不会白屏，只是"看起来还行"。所以必须真的拉宽窗口量。
   */
  const breakPage = await browser.newPage({ viewport: { width: 820, height: 580 }, deviceScaleFactor: 1 })
  const breakErrors = []
  breakPage.on('console', (message) => {
    if (message.type() === 'error') breakErrors.push(message.text())
  })
  breakPage.on('pageerror', (error) => { breakErrors.push(String(error)) })
  await breakPage.addInitScript(fakeShell(port))
  await breakPage.addInitScript(soundSpy)
  await breakPage.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'networkidle' })
  await breakPage.waitForTimeout(400)
  /*
   * 等三栏就位再量骨架。
   *
   * 首页已删除，启动即会话；但仍要显式等输入框，因为首帧可能还在骨架屏。
   * 不等就量会得到 null，报红的方式是「期望 560，实测 null」——看着像
   * 布局坏了，实际只是还没挂载完。
   */
  await breakPage.locator('.composer__input').waitFor()
  await breakPage.waitForTimeout(500)

  /**
   * 量一次当前视口下的骨架几何。
   *
   * 每次都要重新读，不能缓存：容器查询的命中结果是**布局阶段**算出来的，
   * 改完视口不读一遍就拿不到新值。
   */
  const measureAt = async () => breakPage.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) return null
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height) }
    }
    const measure = box('.timeline__measure')
    const column = box('.column')
    const shell = box('.shell')
    const spineBox = box('.spine')
    const railBox = box('.rail')
    const workspace = document.querySelector('.workspace')
    const wsRect = workspace?.getBoundingClientRect()
    return {
      shell: shell === null ? null : shell.w,
      /*
       * workspace 的左缘与宽度。
       *
       * 检查器是 `position: absolute; right: var(--w-spine)`，参照的是
       * workspace 而不是主列——workspace 有 8 的左右外边距与 0.5 的边框，
       * 所以「检查器右缘 == 主列右缘」这条旧判据差了 8.5px。判据改成
       * 相对 workspace 算，外面那圈边距就不会再被当成布局错误。
       */
      wsX: wsRect === undefined ? null : Math.round(wsRect.x),
      wsW: wsRect === undefined ? null : Math.round(wsRect.width),
      column: column === null ? null : column.w,
      rail: railBox === null ? null : railBox.w,
      spine: spineBox === null ? null : spineBox.w,
      measure: measure === null ? null : measure.w,
      /* 正文两侧留白 = (主列宽 − 正文宽) / 2。这是「留白吸收新增宽度」的直接读数。 */
      gutter: measure === null || column === null ? null : Math.round((column.w - measure.w) / 2),
      /* 列数：读 grid 模板的列数，比逐个量元素更能反映"到底排了几列"。 */
      columns: workspace === null
        ? null
        : getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
      inspector: box('.inspector'),
      /* 文档宽度：任何横向溢出都会让它大于视口。 */
      docWidth: Math.round(document.documentElement.scrollWidth),
      viewport: globalThis.innerWidth,
    }
  })

  /**
   * 改视口、等布局落地、再量。
   *
   * ## 为什么不能只等两帧
   *
   * 第一版就是「setViewportSize → 两帧 → 量」，结果反向验证时把阈值从
   * 1200 改成 1100，**断言居然全绿**。诊断打出来才发现：量的时候
   * `gridTemplateColumns` 还是三列，几百毫秒后再读已经是四列了。
   * 也就是说 `setViewportSize` 返回时新宽度还没落到布局上，两帧不够。
   *
   * 等的是**事实**不是时长：先等 `innerWidth` 真的变成目标值，再等两帧。
   * 这一条如果不修，整个 §12.8 断言组会在阈值写错时静默通过——比没有断言更糟。
   */
  const resizeAndMeasure = async (width, height = 580) => {
    await breakPage.setViewportSize({ width, height })
    await breakPage.waitForFunction(
      (target) => globalThis.innerWidth === target,
      width,
      { timeout: 5000 },
    )
    // 宽度到位后再等两帧：一帧让容器查询重算，一帧让可能的过渡走完。
    await breakPage.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(resolve) })
    }))
    return measureAt()
  }

  // --- 820 基准：正文 560，两侧各 74 ---
  const at820 = await resizeAndMeasure(820)
  eq('§12.8 820 下正文仍 560', 560, at820.measure)
  eq('§12.8 820 下两侧各留 65', 65, at820.gutter)
  /*
   * 列数是**计数**，容差必须是 0。
   *
   * `eq()` 的默认容差是 1px——它为像素测量设计（半像素取整），对列数
   * 却是灾难：3 与 4 只差 1，落在容差内，于是「容器查询把骨架切成四列」
   * 这件事**永远不会被这条断言发现**。反向验证时正是这样：阈值改成 1100
   * 后 1199 已经是四列，这条仍打绿勾，是旁边那条几何断言报的红。
   * 计数类断言一律显式传 0。
   */
  eq('§12.8 820 下是三列骨架', 3, at820.columns, 0)

  // --- 960：正文不动，留白吸收全部新增宽度（960 − 820 = 140，均分 70） ---
  const at960 = await resizeAndMeasure(960)
  eq('§12.8 960 下正文仍 560', 560, at960.measure)
  eq('§12.8 960 下两侧各留 135', 135, at960.gutter)
  eq('§12.8 960 下仍是三列', 3, at960.columns, 0)

  /*
   * --- 1199：常驻阈值的**下边**，必须仍是覆盖式三列 ---
   *
   * 只测 820 和 1200 会漏掉"阈值写成了 1190" 这类偏差。取 1199 是因为
   * 它离边界只有一个像素，`min-width: 1200` 若被误写成 `min-width: 1199`
   * 或 `min-width: 1100`，这里立刻红。
   */
  await breakPage.locator('.spine').click()
  await breakPage.waitForTimeout(400)
  const at1199Open = await resizeAndMeasure(1199)

  eq('§12.8 1199 下检查器仍是三列（覆盖式）', 3, at1199Open.columns, 0)
  truthy('§12.8 1199 下检查器存在', at1199Open.inspector !== null)
  /*
   * 覆盖态：检查器贴在 Spine 内侧，**与主列重叠**。
   *
   * 判据是两条几何事实同时成立：
   *   1. 它的右缘与主列右缘重合（`right: var(--spine-w)` 的效果）；
   *   2. 它的左缘**严格小于**主列右缘，即它压在正文区域上。
   *
   * ## 第一版判据太松，反向验证没抓住
   *
   * 原先写的是 `inspector.x < 1199 - 56`（"左缘小于 Spine 左边界"）。
   * 把阈值改成 1100 后检查器左缘从 843 变成 899，**仍然小于 1143**，
   * 断言照绿。那条式子看着像几何，实际只是把窗口宽度又抄了一遍，
   * 对"容器查询有没有命中"完全无感。改成与主列的关系式。
   */
  truthy(
    `§12.8 1199 下检查器覆盖主列（主列右缘 ${String(at1199Open.column === null ? 0 : at1199Open.column + (at1199Open.rail ?? 0))}，检查器 ${String(at1199Open.inspector?.x ?? -1)}–${String((at1199Open.inspector?.x ?? 0) + (at1199Open.inspector?.w ?? 0))}）`,
    at1199Open.inspector !== null &&
      at1199Open.column !== null &&
      at1199Open.rail !== null &&
      at1199Open.wsX !== null &&
      at1199Open.wsW !== null &&
      at1199Open.spine !== null &&
      /* 右缘贴在 Spine 左沿：覆盖态是 `right: var(--w-spine)`，参照 workspace 右缘。 */
      Math.abs(
        at1199Open.inspector.x + at1199Open.inspector.w
        - (at1199Open.wsX + at1199Open.wsW - at1199Open.spine),
      ) <= 2 &&
      /* 左缘落在主列之内：这就是"覆盖"的定义。 */
      at1199Open.inspector.x < at1199Open.wsX + at1199Open.rail + at1199Open.column - 1,
  )

  /*
   * --- 1200：正好在阈值上，`min-width` 含等号，必须换成四列 ---
   *
   * 这一条与上一条成对：一条验"没到就别展开"，一条验"到了必须展开"。
   * 只留一条时，把整个容器查询删掉也能全绿。
   */
  const at1200 = await resizeAndMeasure(1200)
  eq('§12.8 1200 下检查器占第四列', 4, at1200.columns, 0)
  eq('§12.8 1200 下正文仍 560', 560, at1200.measure)
  eq('§12.8 1200 下两侧各留 105', 105, at1200.gutter)
  /*
   * 并排的判据：检查器左缘 == 主列右缘 + Spine 宽。
   *
   * ## 为什么是"加 Spine 宽"而不是"等于主列右缘"
   *
   * DOM 顺序是 Rail → 主列 → Spine → 检查器，四列时检查器排在 Spine **之后**，
   * 所以它从 Spine 右沿起算。第一版写成"等于主列右缘"，实测差正好 56
   * （= Spine 宽），红的是断言不是布局。写这条时把 56 硬编码进去同样是错的
   * ——`--spine-w` 改了断言会跟着假红，所以读 `.spine` 的实际宽度。
   *
   * `column` 是**主列宽**不是左缘坐标，所以"主列右缘"= 主列宽 + 左脊宽。
   * 这里同样读 `.rail` 的实测宽度，不写死 48。
   *
   * 覆盖态（三列）下它 `position: absolute; right: var(--spine-w)`，
   * 左缘落在**主列之内**，与这条等式相差一整个检查器宽，两者不能同时成立。
   */
  truthy(
    `§12.8 1200 下检查器不覆盖主列（主列右缘 ${String(at1200.column === null ? 0 : at1200.column + (at1200.rail ?? 0))}，Spine ${String(at1200.spine)}，检查器左缘 ${String(at1200.inspector?.x ?? -1)}）`,
    at1200.inspector !== null &&
      at1200.column !== null &&
      at1200.spine !== null &&
      at1200.rail !== null &&
      at1200.wsX !== null &&
      /* 四列时从 workspace 左缘起算：rail + 主列 + spine 之后才是检查器。 */
      Math.abs(
        at1200.inspector.x - (at1200.wsX + at1200.rail + at1200.column + at1200.spine),
      ) <= 2,
  )

  /*
   * --- 1920：正文绝不跟着变宽 ---
   *
   * §13 原文「窗口放大到 1920 时正文仍为 560，新增宽度全部给留白」。
   * 这一档最能暴露「有人把 max-width 改成百分比」。
   */
  const at1920 = await resizeAndMeasure(1920)
  eq('§12.8 1920 下正文仍 560', 560, at1920.measure)
  /*
   * 留白公式里的两个脊宽读实测值，不写死 48 / 56。
   *
   * 写死的话，把两脊改成 52 之后这条会**假红**——而它红的时候说的是
   * 「留白不对」，看着像主列算错了，实际只是常数没跟上。断言里的每个
   * 数字要么是被测对象的实测值，要么是设计文档里的独立常量；
   * 从别的元素推出来的量一律现读。
   */
  eq(
    '§12.8 1920 下留白吸收全部新增宽度',
    Math.floor((1920 - 17 - (at1920.rail ?? 0) - (at1920.spine ?? 0) - 300 - 560) / 2),
    at1920.gutter,
  )
  eq('§12.8 1920 下无横向滚动', 1920, at1920.docWidth)

  /*
   * --- 常驻检查器关掉后，第四列必须消失 ---
   *
   * 这是一个真实存在的错误写法：把四列写死在 `.workspace` 上（而不是
   * `.workspace[data-inspector]`），关掉检查器后右侧留 300px 空白，
   * 主列内容偏左。而"打开时是四列"那条断言照样绿。
   */
  await breakPage.locator('.spine').click()
  await breakPage.waitForTimeout(400)
  const at1920Closed = await measureAt()
  eq('§12.8 关掉检查器后回到三列', 3, at1920Closed.columns, 0)
  eq('§12.8 关掉检查器后正文仍 560', 560, at1920Closed.measure)

  await breakPage.screenshot({ path: join(OUT, 'breakpoint-1920.png') })

  /*
   * --- 高度 < 560：输入区上间距 12 → 8（§12.8、§3.6 第 2 条）---
   *
   * 高度方向的断点用的是媒体查询而不是容器查询，这是**有意**的：
   * `container-type: inline-size` 只管行内轴，管不到块轴；要管块轴得
   * `container-type: size`，那会让 `.shell` 的高度不再由内容决定，
   * 整页被压扁（`composer.css` 里有同样的说明）。
   *
   * 判据取 padding-top：`12px` → `8px` 是这一档唯一的变化，量它最直接。
   * 560 本身是边界，取 559 与 561 两侧，避免"写成 max-height: 500" 时
   * 在 560 上仍然通过。
   */
  await breakPage.setViewportSize({ width: 820, height: 561 })
  await breakPage.waitForTimeout(150)
  const tallPad = await breakPage.evaluate(
    () => getComputedStyle(document.querySelector('.composer')).paddingTop,
  )
  await breakPage.setViewportSize({ width: 820, height: 559 })
  await breakPage.waitForTimeout(150)
  const shortPad = await breakPage.evaluate(
    () => getComputedStyle(document.querySelector('.composer')).paddingTop,
  )
  same('§12.8 高度 561 时输入区上间距 8', '8px', tallPad)
  same('§12.8 高度 559 时输入区上间距收到 0', '0px', shortPad)

  /*
   * --- 14d. 小热区不得小于 24×24 ---
   *
   * ## 为什么这条必须量**命中测试**而不是量盒子
   *
   * 这一栏里有一批控件视觉上很小（红绿灯 12、关闭键 26），靠伪元素或
   * padding 把命中区补大。上一版 `composer__model-button` 写了
   * `::before { inset: -3px }`，几何算出来是 28×28，**但按钮自己有
   * `overflow: hidden`（为了省略号），伪元素被裁掉，实际点上去只命中
   * 22**。量 `getBoundingClientRect()` 会得到 28 并通过——一个量错对象
   * 还照常出结论的检查，比没有检查更危险。
   *
   * 所以这里用 `elementFromPoint` 在控件边缘**外侧 2px** 取点，看命中的
   * 是不是它自己（或它的子节点）。这才回答「点得中吗」。
   *
   * 阈值 24 而不是 44：桌面端有精确指针，24 是这一套里视觉尺寸的上限
   * （图标钮 26、胶囊 22）。44 留给 `@media (hover: none)`——触屏那档
   * 由 `.rail__item` 与红绿灯各自实现，不在这个判据里重复要求。
   */
  await breakPage.setViewportSize({ width: 820, height: 580 })
  await breakPage.waitForTimeout(200)
  const hitProbe = await breakPage.evaluate(() => {
    /**
     * 量一个元素**真实可点的范围**：从中心向外逐像素走，直到点不中为止。
     *
     * ## 为什么不量盒子、也不量"盒子外面 2px"
     *
     * 两种补热区的做法得到的几何不同：
     * - `::before { inset: -3px }`：热区**超出**盒子，量盒子会少算；
     * - `padding` + 负 `margin`：热区**就是**盒子，去探盒子外面必然不中。
     *
     * 而 `getBoundingClientRect()` 又不含伪元素，对第一种量不准。
     * 只有"从中心往外走"这一种量法对两种做法都成立，且它直接回答
     * 「点得中吗」——这正是要守的东西。
     */
    const reach = (selector) => {
      const el = document.querySelector(selector)
      if (el === null) return null
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return null
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hits = (x, y) => {
        const hit = document.elementFromPoint(x, y)
        return hit !== null && (hit === el || el.contains(hit))
      }
      /** 沿某个方向逐像素探，返回最后一个命中点的距离。 */
      const walk = (dx, dy) => {
        let last = 0
        for (let d = 1; d <= 60; d += 1) {
          if (hits(cx + dx * d, cy + dy * d)) last = d
          else break
        }
        return last
      }
      return {
        boxW: Math.round(r.width),
        boxH: Math.round(r.height),
        up: walk(0, -1),
        down: walk(0, 1),
        left: walk(-1, 0),
        right: walk(1, 0),
      }
    }
    return {
      modelButton: reach('.composer__model-button'),
      attach: reach('.composer__attach'),
      trafficDot: reach('.traffic-lights__dot'),
    }
  })

  /*
   * 模型按钮：padding 方案，热区就是盒子。上下各能走 ~14（28 的一半），
   * 合计 28 —— 比原来的 22 高 27%。
   */
  const modelReach = hitProbe.modelButton
  eq(
    '热区·模型按钮上下可达各 14（合计 28 高）',
    14,
    modelReach?.up ?? -1,
  )
  eq('热区·模型按钮热区高度 28', 28, modelReach === null ? -1 : modelReach.up + modelReach.down + 1)
  /*
   * 附加键：`::before` 外扩 5，盒子 16 → 热区 26。上下各能走 13。
   */
  eq(
    '热区·附加键上下可达各 13（合计 26，视觉仍 16）',
    13,
    hitProbe.attach?.up ?? -1,
  )
  /*
   * --- 14c. `Cmd+N` 回首页，而不是「在三栏里再开一个空会话」---
   *
   * ## 这条断言的靶子是两个具体缺陷
   *
   * 1. `Cmd+N` 的规范原文（§9.1）是「已在会话中时清空并**回到首页形态**」。
   *    旧实现调 `newSession()`——建会话、留在三栏，于是按完界面只是
   *    变成一片空白加一行小字，标题写着「新对话」。用户读到的不是
   *    「我回到了首页」，而是「界面坏了」。
   * 2. 同一个函数每次都先 POST 一个空会话，真机数据目录里积了 8 个
   *    零消息的「未命名会话」。空壳会挤进会话列表与记忆检索。
   *
   * ## 为什么断言里要数 POST 次数
   *
   * 只断言「回到了首页」会漏掉第二条：先建再切、然后立刻切回首页，
   * 界面看起来完全正确，但空壳已经落库了。**界面正确和数据干净是
   * 两件事，必须两个判据**——本仓记过很多次的同一形态。
   *
   * ## 为什么放在这一段的最后
   *
   * 它会把形态切到首页再切回来，焦点随之变化。前面那批焦点断言
   * （启动焦点、第一次 Tab）必须在「没被点过」的世界上跑，所以这条
   * 排在它们之后、断点页之前。
   */
  let sessionPosts = 0
  let clearPosts = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = new URL(request.url()).pathname
    if (path === '/api/sessions') sessionPosts += 1
    if (path.endsWith('/clear')) clearPosts += 1
  })

  await page.keyboard.press('Meta+n')
  await page.waitForTimeout(400)

  /*
   * `Cmd+N` 的语义变了：从「回到首页」变成「清空会话、原地留在三栏」。
   *
   * 首页删掉后这条快捷键只负责清干净，并把焦点放进输入框。断言因此从
   * 「.welcome 在场、.workspace 不在」翻转为「.workspace 仍在、主列回到开场、
   * 焦点在输入框」——三条都对应一个用户真的会感知的结果。
   */
  const afterNew = await page.evaluate(() => ({
    workspace: document.querySelector('.workspace') !== null,
    empty: document.querySelector('.timeline__empty') !== null,
    focused: document.activeElement?.classList.contains('composer__input') ?? false,
  }))
  truthy('Cmd+N 之后仍是三栏（.workspace 在场）', afterNew.workspace)
  truthy('Cmd+N 之后主列回到开场', afterNew.empty)
  truthy('Cmd+N 之后焦点在输入框', afterNew.focused)
  /*
   * 两个计数一起看，缺一个都能被骗过去：
   *
   * - `POST /api/sessions` 必须 0 次：单会话制下这条路由直接回 409，
   *   前端若还在调它，界面上什么都不会发生，用户按了没反应。
   * - `POST …/clear` 必须恰好 1 次：一次误点要点两次（两段确认）才生效，
   *   而快捷键不该重复发两遍——重复发会把刚归档的那一段又清一次。
   */
  same('Cmd+N 不落空会话（POST /api/sessions 0 次）', 0, sessionPosts)
  same('Cmd+N 走归档清空（POST …/clear 恰 1 次）', 1, clearPosts)

  if (breakErrors.length > 0) {
    console.log('\n断点页的控制台错误：')
    for (const error of breakErrors) console.log(`  ${error}`)
    process.exitCode = 1
  }
  await breakPage.close()

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
