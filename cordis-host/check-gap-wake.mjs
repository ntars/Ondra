/**
 * 执念「够不够格开口」的端到端核对。
 *
 * ## 为什么要有这个脚本（它测的是一个真缺陷）
 *
 * `ondra-proactive-reason` 的 `KIND_ORDER` 把 `gap` 排在第一位，且排序是
 * **字典序**（`score = 序位分 + 权重`，序位相差 1 就值 10 分，权重最多值 1 分）。
 * 于是只要池里有一条 open，它就压过所有承诺与待办——**不管张力多少**。
 *
 * 而 `ondra-drive-gap` 的 `open()` 默认 `base = 40`，唤醒线是 `WAKE_TENSION = 80`。
 * 两件事凑起来：用户刚说一句让她答不上来的话，她就拿这条**刚出生、只有 40 张力、
 * 并不压人**的事当由头开口，而「答应过明天打印合同」这样的真承诺被压到后面。
 *
 * 这与 §5.1 的本意正相反：执念排第一是因为「压得她静不下来的事该先说」，
 * 40 张力的新执念不构成「压不住」。
 *
 * ## 三种状态各验一遍（只验一档必漏）
 *
 * | `gapEligible` | 期望 | 验的是什么 |
 * | --- | --- | --- |
 * | `undefined` | 照常产 gap 候选 | 没问到时不该让她失声（面板/旧调用方仍走这条） |
 * | `false` | 不产 gap，承诺顶上 | 本轮修的缺陷本身 |
 * | `true` | 产 gap | 反面：不能一味压掉执念 |
 *
 * ## 为什么用真插件而不是打桩
 *
 * 上一轮的教训（记在 `2026-08-*` 日志里）：grep 类断言在「A 写、B 读、
 * 中间少根线」的断裂上恒真。唯一口径是真装载一次，读插件**自己的视图**。
 *
 * 用法：node cordis-host/check-gap-wake.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

/* 这条链的依赖是确定的六个：数据根 → 存储 → 内核 → 承诺 → 缺口 → 话由。
 * `ondra-path-layout` 不能漏：`ondra-store-sqlite` 拿不到路径就直接不注册
 * 服务，于是下游全部静默退到内存态（服务在、`available` 全 true、重启即空）。 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-memory-core',
  'ondra-memory-prospective',
  'ondra-memory-intake',
  'ondra-drive-gap',
  'ondra-proactive-reason',
]

/* 每次跑之前清空。判据里有「池子从 0 变 1」，库若沿用上一次的，起点就是 1，
 * 断言必然失败——而一个只在第一次能过的检查脚本等于没有检查脚本。 */
const dataDir = new URL('../.shots/gap-wake-check/', import.meta.url).pathname
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

console.log('=== 执念唤醒资格 · 端到端核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) console.log(`  ! ${item.id}：${item.reason}`)

const gap = ctx.get('ondra-drive-gap')
const intake = ctx.get('ondra-memory-intake')
const prospective = ctx.get('ondra-memory-prospective')
const reason = ctx.get('ondra-proactive-reason')

console.log('\n--- 0. 四个服务是否都在 ---')
check('ondra-drive-gap 已注册', gap !== undefined)
check('ondra-memory-intake 已注册', intake !== undefined)
check('ondra-memory-prospective 已注册', prospective !== undefined)
check('ondra-proactive-reason 已注册', reason !== undefined)

if (gap === undefined || intake === undefined || prospective === undefined || reason === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * 造出「一条刚出生的执念 + 一条到点的承诺」这个局面。
 *
 * 为什么这条承诺要真的走 `intake.ingest()` 而不是直接 `remember()`：
 * 前者是用户真会说出口的那条路径（`promise.ts` 的检测规则），后者绕过了
 * 检测。本轮验的是「用户交代的事会不会被执念压掉」，若绕过检测，
 * 验的就不是用户那条路。
 */
console.log('\n--- 1. 造局面：一条 40 张力的新执念 + 一条到点的承诺 ---')

await intake.ingest({
  turnId: 'wake-check-1',
  at: Date.now(),
  lines: [
    { role: 'user', text: '记得明天把合同打出来。' },
    { role: 'assistant', text: '好，我记着。' },
  ],
})

/* 让她在下一轮答不上来 —— 这会在池里开一条 base=40 的执念。
 * 走 `ingest` 而不是 `gap.open()`：同一条用户真正会经历的路径。 */
await intake.ingest({
  turnId: 'wake-check-2',
  at: Date.now(),
  lines: [
    { role: 'user', text: '那个接口的参数顺序是怎样的？' },
    { role: 'assistant', text: '这个我也不太确定，得回头看下文档。' },
  ],
})

const top = gap.highestTension()
const promises = prospective.dueForReminder()
check('池里有一条 open 的执念', gap.stats().open >= 1, `open=${String(gap.stats().open)}`)
check('这条执念张力是出生值（远低于唤醒线 80）', (top?.tension ?? 100) < 80, `tension=${String(top?.tension?.toFixed(1))}`)

/*
 * 承诺要能进 `dueForReminder()`，前提是它「到点或进宽限期」。
 * 刚 `remember()` 的承诺 `dueAt` 在明天，今天不会出现在这个视图里——
 * 那样本脚本就验不出「承诺被压掉」，因为压根没有承诺可压。
 *
 * 于是这里补一条**已到点**的承诺（`dueAt` 给过去）。它仍走
 * `prospective.remember()`，是插件自己的公开入口，不是打桩。
 */
const now = Date.now()
try {
  prospective.remember('明天要交那本周报', { dueAt: now - 60_000 })
} catch (error) {
  console.log(`  ! remember 失败：${String(error)}`)
}
const due = prospective.dueForReminder()
check('至少有一条到点的承诺可当话由', due.length >= 1, `due=${String(due.length)}`)

console.log('\n--- 2. 三档资格各验一遍（只验一档必漏）---')

/* 档一：`undefined` —— 没问到时照常产执念候选。
 * 这是兼容旧调用方与面板的那一支，不能因为「没人问」就一条都看不见。 */
{
  const plan = reason.plan({})
  check('gapEligible 缺省 → 仍产 gap 候选', plan.pick?.kind === 'gap', plan.pick?.kind)
  check('gapEligible 缺省 → sources.gap 为 true', plan.sources.gap === true)
}

/* 档二：`false` —— 执念不够格，承诺必须顶上。
 * 这是本轮修掉的缺陷本身：修之前这里仍是 `gap`。 */
{
  const plan = reason.plan({ gapEligible: false })
  check('gapEligible=false → 不产 gap 候选', plan.pick?.kind !== 'gap', plan.pick?.kind)
  check('gapEligible=false → 承诺顶上（pick.kind=promise）', plan.pick?.kind === 'promise', plan.pick?.kind)
  /* `sources.gap` 仍为 true：它说的是「缺口池在位」，不是「产了候选」。
   * 这两件事混成一个字段，面板就再也说不清「她为什么没提那件事」——
   * 是池子里没有，还是池子在但放不下。 */
  check('gapEligible=false → sources.gap 仍为 true（池子在位）', plan.sources.gap === true)
}

/* 档三：`true` —— 反面。不能一味压掉执念，否则「压不住的事」永远说不出口。 */
{
  const plan = reason.plan({ gapEligible: true })
  check('gapEligible=true → 仍以 gap 为 pick', plan.pick?.kind === 'gap', plan.pick?.kind)
}

console.log('\n--- 3. 判据的真源在插件，不在宿主 ---')

/* `dueForWake()` 是那四条判据的唯一真源。这里直接问它，确认「40 张力不够格」
 * 这个结论是**插件自己给的**，不是本脚本或宿主猜的。 */
const decision = gap.dueForWake({ idleMinutes: 60, energy: 80 })
check('dueForWake() 此刻说「不唤醒」', decision.wake === false)
check('拦在张力上（不是能量/闲置/冷却）', decision.blockedBy === 'tension-low', decision.blockedBy)

/* 反过来：把张力抬到线上，同一组读数就该放行。
 * 这一档是为了证明「拦在张力」不是恒拦——否则上一条断言在实现写死
 * `wake: false` 时也照样绿。 */
if (top !== undefined) {
  gap.relieve(top.id, 0)
  /* `relieve` 只能加压不能减，故直接改 `base` 没有公开入口。
   * 用 `open()` 一条 base=90 的执念——池子按张力降序，它会成为新的最高。 */
  gap.open({ text: '那个接口的参数顺序是怎样的', source: 'model-unsure', base: 90 })
  const raised = gap.dueForWake({ idleMinutes: 60, energy: 80 })
  check('张力抬到线上后 → 放行', raised.wake === true, raised.blockedBy ?? 'wake')
}

console.log('\n--- 4. markDelivered 真的记账（此前恒为 0）---')

/* 本轮之前 `markDelivered()` 全仓零调用方：`delivered` 恒 0、`picks` 恒 0、
 * `lastWakeAt` 恒 0。三个字段同时为 0 是「接口在，但没人用」的典型形态——
 * 面板照样显示，用例照样通过，只有「她重复说同一件事」会慢慢显出来。 */
const beforeStats = gap.stats()
const target = gap.highestTension()
if (target !== undefined) {
  const ok = gap.markDelivered(target.id)
  const afterStats = gap.stats()
  check('markDelivered() 返回 true', ok === true)
  check('delivered 计数器 +1', afterStats.counters.delivered === beforeStats.counters.delivered + 1,
    `${String(beforeStats.counters.delivered)} → ${String(afterStats.counters.delivered)}`)
  check('picks 落在那一条上', (gap.get(target.id)?.picks ?? 0) === 1, `picks=${String(gap.get(target.id)?.picks)}`)
  check('lastWakeAt 被刷新（冷却闸从此生效）', gap.stats().lastWakeAt > 0, `lastWakeAt=${String(gap.stats().lastWakeAt)}`)

  /* 冷却闸生效的反面证据：刚投递过，同一组读数应当被拦在冷却上。 */
  const cooled = gap.dueForWake({ idleMinutes: 60, energy: 80 })
  check('刚投递后 → 被冷却闸拦住', cooled.wake === false && cooled.blockedBy === 'cooldown', cooled.blockedBy)
}

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
