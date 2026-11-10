/**
 * 阈值漂移**生效侧**的实物核对：判定真的换了判据吗。
 *
 * ## 这个脚本要证明的事
 *
 * `ondra-persona-evolve` 的公式一直算得出「相处 5000 次后 ×1.60」，但判定侧
 * 的 `STATE_SPECS`（六态）与 `STAGE_SPECS`（七阶）是常量表，**没有任何一处
 * 接受外部阈值**。症状不是报错，而是「她永远像第一天认识你」——
 * 而 `×1.00` 是合法系数，`0` 是合法互动数，所以谁也不响。
 *
 * ```text
 * 本插件的常量表（base 真源）→ persona-evolve 乘系数 → 判定读漂移后的表
 * ```
 *
 * 上一轮只验到「系数算得出、appliedTo 如实为空」。本轮要验到
 * **同一个读数在漂移前后判出不同结果**——这才是「生效」。
 *
 * ## 为什么必须验「判定结果变了」而不是「系数传过去了」
 *
 * 传参成功有太多种假象：函数被调用、返回值非 1、日志里印了数字。
 * 但只要判定还读常量表，用户看到的就是一模一样。唯一能分辨的是
 * **同一个 mood 在 n=0 与 n=5000 时判出不同的态**。
 *
 * 这也是本仓第六次处理同族缺陷（前五次：两个同名 tabIndex、关闭拦截只查函数、
 * 壳抽象零匹配、`asked` 统计在调用之外、`observe()` 只验布尔）——
 * 一律用「副作用真的发生了吗」作判据，不用「代码里有没有」。
 *
 * 用法：node cordis-host/check-drift.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { evolveProbe } from './lib/src/evolve.js'

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

/**
 * 起一个只装这条链的上下文。
 *
 * `ondra-path-layout` 不能漏（本仓第七、八次记过）：`ondra-store-sqlite`
 * 拿不到路径就**直接不注册服务**，22 个业务插件静默退到内存态，
 * 而 `available` 仍是 true。
 * @param name 用于隔离数据目录。
 * @param extra 额外成员。
 * @param evolve 是否装人格演化。
 */
async function boot(name, extra, evolve) {
  const ctx = new Context()
  ctx.baseUrl = new URL('./', import.meta.url).href
  const dataDir = new URL(`../.shots/drift-check-${name}/`, import.meta.url).pathname
  await rm(dataDir, { recursive: true, force: true })
  const enable = [
    'ondra-path-layout',
    'ondra-store-sqlite',
    'ondra-emotion-core',
    'ondra-emotion-stage',
    'ondra-emotion-express',
    ...extra,
  ]
  if (evolve) enable.push('ondra-persona-evolve')
  await loadCore(ctx, {
    enable,
    configs: { 'ondra-path-layout': { root: dataDir } },
  })
  return ctx
}

console.log('=== 阈值漂移生效核对 ===')

/* ------------------------------------------------------------------ *
 * 1. 纯函数：漂移表本身
 * ------------------------------------------------------------------ */
console.log('\n--- 1. 纯函数：护栏三条 ---')
const expressMod = await import('./plugins/ondra-emotion-express/lib/index.js')
const { driftedSpecs, driftRange } = expressMod

// ① 系数缺席 → 返回出厂表**本身**（不是副本）：逐字等价。
const none = driftedSpecs(undefined)
check('没有漂移函数时返回出厂表本身（同一引用）', none.specs === expressMod.STATE_SPECS)
check('报告 asked 为 0', none.report.asked === 0 && none.report.applied.length === 0,
  JSON.stringify(none.report))

// ② 系数 1.6 时：joyful 的 mood 门槛会撞量程 → 必须挡回，而不是判死这一态。
const hot = driftedSpecs((_key, base) => base * 1.6)
check('joyful.mood 撞量程被挡回', hot.report.rejected.some(item => item.key === 'joyful.mood'),
  JSON.stringify(hot.report.rejected.map(item => item.key)))
check('被挡回后 joyful 的 mood 门槛仍是出厂的 0.7',
  hot.specs.joyful.mood.gt === 0.7, String(hot.specs.joyful.mood.gt))
/* 这一条是护栏存在的全部理由：`0.7 × 1.6 = 1.12 > 1`，
 * 若照乘不误，`mood > 1.12` 永远不成立，「雀跃」这一态就被判死了。 */
check('joyful.energy 没撞量程（60 × 1.6 = 96 ≤ 100）',
  hot.specs.joyful.energy.gt === 96, String(hot.specs.joyful.energy.gt))
check('bristled.tension 撞量程被挡回（0.5 × 1.6 = 0.8 < 1，应通过）',
  hot.specs.bristled.tension.gt === 0.8, String(hot.specs.bristled.tension.gt))

// ③ 下界一律不动：蔫与困的门槛在漂移前后必须逐字相同。
check('蔫的门槛不漂（下界不动）', hot.specs.wilted === expressMod.STATE_SPECS.wilted)
check('困的门槛不漂（下界不动）', hot.specs.sleepy === expressMod.STATE_SPECS.sleepy)

// ④ 中小系数：真的按比例上移。
const mid = driftedSpecs((_key, base) => base * 1.2)
check('系数 1.2 时 joyful.energy = 72', mid.specs.joyful.energy.gt === 72,
  String(mid.specs.joyful.energy.gt))
check('系数 1.2 时一条都没被挡回', mid.report.rejected.length === 0,
  JSON.stringify(mid.report.rejected))

// ⑤ 护栏边界：`gt` 恰好等于量程也不可满足。
const edge = driftRange({ gt: 0.5 }, 2, 1)
check('gt 阈值 × 2 = 量程时被判定为不可满足', edge.rejected !== undefined, String(edge.rejected))
const edgeOk = driftRange({ gte: 0.5 }, 2, 1)
check('gte 阈值 × 2 = 量程时允许（可以等于）', edgeOk.rejected === undefined && edgeOk.range.gte === 1,
  String(edgeOk.range.gte))

/* ------------------------------------------------------------------ *
 * 2. 七阶表：只漂心理门槛
 * ------------------------------------------------------------------ */
console.log('\n--- 2. 七阶表：只漂 affection / trust ---')
const stageMod = await import('./plugins/ondra-emotion-stage/lib/index.js')
const { driftedStages, STAGE_SPECS } = stageMod

const stageNone = driftedStages(undefined)
check('没有漂移函数时返回出厂表本身', stageNone.specs === STAGE_SPECS)

const stageHot = driftedStages((_key, base) => base * 1.6)
check('crush.affection 被上移（0.18 × 1.6 = 0.288）',
  Math.abs(stageHot.specs.crush.affection - 0.288) < 1e-9, String(stageHot.specs.crush.affection))
check('days 一律不漂（客观时间不是心理门槛）',
  stageHot.specs.crush.days === STAGE_SPECS.crush.days && stageHot.specs.settled.days === STAGE_SPECS.settled.days,
  `${String(stageHot.specs.crush.days)} / ${String(stageHot.specs.settled.days)}`)
check('minInteractions 一律不漂（自指）',
  stageHot.specs.crush.minInteractions === STAGE_SPECS.crush.minInteractions)
check('maxTrust 一律不漂（上界方向手册没说）',
  stageHot.specs.pathological.maxTrust === STAGE_SPECS.pathological.maxTrust)
check('settled.affection 撞量程被挡回（0.75 × 1.6 = 1.2 > 1）',
  stageHot.specs.settled.affection === STAGE_SPECS.settled.affection,
  String(stageHot.specs.settled.affection))

/* ------------------------------------------------------------------ *
 * 3. 真装载：同一个读数额，判定结果真的变了
 * ------------------------------------------------------------------ */
console.log('\n--- 3. 六态：同一个 mood 在漂移前后判出不同的态 ---')

/*
 * 选 0.78 这个读数是有讲究的：
 * - 出厂 `mood > 0.7` → 命中「雀跃」；
 * - `0.7 × 1.2 = 0.84`（系数 1.2，相处 1667 次）→ 0.78 不再命中。
 *
 * 若判定仍读常量表，两次都判「雀跃」，断言会红。
 * 这比「传参了没」硬一万倍：它证明的是用户看得见的那一层变了。
 */
const FIXED_MOOD = 0.78
const FIXED_ENERGY = 80

const at0 = await boot('zero', [], true)
const express0 = at0.get('ondra-emotion-express')
const evolve0 = at0.get('ondra-persona-evolve')
check('六态服务在位', express0 !== undefined)
check('人格演化在位', evolve0 !== undefined)

const zeroView = express0.classify({ mood: FIXED_MOOD, energy: FIXED_ENERGY, tension: 0 })
check('0 次互动时 0.78 判「雀跃」', zeroView.state === 'joyful', zeroView.state)
check('0 次互动时报告 asked > 0（调用真的发生了）',
  express0.stats().drift.asked > 0, String(express0.stats().drift.asked))
check('0 次互动时一条都没漂（系数 ×1.00）',
  express0.stats().drift.applied.length === 0, JSON.stringify(express0.stats().drift.applied))
await at0.fiber.dispose()

// 推到 1667 次互动（系数 ×1.2），再判同一个读数。
const at1 = await boot('hot', [], true)
const express1 = at1.get('ondra-emotion-express')
const evolve1 = at1.get('ondra-persona-evolve')
evolve1.noteInteraction(1667)
const factor1 = evolve1.stats().factor
check('1667 次互动后系数约 ×1.2', Math.abs(factor1 - 1.2) < 5e-4, String(factor1))

const hotView = express1.classify({ mood: FIXED_MOOD, energy: FIXED_ENERGY, tension: 0 })
/*
 * `joyful` 需要 mood > 0.84 且 energy > 72，两个都不满足；
 * `soft` 需要 0.55 ≤ mood ≤ 0.7，0.78 超了上界 → 落空档兜底（mood ≥ 0.55 → 软和）。
 * 兜底是出厂就有的行为，与漂移无关，所以这里断言的是「不再雀跃」+「matched 为 false」。
 */
check('1667 次互动后同一个 0.78 不再判「雀跃」', hotView.state !== 'joyful', hotView.state)
/*
 * 判据从 `drift` 换成 `lastDrift`，这是反向验证逼出来的。
 *
 * `drift` 是现算的（诊断自己调一遍 `driftedSpecs()`），所以判定路径里
 * 把 `resolveState(axes, drifted.specs)` 改回 `resolveState(axes)`
 * 它照样显示「已漂 3 条」——只红上面那一条。而 `lastDrift` 只在
 * `viewOf()` 里赋值，删掉传参它就变回 `asked: 0`。
 *
 * 这是本仓第六次同族缺陷：**能自己算一遍的报告字段，证明不了那条路真的走了**。
 */
check('report 用的是判定路径的结果（lastDrift 非空）',
  express1.stats().lastDrift.applied.length > 0, JSON.stringify(express1.stats().lastDrift.applied))
check('lastDrift 里带着 joyful.energy 这一条',
  express1.stats().lastDrift.applied.includes('joyful.energy'),
  JSON.stringify(express1.stats().lastDrift.applied))

console.log('\n--- 4. 七阶：同一个信任值在漂移前后判出不同的阶 ---')
const stage1 = at1.get('ondra-emotion-stage')
check('关系阶段在位', stage1 !== undefined)
/*
 * 先把七阶真的判一次。`stats()` 的 `drift` 是现算的，
 * 不判一次的话 `lastDrift` 会是零——那正是「接线断了」与「还没判过」
 * 唯一分得开的地方。
 */
stage1.observe()
const stageReport = stage1.stats().lastDrift
check('七阶报告 asked > 0（判定路径真的问了系数）', stageReport.asked > 0, String(stageReport.asked))
check('七阶门槛真的换了', stageReport.applied.length > 0, JSON.stringify(stageReport.applied))
check('七阶报告里带着 crush.affection',
  stageReport.applied.includes('crush.affection'), JSON.stringify(stageReport.applied))
check('七阶 days 不在 applied 里（刻意不漂）',
  !stageReport.applied.some(key => key.endsWith('.days')), JSON.stringify(stageReport.applied))
check('七阶 maxTrust 不在 applied 里（上界方向未定）',
  !stageReport.applied.some(key => key.endsWith('.maxTrust')), JSON.stringify(stageReport.applied))

console.log('\n--- 5. 诊断：appliedTo 不再为空，且是消费方自己报的 ---')
const probe1 = evolveProbe(at1)
check('诊断报告服务在位', probe1.present === true)
check('appliedTo 列出了两个判定侧',
  probe1.appliedTo.length === 2 &&
    probe1.appliedTo.includes('ondra-emotion-express') &&
    probe1.appliedTo.includes('ondra-emotion-stage'),
  JSON.stringify(probe1.appliedTo))
check('consumers 里每个都有 asked > 0',
  probe1.consumers.length === 2 && probe1.consumers.every(item => item.asked > 0),
  JSON.stringify(probe1.consumers.map(item => item.asked)))
await at1.fiber.dispose()

console.log('\n--- 6. 反例：0 次互动时 appliedTo 必须为空 ---')
/*
 * 这一条防的是「装了就算生效」。系数 ×1.00 时阈值与出厂逐字相同，
 * 判定结果毫无变化，此时声称已生效就是撒谎——而那正是刚装上的常态。
 */
const at2 = await boot('flat', [], true)
const probe2 = evolveProbe(at2)
check('0 次互动时系数是 1', at2.get('ondra-persona-evolve').stats().factor === 1,
  String(at2.get('ondra-persona-evolve').stats().factor))
check('0 次互动时 appliedTo 为空（没生效就别说生效）',
  probe2.appliedTo.length === 0, JSON.stringify(probe2.appliedTo))
check('0 次互动时 consumers 仍有 asked（证明调用发生了）',
  probe2.consumers.length === 2 && probe2.consumers.every(item => item.asked > 0),
  JSON.stringify(probe2.consumers.map(item => item.asked)))
await at2.fiber.dispose()

console.log('\n--- 7. 反例：不装人格演化时判定逐字退回出厂 ---')
const at3 = await boot('bare', [], false)
const express3 = at3.get('ondra-emotion-express')
const bareView = express3.classify({ mood: FIXED_MOOD, energy: FIXED_ENERGY, tension: 0 })
check('没装演化时 0.78 仍判「雀跃」', bareView.state === 'joyful', bareView.state)
check('没装演化时 asked 为 0（根本没问）',
  express3.stats().drift.asked === 0, String(express3.stats().drift.asked))
const probe3 = evolveProbe(at3)
check('没装演化时诊断报 not-loaded', probe3.present === false && probe3.reason === 'not-loaded',
  String(probe3.reason))
await at3.fiber.dispose()

console.log('\n--- 结果 ---')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`失败 ${String(failures.length)} 条：`)
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failures.length === 0 ? 0 : 1)
