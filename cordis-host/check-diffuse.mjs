/**
 * 跨会话情绪弥散的实物核对。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ```
 * 上一场会话结束时心情被压到 0.2
 *   → 隔了 31 分钟（超过 minGapMinutes）再开一轮
 *   → ondra-emotion-diffuse 判 diffused
 *   → 宿主 src/diffuse.ts 把 target 写回情绪内核
 *   → 心情从 0.2 抬到 0.32（保留 0.4 的残差）
 * ```
 *
 * ## 为什么必须验「写回去」这一步
 *
 * 插件的全套代码从公式到标记表都写完了，README 里有参数总表、有四个边界
 * 情形的算例。**唯一缺的是调用方**：`claim()` 全仓零调用方、
 * `ondra-emotion-diffuse` 不在默认启用名单里。于是插件自己的 `stats()` 会说
 * 「我是好的」——它确实好，只是没人问过它。
 *
 * 所以这里的断言分三层，缺一层就查不出「少根线」：
 *
 * | 层 | 断言什么 | 只验这一层会漏什么 |
 * | --- | --- | --- |
 * | 插件 | `claim()` 的状态码与算术对不对 | 没人调用它 |
 * | 宿主 | `diffuseAcrossSessions()` 真的写了 `setAxis` | 宿主没被推理路由调用 |
 * | 落盘 | `emotion_state` 里那一行真的变了 | 写完没存，重启即丢 |
 *
 * 用法：node cordis-host/check-diffuse.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { boundaryKeyOf, diffuseAcrossSessions } from './lib/src/diffuse.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

/*
 * 只装这条链需要的成员。
 *
 * **`ondra-path-layout` 不能漏**（本仓第六次记这一条）：`ondra-store-sqlite`
 * 的 `path` 默认为空，空时必须向路径服务要位置；拿不到就**直接不注册服务**，
 * 于是情绪内核静默退回内存态，`emotion_state` 表根本不存在，
 * 而 `available` 仍是 true。
 *
 * **刻意不装 `ondra-memory-intake`**：弥散与「这一轮说了什么」无关，
 * 它只看会话边界与时间差。带上 intake 会让本脚本多依赖三个无关成员，
 * 而它们任何一个出问题都会让整条链看起来「弥散坏了」。
 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-emotion-core',
  'ondra-emotion-express',
  'ondra-emotion-diffuse',
]

/*
 * 每次跑之前清空。判据全是「从 A 变 B」，库若沿用上一次的，
 * 起点就不是基线了——**一个只在第一次能过的检查脚本等于没有检查脚本**。
 */
const dataDir = new URL('../.shots/diffuse-check/', import.meta.url).pathname
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

console.log('=== 跨会话情绪弥散核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) {
  if (!NEEDED.includes(item.id)) continue
  console.log(`  ! 本链成员被跳过 ${item.id}：${item.reason}`)
}

const emotion = ctx.get('ondra-emotion-core')
const express = ctx.get('ondra-emotion-express')
const diffuse = ctx.get('ondra-emotion-diffuse')
const store = ctx.get('ondra-store-sqlite')

console.log('\n--- 1. 四个服务是否都在 ---')
check('ondra-emotion-core 已注册', emotion !== undefined)
check('ondra-emotion-express 已注册', express !== undefined)
check('ondra-emotion-diffuse 已注册', diffuse !== undefined)
check('存储端口在位', store !== undefined)

if (emotion === undefined || diffuse === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * ## 为什么判据是 `reason === undefined` 而不是 `available === true`
 *
 * 情绪内核在内存态下 `available` 照样 true（刻意如此：「有情绪但会丢」
 * 优于「完全没情绪」）。所以 `available` 证明不了落盘。`reason` 的三个
 * 取值是 `disabled` / `no-store` / `schema-failed`，为空才说明存储真就位。
 */
check('情绪内核没有降级（表建出来了）', emotion.stats().reason === undefined,
  `reason=${String(emotion.stats().reason)}`)
check('弥散服务没有降级', diffuse.stats().reason === undefined,
  `reason=${String(diffuse.stats().reason)}`)
check('弥散标记表已建出', store?.tableExists?.('emotion_diffuse_mark') === true,
  String(store?.tableExists?.('emotion_diffuse_mark')))

console.log('\n--- 2. 起点：基线心情，标记表空 ---')
const baseline = emotion.state()
check('起点 mood 为基线 0.5', Math.abs(baseline.axes.mood - 0.5) < 1e-3, String(baseline.axes.mood))
check('起点六态为 calm（express 在读情绪内核）', express?.stateOf().state === 'calm',
  String(express?.stateOf().state))
check('标记表里还没有行', (store?.count?.('emotion_diffuse_mark') ?? 0) === 0,
  `${String(store?.count?.('emotion_diffuse_mark') ?? 0)} 行`)

console.log('\n--- 3. 心情先被压到 0.2（模拟「上一场结束时不太好受」）---')
/*
 * 用 `setAxis` 而不是 `feel()`：`feel()` 有 0.12 的单条上限，要把心情从
 * 0.5 压到 0.2 得连投三次以上，而每投一次都会改张力、标签、激素——
 * 那些都不该参与弥散的验算。`setAxis` 的注释写明它是「剧本 / 调试 /
 * 迁移用」，检查脚本正是这个场景（`check-emotion.mjs` 同款用法）。
 */
const LOW = 0.2
emotion.setAxis('mood', LOW)
emotion.save()
const before = emotion.state()
check('心情已落到 0.2', Math.abs(before.axes.mood - LOW) < 1e-3, String(before.axes.mood))

console.log('\n--- 4. 插件层的算术：0.2 → 0.38 ---')
/*
 * `familiarity` 缺省 0（出厂值，master-plan §9.1），于是
 * `retain = 0.4 × (1 − 0 × 0.5) = 0.4`，
 * `target = 0.5 + (0.2 − 0.5) × 0.4 = 0.38`……
 *
 * 等一下：`0.5 + (−0.3) × 0.4 = 0.5 − 0.12 = 0.38`。是 0.38，不是 0.32。
 * 这条推导要写在断言旁边：数字算错是本仓反复踩的那类「红的是断言」。
 * `|delta| = 0.12`，小于文档里说的上限 0.30。
 */
const preview = diffuse.preview()
check('preview 的 retain 为 0.4（熟悉度 0）', Math.abs(preview.retain - 0.4) < 1e-6,
  String(preview.retain))
check('preview 的 target 为 0.38', Math.abs(preview.target - 0.38) < 1e-6,
  String(preview.target))

console.log('\n--- 5. 宿主的接线：真的写回去了 ---')
/*
 * 这一条是本脚本的核心。它调的是**宿主自己的函数**（`src/diffuse.ts`），
 * 不是插件——插件算得再对，这一层不调它，心情一样不动。
 *
 * 时刻钉在「现在」，边界键用宿主同一套生成规则。第一次调用应当是
 * `diffused`：标记表还是空的，没有上一次，间隔闸无从触发。
 */
const key1 = boundaryKeyOf('diffuse-check-session', 1)
const outcome1 = diffuseAcrossSessions(ctx, key1)
check('宿主真的写了心情（written=true）', outcome1.written === true,
  `${outcome1.status}：${outcome1.note}`)
check('写回后的心情是 0.38（插件算的 target）',
  Math.abs(outcome1.moodAfter - 0.38) < 1e-6, String(outcome1.moodAfter))

/*
 * 再从**上游自己的视图**读一次。只用 `outcome1.moodAfter` 是不够的：
 * 那是函数自己返回的值，它完全可能在没调 `setAxis` 的情况下把
 * `plan.target` 原样回传（本仓在情绪那一轮踩过同一类：`source === 'emotion'`
 * 只证明服务在位，不证明值变了）。
 */
const afterWrite = emotion.state()
check('情绪内核里的心情真的是 0.38', Math.abs(afterWrite.axes.mood - 0.38) < 1e-6,
  String(afterWrite.axes.mood))

console.log('\n--- 6. 幂等与间隔：同一个键第二次不重复衰减 ---')
/*
 * 两道闸都必须验。只验幂等会让「间隔闸被删掉」照样全绿：
 * 同一个键本来就命中幂等，轮不到间隔闸出手。
 */
const outcomeRepeat = diffuseAcrossSessions(ctx, key1)
check('同一个边界键第二次是 already', outcomeRepeat.status === 'already',
  outcomeRepeat.status)
check('第二次没有写（written=false）', outcomeRepeat.written === false, String(outcomeRepeat.written))
const afterRepeat = emotion.state()
check('心情没有再被衰减（仍是 0.38）',
  Math.abs(afterRepeat.axes.mood - 0.38) < 1e-6, String(afterRepeat.axes.mood))

console.log('\n--- 7. 隔了 31 分钟：新键才真的弥散 ---')
/*
 * 换一个边界键（模拟「隔了半小时后的另一轮」），时刻往后推 31 分钟。
 * 31 > 默认 `minGapMinutes` 30，所以间隔闸放行。
 *
 * ## 为什么必须传 `at` 而不真等
 *
 * 真等 31 分钟不行；而把 `minGapMinutes` 改成 0 会让「出厂默认是多少」
 * 从代码里消失——那是检查脚本最不该做的妥协。
 */
const laterAt = Date.now() + 31 * 60_000
const key2 = boundaryKeyOf('diffuse-check-session', 2)
const outcome2 = diffuseAcrossSessions(ctx, key2, laterAt)
check('隔 31 分钟后真弥散了', outcome2.status === 'diffused',
  `${outcome2.status}：${outcome2.note}`)
/*
 * ## 为什么这里不能写死 0.452
 *
 * 第一版写的是「0.38 → 0.452」（`0.5 + (0.38 − 0.5) × 0.4`），实测 0.4548，
 * 四条断言同时红。**红的是断言**：`mood` 有 6 小时半衰，而这一轮的时刻
 * 被推后了 31 分钟——在这 31 分钟里心情已经从 0.38 自己往基线走了
 * 一小段（0.38 → 约 0.387），弥散是对**那个值**乘 0.4。
 *
 * 这正是本仓第五次踩的同一类：把「引擎算出来的中间量」当常数写进断言。
 * 改法是钉**关系**而不是钉绝对值：
 *
 * | 关系 | 说明 |
 * | --- | --- |
 * | 目标在起点与基线之间 | 弥散是往基线靠，不是越过它 |
 * | 残差缩到四成 | `(target − 0.5) / (moodBefore − 0.5) ≈ 0.4` |
 * | 比上一轮更靠近基线 | 每次只带走四成，所以越走越近、永不越过 |
 *
 * 这三条换成任何一组具体数字都成立，而「算错了」会同时违反它们。
 */
check('第二轮目标落在起点与基线之间',
  outcome2.moodAfter > outcome2.moodBefore && outcome2.moodAfter < 0.5,
  `${String(outcome2.moodBefore)} → ${String(outcome2.moodAfter)}`)
const residualRatio = (outcome2.moodAfter - 0.5) / (outcome2.moodBefore - 0.5)
check('残差缩到四成（retain = 0.4）', Math.abs(residualRatio - 0.4) < 1e-3,
  String(residualRatio))
check('比上一轮更靠近基线（不是越走越远）',
  Math.abs(outcome2.moodAfter - 0.5) < Math.abs(outcome1.moodAfter - 0.5),
  `${String(outcome1.moodAfter)} → ${String(outcome2.moodAfter)}`)

console.log('\n--- 8. 间隔不足：新键也不弥散 ---')
/*
 * 这是第 6 条验不到的那一半。新键 + 同一时刻 → 只能被间隔闸拦下。
 * 缺这一条时，把 `minGapMinutes` 那道闸整个删掉，前面全部照样绿。
 */
const key3 = boundaryKeyOf('diffuse-check-session', 3)
const outcome3 = diffuseAcrossSessions(ctx, key3, laterAt + 5 * 60_000)
check('隔 5 分钟判成 no-gap', outcome3.status === 'no-gap', outcome3.status)
check('no-gap 时不写（written=false）', outcome3.written === false, String(outcome3.written))

console.log('\n--- 9. 落盘：重启后心情不回到 0.2 ---')
/*
 * 弥散写完立刻 `save()`。不落盘的后果很具体：写完心情、应用被关掉，
 * 重启后心情回到上一次存档的值（0.2），弥散白算一遍。
 *
 * 断言读的是**库里的那一行**，不是内存里的 `state()`——后者在没存档时
 * 照样是新值，分不开「存了」与「没存」。
 */
check('emotion_state 里有行', (store?.count?.('emotion_state') ?? 0) >= 1,
  `${String(store?.count?.('emotion_state') ?? 0)} 行`)
const persisted = store?.select?.('emotion_state', { limit: 1 })?.[0]
let persistedMood
try {
  const axes = JSON.parse(String(persisted?.axes ?? '{}'))
  persistedMood = axes.mood
} catch {
  persistedMood = undefined
}
/*
 * 钉的是「存档等于内存」而不是某个具体数字：`save()` 的职责是把当前值
 * 写下去，而不是算出某个值。写死数字会让这条断言在「行情变了」时误红，
 * 而它真正要抓的缺陷是「算了没存」——那表现为存档停在 0.2（上一轮的值）。
 */
check('存档里的 mood 等于内存里的值（不是停在 0.2）',
  typeof persistedMood === 'number'
  && Math.abs(persistedMood - outcome2.moodAfter) < 1e-3
  && Math.abs(persistedMood - 0.2) > 0.1,
  String(persistedMood))

console.log('\n--- 10. 标记表：只留一行，且记着最后一次 ---')
/*
 * 单行 upsert 而不是流水表：第二次保存时主键已存在。条数多了说明
 * upsert 退化成 insert，那会让 `load()` 读到哪一行变成不确定的。
 */
check('标记表恰好一行', (store?.count?.('emotion_diffuse_mark') ?? 0) === 1,
  `${String(store?.count?.('emotion_diffuse_mark') ?? 0)} 行`)
const mark = store?.select?.('emotion_diffuse_mark', { limit: 1 })?.[0]
check('标记记的是最后一次的边界键', String(mark?.boundary_key ?? '') === key2,
  String(mark?.boundary_key ?? ''))
check('标记里的目标心情等于写回值',
  typeof mark?.target === 'number' && Math.abs(mark.target - outcome2.moodAfter) < 1e-3,
  String(mark?.target))

console.log('\n--- 11. 统计：四种「没弥散」分得开 ---')
/*
 * 四个计数器是这条链唯一的可观测面。它们全都表现为「心情不动」，
 * 只看 `available` 一律显示「我是好的」——本仓已因这一点白查四轮。
 */
const stats = diffuse.stats()
check('claims 记到了 2 次真弥散', stats.counters.claims === 2, String(stats.counters.claims))
check('duplicates 记到了 1 次同键重复', stats.counters.duplicates === 1,
  String(stats.counters.duplicates))
check('tooSoon 记到了 1 次间隔不足', stats.counters.tooSoon === 1,
  String(stats.counters.tooSoon))
check('noEmotion 为 0（情绪内核一直在）', stats.counters.noEmotion === 0,
  String(stats.counters.noEmotion))
check('存储后端不是 none（标记落盘了）', stats.storeProvider !== 'none',
  String(stats.storeProvider))

console.log('\n--- 12. 六态跟着变（不是只有数字动了）---')
/*
 * 前十一条验的是数值。这一条验「她能被说出来是什么状态」——
 * 若六态读的是别的源（比如永远读基线），上面全绿而她照样永远平静。
 *
 * 钉的是**六态与情绪内核一致**，而不是钉某个具体态值：具体阈值归
 * O-031 的阈值表，那是另一份会漂的真源，不该在检查脚本里抄一遍。
 * 两次读之间 `mood` 会随时间微动（6 小时半衰），所以比的是「两条
 * 读数的差」而不是绝对值——差值只可能来自读到了不同的源。
 */
const view = express?.stateOf()
const core = emotion.state()
check('六态读到了非基线的值', typeof view?.mood === 'number',
  String(view?.mood))
check('六态的 mood 与情绪内核读的是同一个源',
  Math.abs((view?.mood ?? -1) - core.axes.mood) < 1e-3,
  `express=${String(view?.mood)} core=${String(core.axes.mood)}`)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
