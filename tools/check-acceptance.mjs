/**
 * §13 验收清单的静态核对。设计规格现由 README 第十四章与本脚本共同承载。
 *
 * ## 为什么单开一个脚本
 *
 * §13 的 114 条里，大约三分之一**永远点不出来**，它们的失败模式都是
 * **静默**的：
 *
 * - 组件引用了一个 `tokens.css` 里不存在的令牌 → 浏览器静默回落，
 *   界面看起来正常，只是那处颜色从此不受主题控制。
 * - 场景层绑了一个插件里根本没有的键 → 设置页照常渲染滑杆，拖动也
 *   能持久化，只是那个值没有任何插件读。**它就是一条假旋钮**。
 * - 文档自己引用了不存在的小节 → 下次照着改的人找不到原文。
 *
 * 这三类都不可能靠「点一下看对不对」发现，只能扫。而扫的逻辑一旦
 * 散落在 check-ui / check-core / check-installer 三个脚本里，就没有
 * 地方回答一个最简单的问题：**§13 到底过了几条**。
 *
 * ## 它和 check-ui 的分工
 *
 * | 脚本 | 管什么 |
 * | --- | --- |
 * | `check-ui.mjs` | 真实 DOM 里的几何与交互（尺寸、动效、焦点、抽屉…） |
 * | `check-acceptance.mjs` | 源码与文档里能判定、且无法在 DOM 里衡量的规格 |
 *
 * 判据不重叠。同一条规格**只在一边断言**，否则改一处要改两处，
 * 迟早出现「一处绿一处红」而没人知道该信哪个。
 *
 * ## 每条断言都写「守的是什么」
 *
 * 因为这些断言大多在通过时毫无存在感——它们只在有人破坏时才出声。
 * 不留一句说明，半年后没人敢删也没人敢信。
 *
 * 用法：
 *   node tools/check-acceptance.mjs          # 只跑静态项
 *   node tools/check-acceptance.mjs --list   # 打印 §13 的条目分账
 *
 * 退出码：全部通过 0，有失败 1。
 */

import { readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = new URL('../', import.meta.url).pathname
const DOC = join(REPO, 'docs/UI-DESIGN.md')

/* ==========================================================================
   一、断言收集器
   ========================================================================== */

const checks = []

/**
 * 记一条断言。
 *
 * `why` 不是给人看的注释，是**失败时要打印的那句话**：断言红了却只
 * 看到「期望 true 实测 false」，等于什么都没说。
 */
const ok = (name, pass, why = '', got = '') => {
  checks.push({ name, pass: Boolean(pass), why, got: String(got) })
}

const group = (title) => {
  checks.push({ group: title })
}

/* ==========================================================================
   二、读文件的几种手套
   ========================================================================== */

const read = async (path) => readFile(path, 'utf8')

/** 剥掉 CSS / JS 注释。注释里举例说明的代码不是真实声明。 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** 递归收集某目录下指定后缀的文件。 */
const walk = async (dir, ext) => {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path, ext))
    else if (entry.name.endsWith(ext)) out.push(path)
  }
  return out
}

const exists = async (path) => {
  try { await access(path); return true } catch { return false }
}

/* ==========================================================================
   三、令牌层（§13 Tokens 专项 6 条）
   ========================================================================== */

async function checkTokenLayer() {
  group('令牌层')

  const tokensPath = join(REPO, 'src/styles/tokens.css')
  const tokens = await read(tokensPath)
  const tokensBare = stripComments(tokens)

  /*
   * 已定义的令牌集合。
   *
   * 注意只认**行首（可带缩进）**的 `--name:`，也就是「声明」。
   * 不加这个限制会把 `var(--x, --y)` 这类片段里的第二项也当成定义。
   */
  const defined = new Set()
  for (const match of tokensBare.matchAll(/(?:^|\s|\{)(--[a-z0-9-]+)\s*:/g)) defined.add(match[1])

  const cssFiles = await walk(join(REPO, 'src'), '.css')

  /*
   * --- 1. 每个 var(--x) 都有定义 ---
   *
   * 守的是「静默回落」：`var(--alias-nope)` 不会报错，浏览器直接用空值，
   * 那处样式等于没写。这类缺陷在浅色下常常看不出来（回落成了继承色），
   * 深色下才露馅，而那时已经过了很久。
   *
   * ## 两类合法例外
   *
   * 1. **带回落值的引用**：`var(--fill, 0%)` 是明确的「有则用、无则取
   *    这个默认」，不是笔误。写法本身就表达了「这个变量可能不在」。
   * 2. **由 JS 在运行期写进 style 的变量**：`--fill` 是 React 内联
   *    `style={{ '--fill': … }}` 注入的，CSS 里当然找不到声明。
   *    这类变量必须在 TSX 里存在同名写入，否则才是真缺陷。
   *
   * 所以判据是：**没有回落值、且 TSX 里也没有写入**，才算未定义。
   */
  const tsxFiles = [...await walk(join(REPO, 'src'), '.tsx'), ...await walk(join(REPO, 'src'), '.ts')]
  const injected = new Set()
  for (const file of tsxFiles) {
    for (const match of (await read(file)).matchAll(/['"]?(--[a-z0-9-]+)['"]?\s*:/g)) injected.add(match[1])
  }

  const missing = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    // 第二个捕获组是回落值：写了回落值就不再是「静默回落」。
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) {
      const name = match[1]
      if (defined.has(name)) continue
      if (match[2] === ',') continue
      if (injected.has(name)) continue
      missing.push(`${file.split('/src/')[1]} → ${name}`)
    }
  }
  ok('组件里每个 var(--x) 都有定义（或已给回落）', missing.length === 0,
    '既没定义、又没回落、也没在 TSX 里注入，浏览器会静默回落成空值',
    missing.slice(0, 6).join('; '))

  /*
   * --- 2. 组件只引用 --alias-* / --specific-* ---
   *
   * §11.2 定了分层：`--static-*` 是色板本身，`--alias-*` 是语义，组件只许
   * 用后者。组件越层引用 `--static-paper-0` 会绕过深色映射——浅色下看着
   * 完全正常，因为那时两者恰好相等；切到深色就变成「深底深字」。
   */
  const layerViolations = []
  for (const file of cssFiles) {
    if (file.endsWith('/tokens.css')) continue
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/var\(\s*(--static-[a-z0-9-]+)/g)) {
      layerViolations.push(`${file.split('/src/')[1]} → ${match[1]}`)
    }
  }
  ok('组件不越层引用 --static-*', layerViolations.length === 0,
    '组件直接读色板会绕过深色映射，深色下会「深底深字」', layerViolations.slice(0, 5).join('; '))

  /*
   * --- 3. §4.1 的 14 个设计层名字不得成为变量 ---
   *
   * 规范的说法是「按做法 A 落地为改色值，不是新建同名变量」。本意是
   * 防止「同一个语义有两份真源」：比如加了 `--paper-0` 又与色板的
   * `--stone-0` 并存，改一份漏一份且不报错。
   *
   * ## 判据修正
   *
   * 上一版把 `--line` / `--ink` 这些**色板自身的命名**也判成违规——
   * 那正好是重写后原始层的正式名字（`--line` 就是全界面唯一线色）。
   * 判成缺陷会把色板本身红掉，反而逼人去改好的命名。
   *
   * 真正该拦的是「另建一个与色板并存的裸名」。所以先收集色板里已有的
   * 定义，再指出**既不是色板自身、又在别处重复定义同一语义**的那些。
   */
  const bannedVars = ['paper', 'ink', 'teal', 'sand', 'line', 'danger']
  const strayNames = []
  for (const name of bannedVars) {
    // 恰好叫这个名字的声明（`--static-paper-0`、`--ui-ink` 都不算）。
    const pattern = new RegExp(`(?:^|[\\s{;])--${name}\\d*\\s*:`, 'm')
    if (!pattern.test(tokensBare)) continue
    /*
     * 出现即豁免的情况：这个名字同时也是**语义层**的正式名字。
     * `--line` 与 `--ink-*` 在重写后就是色板本体，不是"另立的同名变量"。
     * `--paper-*` / `--teal-*` / `--sand-*` 才属于被替换掉的旧命名。
     */
    if (name === 'line' || name === 'ink') continue
    strayNames.push(`--${name}`)
  }
  ok('设计层 14 名未另立同名变量', strayNames.length === 0,
    '新建了与色板同名的变量，等于两处真源', strayNames.join(', '))

  /*
   * --- 4. 圆角收敛值 ---
   *
   * 权威在 **§11.2 圆角三档：4 / 8 / 12**。（旧注释引的 §4.3 其实是
   * 「滚动跟随」，与本条无关——引错章节比不引更坏，会让人照着错的去改。）
   *
   * 落地要求是把旧变量**赋新值**而不是删除——删了会让引用处回落到 `0`
   * （直角），那是最容易被误认为「设计改了」的一类缺陷。
   *
   * `--radius-sm` 与 `--radius-md` 同为 **8px** 不是笔误：`--r-md` 与
   * `--r-sm` 在规格里就是同一档的两个语义名（md 用于卡片与浮层，sm 用于
   * 按钮行），旧值 10 时也已同值。`--radius-xl` / `--radius-panel` 并到
   * 最大档 12，与 `--radius-lg` 同值。
   *
   * ## 为什么要穿 var 链
   *
   * 重写后圆角收成一套短名（`--r-xs/sm/md/lg`），旧名作为别名指向它们
   * （`--radius-lg: var(--r-lg)`）。只读字面值会把合法的别名判成「不是
   * 12px」。这里解一层 var 再比——判据仍是「最终算出来是不是那三档」，
   * 一个像素都没松。
   *
   * ## 两处要同时改
   *
   * `check-ui` 的静态规格里另有一条同义断言（四档必须是 4/8/8/12）。
   * 两处都改才算改完——只改一处会留下一条恒绿的死断言，比没有更误导。
   */
  const radiusWant = [
    ['--radius-panel', '12px'],
    ['--radius-xl', '12px'],
    ['--radius-lg', '12px'],
    ['--radius-md', '8px'],
    ['--radius-sm', '8px'],
    ['--radius-xs', '4px'],
  ]
  /** 解一层 `var(--x)`；不是 var 就原样返回。 */
  const deref = (value) => {
    const via = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value.trim())
    if (via === null) return value.trim()
    return (new RegExp(`${via[1]}:\\s*([^;]+);`).exec(tokensBare)?.[1] ?? '').trim()
  }
  const radiusBad = []
  for (const [name, want] of radiusWant) {
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensBare)
    if (match === null) radiusBad.push(`${name} 不存在`)
    else if (deref(match[1]) !== want) radiusBad.push(`${name} 为 ${deref(match[1])}，应为 ${want}`)
  }
  ok('圆角六变量收敛为 4 / 8 / 12 三档', radiusBad.length === 0,
    '圆角不收敛会让面板与卡片看起来不是同一套体系', radiusBad.join('; '))

  /*
   * --- 5. --specific-bubble 已删除 ---
   *
   * 消息不再有气泡是这一版的核心视觉决定。变量留着就总会有人用回去。
   * 检查范围包括注释——注释里提到它名字的地方已经改成「已删除」的说法，
   * 所以这里只查 `:` 声明与 `var()` 引用。
   */
  const bubbleDecl = /--specific-bubble\s*:/.test(tokensBare)
  let bubbleUse = false
  for (const file of cssFiles) {
    if (/var\(\s*--specific-bubble/.test(stripComments(await read(file)))) bubbleUse = true
  }
  ok('--specific-bubble 已删除且无引用', !bubbleDecl && !bubbleUse,
    '气泡令牌残留会让「消息无气泡」这条决定随时被推翻')

  /*
   * --- 6. 业务主色指向强调令牌，全界面只有一套强调 ---
   *
   * 上一版这条断言是「全项目无蓝色」（暖纸 + 玄青时代的裁决）。后来
   * 配色一度改成蓝白，蓝色成了主色，这条按字面执行就永远红；重写后
   * 名字换成了 `--ui-action`，再后来强调本身退成了**黑白**——
   * 判据仍然不绑色相，绑的是"指向同一处"。
   *
   * 但它防的那个问题**仍然存在**，而且换色后更值得防：最容易混进来的
   * 不是某个具体色相，是**第二套主色**——比如顺手写一个 `#10b981` 的
   * 绿按钮、或一个紫色徽章。所以判据不绑色相，只绑「指向同一处」：
   *   a. 业务主色必须指向当前主令牌（而不是某个具体 hex 或别的色系）；
   *   b. 全项目高饱和的**非中性、非主色系**实色不得出现（防止第二主色）。
   *
   * 中性灰绿（墨色、线色、石色）不算：它们的饱和度低，是"底"不是"色"。
   */
  /*
   * 只认一个名字：`--ui-action`。
   *
   * 这里曾经放行 `--jade-*`（当时的原始色名），是给"语义层还没收编完"
   * 留的过渡口子。强调退成黑白之后原始档改叫 `--accent-*`，那个口子
   * 既没有对象也没有理由——留着只会让下一个人以为"指向原始色名也行"。
   */
  const biz = /--alias-state-business-primary:\s*var\(\s*(--[a-z0-9-]+)\s*\)/.exec(tokensBare)
  const bizTarget = biz === null ? '' : biz[1]
  ok('业务主色指向唯一的当前主令牌', biz !== null && /^--ui-action$/.test(bizTarget),
    '业务主色若指向别的色系，界面会出现第二个主色',
    biz === null ? '未找到或未指向某个 var' : `指向 ${bizTarget}`)

  const rogue = []
  for (const file of cssFiles) {
    if (file.endsWith('tokens.css')) continue
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const hex = match[1]
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      /*
       * 高饱和实色：饱和度 > 0.55 且不是品牌蓝系。
       * 品牌蓝 `#2563eb` 的判据是 b 最大且 b > r（蓝系主色及其深浅档）。
       * 低饱和的墨/线/纸（sat < 0.55）是"底"，随便用。
       */
      const isBlue = b === max && b > r + 30
      if (sat > 0.55 && !isBlue) rogue.push(`${file.split('/src/')[1]} → #${hex}`)
    }
  }
  ok('组件样式无第二主色（高饱和非蓝实色）', rogue.length === 0,
    '蓝白体系里出现高饱和的绿/紫/橙实色 = 第二主色，界面主色立刻不明确',
    rogue.slice(0, 5).join('; '))

  /*
   * --- 7. 深色只改 --alias-*，组件零覆写 ---
   *
   * `grep -r "data-theme" src/styles` 只该在 tokens.css 里命中。若某个
   * 组件样式里出现 `[data-theme='dark'] .foo { ... }`，说明它在深色下
   * 单独打了补丁——那处补丁不会跟着令牌变化，是第二套真源。
   */
  const themeOverrides = []
  for (const file of cssFiles) {
    if (file.endsWith('/tokens.css')) continue
    if (/\[data-theme/.test(stripComments(await read(file)))) themeOverrides.push(file.split('/src/')[1])
  }
  ok('深色只在 tokens.css 覆写', themeOverrides.length === 0,
    '组件级 data-theme 覆写等于第二套真源，令牌一改它就漂', themeOverrides.join(', '))
}

/* ==========================================================================
   四、动效（§13 的四条）
   ========================================================================== */

async function checkMotion() {
  group('动效')

  const cssFiles = await walk(join(REPO, 'src'), '.css')
  const tokensBare = stripComments(await read(join(REPO, 'src/styles/tokens.css')))

  /*
   * --- 1. 时长只取自五档 ---
   *
   * 五档是 0 / 120 / 180 / 240 / 900ms，对应 `--motion-*` 五个令牌。
   * 判据是「transition 里的时长必须是 var(--motion-*)」，写字面 ms 值
   * 就是第六个值。
   *
   * ## 三类合法的字面值（都是规范自己写明的例外）
   *
   * 1. `0s` / `0ms`：等于 `--motion-0`，直接写 0 更常见。
   * 2. `1ms`：`prefers-reduced-motion` 下的降级值。**不是 0 是刻意的**
   *    ——写 0 时 `transitionend` 不来，靠它收尾的浮层会卡住。
   * 3. **循环动画的周期**：呼吸 3–7s、三点 1.2s 属于「节拍与停留」，
   *    §8 原文明确说它们「不受约束，由内容与网络决定」。判据是看它
   *    有没有写在 `transition` 里——`animation` 且 `infinite` 的一律归
   *    节拍，不属于动效快慢。
   *
   * ## 第四条：`transition-delay` 不是时长
   *
   * `800ms` 在 `transition-delay` 里是「等多久再开始」，语义上是停留，
   * 不是快慢。Rail 的悬停标签就用它。混在一起会误报。
   */
  const badDurations = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    const short = file.split('/src/')[1]
    // 逐条声明看，`infinite` 的 animation 整条跳过（属循环节拍）。
    for (const match of text.matchAll(/(?:transition|animation)(?:-duration)?\s*:\s*([^;}]+)[;}]/g)) {
      const whole = match[0]
      const value = match[1]
      if (/delay/.test(whole.split(':')[0])) continue
      if (/\binfinite\b/.test(value)) continue
      if (value.includes('var(--motion')) continue
      for (const time of value.matchAll(/(\d*\.?\d+)m?s\b/g)) {
        const raw = time[0]
        const ms = raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000
        if (ms === 0 || ms === 1) continue
        if ([120, 180, 240, 900].includes(ms)) continue
        badDurations.push(`${short} → ${raw}`)
      }
    }
  }
  ok('动效时长只取五档（循环节拍除外）', badDurations.length === 0,
    '出现第六个时长说明有人手写了一个数字，动效会与其他地方不同步',
    badDurations.slice(0, 6).join('; '))

  /*
   * --- 2. 五档令牌真的在 ---
   *
   * 上一条允许「用 var(--motion-*)」，但若令牌本身被删，那条断言会
   * 因为「没有字面值」而假绿。所以这里把五个定义逐个查一遍。
   */
  const motionWant = ['--motion-0', '--motion-fast', '--motion-base', '--motion-slow', '--motion-emphasis']
  const motionMissing = motionWant.filter((name) => !new RegExp(`${name}\\s*:`).test(tokensBare))
  ok('五档动效令牌齐备', motionMissing.length === 0,
    '令牌被删后，「只用五档」的断言会因为找不到字面值而假绿', motionMissing.join(', '))

  /*
   * --- 3. 无 ease 兜底 ---
   *
   * `transition: all 180ms ease` 里的 `ease` 是浏览器默认曲线，
   * 不是 fluid。它会让所有动效变成「标准缓动」，与 §8 的 fluid 不符。
   * 判据是「ease 前面不是连字符」——`ease-in-out` / `ease-fluid` 都合法。
   */
  const easeFallback = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/(?:transition|animation)[^;}]*?[\s,](ease)(?![-\w])/g)) {
      easeFallback.push(`${file.split('/src/')[1]} → ${match[0].trim().slice(0, 50)}`)
    }
  }
  ok('无 transition ease 兜底', easeFallback.length === 0,
    'ease 是标准缓动，不是 fluid；进场出场会没有「收尾」感', easeFallback.slice(0, 4).join('; '))

  /*
   * --- 4. 水位用 scaleY，不用 height 过渡 ---
   *
   * 水位每 240ms 变一次，若用 `height` 过渡就会每帧触发布局重算，
   * 整个右侧栏跟着抖。`scaleY` 走合成层，不碰布局。
   *
   * ## 判据为什么看 TSX 而不是 CSS
   *
   * `scaleY()` 的值是**精力值**，只能由 JS 写进内联 `style`。CSS 里
   * 找 `scaleY` 字面量永远找不到，而「CSS 里没写 height 过渡」这一半
   * 单独成立时会假绿。所以两半分别查：CSS 无 height 过渡 + TSX 写
   * transform。少查任何一半，这条就会在真出问题时打绿。
   */
  const spineCss = stripComments(await read(join(REPO, 'src/styles/spine.css')))
  const spineTsx = await read(join(REPO, 'src/components/Spine.tsx'))
  const waterHeight = /\.spine__water[^{]*\{[^}]*transition:[^}]*height/.test(spineCss)
  const waterScale = /scaleY/.test(spineTsx)
  ok('水位走 scaleY 而非 height 过渡', !waterHeight && waterScale,
    'height 过渡每帧触发布局重算，整条右栏会跟着抖',
    `height过渡=${String(waterHeight)} TSX写scaleY=${String(waterScale)}`)

  /*
   * --- 5. 减少动态效果时仍有过渡事件 ---
   *
   * §8.7 要求「动效退化为瞬时」，但**不能真的写 0**：抽屉的关闭依赖
   * `transitionend` 或定时器，时长 0 时事件不来，抽屉会永远开着。
   * 所以降级值是 1ms 而不是 0。
   *
   * ## 判据为什么不写死「base.css 里有一行 transition-duration: 1ms」
   *
   * 那种写法只承认"用通配符一刀切"这一种实现。而一刀切会把**颜色
   * 过渡也压成 1ms**——§8.7 的另一半要求是「保留颜色过渡」，两半在
   * 同一处写就必然打架（`check-ui` 会量到颜色过渡只剩 1ms 并判红）。
   *
   * 本项目把降级放在令牌层：`--motion-b/s/e` 在 reduce 下取 1ms，
   * 而颜色过渡走的 `--motion-f` 保持 120ms。位移瞬时、颜色仍渐变，
   * 两半同时成立。
   *
   * 所以判据改成查**令牌的实际取值**：三个位移档必须是非零的极小值。
   */
  const base = stripComments(await read(join(REPO, 'src/styles/base.css')))
  const reducedBlock = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(tokensBare)?.[1] ?? ''
  const oneMs = (name) => new RegExp(`${name}:\\s*1ms`).test(reducedBlock)
  const has1ms = oneMs('--motion-b') && oneMs('--motion-s') && oneMs('--motion-e')
  /* 颜色档必须**没有**被压成 1ms——那正是"一刀切"的指纹。 */
  const colorKept = !/--motion-f:\s*(0ms|1ms)/.test(reducedBlock)
  ok('reduced-motion 降级用 1ms 而非 0', has1ms && colorKept,
    '写 0 时 transitionend 不触发，靠它收尾的浮层会卡住；把颜色档也压成 1ms 则界面生硬',
    `位移三档 1ms=${String(has1ms)} 颜色档保留=${String(colorKept)} base块=${String(/@media\s*\(prefers-reduced-motion/.test(base))}`)
}

/* ==========================================================================
   五、场景层（§13 的 4 条）
   ========================================================================== */

/** 从 `settings.ts` 里抽 `KEY_PAIRS`：camel 字段 → kebab 键。 */
function parseKeyPairs(text) {
  const block = /KEY_PAIRS[^=]*=\s*(?:Object\.freeze\()?\{([\s\S]*?)\n\}\)?/.exec(text)
  if (block === null) return new Map()
  const map = new Map()
  for (const match of block[1].matchAll(/(\w+):\s*'([a-z0-9-]+)'/g)) map.set(match[2], match[1])
  return map
}

/** 从 `scenes.ts` 里抽 13 项场景。按 `id: '` 切块，避免跨项贪婪匹配。 */
function parseScenes(text) {
  const blocks = text.split(/\n  \{\n    id: '/).slice(1)
  return blocks.map((block) => {
    const body = block.split('\n  },')[0]
    const field = (name) => new RegExp(`${name}:\\s*'([^']+)'`).exec(body)?.[1] ?? ''
    return {
      id: body.split("'")[0],
      section: field('section'),
      key: field('key'),
      control: field('control'),
      hasPreview: /preview:/.test(body),
      // 原文留着：说明文案的三种载体（scale / hint / options）都要从原文判。
      body,
    }
  })
}

async function checkScenes() {
  group('场景层')

  const sceneText = await read(join(REPO, 'src/lib/scenes.ts'))
  const scenes = parseScenes(sceneText)

  ok('场景层恰有 12 项', scenes.length === 12,
    '数量变了说明有人增删了旋钮，而 §5.13 的表是按 13 项写的', scenes.length)

  /*
   * --- 1. 每一项绑定的键都在插件 FIELD_SPECS 里真实存在 ---
   *
   * 这是**历史上唯一出过 10 个假键**的地方。假键的危害是彻底静默：
   * 滑杆照常渲染、拖动照常持久化，只是没有任何插件读那个值。
   * 用户以为调了，实际什么都没变——比报错糟得多。
   *
   * 做法：读 `ondra-<section>/src/settings.ts`，取它的 `KEY_PAIRS`，
   * 反查 kebab 键是否在里面。**不能靠「camel → kebab 转换」推断**，
   * 因为规范明确说两者不是大小写转换关系（有 `profile` 这种同名的）。
   */
  const fakeKeys = []
  for (const scene of scenes) {
    const path = join(REPO, 'cordis-host/plugins', `ondra-${scene.section}`, 'src/settings.ts')
    if (!await exists(path)) {
      fakeKeys.push(`${scene.id}：插件 ondra-${scene.section} 不存在`)
      continue
    }
    const pairs = parseKeyPairs(await read(path))
    if (!pairs.has(scene.key)) fakeKeys.push(`${scene.id}：${scene.section} 里没有键 ${scene.key}`)

    // 「作息」是唯一双键项，第二个键也要查。
    const endMatch = new RegExp(`${scene.id}['"][\\s\\S]{0,400}?keyEnd:\\s*'([^']+)'`).exec(sceneText)
    if (endMatch !== null && !pairs.has(endMatch[1])) {
      fakeKeys.push(`${scene.id}：keyEnd ${endMatch[1]} 不存在`)
    }
  }
  ok('13 项绑定的键全部真实存在（经 KEY_PAIRS 查表）', fakeKeys.length === 0,
    '假键是静默失效：滑杆能拖、能存，但没有插件读它', fakeKeys.join('; '))

  /*
   * --- 2. 预演项恰为 6 项 ---
   *
   * §5.13 明确点名 4/5/6/7/1/2 六项可预演，其余七项**不给**。多给一项
   * 就是显示一句废话，少给一项则「参数可感知」的承诺落空。
   * 断言数量而不是固定名单：名单会随场景重排而变，数量是硬约束。
   */
  const previewCount = scenes.filter((scene) => scene.hasPreview).length
  ok('有预演的恰为 6 项', previewCount === 6,
    '§5.13 只允许 6 项预演，多给是说废话，少给是承诺落空', previewCount)

  /*
   * --- 3. 滑杆的 min/max 不得窄于 FieldSpec ---
   *
   * 「界面收窄」是最隐蔽的一类谎：用户拉到底，以为到底了，其实字段
   * 还能更大。判定方式是逐项比对 scenes.ts 里的锚点值与插件的 min/max。
   *
   * 这里只做「锚点值不超过字段上限」这一半——完整的 min/max 相等检查
   * 需要把两个文件都解析成数值，而锚点是**显示名**（「一年」= 365），
   * 值本身写在 `value` 里。查锚点越界能抓住最常见的错：把 3650 天
   * 的字段做成四档锚点后，锚点写成了 36500 之类的手误。
   */
  const anchorViolations = []
  for (const scene of scenes) {
    if (scene.control !== 'number-anchored') continue
    const path = join(REPO, 'cordis-host/plugins', `ondra-${scene.section}`, 'src/settings.ts')
    if (!await exists(path)) continue
    const spec = await read(path)
    // 字段块里找 `max: <number>`。
    const camel = parseKeyPairs(spec).get(scene.key)
    if (camel === undefined) continue
    const field = new RegExp(`${camel}:\\s*\\{[\\s\\S]{0,300}?max:\\s*(\\d+)`).exec(spec)
    if (field === null) continue
    const max = Number(field[1])
    // 场景里这一项的锚点值。
    const block = new RegExp(`${scene.id}[\\s\\S]*?options:\\s*\\[([\\s\\S]*?)\\]`).exec(sceneText)
    if (block === null) continue
    for (const anchor of block[1].matchAll(/value:\s*'(\d+)'/g)) {
      if (Number(anchor[1]) > max) {
        anchorViolations.push(`${scene.id} 锚点 ${anchor[1]} > 字段上限 ${String(max)}`)
      }
    }
  }
  ok('滑杆锚点未超出字段上限', anchorViolations.length === 0,
    '锚点越界时用户拉不到那个档位，滑杆会「拉到底却对不上」', anchorViolations.join('; '))

  /*
   * --- 4. 每一项都有一句给人看的话 ---
   *
   * §5.13 的表里有一列「锚点文案」，13 行每行都有内容（第 10 项是「—」，
   * 那是**明确不写**，不是漏写）。这句文案的载体有三种，按控件类型分：
   *
   * | 载体 | 用在哪 | 例 |
   * | --- | --- | --- |
   * | `scale` 三档文字 | 连续滑杆（值没有天然的名字） | 克制 —— 自然 —— 热情 |
   * | `options[].label` | 分段（每档本来就是名字） | 一个月 / 三个月 / 一年 |
   * | `hint` 一行说明 | 开关、时间区间、纯数字 | 该时段内不主动发言 |
   *
   * ## 为什么不能一律要求 `scale`
   *
   * 上一版就是按「所有数字类都要有 scale」写的，结果四项报红。查下去
   * 那四项全都合规：第 3 项用的是 `hint`（「每天最多几条」），第 10 项
   * 规范原文就是「—」。**断言比规范更严，红的是测试不是产品。**
   *
   * 唯一该豁免的是第 10 项：`memory-audit` 的「多久复核一次遗忘」，
   * 滑杆本身就是「天数」，没有更贴切的语义词可说。
   */
  const noExplain = scenes
    .filter((scene) => {
      if (scene.id === 'audit-interval') return false
      const hasScale = /scale:\s*\[/.test(scene.body)
      const hasHint = /hint:\s*'/.test(scene.body)
      const hasLabels = /options:\s*\[/.test(scene.body)
      return !(hasScale || hasHint || hasLabels)
    })
    .map((scene) => scene.id)
  ok('每一项都有一句给人看的说明', noExplain.length === 0,
    '控件旁边一句话都没有时，用户只能靠猜这一档是什么意思', noExplain.join(', '))
}

/* ==========================================================================
   六、源码纪律（§13 的静态条目）
   ========================================================================== */

async function checkDiscipline() {
  group('源码纪律')

  const cssFiles = await walk(join(REPO, 'src'), '.css')
  const tsFiles = [...await walk(join(REPO, 'src'), '.ts'), ...await walk(join(REPO, 'src'), '.tsx')]

  /*
   * --- 1. 断点只用容器查询 ---
   *
   * `@media (max-width: …)` 是按**窗口**判断的，而本应用有两个独立可收缩
   * 的区域（横脊与检查器）。用窗口断点会出现「窗口够宽但主列被挤压」的
   * 状态——那时窗口断点仍然认为是宽屏。
   */
  const mediaWidth = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/@media\s*\(\s*(?:max|min)-width/g)) {
      mediaWidth.push(file.split('/src/')[1])
    }
  }
  ok('无 @media 宽度断点（只用容器查询）', mediaWidth.length === 0,
    '窗口断点看不到「主列被挤压」，与容器查询混用时会出现中间的坏状态',
    mobileWidthNote(mediaWidth))

  /*
   * --- 2. 无 rpx ---
   *
   * rpx 是小程序单位，在桌面上浏览器不认识，会被当成无效值整条丢弃。
   * 危险之处是**整条声明**失效，而不是只错一个数。
   */
  const rpx = []
  for (const file of [...cssFiles, ...tsFiles]) {
    const text = stripComments(await read(file))
    if (/\brpx\b/.test(text)) rpx.push(file.split('/src/')[1])
  }
  ok('全项目无 rpx', rpx.length === 0,
    'rpx 在桌面浏览器里是无效单位，整条声明会被丢弃', rpx.join(', '))

  /*
   * --- 3. html 基准 100% 且未被写死 ---
   *
   * 这条是「系统字号 200% 时界面等比放大」的前提。写死 px 会把整条
   * 放大链从根上掐断，而那时界面在自己机器上看起来完全正常。
   */
  const base = stripComments(await read(join(REPO, 'src/styles/base.css')))
  const htmlBase = /html\s*\{[^}]*font-size:\s*100%/.test(base)
  const pinnedBase = cssFiles.some(async () => false) // 占位，下面逐文件查
  const pinned = []
  for (const file of cssFiles) {
    if (/html\s*\{[^}]*font-size:\s*\d+px/.test(stripComments(await read(file)))) {
      pinned.push(file.split('/src/')[1])
    }
  }
  ok('html 基准为 100% 且未被写死 px', htmlBase && pinned.length === 0,
    '写死 px 基准会把「系统字号放大」整条链掐断', `100%=${String(htmlBase)} 写死=${pinned.join(',')}`)
  void pinnedBase

  /*
   * --- 4. 字号单位只有 rem / 关键字 ---
   *
   * 与上一条同源：只要有一处写 px，那处就不会跟着系统字号放大，
   * 200% 时会出现「大部分变大、这一处还是小」的破绽。
   */
  const pxFont = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    // 前置的 `(?<![-\w])` 不能省：`--text-sm: …` 这种自定义属性名里含 `font-size`。
    for (const match of text.matchAll(/(?<![-\w])font-size:\s*([^;]+);/g)) {
      const value = match[1].trim()
      const okValue = /^-?\d*\.?\d+rem$/.test(value)
        || /^(inherit|initial|unset|revert|larger|smaller|xx-small|x-small|small|medium|large|x-large|xx-large)$/.test(value)
        || /^(calc|clamp|min|max)\(/.test(value)
        || /^var\(--text-/.test(value)
        || value === '100%'
      if (!okValue) pxFont.push(`${file.split('/src/')[1]} → ${value}`)
    }
  }
  ok('字号单位只有 rem / 关键字', pxFont.length === 0,
    '写 px 的那一处不会跟着系统字号放大，200% 时会明显偏小', pxFont.slice(0, 6).join('; '))

  /*
   * --- 5. 无 !important（reduced-motion 的两处除外）---
   *
   * 规范点名只允许 §8.7 那两处。`!important` 一旦成风气，样式层就失去
   * 可预测性——后面的人只能靠加更强的 `!important` 覆盖。
   */
  const importants = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/^[^;\n]*!important/gm)) {
      const line = match[0].trim()
      // 降级块里的四条（animation-duration / iteration / transition / scroll-behavior）放行。
      if (/^(animation-duration|animation-iteration-count|transition-duration|scroll-behavior):/.test(line)) continue
      importants.push(`${file.split('/src/')[1]} → ${line.slice(0, 40)}`)
    }
  }
  ok('无 !important（降级四条除外）', importants.length === 0,
    '!important 一旦出现，后续只能靠更强的覆盖，样式层失去可预测性',
    importants.slice(0, 5).join('; '))

  /*
   * --- 6. 图标唯一出口是 Icon.tsx ---
   *
   * 直接 `import { X } from 'lucide-react'` 会绕过 morphicons 的形变
   * 与 `absoluteStrokeWidth`，同一屏里就会出现两种线宽。
   * `import type` 不算——类型导入不产生运行时代码。
   */
  const iconImports = []
  for (const file of tsFiles) {
    const short = file.split('/src/')[1]
    if (short === 'components/Icon.tsx' || short === 'components/icons.ts') continue
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/^(?!.*\bimport\s+type\b).*from\s+'(lucide-react|lucide|@morphicons\/[a-z-]+|morphicons\/react)'/gm)) {
      // 纯类型导入（`import type { IconInput }`）不产生运行时依赖，放行。
      if (/import\s+type\b/.test(match[0])) continue
      iconImports.push(`${short} → ${match[0].trim().slice(0, 50)}`)
    }
  }
  ok('图标只经 Icon.tsx 渲染', iconImports.length === 0,
    '绕过 Icon.tsx 会丢掉形变与统一线宽，同一屏出现两种粗细', iconImports.join('; '))

  /*
   * --- 7. 品牌单一真源 ---
   *
   * `WhaleMark.tsx` 与 `icon-1024.svg` 都必须不在。前者是手绘的第二份
   * logo，后者是生成器的中间产物——两者都会成为「有人去改它」的真源。
   */
  const whale = await exists(join(REPO, 'src/components/WhaleMark.tsx'))
  const icon1024 = await exists(join(REPO, 'icon-1024.svg'))
  ok('logo 只来自 /icon.svg', !whale && !icon1024,
    '残留第二份 logo 就会有人改它，下次生成又被覆盖',
    `WhaleMark=${String(whale)} icon-1024=${String(icon1024)}`)

  /*
   * --- 8. 无转圈 spinner ---
   *
   * §5.0.4 禁止转圈，只允许行内三点、控件 pending、骨架块三种。
   *
   * ## 判据为什么不能只匹配 `spin`
   *
   * 第一版按「`@keyframes` 名字里含 spin」查，把 `spine-breathe` 也抓了
   * 进来——那是**脊的呼吸**，改的是 opacity，正是规范允许的形态。
   * 名字里含 `spin` 不等于在转圈（spine / spinneret 都含）。
   *
   * 真正的判据是**转了没有**：`rotate` 到 `360deg`。转圈的定义就是
   * 绕中心转满一圈，而呼吸、脉冲、淡入淡出都不改角度。按 360deg 查
   * 比按名字查准得多，也不会随命名习惯漂移。
   */
  const spinners = []
  for (const file of cssFiles) {
    const text = stripComments(await read(file))
    for (const match of text.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      // 转满 360 度才是转圈；`rotate(2deg)` 这类微动不算。
      if (/rotate(?:3d)?\(\s*360deg\s*\)/.test(match[2]) || /rotate\(\s*1turn\s*\)/.test(match[2])) {
        spinners.push(`${file.split('/src/')[1]} → ${match[1]}`)
      }
    }
  }
  ok('全项目无转圈 spinner', spinners.length === 0,
    '本地操作通常 < 300ms，转圈只会闪一下，比不动更难看', spinners.join('; '))

  /*
   * --- 9. 移动端禁用下拉刷新 ---
   *
   * 移动端整页滚动会把「从消息区顶部再往上拉」当成刷新手势，导致
   * 用户想回看历史却触发刷新。判据是**整页滚动的那个容器**上有
   * `overscroll-behavior`，值不为 `auto`。
   *
   * ## 为什么 `none` 与 `contain` 都算过
   *
   * 两者的差别只在「到边界后要不要把滚动传给外层」：`none` 完全不传，
   * `contain` 传给外层但外层也滚不动。桌面应用没有外层可滚，效果相同。
   * 第一版只认 `contain`，把桌面上更合适的 `none` 判成了缺陷——
   * **规范说的是「禁用下拉刷新」，不是「必须用某个值」。**
   */
  const baseAll = stripComments(await read(join(REPO, 'src/styles/base.css')))
  ok('移动端禁用下拉刷新', /overscroll-behavior(-y)?:\s*(none|contain)/.test(baseAll),
    '不设这一条时，用户想往回看历史会被当成「下拉刷新」')

  /*
   * --- 10. 触屏下输入框字号 16px ---
   *
   * iOS Safari 在 input 字号小于 16px 时会在聚焦时自动放大页面，
   * 且放大后不会自己缩回去，用户得手动捏。§10.7.3 把它列为手机端
   * 三条硬要求的第一条。
   *
   * ## 判据必须是 `any-pointer` 而不是 `pointer`
   *
   * `pointer: coarse` 只描述**主**指针。iPad 接了妙控键盘后主指针变成
   * `fine`，这条就不再命中——但用户随时可能抬手点屏幕，照样会跳大。
   * §10.4 原文就说「不能因为 `pointer: fine` 就降到 14」。
   *
   * 所以查 `any-pointer: coarse`（有没有触屏），而不是 `pointer: coarse`
   * （主指针是不是手指）。前者在接键盘时仍为真，后者会漏。
   */
  const composer = stripComments(await read(join(REPO, 'src/styles/composer.css')))
  const coarseBlock = /@media\s*\(any-pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/.exec(composer)
  const sixteeen = coarseBlock !== null && /\.composer__input[\s\S]*?font-size:\s*(1rem|16px)/.test(coarseBlock[1])
  ok('触屏下输入框为 16px（防 iOS 自动放大）', sixteeen,
    'iOS 在 < 16px 时聚焦会自动放大页面且不会缩回，点一次输入框整个界面就跳大',
    coarseBlock === null ? '缺 @media (any-pointer: coarse) 块' : '块内未把输入框设为 16px')

  /*
   * --- 11. 键盘弹出后输入框可见 ---
   *
   * §10.7.3 / §10.8：iOS 的布局视口不因键盘缩小，`100%` 高的容器仍是全屏，
   * 输入框落在键盘下面。判据两半：
   *
   * | 半 | 位置 | 管什么 |
   * | --- | --- | --- |
   * | 量 | `lib/viewport.ts` 读 `visualViewport` 写 `--kb-h` | 拿到遮挡高度 |
   * | 用 | `compact.css` 把 `--kb-h` 加进输入区下内边距 | 真的让开 |
   *
   * 少查任何一半都会假绿：只写变量不用，输入框照样被盖住；
   * 只用变量不写，那个变量恒为回落值 0。
   *
   * ## 为什么必须查 `visualViewport` 而不是 `innerHeight`
   *
   * §10.8 原文就写「用 `visualViewport` 而非 `innerHeight`」。
   * `innerHeight` 在 iOS 键盘弹出时不变，用它算出的差恒为 0。
   */
  const viewportTs = await read(join(REPO, 'src/lib/viewport.ts')).catch(() => '')
  const compactCss = stripComments(await read(join(REPO, 'src/styles/compact.css')))
  const measures = /visualViewport/.test(viewportTs) && /--kb-h/.test(viewportTs)
  const applies = /padding-bottom:[^;]*var\(--kb-h/.test(compactCss)
  ok('软键盘弹出后输入框仍可见（visualViewport + --kb-h）', measures && applies,
    '用 innerHeight 算遮挡高度在 iOS 上恒为 0，输入框会被键盘盖住',
    `读visualViewport=${String(/visualViewport/.test(viewportTs))} 用--kb-h=${String(applies)}`)

  /*
   * --- 12. 生成中保持屏幕常亮 ---
   *
   * §10.7.3 第三条：手机端一次长回答可能 40 秒，熄屏会让用户以为卡死。
   * 判据是「申请」与「释放」都在，且挂在 `busy` 上：
   *
   * - 只申请不释放 → 应用一直亮着，耗电，用户会去系统设置里找凶手。
   * - 只释放不申请 → 写了等于没写。
   * - 不在 `busy` 上 → 打开应用就常亮。
   */
  const wakeTs = await read(join(REPO, 'src/lib/wakelock.ts')).catch(() => '')
  const appTs = await read(join(REPO, 'src/App.tsx'))
  ok('生成中申请屏幕常亮且生成结束释放', /wakeLock/.test(wakeTs) && /release\(/.test(wakeTs) && /keepAwake\(state\.busy\)/.test(appTs),
    '只申请不释放会一直亮屏耗电；不挂在 busy 上等于打开应用就常亮',
    `wakeLock=${String(/wakeLock/.test(wakeTs))} 释放=${String(/release\(/.test(wakeTs))} 挂busy=${String(/keepAwake\(state\.busy\)/.test(appTs))}`)

  /*
   * --- 13. Android / 鸿蒙返回键逐层退出 ---
   *
   * §10.7.1：iOS 靠侧滑手势，Android 有实体/虚拟返回键，不接管就会
   * 「按返回直接退出应用」。顺序是「抽屉开着先关抽屉 → 再退会话 →
   * 最后才退出」，与 §9.3 的 Esc 八层同构。
   *
   * 判据：`popstate` 上有监听，且处理函数里按「抽屉 → 检查器 → 会话」
   * 的顺序 return。只查「有监听」不够——监听了但什么都不做，
   * 返回键仍然直穿。
   */
  const hasPopState = /addEventListener\(\s*['"]popstate['"]/.test(appTs)
  /*
   * 顺序判据：在处理函数体里，`drawer` 的分支必须出现在「清空当前会话」
   * 之前。用「两个关键词的首次出现位置」比较，比解析 AST 便宜且够准——
   * 这条规则的实现只有一处，不存在歧义写法。
   *
   * 「清空当前会话」认 `newChat()` 这个动作，而不是某个状态字段：
   * 状态字段会随重构改名（旧的 `inConversation` 已经不存在），
   * 而「退一层就清会话」这个动作本身不会变。
   *
   * 体从 `const onPop` 起到下一个顶层 `}` 为止；找不到时退化成全文搜索，
   * 那种情况下顺序判据仍成立（两个词各自只有一处命中）。
   */
  const popBody = /const onPop[\s\S]*?\n  \}/.exec(appTs)?.[0] ?? appTs
  const drawerAt = popBody.indexOf('drawer !== undefined')
  const sessionAt = popBody.indexOf('newChat()')
  ok('Android / 鸿蒙返回键逐层退出', hasPopState && drawerAt >= 0 && sessionAt > drawerAt,
    '不接管返回键时按一下直接退出应用；顺序反了会先退会话、抽屉留在原地',
    hasPopState ? `抽屉分支=${String(drawerAt)} 会话分支=${String(sessionAt)}` : '缺 popstate 监听')

  /*
   * --- 14. compact 骨架：双脊收起、顶栏登场、水位 2px 横线 ---
   *
   * §10.3 的三件事必须同时成立，缺一条都会「看起来只是窄了」：
   *
   * | 缺哪条 | 表现 |
   * | --- | --- |
   * | 双脊不收 | 320 宽下 104 的脊吃掉 32%，正文只剩 216 |
   * | 顶栏不上 | 入口与状态无处可去，手机上无法打开抽屉与检查器 |
   * | 水位不横 | 状态信息彻底消失，用户完全不知道她今天累不累 |
   *
   * ## 判据是「同一个断点块里同时出现三者」
   *
   * 分开查会漏掉一种真缺陷：三者写在不同的断点块里（比如脊在 819 收、
   * 顶栏在 599 出），那么 600–819 区间就没有顶栏也没有右脊——状态信息
   * 在那一整段宽度里凭空消失。必须落在同一个块。
   *
   * 断点值本身不写死：重写后骨架切换点定在 819（电脑形态的底线），
   * 599 只再压一档密度。所以这里先找出「收 Rail 的那个容器查询块」，
   * 再要求同一块里也有单列与顶栏。写死 599 会把合法的断点选择判成缺陷。
   */
  /*
   * 找出「同时收了 Rail 与 Spine 的那个容器查询块」。
   *
   * 不按固定断点值取块：重写后第一个容器块是 819（骨架切换），第二个
   * 是 599（密度）。写死 599 会取到只调内距的那一块，收脊规则不在里面，
   * 于是合法的实现被判成缺陷。
   *
   * 两个选择器是**分组写法**（`.rail,\n.spine { … }`），所以正则要允许
   * 逗号与换行——只匹配 `.rail {` 会永远落空。
   */
  const blocks = [...compactCss.matchAll(/@container shell \(max-width:\s*\d+px\)\s*\{([\s\S]*?)\n\}/g)].map(
    (match) => match[1],
  )
  const compactBlock = blocks.find((body) => /\.rail[\s,\n]*\.spine[\s,\n]*\{[^}]*display:\s*none/.test(body)
    || /\.spine[\s,\n]*\.rail[\s,\n]*\{[^}]*display:\s*none/.test(body)) ?? ''
  const spineHidden = /\.spine\s*\{[^}]*display:\s*none/.test(compactCss)
  const railHidden = /\.rail[\s,\n]*\.spine[\s,\n]*\{[^}]*display:\s*none/.test(compactBlock)
    || /\.spine[\s,\n]*\.rail[\s,\n]*\{[^}]*display:\s*none/.test(compactBlock)
  const oneColumn = /grid-template-columns:\s*1fr/.test(compactBlock)
  /* 水位线本体定义在 titlebar.css，与顶栏同处；两处合并读。 */
  const waterLine = /\.topbar__water[\s\S]*?height:\s*2px/.test(
    [compactCss, stripComments(await read(join(REPO, 'src/styles/titlebar.css')))].join('\n'),
  )
  ok('compact 下双脊收起、改单列、水位为 2px 横线', spineHidden && railHidden && oneColumn && waterLine,
    '三件事必须同时成立：少一条会正文被挤扁，或多出一段既无脊也无顶栏的宽度',
    `收脊=${String(spineHidden)} 收Rail=${String(railHidden)} 单列=${String(oneColumn)} 水位线=${String(waterLine)}`)

  /*
   * --- 15. 顶栏在 ≤ 819 出现、≥ 820 消失 ---
   *
   * 顶栏是「没有窗口控制」的那一版标题栏。电脑三端已经有 `TitleBar`
   * （含红绿灯让位与拖拽区），两条同时出现会占掉 92px 顶高，且
   * 同一条标题会画两遍。
   *
   * 判据两半：默认 `display: none`（电脑端不显示）+ 断点块里
   * `display: flex`（窄了才显示）。
   *
   * 两半分居两个文件：顶栏本体定义在 `titlebar.css`（默认隐藏），
   * 断点里改成显示写在 `compact.css`。所以这里合并读——只读其中一个
   * 会在拆分文件后假红。
   */
  const topbarDefaultHidden = /\.topbar\s*\{[^}]*display:\s*none/.test(
    stripComments(await read(join(REPO, 'src/styles/titlebar.css'))),
  )
  const topbarShown = /@container shell \(max-width:\s*\d+px\)\s*\{[\s\S]*?\.topbar\s*\{[^}]*display:\s*flex/.test(compactCss)
  ok('顶栏仅在 ≤ 819 出现（电脑端让位给 TitleBar）', topbarDefaultHidden && topbarShown,
    '两条横条同时出现会占掉 92px 顶高，且同一个标题被画两遍',
    `默认隐藏=${String(topbarDefaultHidden)} 819显示=${String(topbarShown)}`)

  /*
   * --- 16. 触屏热区 44，且不靠改尺寸实现 ---
   *
   * §10.4 的「44 × 44」不是要把按钮做大——那些按钮都被固定高度的行卡着
   * （消息操作条在 28 高的行里、关闭叉在 44 高的抽屉头里）。直接做大
   * 会顶破那一行，§3.1 的 436 垂直预算就歪掉。
   *
   * 正确做法是 `::before` 绝对定位扩命中区。判据因此是「`::before` 的
   * `inset: -10px` 存在」（24 + 10 × 2 = 44），而不是「按钮是 44」。
   *
   * ## 为什么不能只查 `pointer: coarse` 块存在
   *
   * 那块里可能只有正文 16px 一条。分开查才能定位到「热区到底做了没有」。
   */
  const hitBefore = /\.message__action::before[\s\S]{0,200}?inset:\s*-10px/.test(compactCss)
  const hitTwenty = /\.composer__attachment-remove::before[\s\S]{0,200}?inset:\s*-12px/.test(compactCss)
  ok('触屏热区 44 用 ::before 扩，不改按钮尺寸', hitBefore && hitTwenty,
    '把按钮直接做成 44 会顶破 28 高的底部行，垂直预算 436 跟着歪',
    `24→44=${String(hitBefore)} 20→44=${String(hitTwenty)}`)

  /*
   * --- 17. iPad 接键盘后热区回到 32 ---
   *
   * §10.4 的条件是 `pointer: fine`，**不是设备判断**。接上妙控键盘后
   * 主指针变成鼠标，44 的热区就过大了（那会让消息操作条互相挤压）。
   *
   * 判据是**读到「这条规则被哪个媒体查询包着」**，而不是「文件里有没有
   * `pointer: coarse` 这个词」——后者在 `compact.css` 里必然命中
   * （正文 16px 那条也挂在它下面），会变成一条永远绿的假断言。
   *
   * 写成 `hover: none` 时：桌面与触屏都"看起来对"，只有 iPad 接键盘
   * 那一档会分岔——主指针是 fine（不再需要 44），而某些 WebView 的
   * `hover` 仍是 none（热区不回缩）。这正是 §10.4 说「不能按设备
   * 判断」的具体后果。
   */
  /*
   * 选择器在这条规则里是**分组写法**（六个按钮共用一块），所以不能找
   * `.message__action::before {`——那行只出现在文件的其他位置。判据取
   * 「选择器名后跟逗号或空白」，两种写法都能命中。
   *
   * ## 为什么不能用 `includes('pointer: coarse')` 判条件
   *
   * 子串匹配有个致命的假绿：`any-pointer: coarse` 里**也**含
   * `pointer: coarse` 这串字。把热区那条 `@media (pointer: coarse)`
   * 手改成 `any-pointer: coarse` 之后本断言仍然全绿——而这正是
   * §10.4 要防的那个错误（Windows 触屏本会把热区一起放大）。
   * 所以判据写成「`pointer:` 前面**不是** `-`」，把 `any-pointer` 排除掉。
   */
  const hitMedia = enclosingMedia(compactCss, /\.message__action::before[\s,]/)
  ok('热区放大只挂在 pointer: coarse（接键盘即回 32）', /(?:^|[^-])pointer:\s*coarse/.test(hitMedia),
    '写成 any-pointer 时 Windows 触屏本会把热区一起放大；写成 hover: none 时 iPad 接妙控键盘热区不回缩',
    hitMedia === '' ? '热区规则不在任何 @media 里' : `包着它的条件：${hitMedia}`)

  /*
   * --- 18. 触屏下消息操作按钮常驻且 40% 不透明 ---
   *
   * §10.4：触屏没有悬停，按钮只能常驻；用 40% 不透明度压住噪声；
   * 滚动时隐藏，停止滚动 600ms 后回来。
   *
   * 三半都要有。只做「常驻」会让一屏消息变成按钮墙；只做「40%」而不
   * 常驻等于没做（桌面版那两个 `opacity: 0` 的规则仍在）。
   */
  const alwaysThere = /@media \(hover: none\) \{[\s\S]*?\.message__actions \{[\s\S]*?opacity:\s*0\.4/.test(compactCss)
  const hideOnScroll = /\.timeline\[data-scrolling\] \.message__actions/.test(compactCss)
  const timelineMarker = /data-scrolling=/.test(await read(join(REPO, 'src/components/Timeline.tsx')))
  ok('触屏消息操作常驻 40%、滚动时隐藏', alwaysThere && hideOnScroll && timelineMarker,
    '不常驻则触屏用户点不到；不压到 40% 则一屏消息变成按钮墙',
    `常驻=${String(alwaysThere)} 滚动隐藏=${String(hideOnScroll)} 标记=${String(timelineMarker)}`)

  /*
   * --- 19. 移动端不出现桌宠、托盘、多窗口、浏览器面板入口 ---
   *
   * §10.0 的功能边界表列了这四项。判据不是「有没有隐藏它们的 CSS」——
   * 那些入口在电脑三端根目录就不在界面里（托盘在系统菜单栏、桌宠是
   * 独立悬浮窗、多窗口由壳开、浏览器面板在抽屉里但宿主不支持远程）。
   *
   * 真正该守的是「没有任何组件在移动端渲染它们」。当前实现里这四项
   * 全部由壳侧决定，前端没有对应组件，所以这条**靠 `platform.ts` 的
   * 能力探测**保证：移动端平台标记为 `unknown`，`isWindows()` /
   * `isMac()` 均为 false，壳能力调用全部走 `invokeShell` 的抛错降级。
   */
  const platformTs = await read(join(REPO, 'src/lib/platform.ts'))
  const mobileUnknown = /return 'unknown'/.test(platformTs)
  const noPetComponent = !(await exists(join(REPO, 'src/components/PetWindow.tsx')))
  ok('移动端不出现桌宠 / 托盘 / 多窗口入口', mobileUnknown && noPetComponent,
    '这些是桌面概念，在手机上渲染出来既点不动也无意义',
    `移动端标记unknown=${String(mobileUnknown)} 无桌宠组件=${String(noPetComponent)}`)
}

/** 把 `@media` 宽度断点的情况说成一句人话。 */
function mobileWidthNote(list) {
  if (list.length === 0) return ''
  return list.join(', ')
}

/**
 * 找出某个选择器所在的**最内层**媒体查询条件。
 *
 * ## 为什么需要这个工具
 *
 * 「热区 44」这条要守的不是「44 写了没有」，而是「它挂在哪个媒体查询
 * 下」。写 `hover: none` 与写 `pointer: coarse` 在桌面上完全等价，
 * 只在「iPad 接了妙控键盘」这一种状态里分岔——而那正是 §13 第 57 条
 * 点名的情况。所以判据必须能读到「这条规则被哪个条件包着」。
 *
 * ## 实现
 *
 * 括号配平：找出全部 `@media` 块的头尾区间，取「包含选择器位置且起点
 * 最靠后」的那一个。取最内层是因为本项目有 `@media` 套 `@container`
 * 的写法（正文 15px 那条）。
 *
 * @param {string} css 已剥注释的样式文本。
 * @param {RegExp} pattern 定位选择器的正则。
 * @returns {string} 最内层媒体条件；不在任何 `@media` 里时返回空串。
 */
function enclosingMedia(css, pattern) {
  const at = css.search(pattern)
  if (at < 0) return ''

  let best = ''
  let bestStart = -1

  for (const match of css.matchAll(/@media\s*\(([^)]*)\)\s*\{/g)) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let end = -1
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) { end = index; break }
      }
    }
    if (end < 0) continue
    if (at > open && at < end && match.index > bestStart) {
      best = match[1].trim()
      bestStart = match.index
    }
  }
  return best
}

/* ==========================================================================
   七、窗口与平台（§13 的静态条目）
   ========================================================================== */

async function checkShellConfig() {
  group('窗口与平台')

  const conf = JSON.parse(await read(join(REPO, 'src-tauri/tauri.conf.json')))
  const wins = conf?.app?.windows ?? []
  const main = wins.find((win) => win.label === 'main')

  /*
   * --- 1. minWidth / minHeight 未被下调 ---
   *
   * 820 × 580 是「正文 588 + 两侧留白」算出来的最小可行尺寸。下调之后
   * 正文会被压到 588 以下，五行字变四行，所有排版断言随之失效。
   */
  ok('最小窗口 820 × 580 未被下调', main?.minWidth === 820 && main?.minHeight === 580,
    '低于这个尺寸正文会窄于 588，排版全部失效',
    `${String(main?.minWidth)}×${String(main?.minHeight)}`)

  /*
   * --- 2. macOS 自绘红绿灯的几何与系统按钮隐藏 ---
   *
   * 红绿灯不再由 AppKit 画：`window.rs` 把三个 standardWindowButton 设成
   * hidden，前端在 `.traffic-lights` 里自绘。因此这里验的**不是**
   * `tauri.conf.json` 的 `trafficLightPosition`——系统按钮已不可见，那个
   * 值是死配置，已删除；留着它再断言 y=16 是一条验不到实物的假断言。
   *
   * 改验三件真正决定观感的事：
   *   ① 圆点 12px、组间距 8px（中心距 20px，与系统按钮同节奏）；
   *   ② top 16px → 圆点中心 16 + 6 = 22，落在 44px 标题栏正中；
   *   ③ 系统按钮确实 setHidden，否则会与自绘圆点叠成两对。
   */
  const layoutCss = await read(join(REPO, 'src/styles/layout.css'))
  const windowRs = await read(join(REPO, 'src-tauri/src/window.rs'))
  const tlTopGap = /\.traffic-lights\s*\{[^}]*top:\s*16px[^}]*gap:\s*8px/s.test(layoutCss)
  const tlDot = /\.traffic-lights__dot\s*\{[^}]*width:\s*12px[^}]*height:\s*12px/s.test(layoutCss)
  const tlHidden = windowRs.includes('setHidden(true)')
  ok('自绘红绿灯 12px / 中心 y=22，且系统按钮已隐藏', tlTopGap && tlDot && tlHidden,
    '圆点 12 配 top 16 才让中心落在 22；系统按钮不藏会叠成两对红绿灯',
    `top16+gap8=${String(tlTopGap)} dot12=${String(tlDot)} hidden=${String(tlHidden)}`)

  /*
   * --- 2.5 Windows 必须关掉系统装饰 ---
   *
   * `titleBarStyle: "Overlay"` 是 **macOS 专属字段**，Windows 读它等于没写，
   * 系统照旧画一条原生标题栏；而界面在 Windows 上又自绘了一套三键。
   * 两套并存的症状用户截图拍到过：窗口顶部出现两排按钮，上面是系统的
   * `− □ ×`，下面是自绘的 `− ×`，版本号还被压在 `×` 底下。
   *
   * 这条断言钉的是「平台配置里必须有 decorations:false」——它是让自绘
   * 三键真正接管的唯一开关。漏了它不会报任何错，只是按钮悄悄变成两排。
   *
   * 顺带验 `app.windows` 的尺寸没在平台文件里被写丢：Tauri 的平台配置
   * 对**数组是整体替换**（JSON Merge Patch），少写一个字段就回退默认值。
   */
  const winConf = JSON.parse(await read(join(REPO, 'src-tauri/tauri.windows.conf.json')))
  const winMain = (winConf?.app?.windows ?? []).find((win) => win.label === 'main')
  ok('Windows 关闭系统装饰，自绘三键接管', winMain?.decorations === false,
    '不关 decorations，系统标题栏与自绘三键会叠成两排按钮',
    `decorations=${String(winMain?.decorations)}`)
  ok('Windows 平台配置没有写丢窗口尺寸', winMain?.minWidth === 820 && winMain?.minHeight === 580
    && winMain?.width === 820 && winMain?.height === 580,
    '平台配置的 app.windows 是整体替换，漏字段会回退成 Tauri 默认尺寸',
    `${String(winMain?.width)}×${String(winMain?.height)} min ${String(winMain?.minWidth)}×${String(winMain?.minHeight)}`)

  /*
   * --- 2.6 编辑供应商时不能抹掉密钥 ---
   *
   * 宿主对密钥有一条约定：回传值里**含圆点**（`••••••••abcd` 这种打码串）
   * 表示"用户没改"，此时沿用已存的原文；回传空串则表示"用户主动清空"，
   * 会真的把密钥写没。
   *
   * 于是「编辑」这条路必须把打码值回填进草稿。留空看着更"干净"，
   * 但改一个标签名就会顺手把密钥删掉——而且界面不会提示，下一次对话
   * 才报 401。这条断言钉住回填，防止将来有人"顺手清理"成空串。
   */
  const providersTsx = await read(join(REPO, 'src/components/SettingsProviders.tsx'))
  const draftFn = /function toDraft\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(providersTsx)?.[1] ?? ''
  ok('编辑供应商时回填打码密钥（否则改个名字就把 key 抹了）',
    /apiKey:\s*profile\.apiKey/.test(draftFn),
    'toDraft 把 apiKey 填成空串会让宿主以为是主动清空，真密钥被覆盖',
    draftFn === '' ? '没找到 toDraft' : 'apiKey 来源=' + (/apiKey:\s*([^,\n]+)/.exec(draftFn)?.[1] ?? '?'))

  /*
   * --- 2.7 出厂配置不能预置连不上的供应商 ---
   *
   * 上一版出厂写一条 `http://127.0.0.1:3425/v1` 的本地网关，注释说「本机上
   * 它已经可用」——那是开发机的现实。用户装到另一台机器上，3425 没有进程
   * 在听，而 `currentModel` 恰好指着它，于是第一句话必然拿到
   *
   *     无法连接供应商（http://127.0.0.1:3425/v1）：fetch failed
   *
   * 这三条断言用**真实的 ConfigStore**跑三种输入，不是文本匹配：
   *   ① 首次启动 → 空清单 + 空 currentModel（界面落到本地演示，一定能说话）
   *   ② 旧配置带着出厂项 → 清掉，currentModel 让回空串
   *   ③ 用户自己填的网关（地址同样是 3425）→ 一条不动
   *
   * ③ 是这套清理的边界：只有我们塞进去过的那个 id 才该被判死，
   * 用户填的地址连不上是他自己的事，宿主无从替他判断。
   */
  const { ConfigStore } = await import(
    pathToFileURL(join(REPO, 'cordis-host/lib/src/config.js')).href
  )
  const { mkdtemp, writeFile: writeText } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')

  /** 用一个临时目录跑一次 ConfigStore.open。 */
  const withConfig = async (initial) => {
    const dir = await mkdtemp(join(tmpdir(), 'ondra-accept-'))
    const path = join(dir, 'config.json')
    if (initial !== undefined) await writeText(path, JSON.stringify(initial), 'utf8')
    const store = await ConfigStore.open(path)
    return { store, path }
  }

  try {
    const fresh = await withConfig(undefined)
    const freshCfg = fresh.store.read()
    ok('首次启动不预置任何供应商（只有本地演示可用）',
      freshCfg.profiles.length === 0 && freshCfg.currentModel === '',
      '预置一个本机不存在的网关，用户第一句话就会撞 fetch failed',
      `profiles=${String(freshCfg.profiles.length)} currentModel=${JSON.stringify(freshCfg.currentModel)}`)

    const legacy = await withConfig({
      currentModel: 'magpie-dsv4',
      profiles: [
        { id: 'magpie-dsv4', label: 'DeepSeek V4.1 Flash', baseUrl: 'http://127.0.0.1:3425/v1', model: 'auto/deepseek-v4.1-flash', apiKey: '' },
        { id: 'my-deepseek', label: '我的 DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test' },
      ],
      permission: 'workspace',
    })
    const legacyCfg = legacy.store.read()
    ok('旧配置里的出厂供应商被清掉，选中项让回本地演示',
      !legacyCfg.profiles.some((item) => item.id === 'magpie-dsv4') && legacyCfg.currentModel === '',
      '只删内置不够：currentModel 还指着它，界面上依旧选中一条死链',
      `profiles=${legacyCfg.profiles.map((item) => item.id).join(',') || '(空)'} currentModel=${JSON.stringify(legacyCfg.currentModel)}`)
    ok('清理不会连累用户自己配的供应商与密钥',
      legacyCfg.profiles.length === 1
        && legacyCfg.profiles[0].id === 'my-deepseek'
        && legacyCfg.profiles[0].apiKey === 'sk-test',
      '清理范围必须收窄到出厂那一个 id，否则用户填好的密钥会被一起删掉',
      legacyCfg.profiles.map((item) => `${item.id}:${item.apiKey === '' ? '无key' : '有key'}`).join(' ') || '(空)')

    const own = await withConfig({
      currentModel: 'my-gateway',
      profiles: [
        { id: 'my-gateway', label: '自己的网关', baseUrl: 'http://127.0.0.1:3425/v1', model: 'auto/deepseek-v4.1-flash', apiKey: '' },
      ],
      permission: 'full',
    })
    const ownCfg = own.store.read()
    ok('用户自己填的网关（哪怕地址相同）不被误删',
      ownCfg.profiles.length === 1 && ownCfg.currentModel === 'my-gateway',
      '判据必须是 id 而不是地址：地址相同不代表它是我们塞进去的那条',
      `profiles=${ownCfg.profiles.map((item) => item.id).join(',')} currentModel=${JSON.stringify(ownCfg.currentModel)}`)
  } catch (caught) {
    ok('出厂配置清理可被验证', false,
      '读不到 cordis-host 的编译产物，先跑 pnpm --filter @ondra/cordis-host run build',
      String(caught))
  }

  /*
   * --- 3. 深色启动无白帧的双保险 ---
   *
   * 两半都必须有：
   *
   * | 保险 | 位置 | 管什么 |
   * | --- | --- | --- |
   * | 窗口背景色 | `tauri.conf.json` | 壳画出窗口到页面加载之间的那一帧 |
   * | 内联脚本 | `src/index.html` 的 `<head>` | 页面开始渲染到 React 挂载之间 |
   *
   * ## 为什么入口是 `src/index.html` 而不是根目录那个
   *
   * 根目录的 `index.html` 是**官网落地页**（vite 的 site 构建入口）。
   * 应用入口在 `src/index.html`——Tauri 的 `frontendDist` 指向 dist，
   * 而那里只会出现应用那一份。扫错文件会让这条断言永远假绿。
   */
  ok('窗口设了背景色（无白帧双保险之一）', typeof main?.backgroundColor === 'string',
    '缺背景色时深色系统下启动会闪一帧白')

  const appHtml = await read(join(REPO, 'src/index.html'))
  ok('内联脚本在首帧前定主题（双保险之二）', /data-theme/.test(appHtml) && /<script>/.test(appHtml),
    '缺内联脚本时首帧按默认浅色画，深色系统下会闪白',
    `含data-theme=${String(/data-theme/.test(appHtml))} 含内联脚本=${String(/<script>/.test(appHtml))}`)

  /*
   * --- 4. 托盘四项齐全 ---
   *
   * §12.10 定的是四项：`打开空谷 / 今天 / —— / 静音 1 小时 / 退出`。
   * 菜单在 `src-tauri/src/tray.rs` 里构建，文案与项数只能扫源码。
   *
   * ## 为什么断言的是这四个确切文案
   *
   * 第一版写的是「显示主窗口 / 静音 / 偏好设置 / 退出」——那是照着
   * 直觉编的四项，与 §12.10 原文不符。**照规范抄，不照印象写。**
   * 静音项还必须是「静音 1 小时」而不是「静音」：菜单项写的是
   * 「点下去会发生什么」，只写「静音」用户就找不到取消的入口。
   */
  const trayRs = await read(join(REPO, 'src-tauri/src/tray.rs')).catch(() => '')
  const trayItems = ['打开空谷', '今天', '静音 1 小时', '取消静音', '退出']
  const trayMissing = trayItems.filter((label) => !trayRs.includes(label))
  ok('托盘菜单四项齐全（含静音双文案）', trayMissing.length === 0,
    '托盘是隐藏窗口后唯一的入口，少一项就有一类操作无法完成', trayMissing.join(', '))

  /*
   * --- 5. Windows 三键与菜单按钮存在 ---
   *
   * 三键（最小化/最大化/关闭）与菜单按钮的样式在 `layout.css` 里——
   * 它们与 44px 标题栏、三列网格同属骨架，放在一起才不会出现
   * 「改了标题栏高度忘了改三键」。`titlebar.css` 只负责手机顶栏。
   *
   * 所以两个文件合并起来查：只查其中一个会在拆分文件后假红/假绿。
   * 是否真的渲染由 check-ui 在 win32 平台下测。
   */
  const titlebar = [
    stripComments(await read(join(REPO, 'src/styles/layout.css'))),
    stripComments(await read(join(REPO, 'src/styles/titlebar.css'))),
  ].join('\n')
  ok('Windows 三键样式存在', /titlebar__controls/.test(titlebar) && /titlebar__control\b/.test(titlebar),
    'Windows 无系统标题栏，三键必须自己画')
  ok('Windows 菜单按钮样式存在', /titlebar__menu/.test(titlebar),
    'Windows 没有 macOS 的菜单栏，必须有菜单按钮')

  /*
   * --- 6. 容器查询真的启用了 ---
   *
   * `@container` 写在子元素上，但父元素必须有 `container-type`，否则
   * 所有容器查询静默失效——它们不报错，只是永远不命中。
   * 这个坑上一轮踩过：阈值写着 1200、实际从不生效。
   */
  const layout = stripComments(await read(join(REPO, 'src/styles/layout.css')))
  ok('容器查询已启用（container-type 存在）', /container-type:\s*inline-size/.test(layout),
    '@container 规则在父级没有 container-type 时静默失效，永不命中')
  ok('主列断点阈值为 1200', /@container[^{]*\(min-width:\s*1200px\)/.test(layout),
    '阈值与 §12.8 不一致时，宽屏下留白算错，窗口变宽反而更挤')
}

/* ==========================================================================
   七之二、平台保真（§13 里原先「只能人工」的那一批）

   这一组的存在理由只有一句：**「肉眼看不出来」不等于「只能肉眼」**。

   §13 有 19 条被标成 manual，复查后发现分三类：

   1. 判据其实写在源码里，只是没人去读（标题居中方式、关闭语义、
      托盘单击、失焦呼吸）。这一类全部转 static。
   2. 规范要求了、代码根本没做（Linux 字体栈、字重 450、半像素降级、
      标题悬停）。这一类要么补代码、要么登记为缺口，不能继续挂着。
   3. 真需要另一台机器才能验（Windows 安装器、125% 缩放的实际渲染）。
      这一类保留 manual，并在文档里单列一张表。

   下面每条断言都对应一个**具体的失败模式**，而不是「文件里出现过某个词」。
   ========================================================================== */

async function checkPlatformFidelity() {
  group('平台保真')

  /*
   * 标题栏骨架（44px 条、三键、标题）在 `layout.css`；`titlebar.css`
   * 只放手机顶栏。两段合并读，断言不依赖文件怎么切分。
   */
  const titlebar = [
    stripComments(await read(join(REPO, 'src/styles/layout.css'))),
    stripComments(await read(join(REPO, 'src/styles/titlebar.css'))),
  ].join('\n')
  const base = stripComments(await read(join(REPO, 'src/styles/base.css')))
  const compact = stripComments(await read(join(REPO, 'src/styles/compact.css')))
  const tokens = stripComments(await read(join(REPO, 'src/styles/tokens.css')))
  const spine = stripComments(await read(join(REPO, 'src/styles/spine.css')))
  const appTsx = await read(join(REPO, 'src/App.tsx'))
  const titleTsx = await read(join(REPO, 'src/components/TitleBar.tsx'))
  const timelineTsx = await read(join(REPO, 'src/components/Timeline.tsx'))
  const shellTs = await read(join(REPO, 'src/lib/shell.ts'))
  const trayRs = await read(join(REPO, 'src-tauri/src/tray.rs')).catch(() => '')
  const windowRs = await read(join(REPO, 'src-tauri/src/window.rs')).catch(() => '')

  /*
   * --- 1. Windows 三键：右对齐、垂直中心 22 ---
   *
   * §2.3 给的是「单键 46 × 32，右对齐 top 6」。垂直中心 = 6 + 32 ÷ 2 = 22，
   * 与 44px 标题栏中心重合，也与红绿灯中心重合（第 2 条已单独断言）。
   *
   * 断言的是**算式两端**而不是「top: 6px」这一个字符串：只查 top 会让
   * 「有人把 height 改成 28」的改动漏网——那时中心变成 20，与红绿灯差 2px，
   * 肉眼几乎看不出，但两端标题栏的视觉轴线就断了。
   */
  const controlsBlock = /\.titlebar__controls\s*\{([^}]*)\}/.exec(titlebar)?.[1] ?? ''
  const ctrlTop = Number.parseFloat(/top:\s*(-?[\d.]+)px/.exec(controlsBlock)?.[1] ?? 'NaN')
  const ctrlHeight = Number.parseFloat(/height:\s*([\d.]+)px/.exec(controlsBlock)?.[1] ?? 'NaN')
  ok('Windows 三键垂直中心落在 22', ctrlTop + ctrlHeight / 2 === 22,
    '三键与红绿灯必须共用同一条视觉轴线（44px 标题栏中心），差 2px 看不出但会偏',
    `top=${String(ctrlTop)} height=${String(ctrlHeight)}`)
  ok('Windows 三键右对齐且总宽 138', /right:\s*0/.test(controlsBlock)
    && /\.titlebar__control\s*\{[^}]*width:\s*46px/s.test(titlebar),
    '三键须贴窗口右缘（§2.3），单键 46 宽 × 3 = 138')

  /*
   * --- 2. 标题栏固定显示品牌牌 ---
   *
   * 需求：标题栏**固定**显示「空谷 Ondra」与版本号。
   *
   * ## 为什么原来的两条断言没有了
   *
   * 上一版把会话标题绝对定位在全窗正中，配了 `text-overflow: ellipsis` 与
   * `title={title}` 兜底，断言守的是那套形态。那是"内容占据窗口身份位"的
   * 做法：标题随对话变，而用户扫一眼标题栏想确认的是"我在哪个应用里"。
   * 换成品牌牌之后，被守护的对象本身消失了——不留空断言，也不把旧判据
   * 硬套到新元素上（那会变成"为了绿而绿"）。
   *
   * ## 现在守三件事
   *
   * 1. 文字在代码里是**常量**，且带版本号——不是从 props 流进来的会话标题。
   * 2. 两段都 `nowrap`：名字长度固定，省略号在这里没有对象，折行才是风险。
   * 3. 左对齐在控件之后，不绝对定位居中——居中会读成「文档标题」。
   */
  const brandBlock = /\.titlebar__brand\s*\{([^}]*)\}/.exec(titlebar)?.[1] ?? ''
  const nameBlock = /\.titlebar__name\s*\{([^}]*)\}/.exec(titlebar)?.[1] ?? ''
  const versionBlock = /\.titlebar__version\s*\{([^}]*)\}/.exec(titlebar)?.[1] ?? ''
  ok('标题栏显示固定品牌名与版本号',
    /titlebar__brand/.test(titlebar) && /空谷 Ondra/.test(titleTsx) && /__APP_VERSION__/.test(titleTsx),
    '需求：标题栏固定显示「空谷 Ondra」和版本号，不随会话标题变',
    brandBlock.slice(0, 60))
  ok('品牌牌是常量，不接会话标题',
    !/titlebar__title/.test(titleTsx) && !/props\.title/.test(titleTsx),
    '会话标题属于内容，不属于窗口身份；完整标题在会话抽屉里读')
  ok('品牌名与版本号都不折行',
    /white-space:\s*nowrap/.test(nameBlock) && /white-space:\s*nowrap/.test(versionBlock),
    '两段的长度都是固定的，折行只会在窄窗里发生——那比截断更难看')
  ok('品牌牌左对齐（不绝对定位居中）',
    !/position:\s*absolute/.test(brandBlock),
    '居中会让它读成「文档标题」，左对齐才是铭牌')

  /*
   * --- 3. 双击标题栏交给系统 ---
   *
   * §2.5 的论据是「macOS 的双击行为受系统偏好控制（缩放 / 最小化 /
   * 无操作），自实现会覆盖用户偏好」。所以判据是**代码里没有**双击处理。
   *
   * 这条只能反向断言：查 `onDoubleClick` 不存在。将来若有人加了一个
   * 自定义双击，这里立刻红——那正是要拦的改动。
   */
  ok('标题栏不自实现双击（交给系统偏好）',
    !/onDoubleClick/.test(titleTsx) && !/dblclick/i.test(titleTsx),
    'macOS 的双击行为由系统偏好设置决定，自实现会覆盖用户选择（§2.5）')
  ok('标题栏标了拖拽区', /data-tauri-drag-region/.test(titleTsx),
    '整条标题栏必须可拖，否则无边框窗口拖不动')

  /*
   * --- 4. 消息区支持 PageUp / PageDown 按屏跳 ---
   *
   * §9.6 把这条列为「唯一的例外」：一条消息一个 Tab 停靠点，40 条消息
   * 要按 40 次 Tab 才能走到输入框。判据有三件，缺一不可：
   * 视口可聚焦、收到键、真滚动。
   *
   * ## 为什么不能只查 `tabIndex={0}` 出现过
   *
   * 文件里有**两处** `tabIndex`：一条消息一个（`<article tabIndex={0}>`），
   * 以及滚动视口自己一个（`ScrollArea` 的 prop，写作对象字面量
   * `tabIndex: 0`）。删掉视口那个、留消息那个，脚本照样全绿——
   * 反向验证时实测踩到，这就是假绿。
   *
   * 视口那一处的形状是 `tabIndex: 0,`（冒号、对象字面量），消息那一处
   * 是 `tabIndex={0}`（等号、JSX 属性）。两者必须分别匹配。
   */
  ok('消息区可聚焦且响应 PageUp / PageDown',
    /tabIndex:\s*0\s*,/.test(timelineTsx)
      && /event\.key !== 'PageUp'/.test(timelineTsx)
      && /scrollBy\(/.test(timelineTsx),
    '视口不进 Tab 顺序则焦点来不了（两个 tabIndex 只留消息那个仍会「看起来有」）',
    `视口tabIndex=${String(/tabIndex:\s*0\s*,/.test(timelineTsx))} 键名=${String(/event\.key !== 'PageUp'/.test(timelineTsx))} 滚动=${String(/scrollBy\(/.test(timelineTsx))}`)

  /*
   * --- 5. 触屏热区判据是 pointer，不是 any-pointer ---
   *
   * §10.4 与 §13 第 57 条：iPad 接妙控键盘后热区回到 32（按
   * `pointer: fine` 判断，非设备判断）。落在 CSS 上就是——热区规则必须
   * 写在 `@media (pointer: coarse)` 里。
   *
   * 正则用 `(?:^|[^-])pointer:` 而不是 `pointer:`：后者会被
   * `any-pointer:` 命中（它们是子串关系），这条坑上一轮踩过一次。
   */
  const hitAreaIndex = compact.indexOf('.message__action::before')
  const hitMediaBefore = compact.slice(0, hitAreaIndex)
  const lastMediaOpen = hitMediaBefore.lastIndexOf('@media')
  const hitMedia = lastMediaOpen === -1 ? '' : hitMediaBefore.slice(lastMediaOpen)
  ok('触屏热区只挂 pointer: coarse（接键盘后自动收回 32）',
    hitAreaIndex !== -1 && /(?:^|[^-])pointer:\s*coarse/.test(hitMedia)
      && !/any-pointer/.test(hitMedia),
    '写 any-pointer 会让带触屏的 Windows 笔记本也放大热区；'
      + '不写媒体查询则鼠标环境下热区永远 44', hitMedia.split('{')[0])

  /*
   * --- 6. Linux 字体栈含 CJK 回退 ---
   *
   * §10.5：`PingFang SC` 与 `Microsoft YaHei` 只存在于 macOS 与 Windows，
   * Linux 上两者都没有。不在栈里点名 CJK 字体，中文会由 fontconfig
   * 临时替补，一屏里出现两种笔画。
   */
  const fontFamily = /--font-family:\s*([^;]+);/s.exec(tokens)?.[1] ?? ''
  ok('字体栈含 Noto Sans CJK SC / Source Han Sans SC',
    /Noto Sans CJK SC/.test(fontFamily) && /Source Han Sans SC/.test(fontFamily),
    'Linux 无 PingFang 与雅黑，缺这两项则中文掉字（§10.5）')

  /*
   * --- 7. Windows / Linux 字重补偿为 450 ---
   *
   * §2.7 与 §10.5 都写 450。这里断言的是**数值本身**：曾写成 420
   * （凭手感「加一点点」），与规范原文不符，而 420 与 450 在 14px 正文上
   * 肉眼几乎分不出——不查数值就永远发现不了。
   */
  ok('Windows 与 Linux 字重补偿均为 450',
    /\[data-platform='win32'\]\s*body,\s*\[data-platform='linux'\]\s*body\s*\{[^}]*'wght'\s*450/s.test(base),
    'DirectWrite 与 FreeType 比 CoreText 细约 8%，补偿值规范定为 450（§2.7 / §10.5）')
  ok('字重补偿用 font-variation-settings 而非 font-weight',
    !/\[data-platform='win32'\][^{]*\{[^}]*font-weight:\s*4[0-9]0/s.test(base),
    'MiSans VF 是可变字体，font-weight 会被映射到最近的静态实例，轴值落不到 450')

  /*
   * --- 8. 非整数像素比下 0.5px 线降级为 1px ---
   *
   * §2.7：「125% / 150% 缩放时 0.5px 会被渲染成 0 或 2 物理像素，
   * 线会消失或发粗」。判据是那条区间媒体查询存在、且只改线宽。
   *
   * 为什么必须限定区间：只写 `min-resolution: 1.1dppx` 会连 2x / 3x
   * 一起命中，把 Retina 上唯一正确的那一档也变粗。
   */
  const dprBlock = /@media\s*\(min-resolution:\s*1\.1dppx\)([\s\S]*?)\}\s*\}/.exec(tokens)?.[0] ?? ''
  ok('非整数像素比下 0.5px 线降级为 1px',
    /max-resolution:\s*1\.9dppx/.test(dprBlock) && /--line-width:\s*1px/.test(dprBlock),
    '125% / 150% 缩放下 0.5 CSS px 落到非整数物理像素上，线会消失或发粗（§2.7）')

  /*
   * --- 9. 关闭 = 隐藏到托盘，首次解释且可记住 ---
   *
   * §2.7 的原话是「Windows 用户默认认为关闭即退出，因此首次必须解释，
   * 不能默默改行为」。判据分三处，缺一处就是「点了关闭什么都没发生」：
   *
   * | 处 | 判据 | 缺了会怎样 |
   * | --- | --- | --- |
   * | 壳的逻辑 | `intercept_close` 里区分 Quit / Hide / 首次 | 一律隐藏，用户以为退出了 |
   * | 壳的接线 | `main.rs` 在 `CloseRequested` 上真调它并 `prevent_close` | 逻辑写好了但没人调 |
   * | 界面 | `App` 监听 `close-requested` | 事件发了，界面毫无反应 |
   *
   * 中间那一格最早漏了：只查 `window.rs` 里有没有函数，函数是有的，
   * 但把 `main.rs` 的调用点删掉，脚本照样全绿——反向验证时实测踩到。
   */
  const mainRs = await read(join(REPO, 'src-tauri/src/main.rs')).catch(() => '')
  ok('壳拦截关闭并区分三种去留',
    /fn intercept_close/.test(windowRs)
      && /CloseAction::Quit/.test(windowRs)
      && /CloseAction::Hide/.test(windowRs)
      && /close-requested/.test(windowRs),
    '关闭不是退出（§2.1）；首次必须拦下来问一次，不能默默隐藏')
  ok('关闭拦截真接在窗口事件上',
    /WindowEvent::CloseRequested\s*\{[^}]*\}/.test(mainRs)
      && /intercept_close\(/.test(mainRs)
      && /prevent_close\(\)/.test(mainRs),
    '缺 prevent_close 窗口在判断完成前就销毁了；缺调用点则拦截逻辑是死代码',
    `事件=${String(/WindowEvent::CloseRequested/.test(mainRs))} 调用=${String(/intercept_close\(/.test(mainRs))} 阻止=${String(/prevent_close\(\)/.test(mainRs))}`)
  ok('界面接住关闭询问', /close-requested/.test(appTsx) && /close-degraded/.test(appTsx),
    '壳发了事件而界面没监听，用户点关闭会毫无反应')

  /*
   * --- 10. 窗口失焦时呼吸暂停、水位降到 60% ---
   *
   * §12.9 与 §5.7 的「呼吸暂停条件 ①窗口失焦」。
   *
   * 必须同时断言 `animation: none`：CSS 动画的声明优先级高于普通属性，
   * 只写 `opacity: 0.6` 会被动画帧覆盖，看起来「改了没生效」。
   */
  ok('失焦时水位降到 60% 且停止呼吸',
    /\[data-window-blurred\]\s*\.spine__fill\s*\{[^}]*opacity:\s*0\.6[^}]*animation:\s*none/s.test(spine),
    '只写 opacity 会被呼吸动画帧覆盖，必须同时 animation: none')
  ok('失焦标记由界面写入', /data-window-blurred/.test(appTsx),
    'CSS 有规则但没人写属性，那条规则永远不会命中')

  /*
   * --- 11. 托盘单击唤回窗口 ---
   *
   * §12.10 与 §13 第 96 条。Tauri 托盘默认「左键弹菜单」，本项目改成
   * `show_menu_on_left_click(false)` + 左键 Up 唤回。两半都要在：
   * 少了前者左键弹菜单，少了后者左键什么都不做。
   */
  ok('托盘左键唤回窗口（菜单留给右键）',
    /show_menu_on_left_click\(false\)/.test(trayRs)
      && /MouseButton::Left/.test(trayRs)
      && /MouseButtonState::Up/.test(trayRs),
    '左键弹菜单与「打开空谷」是同一动作的两条路径；只试左键会误判成菜单没做出来')

  /*
   * --- 12. 壳抽象只依赖 invoke 与 listen ---
   *
   * §13 第 66 条：鸿蒙走 ArkWeb 薄壳时，`shell.ts` 只需提供等价的
   * `invoke` / `listen`，前端零改动。
   *
   * ## 判据为什么是那个 interface 的成员，而不是 `__TAURI__.xxx` 的出现
   *
   * 第一版扫的是 `__TAURI__\.(\w+)`——但 `shell.ts` 里只有一处
   * `.__TAURI__`，是取值本身（`(globalThis as {...}).__TAURI__`），
   * 后面从不接子命名空间。于是那条断言**一个匹配都抓不到**，
   * 无论怎么改都恒绿。反向验证时把它改成 `__TAURI__.window` 也照样绿。
   *
   * 真正约束「能摸到什么」的是 `interface TauriGlobal`：它只声明
   * `core` 与 `event` 两个可选成员，TypeScript 因此让任何别的子命名
   * 空间在**编译期**就写不出来——这比运行时扫字符串强一档。
   *
   * 所以这里断言的是「接口成员恰好是这两个」。多一个就红：那意味着
   * 有人为了某个平台特性开了口子，换壳时那段就得重写。
   */
  const tauriGlobal = /interface TauriGlobal\s*\{([\s\S]*?)\n\}/.exec(shellTs)?.[1] ?? ''
  const declaredMembers = [...tauriGlobal.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1])
  const extraMembers = declaredMembers.filter((name) => name !== 'core' && name !== 'event')
  ok('shell.ts 只声明 invoke / listen 两个能力',
    declaredMembers.includes('core') && declaredMembers.includes('event') && extraMembers.length === 0,
    '多声明一个子命名空间，换壳（鸿蒙 ArkWeb 等）时那段前端代码就得重写（§13 第 66 条）',
    extraMembers.length > 0 ? extraMembers.join(', ') : declaredMembers.join(' + '))
}

/* ==========================================================================
   八、文档自身一致性（§13 的五条）
   ========================================================================== */

async function checkDoc() {
  group('文档一致性')

  /*
   * 设计文档已从仓库移除（2026-11-10 的清理决定）。
   *
   * 这一组量的是「文档自己的小节号与 § 引用对不对得上」——它只对**照文档
   * 改代码的人**有用，文档不在时无从谈起。直接跳过并留一条可见记录，
   * 而不是让 ENOENT 把后面几百条断言一起带走：那是工具的缺陷，不是产品的。
   */
  if (!(await exists(DOC))) {
    ok('设计文档已移出仓库，本节跳过', true, '', 'docs/UI-DESIGN.md 不存在')
    return
  }

  const text = await read(DOC)
  const lines = text.split('\n')

  /*
   * --- 1. 小节号无重复、无断号；引用全部指向真实小节 ---
   *
   * 三级编号（10.7.1）也必须认。只匹配两级会把这五个真实存在的小节
   * 当成悬空引用——上一版就是这样误报了五条。
   */
  const ids = new Set()
  for (const line of lines) {
    const match = /^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]/.exec(line)
    if (match !== null) ids.add(match[1])
  }
  const refs = new Set()
  for (const line of lines) {
    for (const match of line.matchAll(/§(\d+(?:\.\d+)*)/g)) refs.add(match[1])
  }
  const dangling = [...refs].filter((ref) => !ids.has(ref))
  ok('§ 引用全部指向真实小节', dangling.length === 0,
    '悬空引用会让照文档改的人找不到原文', dangling.join(', '))

  /* 重复只查顶层与二级——三级编号在不同父小节下重名是合法的。 */
  const major = lines
    .map((line) => /^(#{2,3})\s+(\d+(?:\.\d+)?)[.\s]/.exec(line)?.[2])
    .filter((id) => id !== undefined)
  const dup = major.filter((id, index) => major.indexOf(id) !== index)
  ok('小节号无重复', dup.length === 0, '同一编号出现两次，引用会指向错的地方', dup.join(', '))

  /*
   * --- 2. 表格列数与表头一致 ---
   *
   * 分隔线的竖线数必须等于表头。多一列或少一列不会报错，只是那张表
   * 渲染出来会错位，而错位后读者看到的是「另一张表」。
   * 正则里的 `\|` 不能计入列数，所以用负向回顾排除转义的竖线。
   */
  const badTables = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const head = lines[index]
    const sep = lines[index + 1].trim()
    if (!head.trim().startsWith('|')) continue
    if (!/^\|[\s:|-]+\|$/.test(sep)) continue
    const count = (line) => (line.match(/(?<!\\)\|/g) ?? []).length
    if (count(head) !== count(sep)) badTables.push(`第 ${String(index + 1)} 行`)
  }
  ok('所有表格列数与表头一致', badTables.length === 0,
    '列数不一致的表会整张渲染错位，读者看到的是另一张表', badTables.join(', '))

  /*
   * --- 3. 插件总数口径一致 ---
   *
   * 134 这个数在三处出现：`MIGRATED_PLUGIN_COUNT`、附录 A 的合计、
   * §13 的条目。任何一个改了口径，另外两处就是错的。
   *
   * ## 「132 个有 README」这条判据必须排除 §13 自身
   *
   * §13 的验收条目**原文就写着**「不存在"132 个有 README"的表述」——
   * 扫全文时会把这条禁令本身当成违规命中，报出一句自相矛盾的红。
   * 这是「检查规则出现在被检查的文本里」的经典自指陷阱。
   *
   * 附录 A 里那句「有 README 的插件是 132 个，但 members 是 134 个」
   * 也不违规：它说的是**两个数各自的含义**，正是为了提醒别混用。
   * 真正要禁的只有一种句式：把 132 当插件总数（「共 132 个插件」之类）。
   */
  const coreText = await read(join(REPO, 'cordis-host/plugins/ondra-core/src/index.ts'))
  const migrated = Number(/MIGRATED_PLUGIN_COUNT\s*=\s*(\d+)/.exec(coreText)?.[1] ?? 0)
  /*
   * 条目可以写成一行，也可以因为带 `after` 与注释而拆成多行。
   * 正则必须容忍换行与缩进：只认单行时，**任何一条被格式化拆行都会让计数少一**，
   * 报出来的却是「清单被增删过而计数没跟」——一个与真实原因无关的结论。
   * 这类「格式化触发假红」会让人去改计数，把正确的 132 改成 131，越修越错。
   */
  const memberIds = [...coreText.matchAll(/\{\s*id:\s*'([^']+)',\s*plugin:/g)].map((match) => match[1])
  ok('MIGRATED_PLUGIN_COUNT 等于 members 条数', migrated === memberIds.length,
    '两个数不一致说明清单被增删过而计数没跟',
    `${String(migrated)} vs ${String(memberIds.length)}`)

  // 排除 §13 自身（它引用了这句禁语），只看正文。
  const body = text.slice(0, text.indexOf('## 13.')) + text.slice(text.indexOf('## 附录 A'))
  const wrongTotal = /(?:共|合计|总数为?)\s*132\s*个?(?:插件)?/.test(body)
  ok('不存在把 132 当插件总数的表述', !wrongTotal,
    '132 是「有 README 的插件数」，用它当总数会漏掉两个没有 README 的插件')

  /*
   * --- 4. 附录 A 合计等于插件数 ---
   *
   * 附录按层分表，每张表的条目数相加必须等于 134。少一条就是某个插件
   * 没有被登记层级，而「每个插件都有 L 层级」正是 §13 的一条验收。
   */
  const appendix = text.slice(text.indexOf('## 附录 A'))
  const appendixRows = [...appendix.matchAll(/^\|\s*`(ondra-[a-z0-9-]+)`\s*\|/gm)].map((match) => match[1])
  const uniqueRows = new Set(appendixRows)
  ok('附录 A 条目数与插件数一致', uniqueRows.size === migrated,
    '附录少登记就会让某个插件没有层级归属',
    `附录 ${String(uniqueRows.size)} 条 / 清单 ${String(migrated)} 项`)

  /* 桥接项不占这 134：它们单列在 A.11。 */
  const bridges = ['desktop-bridge', 'dsh-client']
  const bridgeInCore = bridges.filter((name) => memberIds.includes(name))
  ok('桥接项不在 members 里', bridgeInCore.length === 0,
    '桥接项不在 134 之内，混进去会让总数虚高', bridgeInCore.join(', '))

  /*
   * --- 7. Windows 安装器 410 × 290 ---
   *
   * 尺寸写在 `.nsi` 里（`IntOp $2 $1 * 410` / `* 290`，按 DPI 等比换算）。
   * 这两行是「安装器窗口多大」的唯一真源，改了它不会在应用里露出任何
   * 征兆——只有装的时候才发现装不下中文。
   */
  const nsi = await read(join(REPO, 'src-tauri/installer/installer.nsi')).catch(() => '')
  const sizeOk = /IntOp\s+\$\d+\s+\$\d+\s+\*\s+410/.test(nsi) && /IntOp\s+\$\d+\s+\$\d+\s+\*\s+290/.test(nsi)
  ok('安装器窗口 410 × 290', sizeOk,
    '410 宽扣掉边框只剩 246px 给内容区，改窄了中文一行放不下八个字',
    nsi === '' ? '找不到 installer.nsi' : `410=${String(/410/.test(nsi))} 290=${String(/290/.test(nsi))}`)

  /*
   * --- 7b. 安装器向导三页 ---
   *
   * §10.13 定的是「欢迎 / 安装中 / 完成」三页，与 410 × 290 是一组：
   * 那个尺寸装不下第四页，也没有第五页的内容可放。
   *
   * ## 为什么只数 `MUI_PAGE_` 而不查具体是哪三页
   *
   * 更换页序（欢迎 ↔ 完成）在这个尺寸下毫无意义，而新增一页（比如
   * 「选择安装位置」）会直接撑爆布局。**页数是硬约束，页序不是。**
   * 只数数量，既能拦住新增，也不会因为调换顺序误报。
   *
   * 卸载页（`un.MUI_PAGE_` 前缀过了 `!insertmacro MUI_` 这一层不算在内）
   * 不参与计数——卸载向导与安装向导是两个窗口。
   */
  const wizardPages = [...nsi.matchAll(/^!insertmacro MUI_PAGE_(\w+)/gm)].map((match) => match[1])
  ok('安装器向导三页（欢迎 / 安装中 / 完成）', wizardPages.length === 3,
    '410 × 290 装不下第四页；新增一页会直接撑爆布局（§10.13）', wizardPages.join(' → '))

  /*
   * --- 8. 插件 README 首行的层级与附录登记一致 ---
   *
   * 附录 A 说「本附录的数据全部来自插件自身：每个 README 的首行元信息」。
   * 若某个插件的 README 首行写着 L4 而附录把它登记在 A.2（L2），那两边
   * 就有一处是错的，而读者只会相信自己先看到的那份。
   *
   * 判据：README 首行的 `L\d` 与附录里该插件所在小节号（A.2 = L2）对齐。
   */

  // 把附录切成「小节 → 插件名」两列（`appendix` 已在上面切好）。
  //
  // 用数组而不是 Map：Map 会让「同一插件登记两次」被后一次覆盖，
  // 那种重复正是最该抓的错——两个层级都说自己管它。反向验证时本轮
  // 就撞上了这个洞（把 ondra-breath 同时写进 A.0 与 A.4，全程没报红）。
  const registration = []
  let currentLayer = ''
  for (const line of appendix.split('\n')) {
    const head = /^###\s+A\.(\d+)\s+.*?L(\d)/.exec(line)
    if (head !== null) { currentLayer = head[2]; continue }
    const row = /^\|\s*`(ondra-[a-z0-9-]+)`\s*\|/.exec(line)
    if (row !== null && currentLayer !== '') registration.push([row[1], currentLayer])
  }

  // 重复登记：同一个名字出现在两个不同层级。
  const seen = new Map()
  const duplicates = []
  for (const [name, layer] of registration) {
    const before = seen.get(name)
    if (before !== undefined && before !== layer) duplicates.push(`${name}（L${before} 与 L${layer}）`)
    else seen.set(name, layer)
  }
  ok('附录 A 无重复登记（同一插件只在一个层级）', duplicates.length === 0,
    '同一插件登记两层时，两处都说自己管它，读者无法判断哪个是真的',
    duplicates.join('; '))

  const layerMismatch = []
  for (const [name, layer] of seen) {
    let first = ''
    try {
      first = (await read(join(REPO, 'cordis-host/plugins', name, 'README.md'))).split('\n')[0]
    } catch { continue } // 没有 README 的两个插件已在附录里说明，跳过
    const declared = /L(\d)/.exec(first)?.[1]
    if (declared !== undefined && declared !== layer) {
      layerMismatch.push(`${name}：README 写 L${declared}，附录登记 L${layer}`)
    }
  }
  ok('插件 README 首行层级与附录一致', layerMismatch.length === 0,
    '两处写同一件事却不同，读者只会信自己先看到的那份', layerMismatch.slice(0, 6).join('; '))

  /*
   * --- 4b. 没有 README 的插件恰好是登记过的那几个 ---
   *
   * §13 第 101 条的实质是「134 个插件均有 L 层级登记」。上面两条
   * （附录合计 = 134、README 首行与附录一致）已经守住了「登记过的
   * 都对得上」，但漏了一种情况：**新加一个插件、忘了写 README**。
   *
   * 那时它会出现在 `members` 里、也会被登记进附录某层，而
   * `layerMismatch` 的循环遇到读不到 README 的目录是 `continue`——
   * 静默跳过。于是「没写 README」这件事故意不报错，看不出任何异常。
   *
   * 这里把「无 README 的目录」钉成一份名单：多一个就红，提示要么补
   * README、要么把名字加进名单并说明原因。**名单本身就是文档**。
   */
  const noReadmeAllowed = new Set([
    'desktop-bridge', // 桥接项，不在 members（A.11）
    'dsh-client', // 同上
    'ondra-core', // 清单本身，不是可装载插件
    'ondra-memory-intake', // 有代码、在 members、无 README（A.9 已说明）
    'ondra-theater', // 同上（A.10）
  ])
  const pluginDirs = (await readdir(join(REPO, 'cordis-host/plugins'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  const noReadme = []
  for (const name of pluginDirs) {
    try {
      await access(join(REPO, 'cordis-host/plugins', name, 'README.md'))
    } catch {
      noReadme.push(name)
    }
  }
  const unexpected = noReadme.filter((name) => !noReadmeAllowed.has(name))
  ok('无 README 的插件恰为已登记的 5 个', unexpected.length === 0,
    '新增插件缺 README 时附录无法核对其层级，而这正是「134 个都有登记」的漏洞',
    unexpected.join(', '))
  /* 反向：名单里的人若补了 README，名单本身就成了错的说明，同样要清。 */
  const stale = [...noReadmeAllowed].filter((name) => !noReadme.includes(name))
  ok('无 README 名单无过期条目', stale.length === 0,
    '名单里的人已经补了 README，留着会让下一个人误以为可以继续不写',
    stale.join(', '))

  /*
   * --- 5. 验收清单条目数 ---
   *
   * 记录条目数不是为了「必须等于 116」，而是为了让任何一次增删都在
   * 这里留下痕迹——数字突然变了，说明有人改了验收标准，
   * 那属于需要复核的改动，不该悄悄发生。
   *
   * 114 → 116 的那次改动是可复核的：原来的「全界面无蓝色、无渐变、
   * 无毛玻璃」一条，在「三层表面」那一版被拆成三条（禁止装饰性渐变 /
   * 三层表面取值成立 / 两脊是实色窗身）。拆分理由是新规则有三处独立
   * 的失败方式，合并成一条时任何一种失败都只能报"那条不对"，
   * 看不出是哪一层错了。
   */
  const acceptance = text.slice(text.indexOf('## 13.'), text.indexOf('## 附录 A'))
  const items = [...acceptance.matchAll(/^- \[[ x]\] /gm)].length
  ok('验收清单条目数与记录一致', items === 116,
    '条目数变了说明验收标准被改动，需要复核', items)
}

/* ==========================================================================
   九、§13 条目分账（--list）
   ========================================================================== */

/**
 * 把 114 条按「谁来验」分类。
 *
 * ## 为什么需要这张账
 *
 * §13 是一张平铺的清单，读的时候看不出「哪些已经有人守着」。结果每次
 * 想「过一遍验收」都从第一条开始手点，点到第二十条就放弃了。
 *
 * 三类：
 * - `auto`：已有断言守着（check-ui 的 276 条 + 本脚本），改坏了会红。
 * - `static`：本脚本新覆盖的静态规格。
 * - `manual`：只能真机或人工判断（红绿灯位置、字体观感、触摸手势…）。
 *
 * `manual` 不是欠债，是**性质如此**：没有自动化能判断「两端字重并排
 * 看不出差异」。
 *
 * ## 移动端与触屏一批之后，这份名单已剔除六条
 *
 * 原 23 条里有 6 条随那轮落地转成 static：
 *
 * | 原序号 | 条目 | 新判据 |
 * | --- | --- | --- |
 * | 58 | 触屏操作按钮常驻 40% | `compact.css` 的 `hover: none` 块 |
 * | 59 | 移动端输入框 16px | `any-pointer: coarse` 块（第 10 条） |
 * | 60 | iOS 键盘弹出输入框可见 | `visualviewport` + `--kb-h`（第 11 条） |
 * | 65 | Android / 鸿蒙返回键逐层退 | `popstate` 顺序（第 13 条） |
 * | 56 | compact 双脊收起 | 容器查询块（第 14 条） |
 * | 64 | 移动端不出现桌面入口 | 能力探测（第 19 条） |
 *
 * ## 本轮再剔除十条（19 → 9）
 *
 * 复查时发现原名单混进了三类完全不同的东西，`manual` 这个标签把
 * 「没验」和「验不了」混成了一种状态。逐条重判后：
 *
 * | 原序号 | 条目 | 为什么可以机器化 |
 * | --- | --- | --- |
 * | 2 | 红绿灯垂直中心 22 | 自绘圆点 12px + top 16px 可算（平台保真第 2 条，同时验系统按钮已隐藏） |
 * | 3 | Windows 三键中心 22 | `top + height / 2` 可算（平台保真第 1 条） |
 * | 4 | 标题位置像素级一致 | 判据是「不因平台让位偏移」，绝对定位可查（第 2 条） |
 * | 6 | 双击标题栏交给系统 | 判据是**代码里没有** `onDoubleClick`（第 3 条） |
 * | 42 | PageUp / PageDown 翻页 | `tabIndex` + 键名 + `scrollBy` 三件（第 4 条） |
 * | 57 | iPad 接键盘热区回 32 | 热区只挂 `pointer: coarse`（第 5 条） |
 * | 63 | Linux 字体栈含 CJK 回退 | 字体栈里有 `Noto Sans CJK SC`（第 6 条） |
 * | 66 | 鸿蒙薄壳只需 invoke / listen | `shell.ts` 只摸 `__TAURI__.core` / `.event`（第 12 条） |
 * | 90 | 关闭为隐藏到托盘 + 首次解释 | 壳 `intercept_close` + 界面 `close-requested`（第 9 条） |
 * | 95 | 失焦呼吸暂停、水位 60% | `[data-window-blurred]` 块 + `animation: none`（第 10 条） |
 * | 96 | 托盘四项齐全、单击唤回 | 文案 + `show_menu_on_left_click(false)`（第 11 条） |
 * | 74 | Windows 安装器 410 × 290 | `IntOp $2 $1 * 410` 写在 `.nsi`（既有第 7 条），**页数另加一条** |
 * | 101 | 134 个插件均有 L 层级登记 | 附录 A 合计 = 134（既有第 4 条），本轮补「无 README 的只许 5 个」 |
 *
 * 其中 86（Windows 字重 450 的**观感**）拆成两半：数值已由平台保真
 * 第 7 条守住，剩下「并排看不出粗细差异」才是真的要两台机器并排看，
 * 仍留 manual。这是本轮唯一一条被拆分的条目，也不再当作「没做」。
 *
 * ## 剩下的 6 条：真需要另一台机器或另一个人
 *
 * 它们不是欠债，是**验证环境不在本机**。登记表原在设计文档 §13 末尾，
 * 文档移出仓库后改由 15.1 未验证清单承载，写明各自需要什么设备、看哪一处。
 */
const MANUAL_ITEMS = new Set([
  53, 62, 75, 86, 89, 91,
])

async function listAcceptance() {
  if (!(await exists(DOC))) {
    console.log('docs/UI-DESIGN.md 已移出仓库，§13 验收清单无从列出')
    return
  }
  const text = await read(DOC)
  const section = text.slice(text.indexOf('## 13.'), text.indexOf('## 附录 A'))
  const items = [...section.matchAll(/^- \[([ x])\] (.+)$/gm)].map((match) => ({
    checked: match[1] === 'x',
    text: match[2],
  }))

  console.log(`§13 验收清单共 ${String(items.length)} 条\n`)
  console.log('分类规则：auto = 已有断言守；static = 本脚本覆盖；manual = 只能人工\n')

  let auto = 0
  let manual = 0
  items.forEach((item, index) => {
    const kind = MANUAL_ITEMS.has(index + 1) ? 'manual' : 'static'
    if (kind === 'manual') manual += 1
    else auto += 1
    const mark = item.checked ? '✓' : kind === 'manual' ? '·' : ' '
    console.log(`${mark} [${kind.padEnd(6)}] ${String(index + 1).padStart(3)}. ${item.text}`)
  })

  console.log(`\n可自动验证 ${String(auto)} 条 / 需人工 ${String(manual)} 条`)
}

/* ==========================================================================
   十、主流程
   ========================================================================== */

/**
 * 主动节律的**行为**接线（不是文本匹配）。
 *
 * ## 为什么这一组必须真跑插件，而不是 grep 源码
 *
 * 这里防的是一个已经发生过的真实断裂：`loadCore` 曾经只收 `enable`，
 * 成员的 `config` 恒为 `undefined`。于是设置页把「她多主动」存成 `fast`，
 * 插件里仍按 `standard` 跑，**两侧都不报错**——grep 只能看到
 * `profile` 这个字符串在两个文件里都出现过，那正是「假绿」最爱的形状。
 *
 * 只有真的装载、真的读 `quota()`，才能问出那句：用户选快速档时，
 * 额度到底是 6 还是 3？
 *
 * ## 为什么断言的是三条而不是一条
 *
 * 只验 `fast = 6` 的话，把 `slow` 也写死成 6 仍然全绿。三档一起验，
 * 才能证明「档位 → 额度」是一条真映射而不是某个默认值碰巧对上。
 */
async function checkProactiveWiring() {
  group('主动节律接线')

  const coreEntry = join(REPO, 'cordis-host/plugins/ondra-core/lib/index.js')
  if (!await exists(coreEntry)) {
    ok('空谷核心已构建（可装载）', false, '缺 lib/index.js，跑 pnpm run build:plugins')
    return
  }

  let loadCore
  let Context
  try {
    ({ loadCore } = await import(coreEntry))
    /*
     * `@ntars/cordis` 只在 `cordis-host` 的依赖里，不在根目录。
     * 用 `createRequire` 以宿主为锚点解析，而不是硬编码 pnpm 的
     * `.pnpm/cordis@版本/` 路径——那个路径带版本号，升级一次就断。
     */
    const { createRequire } = await import('node:module')
    const requireFromHost = createRequire(join(REPO, 'cordis-host/index.ts'))
    ;({ Context } = await import(pathToFileURL(requireFromHost.resolve('@ntars/cordis')).href))
  } catch (error) {
    ok('空谷核心可被导入', false, `导入失败：${String(error)}`)
    return
  }

  /** 装载一组固定成员，返回它们的服务。 */
  const boot = async (configs) => {
    const ctx = new Context()
    ctx.baseUrl = new URL('./', `file://${join(REPO, 'cordis-host/')}`).href
    await loadCore(ctx, {
      enable: [
        'ondra-clock', 'ondra-path-layout', 'ondra-config-schema', 'ondra-identity',
        'ondra-proactive-gate', 'ondra-proactive-quota',
      ],
      ...(configs === undefined ? {} : { configs }),
    })
    return { ctx, quota: ctx.get('ondra-proactive-quota') }
  }

  /** 三档的期望额度。表与插件 `PROFILE_QUOTA` 必须一致。 */
  const EXPECT = { slow: 1, standard: 3, fast: 6 }
  for (const [profile, expected] of Object.entries(EXPECT)) {
    const { ctx, quota } = await boot({ 'ondra-proactive-quota': { profile } })
    const got = quota?.quota?.().base
    ok(`用户层 ${profile} → 额度 ${String(expected)} 条`, got === expected,
      '用户层设置没递进插件：设置页拨哪一档都不影响她实际多主动',
      got === undefined ? '（服务缺席）' : String(got))
    await ctx.fiber.dispose()
  }

  /*
   * 非法值必须回落到标准档，而不是让插件炸掉或停在非法状态。
   * 用户手改 settings.json 是常态，一条写错不该让主动行为整块消失。
   */
  {
    const { ctx, quota } = await boot({ 'ondra-proactive-quota': { profile: '不存在的档' } })
    const got = quota?.quota?.().base
    ok('非法档位回落标准档（3 条）', got === EXPECT.standard,
      '非法值应回落到 standard 而不是崩溃或归零', String(got))
    await ctx.fiber.dispose()
  }

  /*
   * 额度必须真的到达门控。
   *
   * `quota.patch()` 算出 6，若宿主没把它传进 `gate()`，门控会用自己配置里的
   * 默认 3——现象正是「设置显示主动，实际只有三条」，且两处日志都正常。
   */
  {
    const { ctx, quota } = await boot({ 'ondra-proactive-quota': { profile: 'fast' } })
    const gate = ctx.get('ondra-proactive-gate')
    let budget
    try {
      budget = gate.gate({ reason: 'active', text: '探针', conversationId: 'probe', dailyQuota: quota.patch().dailyQuota }).budget
    } catch { budget = undefined }
    ok('档位额度经 patch() 到达门控（fast → 6）', budget?.quota === EXPECT.fast,
      'patch() 的 dailyQuota 没接进 gate()：额度闸只会用门控自己的配置值',
      String(budget?.quota))
    await ctx.fiber.dispose()
  }

  /*
   * 执念的「够不够格开口」必须由宿主递进话由。
   *
   * ## 守的是什么
   *
   * `KIND_ORDER` 把 `gap` 排第一，排序是字典序（序位差 1 值 10 分，权重最多值 1 分），
   * 于是**任何**一条 open 执念都压过所有承诺与待办。而 `open()` 的 `base` 默认 40，
   * 唤醒线 80。两件事凑起来：用户刚说一句让她答不上来的话，她三秒后就拿这条
   * 刚出生、并不压人的事开口，把「答应过明天打印合同」全压到后面。
   *
   * ## 为什么不 grep「宿主里有没有写 gapEligibleFor」
   *
   * 那是本轮之前反复踩的坑：字符串在文件里出现过，但中间那根线可能没接上
   * （调了却没用返回值、用了返回值却没传给 `plan()`）。唯一口径是真装载一次，
   * 用**同一组输入**分别走「够格」与「不够格」两条路，看 `pick.kind` 是否真的换人。
   */
  {
    const { gapEligibleFor, takeReason } = await import(
      pathToFileURL(join(REPO, 'cordis-host/src/proactive.ts')).href
    ).catch(() => ({}))

    if (typeof gapEligibleFor !== 'function' || typeof takeReason !== 'function') {
      ok('宿主主动模块可被导入（含 gapEligibleFor / takeReason）', false,
        '导入失败：找不到两个函数，接线断言无从谈起')
    } else {
      /* 用一个最小的假池子：`dueForWake()` 的结论由 `wake` 字段给，
       * 本断言验的是「结论有没有被转成 plan 的入参」，不是判定本身
       * （判定属于 `check:gap-wake`）。 */
      const stubGap = (wake) => ({
        available: true,
        dueForWake: () => ({ wake }),
        markDelivered: () => true,
      })

      ok('缺口池说「不够格」→ gapEligibleFor 返回 false',
        gapEligibleFor(stubGap(false), 60) === false,
        '`false` 没被透出来：话由层收不到「这条执念还不够格」')

      ok('缺口池说「够格」→ gapEligibleFor 返回 true',
        gapEligibleFor(stubGap(true), 60) === true,
        '`true` 没被透出来')

      ok('缺口池缺席 → 返回 undefined（不是 false）',
        gapEligibleFor(undefined, 60) === undefined,
        '缺席若当成 false，一次装载顺序变化就会让她彻底不主动')

      ok('缺口池抛错 → 返回 undefined（不连坐主动链）',
        gapEligibleFor({ available: true, dueForWake: () => { throw new Error('boom') }, markDelivered: () => true }, 60) === undefined,
        '判错应当退回旧行为，而不是让整条主动链停摆')

      /*
       * 真正的那根线：`takeReason(reason, gapEligible)` 要把第二参递给 `plan()`。
       *
       * 这里用一个记下「收到了什么」的话由桩。若 `takeReason` 忘了把
       * `gapEligible` 塞进 `plan()` 的入参，`seen` 会是 `undefined`——
       * 而租出去的返回值照样是个合法对象，症状只有「缺陷还在，测试全绿」。
       */
      let seen
      const stubReason = {
        available: true,
        plan: (input) => {
          seen = input?.gapEligible
          return {
            code: 'ok',
            pick: { kind: 'promise', text: '明天打印合同', topic: 'promise:p1', dueAt: 0, key: 'p1' },
            candidates: [],
          }
        },
        markUsed: () => 0,
      }
      takeReason(stubReason, false)
      ok('gapEligible 真的递进了 plan()（false）', seen === false, String(seen))
      takeReason(stubReason, true)
      ok('gapEligible 真的递进了 plan()（true）', seen === true, String(seen))

      /* 返回的 `key` 必须是话由自己的 key，`markDelivered()` 靠它对上执念。 */
      const taken = takeReason(stubReason, true)
      ok('takeReason 回传候选 key（供执念回写用）', taken?.key === 'p1', String(taken?.key))
      ok('takeReason 回传候选 kind', taken?.kind === 'promise', String(taken?.kind))
    }
  }
}

/**
 * 装载顺序与话由源的行为接线。
 *
 * ## 守的是什么
 *
 * `loadCore` 曾按成员清单的**字母序**装。字母序不是依赖序：
 * `ondra-memory-prospective` 排第 25 位、`ondra-store-sqlite` 排第 68 位，
 * 于是前者在 `apply` 里 `ctx.get('ondra-store-sqlite')` 拿到 `undefined`，
 * 以 `available=false, reason=no-store` 注册服务。症状是「待办与承诺永远为空」，
 * 而 `loadCore` 返回后宿主再读，store 明明在——**两侧都不报错**。
 *
 * 这条缺陷还会连带整条主动链：待办为空 → `ondra-proactive-reason` 的
 * `plan()` 恒为 `no-candidate` → 她永远没有「话由」，只能靠门控给的一句通用话。
 * 所以断言必须一路验到 `plan().code === 'ok'`，只验「store 装上」会漏掉后半段。
 *
 * ## 为什么不能 grep
 *
 * 「`after` 这个字段在清单里出现过」无法证明排序真的生效——排序逻辑写错、
 * 或 `loadCore` 忘了调它，grep 一样全绿。唯一口径是真装载一次，读插件自己的视图。
 */
async function checkLoadOrder() {
  group('装载顺序与话由源')

  const coreEntry = join(REPO, 'cordis-host/plugins/ondra-core/lib/index.js')
  if (!await exists(coreEntry)) {
    ok('空谷核心已构建（可装载）', false, '缺 lib/index.js，跑 pnpm run build:plugins')
    return
  }

  let loadCore
  let orderMembers
  let Context
  let tmpRoot
  try {
    ({ loadCore, orderMembers } = await import(coreEntry))
    const { createRequire } = await import('node:module')
    const requireFromHost = createRequire(join(REPO, 'cordis-host/index.ts'))
    ;({ Context } = await import(pathToFileURL(requireFromHost.resolve('@ntars/cordis')).href))
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    tmpRoot = mkdtempSync(join(tmpdir(), 'ondra-order-'))
  } catch (error) {
    ok('空谷核心可被导入', false, `导入失败：${String(error)}`)
    return
  }

  /*
   * 纯函数先验一次：字母序里 prospective 在 store 之前，排完必须反过来。
   * 这一条与下面的真装载互为两道锁——排序函数对但没被调用，这里绿、下面红。
   */
  {
    const { ordered } = orderMembers([
      { id: 'ondra-memory-prospective', plugin: {}, after: ['ondra-store-sqlite'] },
      { id: 'ondra-store-sqlite', plugin: {} },
    ])
    ok('after 让存储端口排在依赖方前面', ordered[0]?.id === 'ondra-store-sqlite',
      'orderMembers 没把 after 当依赖：字母序仍会让 prospective 看到没有存储端口',
      String(ordered[0]?.id))
  }

  /** 装一组固定成员。 */
  const boot = async (extra, dbName) => {
    const ctx = new Context()
    ctx.baseUrl = new URL('./', `file://${join(REPO, 'cordis-host/')}`).href
    const configs = {
      'ondra-store-sqlite': { path: join(tmpRoot, dbName) },
      ...(extra.configs ?? {}),
    }
    await loadCore(ctx, {
      enable: [
        'ondra-clock', 'ondra-path-layout', 'ondra-config-schema', 'ondra-identity',
        ...extra.enable,
      ],
      configs,
    })
    return ctx
  }

  // 一、存储端口 → 承诺待办：真装载后必须可用。
  {
    const ctx = await boot({ enable: ['ondra-store-sqlite', 'ondra-memory-prospective'] }, 'order-a.db')
    const prospective = ctx.get('ondra-memory-prospective')
    ok('承诺待办在真装载后可用（不是 no-store）',
      prospective !== undefined && prospective.available === true,
      '装载顺序错：prospective 在 apply 里取不到存储端口，待办与承诺永远为空',
      prospective === undefined ? '（服务缺席）' : `available=${String(prospective.available)} reason=${String(prospective.reason)}`)
    await ctx.fiber.dispose()
  }

  /*
   * 二、待办 → 话由源：整条主动链的末端。
   *
   * 只验「待办建成功」不够——`ondra-proactive-reason` 若没读到它，
   * 她照样没有话由。断言必须落在 `plan().code` 与 `pick.kind` 上。
   */
  {
    const ctx = await boot({
      enable: ['ondra-store-sqlite', 'ondra-memory-prospective', 'ondra-proactive-reason'],
    }, 'order-b.db')
    const prospective = ctx.get('ondra-memory-prospective')
    const reason = ctx.get('ondra-proactive-reason')
    let plan
    try {
      if (prospective !== undefined && prospective.available) prospective.addTodo('周三前把报价单发过去')
      plan = reason?.plan()
    } catch { plan = undefined }
    ok('待办能变成一条话由（plan = ok / pick = todo）',
      plan?.code === 'ok' && plan.pick?.kind === 'todo',
      '话由源断路：待办写进库了但 reason 读不到，她永远没有由头',
      plan === undefined ? '（服务缺席）' : `code=${String(plan.code)} candidates=${String(plan.candidates.length)}`)
    await ctx.fiber.dispose()
  }

  /*
   * 三、对话 → 待办：**用户说一句交代，她得记下来**。
   *
   * 这一条守的是整条链真正的那道断层：`prospective.detect()` / `addTodo()` /
   * `remember()` 在全仓曾**零调用方**——表建好了、正则写好了、提醒算术写好了，
   * 但没有任何代码把用户说的话喂进去。症状是「她从来不记得你交代过什么」，
   * 而所有单元级检查都绿。
   *
   * 断言走 `intake.ingest()`（本插件的公开入口），不直接调 `detect()`——
   * 直接调只能证明正则有效，证明不了「它被接上了」。
   *
   * 刻意**不装记忆内核**：待办按设计不进记忆链（§2.8），它必须在没有内核时
   * 照样能记。这一档同时守着「承诺不该被内核的缺席连坐」。
   */
  {
    const ctx = await boot({
      enable: ['ondra-store-sqlite', 'ondra-memory-prospective', 'ondra-memory-intake'],
    }, 'order-c.db')
    const prospective = ctx.get('ondra-memory-prospective')
    const intake = ctx.get('ondra-memory-intake')
    let todos = []
    try {
      if (intake !== undefined) {
        await intake.ingest({
          turnId: 'probe#1',
          lines: [
            { role: 'user', text: '记得明天帮我把合同打印出来' },
            // 她自己的话不该变成待办：那会让她对着自己的话发提醒。
            { role: 'assistant', text: '好，明天提醒你打印合同' },
          ],
        })
      }
      todos = prospective?.listTodos() ?? []
    } catch { todos = [] }
    ok('用户交代的事会变成待办（且只从用户的话里取）',
      todos.length === 1 && todos[0]?.text.includes('合同'),
      '对话到待办的边没接上：detect()/addTodo() 没有调用方，两张表永远是空的',
      `todos=${String(todos.length)}`)
    await ctx.fiber.dispose()
  }

  /*
   * 四、整条链走一遍：交代 → 待办 → 话由。
   *
   * 前三档各自绿不代表合起来通。这一档一次装齐，验的是「她第一次真的有话可说」。
   */
  {
    const ctx = await boot({
      enable: ['ondra-store-sqlite', 'ondra-memory-prospective', 'ondra-memory-intake', 'ondra-proactive-reason'],
    }, 'order-d.db')
    const intake = ctx.get('ondra-memory-intake')
    const reason = ctx.get('ondra-proactive-reason')
    let plan
    try {
      if (intake !== undefined) {
        await intake.ingest({
          turnId: 'probe#2',
          lines: [{ role: 'user', text: '记得明天帮我把合同打印出来' }],
        })
      }
      plan = reason?.plan()
    } catch { plan = undefined }
    ok('整条链走得通（交代 → 待办 → 有话可说）',
      plan?.code === 'ok' && typeof plan.pick?.text === 'string' && plan.pick.text.includes('合同'),
      '三段各自能跑但合起来断：她仍然没有可说的由头',
      plan === undefined ? '（服务缺席）' : `code=${String(plan.code)} pick=${String(plan.pick?.text)}`)
    await ctx.fiber.dispose()
  }

  // 五、空 enable 必须一条都不装（防清单被误改成「默认全开」）。
  {
    const ctx = new Context()
    ctx.baseUrl = new URL('./', `file://${join(REPO, 'cordis-host/')}`).href
    const result = await loadCore(ctx, { enable: [], configs: {} })
    ok('空 enable 时一条都不装（默认策略仍是全禁）',
      result.loaded.length === 0 && result.skipped.length > 0
        && result.skipped.every((item) => item.reason === '默认禁用'),
      '默认策略被改坏了：空名单应当一条都不装，且说明全是「默认禁用」',
      `loaded=${String(result.loaded.length)} skipped=${String(result.skipped.length)}`)
    await ctx.fiber.dispose()
  }

  /*
   * 六、对话 → 缺口（执念）→ 话由。
   *
   * 这一段守的是与「三」同源的另一个洞：`ondra-drive-gap` 的六个对外方法
   * （`open` / `dueForWake` / `fragment` / `markDelivered` / `recheck` /
   * `dueForDream`）在全仓**零调用方**——缺口池从建库起就是空的。
   *
   * 两件事要一起验，缺一件都还是空转：
   * ① 她自己的话里有「不确定」，池子里得多一条（写入侧）；
   * ② `reason` 得把它取成 `gap` 种类的候选（读取侧）。
   *
   * 判据落在「池子从 0 变 1」而不是「服务 exists」：后者在全仓零调用方时
   * 同样为真，那正是这个洞能挂了四轮的原因。
   */
  {
    const ctx = await boot({
      enable: ['ondra-store-sqlite', 'ondra-memory-intake', 'ondra-drive-gap', 'ondra-proactive-reason'],
    }, 'order-e.db')
    const gap = ctx.get('ondra-drive-gap')
    const intake = ctx.get('ondra-memory-intake')
    const reason = ctx.get('ondra-proactive-reason')
    let before = -1
    let after = -1
    let plan
    try {
      before = gap?.stats?.().open ?? -1
      if (intake !== undefined) {
        await intake.ingest({
          turnId: 'probe#3',
          lines: [
            { role: 'user', text: '那个接口的参数顺序是什么？' },
            // 她答不上来 —— 这就是「缺口」。
            { role: 'assistant', text: '这个我也不太确定，得回头看下文档。' },
          ],
        })
      }
      after = gap?.stats?.().open ?? -1
      plan = reason?.plan()
    } catch { plan = undefined }
    ok('她答不上来的事会进缺口池（0 → 1）',
      before === 0 && after === 1,
      '对话到缺口的边没接上：open()/detect() 没有调用方，池子永远是空的',
      `open ${String(before)} → ${String(after)}`)
    ok('缺口能变成一条话由（plan = ok / pick = gap）',
      plan?.code === 'ok' && plan.pick?.kind === 'gap',
      '缺口写进池了但 reason 读不到，她心里压着事却说不出来',
      plan === undefined ? '（服务缺席）' : `code=${String(plan.code)} kind=${String(plan.pick?.kind)}`)
    await ctx.fiber.dispose()
  }

  /*
   * 七、存储必须真落盘，而不是内存态。
   *
   * `ondra-store-sqlite` 的 `path` 默认为空，空时必须向 `ondra-path-layout`
   * 要路径；拿不到它**直接 return、不注册服务**（连错误日志都在插件内部，
   * 宿主那层看不出来）。于是 22 个业务插件全部静默退到内存态：
   * 服务在、`available` 全 true、表建得出来，唯独**重启即空**。
   *
   * 这一档单独存在，是因为前面每一档都能在内存态下全绿——它们验的是
   * 「链路通不通」，不是「数据在不在」。唯一能区分两者的判据是
   * `storeProvider`（`GapStats.available` 在无存储时仍是 true）。
   */
  {
    const ctx = await boot({
      enable: ['ondra-store-sqlite', 'ondra-drive-gap'],
    }, 'order-f.db')
    const gap = ctx.get('ondra-drive-gap')
    const provider = gap?.stats?.().storeProvider
    ok('缺口池落到 sqlite（不是内存态，重启不丢）',
      provider === 'sqlite',
      '数据根没接上：sqlite 拿不到 path 就不注册服务，全部记忆链静默退到内存态',
      `storeProvider=${String(provider)}`)
    await ctx.fiber.dispose()
  }
}

async function main() {
  if (process.argv.includes('--list')) {
    await listAcceptance()
    return
  }

  await checkTokenLayer()
  await checkMotion()
  await checkScenes()
  await checkDiscipline()
  await checkShellConfig()
  await checkPlatformFidelity()
  await checkProactiveWiring()
  await checkLoadOrder()
  await checkDoc()

  const flat = checks.filter((check) => check.group === undefined)
  const failed = flat.filter((check) => !check.pass)

  console.log('\n§13 静态验收：\n')
  for (const check of checks) {
    if (check.group !== undefined) {
      console.log(`\n── ${check.group} ──`)
      continue
    }
    if (check.pass) {
      console.log(`  ✓ ${check.name}`)
    } else {
      console.log(`  ✗ ${check.name}`)
      console.log(`      ${check.why}`)
      if (check.got !== '') console.log(`      实测：${check.got}`)
    }
  }

  console.log(`\n合计：${String(flat.length - failed.length)}/${String(flat.length)} 通过`)
  if (failed.length > 0) {
    console.log(`\n失败 ${String(failed.length)} 条：`)
    for (const check of failed) console.log(`  · ${check.name} —— ${check.why}`)
    process.exitCode = 1
  }
}

await main()
