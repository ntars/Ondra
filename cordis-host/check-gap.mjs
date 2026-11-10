/**
 * 缺口链的端到端实物核对。
 *
 * ## 为什么必须真装载一次
 *
 * 前几轮反复在这里踩坑：只 grep「A 写了没有、B 读没读」，判据恒真，
 * 而真正断的是中间那根线。唯一可靠的口径是**把真插件装进真上下文，
 * 喂一轮真对话，然后去读上游自己的视图**（`list()` / `highestTension()`）。
 *
 * 本轮要证的事有四条，缺一条这条链就还是空转：
 *
 * 1. `ondra-drive-gap` 能装载，且 `available === true`（有存储端口）。
 * 2. `ondra-memory-intake` 收一轮「她说了不知道」，池子里真的多一条 open。
 * 3. 那条缺口能经 `highestTension()` 被 `ondra-proactive-reason` 取成话由，
 *    且 `sources.gap === true`（不是「装上了但没内容」）。
 * 4. 判据的反面：用户说「不知道」**不进**池；「我不知道你这么早回来」
 *    这句口语惊讶**不进**池（本轮新加的否决窗口）。
 *
 * 用法：node cordis-host/check-gap.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore, members } from './plugins/ondra-core/lib/index.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

/* 只装这条链需要的成员。装全部 134 个会让本脚本跑 40 秒以上，
 * 而这条链的依赖是确定的六个：数据根 → 存储 → 内核 → 承诺 → 缺口 → 话由。
 *
 * **`ondra-path-layout` 不能漏。** `ondra-store-sqlite` 的 `path` 默认为空，
 * 空时必须向路径服务要文件位置；拿不到它就**直接不注册服务**（不是报错、
 * 不是降级提示），于是下游全部静默退到内存态。这条链第一次跑就是这样：
 * 服务全在、`available` 全 true、池子恒空，而 `store=none` 是唯一线索。 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-memory-core',
  'ondra-memory-prospective',
  'ondra-memory-intake',
  'ondra-drive-gap',
  'ondra-proactive-reason',
]

// 存储要一个真实目录。这里用 `.shots/` 下的隔离目录，避免把测试数据写进
// 用户真实库（`~/Library/Application Support/com.ntars.ondra`）。
//
// **每次跑之前先清空**：判据里有「池子从 0 变 1」，库若沿用上一次的，
// 起点就是 1，断言必然失败。这不是功能问题，是脚本不幂等——而一个
// 只在第一次能过的检查脚本，等于没有检查脚本（第二次就是红色，
// 而人会把红色当噪音）。
const dataDir = new URL('../.shots/gap-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

/* 与宿主同款注入：数据根由调用方给定，不让插件自己猜 `~/.ondra`。
 * 少了这一句，`path-layout` 会把库写到 `~/.ondra/user/ondra.db`，
 * 与本脚本要验的目录不是一处——于是「写进去了」和「读得到」验的是两个库。 */
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

console.log('=== 缺口链端到端核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) console.log(`  ! ${item.id}：${item.reason}`)

const gap = ctx.get('ondra-drive-gap')
const intake = ctx.get('ondra-memory-intake')
const reason = ctx.get('ondra-proactive-reason')

console.log('\n--- 1. 三个服务是否都在 ---')
check('ondra-drive-gap 已注册', gap !== undefined)
check('ondra-memory-intake 已注册', intake !== undefined)
check('ondra-proactive-reason 已注册', reason !== undefined)
check('缺口池可用（有存储端口）', gap?.available === true, gap?.reason ?? `store=${String(gap?.stats?.().storeProvider)}`)

if (gap === undefined || intake === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/*
 * 存储后端**必须是 sqlite**，不能只看 `available`。
 *
 * `GapStats.available` 在「没有存储端口」时**仍然是 true**——那是插件
 * 刻意的设计（内存态照常记、照常判，只是重启丢，见 `GapUnavailableReason`
 * 的注释）。所以 `available === true` 证明不了「落盘可用」：
 * 本轮第一版断言就是这么写的，`store=none` 的时候它照样打勾，
 * 而池子其实是内存的。唯一能证明落盘的判据是 `storeProvider`。
 */
const provider = gap.stats().storeProvider
check('缺口池落到 sqlite（不是内存态）', provider === 'sqlite', `store=${provider}`)

console.log('\n--- 2. 判据正面 / 反面（纯判定，不落库）---')
// 正面：真的是「一件事没弄明白」。
check('「这个接口的参数顺序我不确定」命中', gap.detect('这个接口的参数顺序我不确定。') !== undefined)
check('「我查不到那家店的营业时间」命中', gap.detect('我查不到那家店的营业时间。') !== undefined)
// 反面一：在说用户，不是在自认无知。
check('「你不知道我在想什么」不命中', gap.detect('你不知道我在想什么吧。') === undefined)
// 反面二（本轮新增的否决窗口）：口语惊讶，没有留下待解的问题。
check(
  '「我不知道你今天这么早回来」不命中',
  gap.detect('我不知道你今天这么早回来。') === undefined,
)
// 反面三：含糊是修辞，不是缺口。
check('「我觉得这样挺好」不命中', gap.detect('我觉得这样挺好的。') === undefined)

console.log('\n--- 3. 喂一轮真对话，池子里是否真的多一条 ---')
const before = gap.stats().open

await intake.ingest({
  turnId: 'gap-check-1',
  at: Date.now(),
  lines: [
    { role: 'user', text: '你知道那个接口的参数顺序吗？' },
    // 这一轮她答不上来 —— 应当进池子。
    { role: 'assistant', text: '这个我也不太确定，得回头看下文档。' },
  ],
})

const after = gap.stats().open
check('池子里多了一条 open', after === before + 1, `${String(before)} → ${String(after)}`)

const top = gap.highestTension?.()
check('highestTension() 取得到', top !== undefined, top === undefined ? '仍是空池' : `张力 ${String(top.tension)}`)
check('取到的那条来源是 model-unsure', top?.source === 'model-unsure', top?.source)
/*
 * 「取整句」的判据是**这句话本身完整**，不是「含某个关键词」。
 *
 * 第一版这里断言 `includes('不确定')`，而实际正文是「这个我也不太确定…」
 * ——`不**太**确定` 里插了一个「太」，子串匹配落空，于是一条正确的实现
 * 被判成失败。这类断言的错法很隐蔽：它测的是「我猜的实现细节」，
 * 不是「§5.1 说的那个行为」。这里改为按规范原文验形状：正文必须是
 * 那一整句（去掉句末标点后等于原句），而不是被截成「不确定」三个字。
 */
const topText = (top?.text ?? '').replace(/[。！？.!?]+$/u, '')
check('正文是整句（不是关键词）', topText === '这个我也不太确定，得回头看下文档', top?.text)

console.log('\n--- 4. 反面：用户说的「不知道」不该进池 ---')
const beforeUser = gap.stats().open
await intake.ingest({
  turnId: 'gap-check-2',
  at: Date.now(),
  lines: [
    { role: 'user', text: '我不知道这个怎么弄。' },
    { role: 'assistant', text: '那我给你看看，别急。' },
  ],
})
check('用户说的不记成她的执念', gap.stats().open === beforeUser, `${String(beforeUser)} → ${String(gap.stats().open)}`)

console.log('\n--- 5. 话由是否真的把这条件取成候选 ---')
const plan = reason?.plan?.()
check('reason 的 sources.gap 为 true', plan?.sources?.gap === true)
check('pick 的 kind 是 gap（执念优先级最高）', plan?.pick?.kind === 'gap', plan?.pick?.kind)
check('pick 的正文非空', (plan?.pick?.text ?? '').trim() !== '', plan?.pick?.text)

await ctx.fiber.dispose()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
