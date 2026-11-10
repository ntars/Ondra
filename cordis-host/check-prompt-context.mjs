/**
 * 运行时上下文的端到端核对。
 *
 * ## 它钉的是哪一处断口（本仓第六次同形态）
 *
 * `ondra-prompt-inject` 从写完那天起就在做一件对的事：把八块记忆渲染成一段
 * 正文，挂进宿主的系统提示词。它调 `ctx.get('systemPrompt')`，拿不到就
 * `ctx.inject(['systemPrompt'], …)` 等它出现。
 *
 * 宿主这边**从来没有 provide 过这个键**——只是在自己的请求处理函数里直接调
 * `assembleSystemPrompt(ctx)`。于是插件永远等不到，只打一行
 * 「注入装箱已就绪但无人阅读」warn；而它的 `stats()` 照常可读、界面照常
 * 「只要有数据就显示有」，唯一体现是**她从来不提记忆里的任何事**。
 *
 * 本轮补的是那个位置（`src/prompt-context.ts` + 装配里的第三段）。
 *
 * | 断言组 | 防的是什么 |
 * | --- | --- |
 * | 服务真被 provide | 「宿主写了 provide 但漏了 effect」这类假接通 |
 * | 插件走的是直路 | 走 `inject` 也不是错，但「直路通」才说明顺序对（provide 早于 loadCore） |
 * | 话头真透传 | `query` 传了但没进求值函数 —— 会让她永远按「无检索词」渲染 |
 * | 无话头缺席而非空串 | 主动开口那轮不编检索词，也不产出空段污染提示词 |
 * | 单段抛错被隔离 | 一段坏掉不该让整轮装配失败 |
 * | 顺序：上下文在情绪之前 | 情绪是「这一轮的语气指令」，必须最后一句 |
 * | 幂等 | 同一输入两跑字符数一致（乱序会让前缀缓存全废） |
 *
 * ## 为什么必须真装载
 *
 * 本仓已在记忆日志里栽过四次（第十三 / 十五 / 十六 / 十八段）：`grep` 恒真，
 * 因为字符串在两个文件里都出现过。唯一口径是真装载一次，读**注册表的实际
 * 内容**与**装配的实际产出**。
 *
 * 用法：node cordis-host/check-prompt-context.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { assembleSystemPrompt } from './lib/src/system-prompt.js'
import { ContextRegistry, SYSTEM_PROMPT_SERVICE_KEY } from './lib/src/prompt-context.js'

/* 每次跑前清空：沿用上一次的库会让「起点」不确定，而只在第一次能过的脚本
 * 等于没有脚本（第十七段踩过：检查脚本不幂等，第二次就红，红被当噪音）。 */
const dataDir = new URL('../.shots/prompt-context-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-memory-core',
  'ondra-memory-pool',
  'ondra-prompt-inject',
  /* 情绪链两个成员：第 6 组要验「上下文排在情绪之前」，情绪段必须在场。
   * `emotion-project` 单独装会 `no-state`（缺 express 没状态可投影），
   * 两个一起才算覆盖到那一格。 */
  'ondra-emotion-core',
  'ondra-emotion-express',
  'ondra-emotion-project',
]

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href
const registry = new ContextRegistry()
ctx.effect(() => ctx.provide(SYSTEM_PROMPT_SERVICE_KEY, registry), 'check: 注册上下文')

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

console.log('=== 运行时上下文 · 端到端核对 ===')

console.log('\n--- 1. 装配前置 ---')
const loaded = new Set(result.loaded)
check('ondra-prompt-inject 已装载', loaded.has('ondra-prompt-inject'))
check('ondra-memory-pool 已装载', loaded.has('ondra-memory-pool'))
check('宿主提供了 systemPrompt 服务', ctx.get(SYSTEM_PROMPT_SERVICE_KEY) === registry)

console.log('\n--- 2. 插件走了直路（provide 早于 loadCore）---')
/*
 * 走 `inject` 分支不是错误，但那条路说明 provide 晚于插件装载。
 * 两条路都通，可「直路」证明顺序对；顺序错了，插件在装载期看到的是一个
 * 「宿主没有这个服务」的世界，将来任何在装载期就要读登记的代码都会失效。
 */
check('注册表里已有插件登记的段', registry.size > 0, `size=${String(registry.size)}`)
check(
  '登记名与本插件契约一致',
  registry.names().includes('ondra:injection'),
  registry.names().join(', ') || '(空)',
)

console.log('\n--- 3. 话头透传 ---')
/*
 * 用替身登记一段「回显话头」的上下文，验的是**宿主传给求值函数的 query**，
 * 而不是嗅探插件内部。替身与真实插件走同一个 `context()` 接口。
 */
let seenQuery
const disposeProbe = registry.context({
  name: 'check:probe',
  order: 999,
  text: (context) => {
    seenQuery = context.query
    return context.query === undefined ? '' : `probe:${context.query}`
  },
})
const withQuery = assembleSystemPrompt(ctx, '你还记得我叫什么吗')
check('求值函数收到了话头', seenQuery === '你还记得我叫什么吗', String(seenQuery))
const withQueryPart = withQuery.parts.find(part => part.id === 'context')
check('上下文段真的进了提示词', withQueryPart !== undefined)
check(
  '上下文段正文含替身回显',
  withQueryPart?.text.includes('probe:你还记得我叫什么吗') === true,
)

console.log('\n--- 4. 无话头时缺席 ---')
const noQuery = assembleSystemPrompt(ctx)
check('主动开口那一轮不产出上下文段', noQuery.parts.every(part => part.id !== 'context'))

console.log('\n--- 5. 单段抛错被隔离 ---')
const disposeBoom = registry.context({
  name: 'check:boom',
  order: 1,
  text: () => {
    throw new Error('故意炸')
  },
})
const boom = assembleSystemPrompt(ctx, '测试')
check('抛错段记进了 missing', boom.missing.some(item => item.includes('check:boom')))
check('其余段照常产出', boom.parts.some(part => part.id === 'context'))
disposeBoom()

console.log('\n--- 6. 顺序：上下文在情绪之前 ---')
/*
 * 情绪段是「这一轮该怎么开口」的行为指令，必须压在所有内容之后。
 * 若 `context` 排到它后面，模型读到的最后一句就变成了旧事而不是语气，
 * 这正是 §8.5 那条规则的由来。
 *
 * ## 为什么这里要区分「通过」与「未覆盖」
 *
 * 第一版只写 `contextAt < emotionAt`。而情绪段**可以合法地不在场**
 * （投影拒绝产出是正常产品行为），此时 `emotionAt === -1`，断言恒真——
 * 于是我把 context 块整体挪到情绪块之后去验，**一条红都没有**。
 *
 * 那是本仓反复记过的「判据假绿」：断言条件里带一个「或者缺席」，
 * 而缺席恰好是常态。修法是让它在缺席时明确报「未覆盖」，
 * 而不是悄悄算作通过。这样每次跑都能看见这一格的覆盖情况。
 */
const ordered = assembleSystemPrompt(ctx, '顺序测试')
const indices = ordered.parts.map(part => part.id)
const contextAt = indices.indexOf('context')
const emotionAt = indices.indexOf('emotion')
if (emotionAt === -1) {
  console.log('  · 未覆盖：这一轮没有情绪段（投影拒绝是正常行为），顺序无法判定')
  console.log('    —— 这条不是通过。要验它，得让投影真的产出一段。')
} else {
  check(
    '上下文段排在情绪段之前',
    contextAt === -1 || contextAt < emotionAt,
    `顺序 ${indices.join(' → ')}`,
  )
}

console.log('\n--- 7. 撤销与幂等 ---')
disposeProbe()
check('撤销后注册表不再含该段', !registry.names().includes('check:probe'), `size=${String(registry.size)}`)
const a = assembleSystemPrompt(ctx, '幂等测试')
const b = assembleSystemPrompt(ctx, '幂等测试')
check('两跑字符数一致', a.chars === b.chars, `${String(a.chars)} / ${String(b.chars)}`)
check('两跑正文逐字相同', a.text === b.text)

console.log('\n--- 8. 装配不抛错 ---')
let threw = false
try {
  assembleSystemPrompt(ctx, undefined)
} catch {
  threw = true
}
check('无话头装配不抛错', !threw)

if (failures.length > 0) {
  console.log(`\n失败 ${String(failures.length)} 条：`)
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过。')
}
