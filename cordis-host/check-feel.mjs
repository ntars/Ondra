/**
 * 情绪写入链的端到端实物核对。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ```
 * 用户说「对不起，刚才是我错了」
 *   → ondra-memory-intake 收到这一轮        （早已通）
 *   → 认出这是一个「道歉」信号               ← 本轮新增
 *   → 调 ondra-emotion-core 的 comfort()     ← 此前全仓零调用方
 *   → 六态从「平静」变成别的态
 *   → emotion_state 表里有那一行             ← 从建库起一直是 0 行
 * ```
 *
 * ## 为什么必须端到端，不能只测 `feel.ts` 的纯函数
 *
 * `feel.ts` 的判定逻辑是纯的，测它很容易全绿——而它全绿的时候，
 * 完全可能**没有任何人调它**。本仓在这件事上已经踩过四轮：
 *
 * | 轮次 | 症状 | 真因 |
 * | --- | --- | --- |
 * | 二十 | 六张表全 0 行 | `session/event` 只有订阅方 |
 * | 二十一 | `memory_fact` 0 行 | 五个环节同时静默降级 |
 * | 十六 | 待办表全空 | `detect()` 零调用方 |
 * | 十七 | 执念池全空 | 六个接口零调用方 |
 *
 * 所以这里的断言全部**从最外层打进去**（`intake.ingest()`），再读
 * **上游自己的视图**（`emotion.state()` / `store.select()`），
 * 任何一层用自己的 `stats()` 自证都只会说「我是好的」。
 *
 * ## 为什么伪造不了「她答不上来」
 *
 * `stumble` 信号不看文本情绪，只看 `ondra-drive-gap` 的 `detect()` 有没有命中。
 * 所以这里给它一句真会让上游命中的话（「这个我也不太确定」），
 * 而不是在测试里自己造一个 boolean——那测的是测试自己。
 *
 * 用法：node cordis-host/check-feel.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

/*
 * 只装这条链需要的成员。
 *
 * **`ondra-path-layout` 不能漏**（本仓第五次记这一条）：`ondra-store-sqlite`
 * 的 `path` 默认为空，空时必须向路径服务要位置；拿不到就**直接不注册服务**，
 * 于是情绪内核静默退回内存态，`emotion_state` 表根本不存在，
 * 而 `available` 仍是 true。
 *
 * **`ondra-drive-gap` 必须在**：`stumble` 信号的唯一准入判据就是它的
 * `detect()`。缺它的话 `gapDetected` 恒 0，`stumble` 永远不发——
 * 而这不是缺陷（上游缺席时的正确降级），只是本脚本验不到那一支。
 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-memory-core',
  'ondra-memory-prospective',
  'ondra-memory-intake',
  'ondra-drive-gap',
  'ondra-emotion-core',
  'ondra-emotion-express',
]

/*
 * 每次跑之前清空。
 *
 * 判据里全是「从 X 变 Y」：情绪从基线到偏离、表从无到有、存档从 0 行到 1 行。
 * 库若沿用上一次的，起点就不是基线了——**一个只在第一次能过的检查脚本
 * 等于没有检查脚本**（第二次就红，而人会把红当噪音）。
 */
const dataDir = new URL('../.shots/feel-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

const result = await loadCore(ctx, {
  enable: NEEDED,
  configs: { 'ondra-path-layout': { root: dataDir } },
})

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

console.log('=== 情绪写入链端到端核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) {
  if (!NEEDED.includes(item.id)) continue
  console.log(`  ! 本链成员被跳过 ${item.id}：${item.reason}`)
}

const emotion = ctx.get('ondra-emotion-core')
const express = ctx.get('ondra-emotion-express')
const intake = ctx.get('ondra-memory-intake')
const gap = ctx.get('ondra-drive-gap')
const store = ctx.get('ondra-store-sqlite')

console.log('\n--- 1. 四个服务是否都在 ---')
check('ondra-emotion-core 已注册', emotion !== undefined)
check('ondra-emotion-express 已注册', express !== undefined)
check('ondra-memory-intake 已注册', intake !== undefined)
check('ondra-drive-gap 已注册', gap !== undefined)
check('存储端口在位', store !== undefined)

if (emotion === undefined || express === undefined || intake === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * ## 为什么判据是 `reason === undefined` 而不是 `available === true`
 *
 * 情绪内核在内存态下 `available` 照样为 true（刻意如此：「有情绪但会丢」
 * 优于「完全没情绪」）。所以 `available` 证明不了落盘。`reason` 的三个取值
 * 是 `disabled` / `no-store` / `schema-failed`，为空才说明存储真的就位。
 */
check('情绪内核没有降级（表建出来了）', emotion.stats().reason === undefined,
  `reason=${String(emotion.stats().reason)}`)
check('emotion_state 表已建出', store?.tableExists?.('emotion_state') === true,
  String(store?.tableExists?.('emotion_state')))

console.log('\n--- 2. 起点：基线，六态「平静」，存档表空 ---')
const baseline = emotion.state()
check('起点 mood 为基线 0.5', Math.abs(baseline.axes.mood - 0.5) < 1e-3, String(baseline.axes.mood))
check('起点 tension 为基线 0', Math.abs(baseline.axes.tension) < 1e-3, String(baseline.axes.tension))
check('起点六态为 calm', express.stateOf().state === 'calm', express.stateOf().state)
check('emotion_state 里还没有行', (store?.count?.('emotion_state') ?? 0) === 0,
  `${String(store?.count?.('emotion_state') ?? 0)} 行`)

console.log('\n--- 3. 道歉：从「她答不上来」到张力上涨 ---')
/*
 * ## 为什么这一支用「她答不上来」而不是「用户说对不起」
 *
 * 两支都能验 `feel()`，但 `stumble` 多了**一层真实的上游判据**
 * （`gap.detect()`）：它证明的不是「`feel.ts` 会算」，而是
 * 「intake → gap.detect → 信号 → emotion.feel」这条四段链真的通。
 * 把最容易断的那一段先验掉。
 */
const stubTurn = {
  turnId: 'feel-check-stumble',
  at: Date.now(),
  lines: [
    { role: 'user', text: '这个接口的签名是怎么写的？' },
    { role: 'assistant', text: '这个我也不太确定，得回头看下文档。' },
  ],
}
await intake.ingest(stubTurn)

const afterStumble = emotion.state()
check('张力涨了（stumble 真的投到了情绪内核）',
  afterStumble.axes.tension > baseline.axes.tension + 0.01,
  `${String(baseline.axes.tension)} → ${String(afterStumble.axes.tension)}`)
check('委屈标签出现（不是零变化）',
  (afterStumble.labels.hurt ?? 0) > 0,
  String(afterStumble.labels.hurt))
check('心情被压下去了',
  afterStumble.axes.mood < baseline.axes.mood,
  `${String(baseline.axes.mood)} → ${String(afterStumble.axes.mood)}`)
check('intake 的 stats.felt 记到了这一笔', intake.stats().felt >= 1,
  `${String(intake.stats().felt)} 次`)
/*
 * 位移量必须**小**：手册 §3.2 的单条上限是 0.12，而 `SIGNAL_SHIFT.stumble.tension`
 * 写的是 0.6（意图值），落到轴上 = 0.6 × 0.12 = 0.072。
 * 这条断言钉的是「上限真的被上游执行了」——写 0.6 就该只有 0.072，
 * 而不是 0.6。若哪天有人在调用方自己乘一遍，这里会红。
 */
check('位移遵守 0.12 单条上限（0.6 意图值 → 约 0.072）',
  afterStumble.axes.tension < 0.12,
  String(afterStumble.axes.tension))

console.log('\n--- 4. 道歉：comfort() 而不是 feel() ---')
/*
 * 道歉走 `comfort()`，位移由**上游**的 0.08 算，本插件不重写那个数。
 *
 * ## 为什么必须先把张力抬到 0.5 再验
 *
 * 上一条留下的张力只有 0.072，减去 0.08 会被夹到 0——于是「降了」与
 * 「清零了」两种实现给出同一个读数，**这条断言分不开它们**。
 * 第一版就是这样，红的是断言不是产品。
 *
 * 抬高起点后，`comfort()` 的正确结果是 0.5 → 0.42：既降了、又没清零。
 * 这才是手册 §3.2「只降 0.08，保留一点嘴硬」的可分辨形态。
 * 用 `setAxis` 而不是连投十次 `stumble`：它的注释写明是「剧本 / 调试 /
 * 迁移用」，检查脚本正是这个场景（`check-emotion.mjs` 同款用法）。
 */
emotion.setAxis('tension', 0.5)
const beforeComfort = emotion.state()
await intake.ingest({
  turnId: 'feel-check-apology',
  at: Date.now(),
  lines: [
    { role: 'user', text: '对不起，刚才是我错了。' },
    { role: 'assistant', text: '没关系，我知道你不是故意的。' },
  ],
})
const afterComfort = emotion.state()
const tensionDrop = beforeComfort.axes.tension - afterComfort.axes.tension
check('张力降了（走的是 comfort，不是 feel）',
  tensionDrop > 0,
  `${String(beforeComfort.axes.tension)} → ${String(afterComfort.axes.tension)}`)
check('降幅恰好是 0.08（上游口径，不是调用方自己算的）',
  Math.abs(tensionDrop - 0.08) < 1e-3,
  String(tensionDrop))
check('没有清零（保留嘴硬）', afterComfort.axes.tension > 0.4,
  String(afterComfort.axes.tension))
check('愉悦度也回升了 0.08',
  Math.abs((afterComfort.axes.pleasure - beforeComfort.axes.pleasure) - 0.08) < 1e-3,
  String(afterComfort.axes.pleasure - beforeComfort.axes.pleasure))

console.log('\n--- 5. 久别：距上一轮超过 30 分钟，唤醒上升 ---')
/*
 * `reunion` 是唯一纯时间差的信号。用 `ingest()` 的第二参数直接给毫秒差，
 * 不靠真实等待——真等 30 分钟不行，而把 `REUNION_MINUTES` 改成可注入
 * 会让「出厂默认是多少」从代码里消失。
 */
const beforeReunion = emotion.state()
await intake.ingest({
  turnId: 'feel-check-reunion',
  at: Date.now(),
  lines: [
    { role: 'user', text: '我回来了。' },
    { role: 'assistant', text: '欢迎回来。' },
  ],
}, 31 * 60_000)
const afterReunion = emotion.state()
check('唤醒度升了（久别重逢）', afterReunion.axes.arousal > beforeReunion.axes.arousal,
  `${String(beforeReunion.axes.arousal)} → ${String(afterReunion.axes.arousal)}`)

console.log('\n--- 6. 反例：一句平常的话不该动情绪 ---')
/*
 * 这条是「有输出」与「输出正常」的分界。
 *
 * 若每条轮次都投一次（比如把「有对话」当成情绪事件），她会在几句寒暄里
 * 被推到某个极端态，而每一步单看都「说得过去」。所以必须有一条
 * **零变化**的断言，且它要落在真的什么都没发生的轮次上。
 */
const beforeQuiet = emotion.state()
await intake.ingest({
  turnId: 'feel-check-quiet',
  at: Date.now(),
  lines: [
    { role: 'user', text: '今天天气还行。' },
    { role: 'assistant', text: '嗯，风不大。' },
  ],
})
const afterQuiet = emotion.state()
check('平常轮次一字不动（mood 不变）',
  Math.abs(afterQuiet.axes.mood - beforeQuiet.axes.mood) < 1e-3,
  `${String(beforeQuiet.axes.mood)} → ${String(afterQuiet.axes.mood)}`)
check('平常轮次一字不动（tension 不变）',
  Math.abs(afterQuiet.axes.tension - beforeQuiet.axes.tension) < 1e-3,
  `${String(beforeQuiet.axes.tension)} → ${String(afterQuiet.axes.tension)}`)

console.log('\n--- 7. 落盘：emotion_state 里真的有一行 ---')
/*
 * `saveEmotion()` 只在**真投出去过**的轮次调。前面几条已经投过，
 * 所以这里应当有行。断言「>= 1」而不是「== 1」：表是单行 upsert，
 * 条数多了说明 upsert 退化成 insert，那也是缺陷，但先抓「有没有」。
 */
check('emotion_state 里有行', (store?.count?.('emotion_state') ?? 0) >= 1,
  `${String(store?.count?.('emotion_state') ?? 0)} 行`)
const persisted = store?.select?.('emotion_state', { limit: 1 })?.[0]
check('存档里带六维', typeof persisted?.axes === 'string' && persisted.axes.includes('pleasure'),
  typeof persisted?.axes === 'string' ? persisted.axes.slice(0, 24) : typeof persisted?.axes)

console.log('\n--- 8. 六态真的跟着变了（不是永远平静）---')
/*
 * 前七条验的是「值动了」，这条验的是「动到能被她自己说出来」。
 * 若六态映射读的是别的源（比如永远读基线），上面的断言全绿而
 * 她照样永远平静——那是本仓最熟悉的那种「A 写、B 读、中间少根线」。
 */
const view = express.stateOf()
/*
 * ## 为什么不能写成 `state !== 'calm' || source === 'emotion'`
 *
 * 第一版就是那样写的，做反向验证时发现：把 `feelOnce` 换成空实现、
 * 情绪一字不动，这条**照样打勾**——因为 `source === 'emotion'` 只证明
 * 「服务在位」，不证明「值真的变了」。六态读到基线时 `source` 依然是
 * `emotion`（那是「数值来自情绪服务」的意思，不是「数值偏离了基线」）。
 *
 * 现在钉的是**偏离本身**：张力不为零（第 3 条投进去的还没散），
 * 六态因此不该是「平静」。
 */
check('情绪确实偏离了基线（张力不为 0）', view.tension > 0.01, String(view.tension))
check('六态不再是 calm', view.state !== 'calm', view.state)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
