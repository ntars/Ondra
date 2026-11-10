/**
 * 人格演化的实物核对：阈值到底会不会漂。
 *
 * ## 这个脚本要证明的事
 *
 * ```
 * 宿主在「用户真说了一句话」的轮次调 recordTurn() + syncEvolveInteractions()
 *   → 关系插件 touch() 把 interactions +1（唯一真源）
 *   → 人格演化按差额补到同一个数（镜像，不是第二份真源）
 *   → thresholdOf(base) 真的从 base 涨上去，系数 > 1.00
 *   → 判定侧真的读了它（`appliedTo` 由消费方自己报，第二十八段接通）
 * ```
 *
 * ## 为什么必须验到「差额对齐」那一层
 *
 * `interactions` 恒 0 有四层独立原因，每一层都不报错，因为 **0 与 ×1.00
 * 都是合法值**：
 *
 * | 层 | 缺什么 | 症状 |
 * | --- | --- | --- |
 * | 1 | `ondra-persona-evolve` 不在默认名单 | 服务没注册，`ctx.get` 恒 undefined |
 * | 2 | `noteInteraction()` 零调用方 | `interactions` 恒 0，系数恒 ×1.00 |
 * | 3 | 计数写成「每轮 +1」而非差额 | 历史补不上，镜像永远落后真源 |
 * | 4 | `thresholdOf()` 零调用方 | 算得出，没人问 |
 *
 * 只验第 2 层，第 3 层照样让镜像漂开而断言全绿——这正是本仓反复踩的
 * 「A 写、B 读、中间少根线」。所以断言分五层：算术 / 插件写入 /
 * 宿主差额对齐 / 幂等（重复对齐不再加）/ 阈值读数与「没生效」的如实回答。
 *
 * 用法：node cordis-host/check-evolve.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { recordTurn } from './lib/src/relation.js'
import { evolveProbe, syncEvolveInteractions } from './lib/src/evolve.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

/*
 * 只装这条链需要的成员。
 *
 * `ondra-path-layout` 不能漏（本仓第七次记这一条）：`ondra-store-sqlite`
 * 的 `path` 默认为空，空时必须向路径服务要位置；拿不到就**直接不注册服务**，
 * 于是三张表根本不存在，`available` 却仍是 true——「落盘了」与「只在内存里」
 * 在服务面上分不开，只有读 `storeProvider` 才看得出来。
 *
 * 刻意不装 `ondra-emotion-core` / `-express`：本脚本验的是「关系 → 演化」
 * 这一条边，带上情绪会让「真源是谁」混进三四个候选。
 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-emotion-stage',
  'ondra-persona-evolve',
]

/*
 * 每次跑之前清空。判据全是「从 A 变 B」，库若沿用上一次的，
 * 起点就不是基线了——一个只在第一次能过的检查脚本等于没有检查脚本。
 */
const dataDir = new URL('../.shots/evolve-check/', import.meta.url).pathname
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

console.log('=== 人格演化阈值漂移核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) {
  if (!NEEDED.includes(item.id)) continue
  console.log(`  ! 本链成员被跳过 ${item.id}：${item.reason}`)
}

const stage = ctx.get('ondra-emotion-stage')
const evolve = ctx.get('ondra-persona-evolve')
const store = ctx.get('ondra-store-sqlite')

console.log('\n--- 1. 两个服务都在位且没有降级 ---')
check('ondra-emotion-stage 已注册', stage !== undefined)
check('ondra-persona-evolve 已注册', evolve !== undefined)
check('存储端口在位', store !== undefined)

if (stage === undefined || evolve === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * 判据用 `storeProvider !== 'none'` 而不是 `available === true`：
 * 无存储时两者**刻意**都仍然可用（「有记录但会丢」优于「完全没记录」）。
 * 所以 `available` 证明不了落盘，只有 `storeProvider` 能。
 */
check('人格演化没有降级（表建出来了）', evolve.stats().storeProvider !== 'none',
  `storeProvider=${String(evolve.stats().storeProvider)}`)
check('互动计数表已建出', store?.tableExists?.('persona_interaction') === true,
  String(store?.tableExists?.('persona_interaction')))
check('特质声明表已建出', store?.tableExists?.('persona_trait') === true,
  String(store?.tableExists?.('persona_trait')))
check('漂移日志表已建出', store?.tableExists?.('persona_trait_delta') === true,
  String(store?.tableExists?.('persona_trait_delta')))

console.log('\n--- 2. 起点：全新镜像，次数 0、系数 ×1.00 ---')
check('起点 interactions 为 0', evolve.interactions() === 0, String(evolve.interactions()))
check('起点系数是 1', evolve.stats().factor === 1, String(evolve.stats().factor))
check('起点阈值不漂（thresholdOf(60) = 60）', evolve.thresholdOf('t', 60) === 60,
  String(evolve.thresholdOf('t', 60)))

console.log('\n--- 3. 纯算术：漂移公式本身 ---')
/*
 * 四条一起验，缺一条就分不开「算错了」与「没算」：
 * ① 饱和点 5000（与关系域的 familiarity 同一个分母，不是新造的）
 * ② 斜率 0.6（手册 §3.5 逐字）
 * ③ 上限 +60%（斜率被改大也不会静默越界）
 * ④ 非法输入不倒挂
 */
const evolveMod = await import('./plugins/ondra-persona-evolve/lib/index.js')
const probeAt = n => evolveMod.driftProgress(n)
check('progress(5000) = 1', probeAt(5000).progress === 1, String(probeAt(5000).progress))
check('factor(0) = 1', probeAt(0).factor === 1, String(probeAt(0).factor))
check('factor(5000) = 1.6', Math.abs(probeAt(5000).factor - 1.6) < 1e-9, String(probeAt(5000).factor))
check('factor(2778) ≈ 1.333（「60 变 80」的位置）',
  Math.abs(probeAt(2778).factor - (1 + 0.6 * (2778 / 5000))) < 1e-9,
  String(probeAt(2778).factor))
check('effectiveThreshold(60, 2778) ≈ 80',
  Math.abs(evolveMod.effectiveThreshold(60, 2778) - 80) < 0.01,
  String(evolveMod.effectiveThreshold(60, 2778)))
check('负次数按 0 处理（不倒挂）', probeAt(-100).factor === 1, String(probeAt(-100).factor))
check('factor 上限夹在 1.6', probeAt(1e9).factor <= 1.6, String(probeAt(1e9).factor))

console.log('\n--- 4. 宿主差额对齐：真源动一步，镜像跟一步 ---')
/*
 * 这是本轮的核心断言。分三步，每步都读**两边的原始数**：
 *
 * | 步骤 | 真源 | 镜像 | 要证的事 |
 * | --- | --- | --- | --- |
 * | 初始 | 0 | 0 | 起点一致 |
 * | 记 3 轮 | 3 | 3 | 差额补齐（不是 +1） |
 * | 再对齐一次 | 3 | 3 | 幂等（重复调不再加） |
 */
const sync0 = syncEvolveInteractions(ctx)
check('起点对齐不补任何数', sync0.added === 0, `added=${String(sync0.added)}`)
check('起点两边都是 0', sync0.source === 0 && sync0.interactions === 0,
  `source=${String(sync0.source)} mirror=${String(sync0.interactions)}`)

for (let i = 0; i < 3; i += 1) recordTurn(ctx)
const sourceAfter = stage.relation().interactions
check('真源已经推到 3', sourceAfter === 3, String(sourceAfter))

const sync1 = syncEvolveInteractions(ctx)
check('一次补齐 3（不是每轮 +1）', sync1.added === 3, `added=${String(sync1.added)}`)
check('镜像追平真源', sync1.interactions === 3, String(sync1.interactions))
check('对齐后不再报 drifted', sync1.drifted === false)

const sync2 = syncEvolveInteractions(ctx)
check('重复对齐是幂等的（added = 0）', sync2.added === 0, `added=${String(sync2.added)}`)
check('重复对齐后镜像仍是 3', sync2.interactions === 3, String(sync2.interactions))

console.log('\n--- 5. 阈值真的离开出厂值 ---')
const base = 60
const effective = evolve.thresholdOf('六态能量线', base)
check('thresholdOf 已经不是出厂值', effective !== base, String(effective))
check('系数与互动次数一致（3 次 → ×1.0004）',
  Math.abs(effective - base * (1 + 0.6 * (3 / 5000))) < 1e-9,
  String(effective))

const explained = evolve.explainThreshold('六态能量线', base)
check('explainThreshold 给出的 effective 与 thresholdOf 一致',
  Math.abs(explained.effective - effective) < 1e-9,
  `${String(explained.effective)} vs ${String(effective)}`)
check('解释里带着互动次数', explained.interactions === 3, String(explained.interactions))
check('解释句子能读（含「出厂」二字）', explained.sentence.includes('出厂'),
  explained.sentence)

console.log('\n--- 6. 落盘：重启不会「一夜回到出厂」 ---')
/*
 * 只看 `available` 证明不了落盘（无存储时也 true）。判据是
 * ① 服务报的 provider 不是 none；② 库里那一行的 count 真是 3。
 */
const row = store?.get?.('persona_interaction', { id: 'singleton' })
check('互动计数写进了库', row !== undefined, row === undefined ? '无行' : 'ok')
check('库里记的次数是 3', Number(row?.count) === 3, String(row?.count))

console.log('\n--- 7. 诊断如实回答「现在被谁消费了」 ---')
const probe = evolveProbe(ctx)
check('诊断报告服务在位', probe.present === true)
check('诊断给出互动次数', probe.interactions === 3, String(probe.interactions))
check('诊断给出系数', typeof probe.factor === 'number' && probe.factor > 1,
  String(probe.factor))
check('诊断报告与真源已对齐', probe.aligned === true, String(probe.aligned))
/*
 * `appliedTo` 的语义在 2026-11-08 第二十八段变了。
 *
 * 之前判定侧的阈值全是常量表，所以正确的答案是**空数组**——那是一条
 * 「如实承认没生效」的断言。本轮把六态与七阶都接上了漂移，于是这里要验
 * 反过来的事：**它列的是真的消费了的那个，不多不少**。
 *
 * 这个脚本只装了 `ondra-emotion-stage`（六态 `ondra-emotion-express` 不在
 * `NEEDED` 里）。所以正确结果是「有 stage、没有 express」：
 * - 只断言非空 → 把 express 也硬塞进去照样绿，那是撒谎；
 * - 只断言含 stage → 同上。
 * 两个方向都要卡住，才证明这一格是**消费方自己报的**而不是猜的。
 */
check('appliedTo 只列出真的消费了的那个（stage）',
  probe.appliedTo.length === 1 && probe.appliedTo[0] === 'ondra-emotion-stage',
  JSON.stringify(probe.appliedTo))
check('没装的六态不出现在 appliedTo 里（没装就没消费）',
  !probe.appliedTo.includes('ondra-emotion-express'),
  JSON.stringify(probe.appliedTo))
check('consumers 里 stage 的 asked > 0（判定路径真的问了系数）',
  (probe.consumers ?? []).some(item => item.key === 'ondra-emotion-stage' && item.asked > 0),
  JSON.stringify((probe.consumers ?? []).map(item => [item.key, item.asked])))

console.log('\n--- 8. 镜像超前：只报告，不抹平 ---')
/*
 * 「镜像比真源大」意味着真源被换过 / 重建过。此时**不能**静默抹平，
 * 也不能当没事发生——`drifted` 就是给这种情况准备的信号灯。
 *
 * 这条是反向验证补出来的：原先只断言「正常路径不报 drifted」，
 * 把 `drifted: true` 改成 `false` 全绿——等于这个字段根本没人验。
 */
{
  const aheadEvolve = ctx.get('ondra-persona-evolve')
  const sourceBefore = stage.relation().interactions
  // 直接把镜像推高，模拟「真源被重建过」。
  aheadEvolve.noteInteraction(5)
  const mirrorAhead = aheadEvolve.interactions()
  const syncAhead = syncEvolveInteractions(ctx)
  check('镜像超前时不加数', syncAhead.added === 0, `added=${String(syncAhead.added)}`)
  check('镜像超前时如实报 drifted', syncAhead.drifted === true,
    `drifted=${String(syncAhead.drifted)} mirror=${String(mirrorAhead)} source=${String(sourceBefore)}`)
  check('镜像超前时不自行抹平', syncAhead.interactions === mirrorAhead,
    String(syncAhead.interactions))
  // 复位：把多出来的 5 次补回真源，让后续断言回到一致的起点。
  for (let i = 0; i < 5; i += 1) recordTurn(ctx)
  const back = syncEvolveInteractions(ctx)
  check('补回真源后重新对齐', back.drifted === false && back.added === 0,
    `drifted=${String(back.drifted)} added=${String(back.added)}`)
}

console.log('\n--- 9. 真源缺席时不动（不自证） ---')
/*
 * 换一个只装人格演化的上下文：没有关系服务时，`syncEvolveInteractions()`
 * 必须**什么都不做**，而不是拿镜像自己当尺子「补齐到镜像」——
 * 那是自证，会让镜像永远认为自己是对的。
 */
const lone = new Context()
lone.baseUrl = new URL('./', import.meta.url).href
const loneData = new URL('../.shots/evolve-check-lone/', import.meta.url).pathname
await rm(loneData, { recursive: true, force: true })
await loadCore(lone, {
  enable: ['ondra-path-layout', 'ondra-store-sqlite', 'ondra-persona-evolve'],
  configs: { 'ondra-path-layout': { root: loneData } },
})
const loneEvolve = lone.get('ondra-persona-evolve')
loneEvolve?.noteInteraction(7)
const loneSync = syncEvolveInteractions(lone)
check('真源缺席时 added = 0', loneSync.added === 0, String(loneSync.added))
check('真源缺席时镜像不被改动', loneSync.interactions === 7, String(loneSync.interactions))
check('真源缺席时如实报告 sourcePresent = false', loneSync.sourcePresent === false)
await lone.fiber.dispose()

console.log('\n--- 结果 ---')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`失败 ${String(failures.length)} 条：`)
  for (const item of failures) console.log(`  - ${item}`)
}

await ctx.fiber.dispose()
process.exit(failures.length === 0 ? 0 : 1)
