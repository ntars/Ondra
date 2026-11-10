/**
 * 情绪链端到端实物核对：从「写一个读数」一路验到「话由里多一类由头」。
 *
 * ## 这个脚本要证明的四件事
 *
 * 情绪链在本仓已经躺了八轮（README 各写得很全、单测口径的纯逻辑复刻 42 例全过），
 * 但它是**最后一个没接上的话由源**。所以这里不验「代码写得对不对」，
 * 只验四件在运行期才看得见的事：
 *
 * 1. **表真的建出来了。** 不是 `available === true`——那个字段在纯内存态下
 *    照样为 true（`emotion-core` 刻意如此，见其 README 第 6 条取舍）。
 *    唯一能证明落盘的是 `stats().reason === undefined` 加上表真的存在。
 *    > 本轮就是在这里抓到真缺陷：`dynamic` 列的 `default: '[]'` 缺了单引号，
 *    > `ensureTable()` 抛错被吞成 `schema-failed`，插件一直跑在内存态。
 *
 * 2. **写进去的读数会真的改变六态。** `feel()` / `setAxis()` 全仓此前
 *    零调用方，所以「六态映射」这套东西从没被真实数据驱动过。
 *    这里直接写，验证 `stateOf()` 真的跟着动。
 *
 * 3. **六态能变成一条话由。** `sources.emotion === true` 只是「服务在位」，
 *    还要看到 `plan().candidates` 里真的出现 `kind === 'emotion'` 的候选。
 *
 * 4. **反例：平静不该产话由。** 否则每轮都有一条「她心情正常」的由头，
 *    冷却表会被无害条目占满，真正的承诺反而轮不上。
 *
 * 用法：node cordis-host/check-emotion.mjs
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
 * **`ondra-path-layout` 不能漏**：`ondra-store-sqlite` 的 `path` 默认为空，
 * 空时必须向路径服务要文件位置；拿不到就直接不注册服务。这条链第一次跑
 * 就是这样——服务全在、`available` 全 true、情绪恒基线，而 `store=none`
 * 是唯一线索（与 `check-gap.mjs` 同一个坑）。
 *
 * `ondra-proactive-reason` 必须在名单里：它才是「有没有话由」的判据所在。
 * `ondra-emotion-express` 只产六态，不产话由。
 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-emotion-core',
  'ondra-emotion-express',
  'ondra-proactive-reason',
]

// 每次跑之前先清空：判据里有「表从无到有」与「情绪从基线到偏离」，
// 库若沿用上一次的，起点就不是基线了。
const dataDir = new URL('../.shots/emotion-check/', import.meta.url).pathname
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

console.log('=== 情绪链端到端核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) {
  if (!NEEDED.includes(item.id)) continue
  console.log(`  ! 本链成员被跳过 ${item.id}：${item.reason}`)
}

const core = ctx.get('ondra-emotion-core')
const express = ctx.get('ondra-emotion-express')
const reason = ctx.get('ondra-proactive-reason')

console.log('\n--- 1. 三个服务是否都在 ---')
check('ondra-emotion-core 已注册', core !== undefined)
check('ondra-emotion-express 已注册', express !== undefined)
check('ondra-proactive-reason 已注册', reason !== undefined)

if (core === undefined || express === undefined || reason === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * ## 判据为什么是 `reason === undefined` 而不是 `available === true`
 *
 * `EmotionStats.available` 在内存态下也是 true——那是刻意的（情绪缺席会让
 * 9 个下游同时变盲，「有情绪但会丢」比「完全没情绪」好）。所以
 * `available === true` 证明不了落盘。`reason` 的三个取值分别是
 * `disabled` / `no-store` / `schema-failed`，为空才说明「存储真的就位了」。
 */
const coreStats = core.stats()
check('情绪内核没有降级（表建出来了）', coreStats.reason === undefined,
  `reason=${String(coreStats.reason)}`)

console.log('\n--- 2. 起点是出厂基线，六态判「平静」 ---')
/*
 * ## 为什么容差是 0.01 / 0.5 而不是 1e-9
 *
 * `state()` 是**惰性结算**：每次读都按闭式公式从上次结算点往前积分到「此刻」，
 * 而「此刻」是 `Date.now()`。所以哪怕刚 `setAxis` 完立刻读，值也会因为
 * 毫秒级的时间差而偏离目标一丁点（实测 `mood 0.8999999871`、`energy 89.9999985`）。
 *
 * 第一版这里写的是 `1e-9`，平时全绿，但在机器负载高、两条语句之间多耗几十毫秒时
 * 就会红——**时红时绿的断言比没有断言更糟**，因为人会开始忽略红色。
 * 容差取 0.01 / 0.5：既能吸收结算漂移，又足以抓住「读数根本没传过去」这类真缺陷
 * （那种情况偏差是 0.4 / 30 这个量级）。
 */
const before = express.stateOf()
check('起点 mood 为基线 0.5', Math.abs(before.mood - 0.5) < 1e-3, String(before.mood))
check('起点 energy 为基线 60', Math.abs(before.energy - 60) < 1e-2, String(before.energy))
check('起点六态为 calm', before.state === 'calm', before.state)
check('起点的数值来源是情绪服务（不是 baseline 兜底）', before.source === 'emotion', before.source)

console.log('\n--- 3. 写一个读数，六态必须真的跟着变 ---')
/*
 * 直接写 0.9 / 90：这是「雀跃」的判据（mood>0.7 且 energy>60）。
 *
 * 用 `setAxis` 而不是 `feel`：`feel` 的入参是**意图值**（-1–1），
 * 实际位移只有 `意图 × 0.12`——传 1.0 也只能把 mood 从 0.5 推到 0.62，
 * 到不了 0.7 的判据线。要走 `feel` 得连投十几次，而那考的是
 * 「12% 上限」这条规则，不是本脚本要验的传导链。
 * `setAxis` 的注释写明它是「剧本 / 调试 / 迁移用」——这正是它的场景。
 */
core.setAxis('mood', 0.9)
core.setAxis('energy', 90)
const peaked = express.stateOf()
check('写完之后六态变成 joyful', peaked.state === 'joyful', peaked.state)
check('六态报告命中了判据（不是空档兜底）', peaked.matched === true, String(peaked.matched))
check('读数确实传到了表达侧', Math.abs(peaked.mood - 0.9) < 0.01 && Math.abs(peaked.energy - 90) < 0.5,
  `mood ${String(peaked.mood)} / energy ${String(peaked.energy)}`)

console.log('\n--- 4. 三处出参出自同一次判定 ---')
/*
 * `profileOf()` 的存在理由就是这条：连调 `prompt()` / `rhythm()` / `tts()`
 * 会在毫秒之间各判一次，三段可能不同源。这里验三段都反映「雀跃」。
 */
const profile = express.profileOf()
check('profileOf 的 view 与 stateOf 同态', profile.view.state === peaked.state,
  `${profile.view.state} vs ${peaked.state}`)
check('雀跃的语速增量为 +10%', profile.tts.speechRateDelta === 0.1, String(profile.tts.speechRateDelta))
check('雀跃的主动额度 +1', profile.rhythm.proactiveQuotaDelta === 1, String(profile.rhythm.proactiveQuotaDelta))

console.log('\n--- 5. 六态真的变成了一条话由 ---')
const plan = reason.plan()
check('sources.emotion 为 true', plan.sources.emotion === true, String(plan.sources.emotion))
const emotionCandidates = plan.candidates.filter((item) => item.kind === 'emotion')
check('候选里出现了 emotion 类由头', emotionCandidates.length > 0, `${String(emotionCandidates.length)} 条`)
check('该由头的正文非空', (emotionCandidates[0]?.text ?? '').trim() !== '', emotionCandidates[0]?.text)
check('该由头的来源指向情绪表达', emotionCandidates[0]?.source === 'ondra-emotion-express',
  emotionCandidates[0]?.source)
/*
 * ## 为什么必须验正文是「雀跃那一句」，而不是只验「正文非空」
 *
 * 第一版这里只断言了非空与来源字段，结果做反向验证时发现：
 * 把 `EMOTION_SEEDS.joyful` 整行删掉，**脚本照样全绿**。
 *
 * 原因在 `collect.ts` 的退路：种子表查不到那个态时，只要不是
 * `calm` / `soft`，就会降级成一条通用文案「心里有点动静，想跟你说一声」。
 * 那条文案非空、来源字段也对，于是「种子表被删空」这种真缺陷
 * 从断言里溜了过去。**测不出缺陷的断言等于没有断言**（本仓第 N 次同类）。
 *
 * 现在钉的是档位专属那一句：`joyful` 的种子文本。
 * 它一被删或一被改错，这里立刻红。
 */
check('该由头的正文是「雀跃」档位专属的那一句（不是通用兜底）',
  emotionCandidates[0]?.text === '心情挺好的，想说给你听',
  emotionCandidates[0]?.text)

console.log('\n--- 6. 反例：平静不该产话由 ---')
/*
 * 这条是「有输出」与「输出正常」的分界。
 *
 * `EMOTION_SEEDS` 只给了四个偏离态（bristled / wilted / joyful / sleepy），
 * `calm` 与 `soft` 刻意没有——否则每轮都有一条「她心情正常」的由头，
 * 冷却表被无害条目占满，真正到期的承诺反而轮不上。
 */
core.setAxis('mood', 0.5)
core.setAxis('energy', 60)
const calmView = express.stateOf()
check('写回基线后六态回到 calm', calmView.state === 'calm', calmView.state)
const calmPlan = reason.plan()
const calmEmotion = calmPlan.candidates.filter((item) => item.kind === 'emotion')
check('平静时不产 emotion 由头', calmEmotion.length === 0, `${String(calmEmotion.length)} 条`)

console.log('\n--- 7. 落盘：表真的在库里，且情绪能读回来 ---')
/*
 * `stats().reason` 为空只说明 `ensureTable()` 没抛。这张表是不是真在库里、
 * 写进去的行是不是真能读回来，要分开验——`upsert` 失败会被
 * `StateStore.save()` 吞成一条 warn（返回 false）。
 */
const store = ctx.get('ondra-store-sqlite')
check('存储端口在位', store !== undefined)
check('emotion_state 表已建出', store?.tableExists?.('emotion_state') === true,
  String(store?.tableExists?.('emotion_state')))

const saved = core.save()
check('存档写入成功', saved === true, String(saved))
const persistedRow = store?.select?.('emotion_state', { limit: 1 }) ?? []
check('存档表里有一行', persistedRow.length === 1, `${String(persistedRow.length)} 行`)

console.log('\n--- 8. 六态与世界状态的隔离 ---')
/*
 * `express` 不持有情绪（只 `state()` 读），所以 `enable=false` 时它应当
 * 一律按平静出档，而 `core` 的真实读数不受影响。这条保证「关掉六态映射」
 * 与「关掉情绪」是两件事——否则用户关前者会把后者的数据一起清掉。
 */
check('表达侧的结构对位里没有写接口', typeof express.setAxis === 'undefined' && typeof express.feel === 'undefined',
  `setAxis=${typeof express.setAxis} / feel=${typeof express.feel}`)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
