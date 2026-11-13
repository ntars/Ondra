/**
 * 「关掉就不干活」回归网：三处曾经关不掉的假开关。
 *
 * ## 这个脚本要证明的一件事
 *
 * `enable=false` 之后，插件**不该产生任何副作用**——特别是**不该建表**。
 *
 * 第 16 轮抓到三处同构缺陷：
 *
 * | 插件 | 关掉之后仍发生的事 | 用户看到的 |
 * | --- | --- | --- |
 * | `ondra-emotion-stage` | 建 `ondra_relation_state` | 面板说「已关闭」，库里多一张表 |
 * | `ondra-emotion-diffuse` | 建 `emotion_diffuse_mark` | 同左，且原因码被压成 `no-store` |
 * | `ondra-persona-evolve` | 建 3 张 `persona_*` | 同左，`noteInteraction` 还能写计数 |
 *
 * 三处都是「`settings` 已经算好了、`if (!settings.enable)` 就是没写」。
 * 对照 `ondra-emotion-core` 一直是对的，说明这是**漏写**而非取舍。
 *
 * ## 为什么判据必须是「表不存在」，不能是 `available === false`
 *
 * `available` 在关闭时当然返回 false——那是最容易写对的一行。
 * 假开关的破绽恰恰在**开关之外**：建表、写计数、写日志这些副作用
 * 不看 `available`。所以只能去问存储层「这张表存不存在」。
 *
 * 反过来，也不能只验「关掉后 available 为 false」：那条断言在修复前就绿，
 * 等于没测。
 *
 * ## 为什么三个插件一起测
 *
 * 它们是同一个错误的三个副本。分成三个脚本，下一个人加第四个插件时
 * 只会记得往其中一个里加；放在一起，新加的表自然会被要求在这里补一行。
 *
 * 用法：node cordis-host/check-disable.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-emotion-core',
  'ondra-emotion-express',
  'ondra-emotion-stage',
  'ondra-emotion-diffuse',
  'ondra-persona-evolve',
]

const dataDir = new URL('../.shots/disable-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

/*
 * 三个插件全部显式关掉。
 *
 * `ondra-emotion-core` **必须开着**：`diffuse` 的 `reason` 链会问它，
 * 关掉的话它自己会报 `no-emotion`，把 `disabled` 遮住——
 * 那样测的就不是我们想测的那一层了。
 */
const result = await loadCore(ctx, {
  enable: NEEDED,
  configs: {
    'ondra-path-layout': { root: dataDir },
    'ondra-emotion-stage': { enable: false },
    'ondra-emotion-diffuse': { enable: false },
    'ondra-persona-evolve': { enable: false },
  },
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

console.log('=== 关掉就不干活：三处假开关核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)

const store = ctx.get('ondra-store-sqlite')
const stage = ctx.get('ondra-emotion-stage')
const diffuse = ctx.get('ondra-emotion-diffuse')
const evolve = ctx.get('ondra-persona-evolve')

check('ondra-store-sqlite 在位（否则本脚本测不到建表）', store !== undefined)
check('ondra-emotion-stage 已注册（关掉也要注册）', stage !== undefined)
check('ondra-emotion-diffuse 已注册（关掉也要注册）', diffuse !== undefined)
check('ondra-persona-evolve 已注册（关掉也要注册）', evolve !== undefined)

if (store === undefined || stage === undefined || diffuse === undefined || evolve === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

console.log('\n--- 1. 三处都报「关掉了」，而不是别的理由 ---')
/*
 * 这一层是「原因码对不对」。修复前 diffuse 会报 `no-store`（被
 * `fallbackReason` 盖掉），stage 报 `disabled`（碰巧对，因为它的 reason
 * 是按 store 是否缺席推的），evolve 没建表之前也没有 `disabled` 这一档。
 *
 * 断言取「等于 'disabled'」而非「只要不是 undefined」：后者在报错成
 * `no-store` 时照样通过，而那正是需要被抓到的那种错。
 */
check('emotion-stage 的原因是 disabled', stage.stats().reason === 'disabled', String(stage.stats().reason))
check('emotion-diffuse 的原因是 disabled', diffuse.stats().reason === 'disabled', String(diffuse.stats().reason))
check('persona-evolve 的原因是 disabled', evolve.stats().reason === 'disabled', String(evolve.stats().reason))

console.log('\n--- 2. 一张表都不该存在（本脚本的核心判据）---')
/*
 * 表名一律**去插件源码里读过**（`grep -n "TABLE_.* = '"`），不按直觉写。
 *
 * 这里踩过一次：第一版把 stage 的表写成 `ondra_relation_state`（因为它的
 * 目录叫 `ondra-emotion-stage`），真名是 `emotion_relation_state`。于是那条
 * 断言永远绿（表压根不存在），反向验证时也一直绿——**一个永远不会红的断言
 * 比没有断言更糟**，它会让人以为那一处被守住了。
 *
 * 现在四个名字都核过：`store.ts` 里的 `TABLE_*` 常量。
 */
const TABLES = [
  ['emotion_relation_state', 'emotion-stage 的关系阶段表'],
  ['emotion_diffuse_mark', 'emotion-diffuse 的弥散标记表'],
  ['persona_trait', 'persona-evolve 的特质定义表'],
  ['persona_trait_delta', 'persona-evolve 的漂移日志表'],
  ['persona_interaction', 'persona-evolve 的互动计数表'],
]
for (const [table, what] of TABLES) {
  const exists = store.tableExists?.(table) === true
  check(`${what} ${table} 没有被建出来`, !exists, exists ? '存在（关掉还建表）' : '不存在')
}

console.log('\n--- 3. 关掉时读操作仍可用，且返回出厂值 ---')
/*
 * 「关掉不建表」不等于「关掉就崩」。读操作必须仍然能调、且回答
 * 「按出厂值判」——这是各插件 README 明写的契约（`emotion-stage`
 * 「所有读操作返回起始阶」、`persona-evolve`「阈值不漂移」）。
 *
 * 如果为了不建表而把服务做成会抛错，那是拿一个新缺陷换一个旧缺陷。
 *
 * ## 探针口径（写错过一次，记下来）
 *
 * 第一版这里写的是 `stage.relation?.()` 然后断言 `!== undefined`。
 * 那个断言**恒真**：`RelationState` 里根本没有 `stage` 字段，所以
 * `${stageRead.stage ?? ...}` 永远打出 `undefined`，而我拿
 * 「`stageRead !== undefined`」当了通过条件——它测的是「对象存不存在」，
 * 不是「阶对不对」。**又是「布尔标志证明不了那一处真的执行了」。**
 *
 * 现在改成两段：`view()` 取阶（判它落在七阶表里），`relation()` 取四维
 * （判 familiarity 为 0——关掉且空库时，相处次数就该是 0）。
 */
let view
let viewThrew
try {
  view = stage.view()
} catch (error) {
  viewThrew = error
}
check('emotion-stage 的 view() 不抛错', viewThrew === undefined, viewThrew === undefined ? '' : String(viewThrew))

const stageIds = new Set((stage.stages?.() ?? []).map(s => s.id))
/*
 * 字段名是 `base` / `effective`，**不是 `stage`**。
 *
 * 第一版我按直觉写了 `view.stage`，脚本立刻红——这不是脚本错，是我错了：
 * `StageView` 的注释把这几个字段的语义分得很细（`base` 是只升不降的棘轮底座，
 * `effective` 是对外语域，锁定时才被覆盖成敌意）。断言必须落在**契约里的字段**上，
 * 顺手记一笔，免得下一个人也按直觉写。
 */
check('view() 的 base 落在七阶表里（不是空壳）', view !== undefined && stageIds.has(view.base), String(view?.base))
check('view() 的 effective 落在七阶表里', view !== undefined && stageIds.has(view.effective), String(view?.effective))
/*
 * 关掉且空库时，棘轮底座必须停在起始阶——`START_STAGE` 是「敌意」。
 * 这一条同时把「关掉后没有偷偷读出一个中间阶」也锁住了。
 */
check('view() 的 base 是起始阶（关掉且空库）', view?.base === 'hostile', String(view?.base))

let relation
let relationThrew
try {
  relation = stage.relation()
} catch (error) {
  relationThrew = error
}
check('emotion-stage 的 relation() 不抛错', relationThrew === undefined, relationThrew === undefined ? '' : String(relationThrew))
/*
 * **空库 + 已关闭**时互动次数必须是 0。这一条同时证明两件事：
 * 关掉之后没有偷偷写库、也没有从某个残留状态里捞出一个数。
 */
check('relation() 的 interactions 为 0（空库、已关闭）', relation?.interactions === 0, String(relation?.interactions))

/*
 * `thresholdOf()` 在关闭时必须**逐字**返回 base，不是「接近 base」。
 * 判据用 !== 而非容差：漂移公式是乘法，1e-9 级别的偏差说明它其实算了一遍
 * 再夹回去，那意味着「关闭」只关住了输出、没关住计算。
 */
check('persona-evolve 的阈值原样返回 base（60 → 60）', evolve.thresholdOf('any', 60) === 60, String(evolve.thresholdOf('any', 60)))

console.log('\n--- 4. 关闭状态下写操作不生效 ---')
/*
 * `noteInteraction()` 修复前没有守卫，靠宿主替它挡。这里绕过宿主直接调，
 * 模拟「第三个调用方」——面板、迁移脚本、以后的自检都能这么调。
 *
 * 判据是「返回值不变」而不是「抛错」：契约是「只加不减的累加器」，
 * 关闭时最合理的行为是原样返回当前值。
 */
const beforeCount = evolve.interactions()
const afterCount = evolve.noteInteraction(5)
check('关掉之后 noteInteraction(5) 不改变计数', afterCount === beforeCount, `${String(beforeCount)} → ${String(afterCount)}`)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
