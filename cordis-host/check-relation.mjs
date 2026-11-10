/**
 * 关系域的实物核对：熟悉度到底会不会动。
 *
 * ## 这个脚本要证明的事
 *
 * ```
 * 宿主在「用户真说了一句话」的轮次调 recordTurn()
 *   → 插件 touch() 把 interactions +1
 *   → observe() 按四闸判一次升阶
 *   → familiarity = min(1, interactions / 5000) 真的离开 0
 *   → 弥散的 claim() 收到的是这个值，不是 undefined
 * ```
 *
 * ## 为什么必须验到底
 *
 * `familiarity` 恒 0 有三层独立原因，每一层都不报错，因为 **0 是「陌生人」
 * 这个合法取值**：
 *
 * | 层 | 缺什么 | 症状 |
 * | --- | --- | --- |
 * | 1 | `ondra-emotion-stage` 不在默认名单 | 服务没注册，`ctx.get` 恒 undefined |
 * | 2 | `touch()` / `observe()` 零调用方 | `interactions` 恒 0 |
 * | 3 | `diffuse.ts` 调 `claim()` 没传 familiarity | 公式里 `(1 − f × 0.5)` 恒等于 1 |
 *
 * 只验其中一层，另外两层照样把它按回 0，而全部断言仍然可能绿——
 * 这正是本仓反复踩的「A 写、B 读、中间少根线」。
 *
 * 所以断言分四层：
 *
 * | 层 | 断言什么 | 只验这层会漏什么 |
 * | --- | --- | --- |
 * | 插件算术 | `familiarityOf()` 的公式对不对 | 没人调它 |
 * | 插件写入 | `touch()` 真的把 `interactions` 推上去并落盘 | 宿主没调它 |
 * | 宿主接线 | `recordTurn()` 真的调了 `touch()` + `observe()` | 推理路由没调它 |
 * | 下游消费 | `claim()` 收到的 familiarity 不是 undefined | 传了但传错 |

 * 用法：node cordis-host/check-relation.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { recordTurn } from './lib/src/relation.js'
import { diffuseAcrossSessions, familiarityOf } from './lib/src/diffuse.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

/*
 * 只装这条链需要的成员。
 *
 * **`ondra-path-layout` 不能漏**（本仓第七次记这一条）：`ondra-store-sqlite`
 * 的 `path` 默认为空，空时必须向路径服务要位置；拿不到就**直接不注册服务**，
 * 于是关系表根本不存在，`available` 却仍是 true——「落盘了」与「只在内存里」
 * 在服务面上分不开，只有读 `storeProvider` 才看得出来。
 *
 * 刻意不装 `ondra-emotion-diffuse`：本脚本验的是**关系那一侧**写入了什么，
 * 弥散是读取侧。带上它会让「熟悉度是不是真的产出来了」与「弥散有没有消费它」
 * 混在一条断言里，任一端坏了都看不出是哪一端。
 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-emotion-core',
  'ondra-emotion-express',
  'ondra-emotion-stage',
]

/*
 * 每次跑之前清空。判据全是「从 A 变 B」，库若沿用上一次的，
 * 起点就不是基线了——**一个只在第一次能过的检查脚本等于没有检查脚本**。
 */
const dataDir = new URL('../.shots/relation-check/', import.meta.url).pathname
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

console.log('=== 关系熟悉度核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) {
  if (!NEEDED.includes(item.id)) continue
  console.log(`  ! 本链成员被跳过 ${item.id}：${item.reason}`)
}

const stage = ctx.get('ondra-emotion-stage')
const store = ctx.get('ondra-store-sqlite')

console.log('\n--- 1. 关系服务在位且没有降级 ---')
check('ondra-emotion-stage 已注册', stage !== undefined)
check('存储端口在位', store !== undefined)

if (stage === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * 为什么判据是 `stats().storeProvider !== 'none'` 而不是 `available === true`：
 * 无存储时本插件**刻意**仍然可用（「有关系到但会丢」优于「完全没关系到」）。
 * 所以 `available` 证明不了落盘，只有 `storeProvider` 能。
 */
const stats0 = stage.stats()
check('关系服务没有降级（表建出来了）', stats0.storeProvider !== 'none',
  `storeProvider=${String(stats0.storeProvider)}`)
check('关系状态表已建出', store?.tableExists?.('emotion_relation_state') === true,
  String(store?.tableExists?.('emotion_relation_state')))

console.log('\n--- 2. 起点：全新关系，熟悉度 0 ---')
const r0 = stage.relation()
check('起点 interactions 为 0', r0.interactions === 0, String(r0.interactions))
check('起点 familiarity 为 0', r0.familiarity === 0, String(r0.familiarity))
check('起点阶段是敌意（七阶的起点）', stage.stats().base === 'hostile',
  String(stage.stats().base))

console.log('\n--- 3. 纯算术：familiarityOf 的公式本身 ---')
/*
 * 四条一起验，缺一条就分不开「算错了」与「没算」：
 * ① 分母是 5000（借 §3.5 阈值漂移同一个 5000，不是新造的）
 * ② 饱和封顶 1（不是线性无限涨）
 * ③ 非法输入回落到 0（不是 NaN）
 * ④ 负数不倒挂（不是负熟悉度）
 */
const stageMod = await import('./plugins/ondra-emotion-stage/lib/index.js')
check('familiarityOf(500) = 0.1（分母 5000）', Math.abs(stageMod.familiarityOf(500) - 0.1) < 1e-9,
  String(stageMod.familiarityOf(500)))
check('familiarityOf(5000) = 1（饱和）', stageMod.familiarityOf(5000) === 1,
  String(stageMod.familiarityOf(5000)))
check('familiarityOf(99999) 仍为 1（封顶）', stageMod.familiarityOf(99999) === 1,
  String(stageMod.familiarityOf(99999)))
check('familiarityOf(NaN) 回落到 0', stageMod.familiarityOf(NaN) === 0,
  String(stageMod.familiarityOf(NaN)))
check('familiarityOf(-5) 回落到 0', stageMod.familiarityOf(-5) === 0,
  String(stageMod.familiarityOf(-5)))

console.log('\n--- 4. 插件写入：touch() 真的把 interactions 推上去 ---')
/*
 * 这一层验的是「插件自己的写入口好不好使」。
 * 它绿而下一层红，就说明「插件没问题、宿主没调它」——这正是本仓
 * 前六次栽的地方：只看这一层，结论永远是「插件是好的」。
 */
const afterOne = stage.touch()
check('touch() 一次后 interactions = 1', afterOne.interactions === 1,
  String(afterOne.interactions))
check('familiarity 跟着离开 0（= 1/5000）',
  Math.abs(afterOne.familiarity - 1 / 5000) < 1e-12, String(afterOne.familiarity))
const statsTouch = stage.stats()
check('touches 计数器记到了 1 次', statsTouch.counters.touches === 1,
  String(statsTouch.counters.touches))

console.log('\n--- 5. adjust() 不再计数（口径只有一处）---')
/*
 * `interactions` 曾写在 `adjust()` 里。若两处都 +1，一轮会记成两次，
 * 而 5000 这个分母是按「一轮一次」标定的——记成两次等于把熟悉度算快一倍。
 *
 * 这条断言在**改之前**会红（adjust 也会 +1），改之后必须绿。
 */
const beforeAdjust = stage.relation().interactions
stage.adjust({ affection: 0.03 })
const afterAdjust = stage.relation().interactions
check('adjust() 不增加 interactions', afterAdjust === beforeAdjust,
  `${String(beforeAdjust)} → ${String(afterAdjust)}`)
check('adjust() 仍把好感推上去了', stage.relation().affection > 0.1,
  String(stage.relation().affection))
check('adjusts 计数器记到了 1 次', stage.stats().counters.adjusts === 1,
  String(stage.stats().counters.adjusts))

console.log('\n--- 6. 宿主接线：recordTurn() 真的调了 touch + observe ---')
/*
 * 这一层是本脚本的核心。它调的是**宿主自己的函数**（`src/relation.ts`），
 * 不是插件——插件写得再对，宿主不调它，`interactions` 一样不动。
 *
 * 断言「变化量」而不是「绝对状态」：绝对状态在「插件自己刚 touch 过一次」
 * 之后就分不清是谁推的了。这正是本仓第十段踩过的坑（写「有变化」而非
 * 「变化了多少」，分不开「降了」与「清零了」）。
 */
const beforeTurn = stage.relation().interactions
const outcome = recordTurn(ctx)
const afterTurn = stage.relation().interactions
check('recordTurn() 报告服务在位', outcome.present === true, outcome.note)
check('recordTurn() 真的记了互动（touched）', outcome.touched === true)
check('recordTurn() 真的判了升阶（observed）', outcome.observed === true)
check('interactions 恰好 +1（不是 +2、不是 0）',
  afterTurn === beforeTurn + 1, `${String(beforeTurn)} → ${String(afterTurn)}`)
check('回报了当前阶段的人话名', typeof outcome.stageZh === 'string' && outcome.stageZh !== '',
  String(outcome.stageZh))

/*
 * ## 为什么这四个布尔还不够，必须再数一次真实调用
 *
 * 第一版只验 `outcome.touched === true` 与 `outcome.observed === true`。
 * 反向验证时把 `service.observe()` 整段删掉、只留 `observed = true`，
 * 五条里**只红了一条**（人话名变成 undefined）——而 `observed` 照样是 true。
 *
 * 这正是本仓第五次踩的那一类：**判据指向「文件里出现过」，而不是
 * 「唯一那一处真的执行了」**。布尔值是我自己赋的，它证明不了调用发生过。
 *
 * 改法：在**真实服务实例上**装一层计数器（不是换一个替身服务——
 * 同一服务键重复 `provide` 会直接抛「已被注册」）。于是「谁被调了几次、
 * 按什么顺序」变成可观测的事实，而宿主取到的仍是同一个对象。
 */
const calls = { touch: 0, observe: 0 }
const order = []
const origTouch = stage.touch.bind(stage)
const origObserve = stage.observe.bind(stage)
stage.touch = (at) => {
  calls.touch += 1
  order.push('touch')
  return origTouch(at)
}
stage.observe = (input, at) => {
  calls.observe += 1
  order.push('observe')
  return origObserve(input, at)
}
recordTurn(ctx)
check('touch() 被真实调用一次', calls.touch === 1, String(calls.touch))
check('observe() 被真实调用一次', calls.observe === 1, String(calls.observe))
/*
 * 顺序断言：`observe()` 必须在 `touch()` **之后**。
 * 反了的话第一轮会因为「互动 0 次」卡在二阶闸上，症状是「升阶总慢一轮」——
 * 那个偏差不会报错，只会让人以为她反应慢。
 */
check('调用顺序是 touch → observe',
  order.join('→') === 'touch→observe', order.join('→'))

// 拆掉计数器，后面几条断言读的是干净的真服务。
stage.touch = origTouch
stage.observe = origObserve

console.log('\n--- 7. 熟悉度真的离开了 0（这是整条链的目的）---')
/*
 * 前三层全绿而这一条红，说明公式与调用都没问题、但**值没传出去**。
 * 这是最容易漏的一环：`interactions` 涨了，`familiarity` 却还在读旧快照。
 */
const rNow = stage.relation()
check('familiarity > 0（不再是陌生人）', rNow.familiarity > 0, String(rNow.familiarity))
check('familiarity 与 interactions 同步（= n/5000）',
  Math.abs(rNow.familiarity - rNow.interactions / 5000) < 1e-12,
  `f=${String(rNow.familiarity)} n=${String(rNow.interactions)}`)

console.log('\n--- 8. 下游消费：宿主读到的 familiarity 不是 0 ---')
/*
 * `familiarityOf()` 是宿主侧 `diffuse.ts` 里那个读函数，`claim()` 收到的
 * 就是它的返回值。它曾经恒为 0（因为宿主压根没传）。这一条与第 7 条
 * 不是重复：第 7 条验的是「插件产出了值」，这条验的是「宿主读到了它」。
 *
 * 中间那根线是 `ctx.get('ondra-emotion-stage')` —— 它断掉的症状与
 * 「熟悉度真是 0」完全一样。
 */
const hostRead = familiarityOf(ctx)
check('宿主读到的 familiarity > 0', hostRead > 0, String(hostRead))
check('宿主读到的值等于插件产出的值',
  Math.abs(hostRead - rNow.familiarity) < 1e-12,
  `host=${String(hostRead)} plugin=${String(rNow.familiarity)}`)

console.log('\n--- 9. 落盘：重启后熟悉度不回到 0 ---')
/*
 * 断言读的是**库里的那一行**，不是内存里的 `relation()`——后者在没存档时
 * 照样是新值，分不开「存了」与「没存」。
 */
check('emotion_relation_state 里有行', (store?.count?.('emotion_relation_state') ?? 0) === 1,
  `${String(store?.count?.('emotion_relation_state') ?? 0)} 行`)
const persisted = store?.select?.('emotion_relation_state', { limit: 1 })?.[0]
check('存档里的 interactions 等于内存里的值',
  Number(persisted?.interactions ?? -1) === rNow.interactions,
  `db=${String(persisted?.interactions)} mem=${String(rNow.interactions)}`)
/*
 * 钉「存档值 > 0」而不是钉「等于 3」：具体次数取决于上面调了几次，
 * 而这条断言要抓的缺陷是「算了没存」——那表现为存档停在 0。
 */
check('存档里的 interactions 不是 0（真写下去了）',
  Number(persisted?.interactions ?? 0) > 0, String(persisted?.interactions))

console.log('\n--- 10. 升阶闸：第一阶要靠互动次数 ---')
/*
 * 二阶（`probing`）的 `minInteractions = 1`。改之前 `interactions` 恒 0，
 * 这道闸**永远过不去**，七阶停在敌意——而「敌意」是合法状态，不会报错。
 *
 * 这里验「闸看见了非零的计数」，不断言「一定升到二阶」：升阶还需要好感
 * 与信任达标（0.1 / 0.1 刚好卡在门槛上），那是另一套判据。
 */
const explain = stage.explain()
check('explain() 能说出当前阶段', typeof explain.note === 'string' && explain.note !== '',
  explain.note)
check('explain() 读到的是非零互动次数',
  explain.relation.interactions === rNow.interactions,
  String(explain.relation.interactions))

console.log('\n--- 11. 弥散收到的 familiarity 不是 undefined ---')
/*
 * ## 为什么这一条要用替身，而不是把真弥散插件装进来
 *
 * 真插件的 `retain = 0.4 × (1 − f × 0.5)`，而 f 在这里只有 0.0004——
 * 保留比例从 0.4 变成 0.39992，**任何比较都会判成「没差别」**。
 * 于是「传了」与「没传」在数值上不可分辨，这正是本仓反复踩的
 * 「断言预期写错比断言缺失更难发现」。
 *
 * 替身只做一件事：把 `claim()` 收到的请求原样记下来。于是判据变成
 * 「字段在不在、值对不对」，与保留比例的量级无关。
 *
 * 这一层单独存在是必要的：第 8 条验「宿主读得到 familiarity」，
 * 第 11 条验「宿主把它交给了下游」。中间那根线（`claim({ familiarity })`）
 * 断掉的症状与「熟悉度真是 0」完全一样。
 */
const seen = []
ctx.provide('ondra-emotion-diffuse', {
  available: true,
  claim(request) {
    seen.push(request)
    // 返回 `no-gap`：本节点只关心入参，不关心有没有真弥散。
    return { status: 'no-gap', target: 0.5, moodBefore: 0.5, delta: 0, note: '检查用替身' }
  },
})
diffuseAcrossSessions(ctx, 'relation-check-key')
check('claim() 被调到了一次', seen.length === 1, String(seen.length))
const got = seen[0]?.familiarity
check('claim() 收到了 familiarity 字段（不是 undefined）', typeof got === 'number',
  String(got))
check('claim() 收到的 familiarity > 0（与宿主读到的一致）',
  typeof got === 'number' && Math.abs(got - hostRead) < 1e-12,
  `claim=${String(got)} host=${String(hostRead)}`)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
