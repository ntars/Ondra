/**
 * 宿主级常驻插件：状态必须如实上报。
 *
 * ## 这个脚本要证明的一件事
 *
 * ```
 * desktop-bridge / dsh-client 无条件挂载
 *      → GET /api/plugins 必须说 loaded=true、enabled=true、core=true
 * ```
 *
 * ## 为什么需要它
 *
 * 宿主在装载核心链（`loadCore`）**之前**就把这两个包 `ctx.plugin()` 挂上了
 * （`cordis-host/index.ts` 的「桌面能力桥」与「dsh 内核客户端」两段）。
 * 它们因此不在 `enabledPlugins` 里——那份名单只描述核心链成员。
 *
 * 而扩展抽屉的 `loaded` 判据只有 `enabledPlugins` 一处，于是界面上稳定显示：
 *
 * ```
 * dsh-client       未装载
 * desktop-bridge   未装载
 * ```
 *
 * 两包其实每次启动都在跑。判据是日志而不是推断：每次启动都有
 * `dsh-client dsh 内核就绪：2.1.2`，同一时刻接口说它没装载。
 *
 * ## 为什么这件事比「显示错了」严重
 *
 * `plugins.json` 的 `disabled` 里就躺着 `desktop-bridge`。用户以为关掉了，
 * 重启后它照装不误，界面还配合着显示「已关」——**关闭动作无效与状态谎报
 * 互相盖章**，两边都不报错。这正是本仓反复踩的那一类：A 写、B 读、中间
 * 少了根线，日志完全干净。
 *
 * ## 为什么判据落在 `enabled` 而不只是 `loaded`
 *
 * 只把 `loaded` 改对，开关仍然可点。点下去进 `extra`，变成
 * 「已启用 / 未装载 / 重启后生效」——重启后依旧，把「谎报」换成了「空响」。
 * 常驻插件本来就没有「停用」这个动作可实现，所以它必须同时是 `core`
 * （界面据此置灰、toggle 接口据此回 409）。
 *
 * ## B 段为什么要把它们写进 `disabled`
 *
 * 这是受控 A/B：**用最坏的用户数据**验证同一件事。如果只在默认数据下测，
 * 「常驻集合」与「碰巧没被禁用」两种解释都成立，断言就证明不了什么。
 * 写进 `disabled` 之后仍然要 `enabled=true`，才说明「不可停用」是真的。
 *
 * ## 为什么还要 C 段
 *
 * 只断言「这两包是 true」的话，把 `loaded` 恒写成 `true` 也能过。
 * C 段用反向判据兜住：**没有任何一行的 `loaded=true` 而 `enabled=false`**
 * ——「装着呢，但显示已停用」正是这次缺陷的形状。
 *
 * 用法：node tools/check-plugins.mjs
 * 退出码：全部通过为 0。
 *
 * 注意：本脚本用的是 `cordis-host/lib/` 产物（与宿主实际加载的同一份），
 * 改完 `src/` 要先 `pnpm run build:host`。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码（同 `check-voice.mjs` 的口径）
 * ---------------------------------------------------------------- */

const ROOT = join(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'cordis-host', 'index.ts')
const ARTIFACT = join(ROOT, 'cordis-host', 'lib', 'index.js')

if (!existsSync(ARTIFACT)) {
  console.log('=== 前置闸门 · 产物过期 ===')
  console.log(`  ✗ 宿主产物不存在（${ARTIFACT}）`)
  console.log('  先执行：pnpm run build:host')
  process.exit(1)
}
const lag = statSync(SOURCE).mtimeMs - statSync(ARTIFACT).mtimeMs
if (lag > 2000) {
  console.log('=== 前置闸门 · 产物过期 ===')
  console.log(`  ✗ index.ts 比产物新 ${String(Math.round(lag / 1000))} 秒`)
  console.log('  先执行：pnpm run build:host（tsc -b 增量可能跳过，必要时加 --force）')
  process.exit(1)
}

/* ---------------------------------------------------------------- *
 * 断言与宿主启动
 * ---------------------------------------------------------------- */

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

/** 起过的宿主与数据目录，收尾统一清。 */
const hosts = []

/**
 * 起一个宿主，返回 `GET /api/plugins` 的结果。
 *
 * @param disabled 要写进 `plugins.json` 的停用名单。
 * @param extra 要写进 `plugins.json` 的用户额外启用名单。
 */
async function bootPlugins(disabled, extra = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ondra-plugins-'))
  await writeFile(join(dataDir, 'plugins.json'), JSON.stringify({ version: 1, extra, disabled }), 'utf8')
  /*
   * 打开调试接口：`/api/debug/status` 只在 `ONDRA_DEBUG=1` 或数据目录里
   * 有这个文件时才注册。D 段要拿它跟 `/api/plugins` 对账，所以这里得开。
   */
  await writeFile(join(dataDir, 'debug.enable'), '', 'utf8')

  const child = spawn(process.execPath, [join(ROOT, 'cordis-host', 'lib', 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONDRA_DATA_DIR: dataDir },
  })
  hosts.push({ child, dataDir })

  let buffer = ''
  const stderrChunks = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderrChunks.push(String(chunk)) })

  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at = buffer.indexOf('\n')
      while (at !== -1) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
        if (line === '') continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready') {
            clearTimeout(timer)
            resolve(message)
          }
        } catch {
          // 非协议行忽略。
        }
      }
    })
  })

  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
  const response = await fetch(`${base}/api/plugins`, { headers })
  const body = await response.json()
  /*
   * 同一次启动里再读一遍 `/api/debug/status`。
   *
   * `ondra status` 的「N 个已装载」就是从这里来的。它此前报的是
   * `coreResult.loaded`——只含核心装载链，两个常驻包不在里面，
   * 于是命令行说 46、插件抽屉说 48。D 段把两个数钉在一起。
   */
  let status
  try {
    const statusResponse = await fetch(`${base}/api/debug/status`, { headers })
    status = statusResponse.status === 200 ? await statusResponse.json() : undefined
  } catch {
    status = undefined
  }
  /*
   * 真实装载数只能从日志里读。
   *
   * `/api/plugins` 与 `/api/debug/status` 报的都是**展示集合**
   * （`enabledPlugins` + 两个常驻包），它回答「用户看到几个」，
   * 不回答「`loadCore` 真装了几个」。E 段要验的正是两者是否一致，
   * 所以必须取装载链自己报的那个数。
   *
   * 读接口而不是读文件：`debug.log` 是攒批落盘的，宿主被杀之前可能
   * 还没 flush（实测读文件恒为空）。`/api/debug/logs` 读的是内存里的
   * 尾部缓冲，不受落盘时机影响。
   */
  let chainLoaded
  try {
    const logsResponse = await fetch(`${base}/api/debug/logs?lines=400`, { headers })
    if (logsResponse.status === 200) {
      const payload = await logsResponse.json()
      const lines = Array.isArray(payload.lines) ? payload.lines.join('\n') : ''
      const matched = /核心链装载 (\d+) 项/.exec(lines)
      chainLoaded = matched === null ? undefined : Number(matched[1])
    }
  } catch {
    chainLoaded = undefined
  }
  /*
   * 同一份启动里再读 `/api/settings`。
   *
   * F 段要的是**宿主的扫描结果**：它把每个插件包的 `lib/settings.js` 逐个
   * `import()` 一遍，看每个包有没有导出 `CONFIG_SECTION`。没导出的包会被
   * 标成 `registered=false`，界面在它上面直接写一行「未注册配置段，
   * 不参与四层合并」——所以这个数字一旦非零，就是用户在设置页能看见的缺陷。
   */
  let settings
  try {
    const settingsResponse = await fetch(`${base}/api/settings`, { headers })
    settings = settingsResponse.status === 200 ? await settingsResponse.json() : undefined
  } catch {
    settings = undefined
  }
  return { body, status, chainLoaded, settings, stderrText: () => stderrChunks.join('') }
}

/** 按 id 取一行。 */
function rowOf(body, id) {
  return body.items.find((item) => item.id === id)
}

/*
 * 宿主常驻三项：两个在链外挂载的地基（桌面桥、dsh 客户端），
 * 外加装配器本身 `ondra-core`——它被宿主直接 `loadCore()` 用，从不 `ctx.plugin()`，
 * 也不在成员清单里（第 12 轮补进 `core` 集合，理由见 `cordis-host/index.ts`）。
 */
const RESIDENT = ['desktop-bridge', 'dsh-client', 'ondra-core']

/* ---------------------------------------------------------------- *
 * A 段：默认数据下，两包如实上报
 * ---------------------------------------------------------------- */

console.log('=== A 段 · 默认数据下常驻插件如实上报 ===')
const a = await bootPlugins([])

for (const id of RESIDENT) {
  const row = rowOf(a.body, id)
  check(`${id} 出现在清单里`, row !== undefined)
  if (row === undefined) continue
  check(`${id} 报 loaded=true`, row.loaded === true, `loaded=${String(row.loaded)}`)
  check(`${id} 报 core=true（不可停用）`, row.core === true, `core=${String(row.core)}`)
  check(`${id} 报 enabled=true`, row.enabled === true, `enabled=${String(row.enabled)}`)
  check(`${id} 没有「重启后生效」的假待办`, row.pendingRestart === false, `pendingRestart=${String(row.pendingRestart)}`)
}

const aLoaded = a.body.items.filter((item) => item.loaded).length
check('装载总数与自报一致', aLoaded === a.body.totals.loaded, `${String(aLoaded)} / ${String(a.body.totals.loaded)}`)
check('装载总数包含两个常驻包', aLoaded >= RESIDENT.length + 45, `${String(aLoaded)} 个`)

/* ---------------------------------------------------------------- *
 * B 段：用户把它们写进停用名单，仍然必须如实上报
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== B 段 · 写进停用名单后仍然如实上报 ===')
const b = await bootPlugins([...RESIDENT])

for (const id of RESIDENT) {
  const row = rowOf(b.body, id)
  check(`${id} 仍在清单里`, row !== undefined)
  if (row === undefined) continue
  check(`${id} 装着呢就报 loaded=true`, row.loaded === true, `loaded=${String(row.loaded)}`)
  check(`${id} 不因为停用名单而谎报已关`, row.enabled === true, `enabled=${String(row.enabled)}`)
}

/* ---------------------------------------------------------------- *
 * C 段：反向判据，兜住「全部写成 true」的敷衍修法
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== C 段 · 没有「装着呢却报已停用」的行 ===')

for (const [label, body] of [['A', a.body], ['B', b.body]]) {
  const lying = body.items.filter((item) => item.loaded && !item.enabled).map((item) => item.id)
  check(`${label} 段无「已装载却报停用」的行`, lying.length === 0, lying.length === 0 ? '0 行' : lying.join(', '))
  const pending = body.items.filter((item) => item.enabled !== item.loaded).length
  check(`${label} 段待重启计数自洽`, pending === body.totals.pending, `${String(pending)} / ${String(body.totals.pending)}`)
}

/*
 * 反向证明 `loaded` 不是「一律写 true」。
 *
 * ## 判据为什么从「有未装载的包」改成「停用一个包它就报 false」
 *
 * 出厂口径改成「磁盘上有的包默认全装」之后，默认启动下**所有包都 loaded**，
 * 原来那条「至少还有一批未装载」自然失效——它守的其实不是"有未装载"，
 * 而是"loaded 有真假两种取值"。全量装载后这个反证要靠**主动停用**来做：
 * 停掉一个，它就必须变成 `loaded=false`。
 *
 * 那一条在 E 段（`bootPlugins(['ondra-live'])`）里验，这里只留一句说明，
 * 免得下一个人看到"没有未装载的包"以为是缺陷。
 */
check(
  '默认启动下全部包都装载（出厂口径：装了就跑）',
  a.body.items.filter((item) => item.loaded).length === a.body.items.length,
  `${String(a.body.items.filter((item) => item.loaded).length)}/${String(a.body.items.length)}`,
)

/* ---------------------------------------------------------------- *
 * D 段：两处装载数必须相等
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== D 段 · 命令行与插件抽屉的装载数一致 ===')

/*
 * 这一段守的是「同一个事实只有一个数字」。
 *
 * 第 6 轮把 `/api/plugins` 的 `loaded` 修对了，却漏了 `/api/debug/status`
 * 的 `loadedPluginCount`——它仍报 `coreResult.loaded`（只含核心链）。
 * 于是同一次启动里，`ondra status` 说 46、设置里的插件抽屉说 48。
 * 两个数都「不算错」，差别只是「算不算常驻包」，但同一个人在两处看到
 * 不同答案时，只会得出「有一个在骗我」的结论。
 *
 * 判据是比较两个接口的**实测值**，不断言某个具体数字：包数会随版本变，
 * 相等关系不会。
 */
for (const [label, booted] of [['A', a], ['B', b]]) {
  const fromPlugins = booted.body.totals.loaded
  const fromStatus = booted.status?.loadedPluginCount
  check(
    `${label} 段 status 报了装载数`,
    typeof fromStatus === 'number',
    fromStatus === undefined ? '（接口没注册或没返回）' : String(fromStatus),
  )
  check(
    `${label} 段两处装载数相等`,
    fromStatus === fromPlugins,
    `status=${String(fromStatus)} / plugins=${String(fromPlugins)}`,
  )
  const listed = booted.status?.loadedPlugins
  check(
    `${label} 段 status 的名单包含两个常驻包`,
    Array.isArray(listed) && RESIDENT.every((id) => listed.includes(id)),
    Array.isArray(listed) ? `${String(listed.length)} 项` : '（没有名单）',
  )
}

/* ---------------------------------------------------------------- *
 * E 段：用户「启用」必须真的进装载名单
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== E 段 · 打开开关的包真的装上了 ===')

/*
 * 这一段守的是「开关不是空响」。
 *
 * 扩展抽屉里点「启用」，写的是 `plugins.json` 的 `extra`；点「停用」写
 * `disabled`。三份名单合成 `enabledPlugins`，**展示层**（`/api/plugins`
 * 的 `loaded`、`/api/debug/status` 的名单）一直用它，所以界面会如实翻成
 * 「已装载」。
 *
 * 但 `loadCore()` 收到的名单此前是 `enableList`——只含代码常量与环境变量。
 * 于是同一个包里出现两套事实：
 *
 * | 谁 | 说什么 |
 * | --- | --- |
 * | 界面 | 已装载 |
 * | 装载链 | 没装 |
 *
 * 而且两边都不报错。用户点开一个出厂关闭的包、重启、界面显示已启用，
 * 能力却一个都没有——这正是本仓反复踩的那一类「A 写、B 读、中间少根线」。
 *
 * ## 判据为什么必须用「核心链装载数」，不能用 `loaded`
 *
 * `loaded` 取自展示集合，坏掉的时候它**照样是 true**。实测反向验证：
 * 把 `enable` 换回 `enableList`，`ondra-live` 仍报 `loaded=true`，
 * 只有日志里的「核心链装载」停在 46 不动。所以判据只能取后者。
 *
 * ## 为什么比「差值」而不是比具体数字
 *
 * 包数会随版本变，46 / 47 这种数字写死在断言里，下次加插件就全红。
 * 这里只断言一件事：**多启用一个包，装载链就多装一个**。相等关系不会过期。
 *
 * ## 为什么选 `ondra-live`
 *
 * 它出厂关闭、不写用户数据、不占端口、不依赖模型——在临时数据目录里
 * 打开它没有副作用。换成任何写盘或联网的包，这一段都会变成一次真实运行。
 */
/*
 * 停用一个包（而不是启用一个）。
 *
 * ## 为什么参数从 `extra: ['ondra-live']` 改成 `disabled: ['ondra-live']`
 *
 * 出厂口径改成全量默认装载之后，「启用」这个动作在干净数据目录上是空操作
 * ——它本来就已经装了。唯一还能改变装载数的用户动作是**停用**。
 *
 * 而「停用是否真的生效」比「启用是否生效」更该被守住：用户点停用是明确
 * 表达"这个我不要"，若装载链没收到这个名单，界面说"已停用"而服务照跑，
 * 那就是最伤信任的一类谎。
 */
const e = await bootPlugins(['ondra-live'])
check('E 段停用项出现在清单里', rowOf(e.body, 'ondra-live') !== undefined)
check(
  'E 段停用项报 loaded=false（停用真的进了装载链）',
  rowOf(e.body, 'ondra-live')?.loaded === false,
  `loaded=${String(rowOf(e.body, 'ondra-live')?.loaded)}`,
)
check(
  'E 段默认启动真的读到了核心链装载数',
  typeof a.chainLoaded === 'number' && typeof e.chainLoaded === 'number',
  `默认=${String(a.chainLoaded)} / 启用后=${String(e.chainLoaded)}`,
)
check(
  'E 段停用一个包，装载链就少装一个（开关不是空响）',
  typeof a.chainLoaded === 'number'
    && typeof e.chainLoaded === 'number'
    && e.chainLoaded === a.chainLoaded - 1,
  `${String(a.chainLoaded)} → ${String(e.chainLoaded)}`,
)
/*
 * 反证：如果「展示集合」与「装载链」脱钩，上面那条会红，而这一条能直接
 * 指出是哪一边在骗人——两个数字摆在一起，不用再猜。
 */
check(
  'E 段展示数与装载链数只差常驻项',
  typeof e.chainLoaded === 'number' && e.body.totals.loaded === e.chainLoaded + RESIDENT.length,
  `展示=${String(e.body.totals.loaded)} / 链=${String(e.chainLoaded)} / 常驻=${String(RESIDENT.length)}`,
)

/* ---------------------------------------------------------------- *
 * F 段：每个插件的配置段都必须被认出
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== F 段 · 没有「未注册配置段」 ===')

/*
 * 这一段守的是「插件声明的段」与「设置页看见的段」是同一件事。
 *
 * 宿主的扫描器（`src/settings.ts` 的 `collectFields`）只认**导出了
 * `CONFIG_SECTION`** 的包；只有 `FIELD_SPECS` 的包被标成 `registered=false`，
 * 界面在它上面直接渲一行「未注册配置段，不参与四层合并」
 * （`src/components/ModuleLayer.tsx`）。那一行是用户能看见的告警。
 *
 * 2026-11-12 第 9 轮实测：64 个有 `settings.ts` 的包里，**只有
 * `ondra-memory-intake` 是这种形态**——记忆的入口恰好是唯一没接进
 * 配置层的那一个，而此前八轮都在核「停用段清单」，没人看这个数字。
 *
 * ## 为什么判据是「段清单」而不是 `totals.unregistered`
 *
 * 两个都读一遍：`totals.unregistered` 是宿主自己数的，段清单是逐段看的。
 * 只断言前者的话，宿主把它恒写成 0 也能过（本仓已经有过「判据量的是
 * 衍生物、不是本体」的先例）。所以先取逐段事实，再拿它跟总数对账。
 */
check('F 段读到了设置快照', a.settings !== undefined)
if (a.settings !== undefined) {
  const total = Array.isArray(a.settings.sections) ? a.settings.sections.length : 0
  const bad = (Array.isArray(a.settings.sections) ? a.settings.sections : [])
    .filter((section) => section.registered !== true)
    .map((section) => section.id)
  check('F 段扫描到了配置段', total > 0, `${String(total)} 段`)
  check(
    'F 段每一段都被认出（未注册 0 段）',
    bad.length === 0,
    bad.length === 0 ? `0 / ${String(total)}` : `${String(bad.length)} 段：${bad.join(', ')}`,
  )
  check(
    'F 段统计与逐段事实一致',
    a.settings.totals?.unregistered === bad.length,
    `${String(a.settings.totals?.unregistered)} / ${String(bad.length)}`,
  )
}

/* ---------------------------------------------------------------- *
 * 收尾
 * ---------------------------------------------------------------- */

for (const { child, dataDir } of hosts) {
  child.kill()
  /*
   * 必须**等进程真的退出**再删目录。
   *
   * 宿主退出前还在收尾（关库、flush 日志）。`kill()` 只是发信号，立刻 `rm`
   * 会撞上它正在写的文件并抛 `ENOTEMPTY`——清理阶段的异常会把已经全绿的
   * 断言结果盖成一次崩溃退出，读起来像被测能力坏了。`check-voice.mjs`
   * 第 5 轮正是这么崩过一次，这里照同一套口径来。
   */
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  try {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // 临时目录删不掉不是被测能力的失败：系统会自己清。
  }
}

/* ---------------------------------------------------------------- *
 * G 段：出厂关闭的包必须有开关，否则用户永远开不了
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== G 段 · 出厂关闭的包在设置页有开关 ===')

/*
 * 这一段守的是「两个开关」被接上的那根线。
 *
 * 一个包要真的跑起来，要过两道闸：
 *
 * | 闸 | 在哪 | 谁能开 |
 * | --- | --- | --- |
 * | 装载名单 | `enabledPlugins`（插件抽屉） | 用户点抽屉 |
 * | 插件自己的总开关 | `Config.enabled`（设置页） | **只有存在配置段才能点** |
 *
 * 只过第一道的样子：抽屉里显示「已启用 / loaded=true」，启动日志一句
 * `enabled=false（出厂默认）：……未注册`，**服务仍然没注册**。三个界面各说各话，
 * 没有一处报错。2026-11-12 第 10 轮实测：`ondra-memory-vector` 与
 * `ondra-store-json` 都是这个形状（两个包都没有 `settings.ts`），
 * 而宿主注释还写着「用户能在设置页看到这一段、能自己打开」。
 *
 * 判据只用「出厂默认是不是关」这一个事实：`FIELD_SPECS` 里 enable/enabled
 * 的 `default === false`，或（没有 settings 产物时）`DEFAULT_CONFIG` 里的
 * `enabled: false,` 字面量。**注释里的同类字样不算**——正则要求 `false` 后紧跟
 * 逗号，而注释里写的是 `enabled: false`，后面跟的是反引号或中文标点。
 */
const PLUGIN_DIR = join(ROOT, 'cordis-host', 'plugins')
const pluginDirs = readdirSync(PLUGIN_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('ondra-'))
  .map((entry) => entry.name)

const factoryOff = []
const offWithoutSwitch = []
for (const dir of pluginDirs) {
  const lib = join(PLUGIN_DIR, dir, 'lib')
  if (!existsSync(lib)) continue
  const settingsFile = join(lib, 'settings.js')
  let hasSection = false
  let off = false
  if (existsSync(settingsFile)) {
    const module = await import(pathToFileURL(settingsFile).href)
    hasSection = module.CONFIG_SECTION !== undefined
    for (const [key, spec] of Object.entries(module.FIELD_SPECS ?? {})) {
      if ((key === 'enabled' || key === 'enable') && spec !== null && typeof spec === 'object' && spec.default === false) {
        off = true
      }
    }
  }
  if (!off) {
    const indexFile = join(lib, 'index.js')
    if (existsSync(indexFile) && /enabled:\s*false,|enable:\s*false,/.test(readFileSync(indexFile, 'utf8'))) off = true
  }
  if (!off) continue
  factoryOff.push(dir)
  if (!hasSection) offWithoutSwitch.push(dir)
}

check(`有出厂关闭的包可核（${String(factoryOff.length)} 个）`, factoryOff.length > 0,
  '一个都没找到，说明扫错了目录')
check(
  '出厂关闭的包都有配置段（用户能自己打开）',
  offWithoutSwitch.length === 0,
  offWithoutSwitch.join(' / '),
)

/*
 * --- 默认装载：**磁盘上有的包，默认就要生效** ---
 *
 * ## 这条守的是产品口径，不是某个缺陷
 *
 * 出厂口径是「插件随包分发即默认生效」。此前启用判据是一份手写白名单
 * （`DEFAULT_CORE_ENABLE`），于是「新加一个包」多了一个必须记得的步骤，
 * 而忘记它的症状是：包进了产物、代码全对、服务没注册、`ctx.get` 恒
 * `undefined`、每一处消费方都写好了降级路径——**没有任何一处报错**。
 *
 * 本仓在这个形态上反复踩了八次。所以判据换成「目录里有没有」，
 * 这条断言把它钉住：只要 `cordis-host/plugins/ondra-*` 下有目录，
 * 宿主就必须把它算进启用名单。
 *
 * ## 判据为什么读源码而不是跑起来问接口
 *
 * 跑起来问 `GET /api/plugins` 要起一个宿主、等它 ready，几十秒；
 * 而这条断言的靶子是一个**静态事实**：`listInstalledPlugins()` 有没有
 * 被接进 `enableList`。读源码就够，而且失败时的报错能直接指出改哪一行。
 *
 * 但静态判据有个风险：它可能"看起来接上了而实际没生效"。所以这里
 * **两条一起查**：
 * 1. 源码里 `listInstalledPlugins` 的结果进了 `enableList`；
 * 2. 它扫描的正是 `plugins/ondra-*` 目录（不是别的目录）。
 *
 * 真正跑起来验证「78/78 装载」的那一条在 `check-e2e-stream` 的同类
 * 脚本里由实跑覆盖，不在这里重复起进程。
 */
const hostSource = readFileSync(join(ROOT, 'cordis-host', 'index.ts'), 'utf8')
{
  const wired = /enableListAll\s*=\s*\[\.\.\.new Set\(\[\.\.\.enableList,\s*\.\.\.discovered\]\)\]/.test(hostSource)
    && /const discovered = listInstalledPlugins\(\)/.test(hostSource)
  check(
    '默认启用名单包含"磁盘扫描"的结果（新加包无需改代码）',
    wired,
    wired ? 'enableListAll ← listInstalledPlugins()' : '未找到 enableListAll / discovered 的接线',
  )
}
{
  const usesAll = /\.\.\.enableListAll,/.test(hostSource)
  check(
    '启用名单的合成用的是全量那份（不是旧的 enableList）',
    usesAll,
    usesAll ? 'enabledPlugins ← enableListAll' : 'enabledPlugins 仍在用 enableList',
  )
}
{
  const filterOk = /startsWith\('ondra-'\)\s*&&\s*name\s*!==\s*'ondra-core'/.test(hostSource)
  check(
    '扫描函数读的是 plugins/ondra-*（与打包目录一致）',
    filterOk,
    filterOk ? "过滤 ondra-* 且排除 ondra-core" : 'listInstalledPlugins 的过滤条件与预期不符',
  )
}
/*
 * 读不到目录时降级而不是抛错。
 *
 * 这条是**可靠性**判据：打包后的布局若与开发态不同，扫描会失败。
 * 那时应当退回白名单（少装几个，功能缺），而不是让宿主起不来
 * （应用打不开）。两者的严重程度差一个量级。
 */
{
  const degrade = /catch[\s\S]{0,400}退回内置启用名单/.test(hostSource)
  check(
    '扫描失败时降级到白名单（不让应用起不来）',
    degrade,
    degrade ? 'catch → 退回白名单' : 'listInstalledPlugins 的 catch 分支没有降级说明',
  )
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const label of failures) console.log(`  ✗ ${label}`)
process.exit(1)
