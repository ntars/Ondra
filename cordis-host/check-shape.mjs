/**
 * 「句形档全覆盖」回归网：O-031 的六个 `SentenceShape` 必须都被 O-038 认得。
 *
 * ## 为什么需要这一条
 *
 * 第 16 轮抓到的真缺陷：`ondra-emotion-express` 的「困」态输出
 * `sentenceShape: 'ellipsis'`，而 `ondra-rhythm` 的 `SHAPE_ADJUST` 表里
 * **没有这个键**。后果不是崩溃，是三重静默：
 *
 * 1. 查表回落 `PLAIN_SHAPE`（`??` 兜住了 `undefined`）；
 * 2. `adjusted` 因为系数算出来等于默认值而判 `false`；
 * 3. `notes` 里的 `{ code: 'shape' }` 也不产生。
 *
 * 于是她困的时候：语速慢下来了（`tempo: 'slow'` 走的是另一张表，那张有键），
 * 分条与单条字数**完全按平常档**，而面板「句形」一格照常显示
 * `ellipsis / 短句带省略`。**看着全对**。
 *
 * ## 判据为什么是「同一段正文，换句形档，单条上限必须变」
 *
 * 不去断言 `SHAPE_ADJUST` 里有哪些键——那是抄实现，表里加错数字也能过。
 * 也不断言日志里出现告警——这只证明「代码走到了 fallback 分支」，
 * 不证明用户看到的效果对不对。
 *
 * 唯一可信的派生量是 `plan().maxCharsPerMessage`：它是**实际生效**的单条上限，
 * 是用户真的会看到的那个数。给同一段正文、同一个 `maxCharsPerMessage` 设置，
 * 只换句形档，上限应当随档位变化。
 *
 * ## 六档里为什么有两档单独处理
 *
 * `medium` 与 `plain` 的系数都是 1（作者刻意如此：手册的「中句」与「平常」
 * 都不该改单条字数），所以这两档的上限**必须相同**。断言它们不同就是错的。
 * 因此本脚本对比的不是「六档两两不同」，而是**每一档与 `plain` 的关系**：
 *
 * | 档 | 与 plain 比 |
 * |---|---|
 * | `burst` | 更小 |
 * | `medium` | 相同（刻意的） |
 * | `plain` | 基准 |
 * | `long-single` | 更大 |
 * | `clipped` | 更小 |
 * | `ellipsis` | 更小（困是「短句」，手册说的） |
 *
 * 用法：node cordis-host/check-shape.mjs
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
 * `ondra-path-layout` 不能漏：`ondra-rhythm` 的配置来自四层合并，
 * 而合并要 `ondra-config-schema` 知道 root 在哪。少了它整条链会退成默认值，
 * 本脚本的「同一设置下只换档位」这个前提就不成立了。
 */
const NEEDED = ['ondra-path-layout', 'ondra-rhythm']

const dataDir = new URL('../.shots/shape-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

/*
 * `maxCharsPerMessage` 钉死 40（出厂值）。
 *
 * 不钉的话，用户配置会改基准，而本脚本的断言是「相对 plain 的大小关系」——
 * 基准一变，`clipped` 的 0.5 系数可能因为下限 8 的夹紧而与 `burst` 的 0.75
 * 撞成同一个数（40×0.5=20、40×0.75=30，碰不到；但若基准是 12，
 * 12×0.5=6 → 夹到 8，12×0.75=9，仍然分得开）。钉死是为了让失败信息可读。
 */
const base = 40

const result = await loadCore(ctx, {
  enable: NEEDED,
  configs: {
    'ondra-path-layout': { root: dataDir },
    'ondra-rhythm': { maxCharsPerMessage: base },
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

console.log('=== 句形档全覆盖核对（O-031 六档 → O-038 单条上限）===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)

const rhythm = ctx.get('ondra-rhythm')
check('ondra-rhythm 已注册', rhythm !== undefined)
if (rhythm === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * 正文用同一段，且**足够长**（200 字），保证单条上限真的会切。
 * 太短的正文会让上限夹紧后不影响输出，`maxCharsPerMessage` 就退回成
 * 「没被用上的配置值」——那样即使表里缺键也测不出来。
 */
const TEXT = '今天下午把窗台上的那盆绿萝转了个方向，让它另一边也能晒到太阳。'.repeat(6)

/** 跑一档，返回实际生效的单条上限。 */
function capOf(shape) {
  const plan = rhythm.plan({ text: TEXT, at: new Date('2026-11-13T14:00:00+08:00').getTime(), style: { sentenceShape: shape }, rng: () => 0.99 })
  return plan.maxCharsPerMessage
}

console.log('\n--- 1. 六档逐个跑一遍 ---')
const SHAPES = ['burst', 'medium', 'plain', 'long-single', 'clipped', 'ellipsis']
const caps = new Map()
for (const shape of SHAPES) {
  const cap = capOf(shape)
  caps.set(shape, cap)
  console.log(`    ${shape.padEnd(12)} → 单条上限 ${String(cap)}`)
}

const plain = caps.get('plain')
check('基准档 plain 的上限等于配置值', plain === base, `plain=${String(plain)} / base=${String(base)}`)

console.log('\n--- 2. 每一档与 plain 的关系（判据是派生量，不抄实现）---')
check('burst 是短句：上限小于 plain', caps.get('burst') < plain, `${String(caps.get('burst'))} < ${String(plain)}`)
check('medium 与 plain 数值相同（手册无「中句」字数要求，刻意如此）', caps.get('medium') === plain, `${String(caps.get('medium'))} = ${String(plain)}`)
check('long-single 是一条说完：上限大于 plain', caps.get('long-single') > plain, `${String(caps.get('long-single'))} > ${String(plain)}`)
check('clipped 是极短：上限小于 plain', caps.get('clipped') < plain, `${String(caps.get('clipped'))} < ${String(plain)}`)

/*
 * ## 这段是本轮修复的核心断言
 *
 * `ellipsis` 在修复前会落到 `PLAIN_SHAPE`，于是 `caps.get('ellipsis') === plain`。
 * 只写「小于 plain」还不够狠：万一有人把它的系数也改成 1（与 `medium` 同待遇），
 * 语义就错了——手册对「困」明写「短句含省略」，短句是硬要求。
 */
check(
  'ellipsis（困）是短句：上限小于 plain —— 缺这个键时这里会红',
  caps.get('ellipsis') < plain,
  `${String(caps.get('ellipsis'))} < ${String(plain)}`,
)

console.log('\n--- 3. 反例：不认识的档名必须留诊断，且仍能出计划 ---')
/*
 * 回落本身是对的（总比抛错强），错的是**回落无声**。修复前查表没有日志，
 * 一个拼错的档名会静默用常句跑到底。
 *
 * 这里不去抓日志文本（那会把断言与措辞绑死，改一个字就红），
 * 只验两件结构性的事：
 * - 未知档名不抛错，仍返回一个可用计划；
 * - 未知档名的上限等于 plain（回落行为仍在，没被改成「抛错」）。
 *
 * 「有没有告警」这件事由 `service.ts` 的 `shapeOfStyle()` 负责，
 * 它读 `this.deps.log.warn?.()`；日志是可选端口，缺了不该崩。
 */
let unknownPlan
let threw
try {
  unknownPlan = rhythm.plan({ text: TEXT, at: Date.now(), style: { sentenceShape: 'no-such-shape' }, rng: () => 0.99 })
} catch (error) {
  threw = error
}
check('未知句形档不抛错（回落而非拒绝）', threw === undefined, threw === undefined ? '' : String(threw))
check('未知句形档回落成 plain 的单条上限', unknownPlan?.maxCharsPerMessage === plain, `${String(unknownPlan?.maxCharsPerMessage)} = ${String(plain)}`)
check('未知句形档仍能出正文', (unknownPlan?.messages.length ?? 0) > 0, `${String(unknownPlan?.messages.length ?? 0)} 条`)

console.log('\n--- 4. 缺省句形是正常情形，不是缺陷 ---')
/*
 * 调用方不传 `style`（也就没有 `sentenceShape`）时必须静默用 plain。
 * 这一条是「反例的反例」：如果 `shapeOfStyle()` 把 `undefined` 也当异常报警，
 * 那每一次没有情绪数据的正常对话都会刷一条告警，把真问题淹掉。
 *
 * 判据只看行为（上限 = plain），不看日志——理由同第 3 段。
 */
const noStyle = rhythm.plan({ text: TEXT, at: Date.now(), rng: () => 0.99 })
check('不传句形档时上限等于 plain', noStyle.maxCharsPerMessage === plain, `${String(noStyle.maxCharsPerMessage)} = ${String(plain)}`)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
