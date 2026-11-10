/**
 * 系统提示词装配的端到端核对。
 *
 * ## 为什么要有这个脚本（它测的是一个跨了五轮的老账）
 *
 * 记忆日志里连着三轮写着「`fragment()` 接上去是假的」「先定系统提示词归属」。
 * 本轮查清的事实比原先记的更深一层：**不只是没有装配位置，连人格链自己
 * 也产不出内容**——`ondra-persona-core` 报 `no-loader`，因为人设包目录
 * `cordis-host/content/personas/bundled` 在 v2.0.1 换代时丢了。
 *
 * 所以这个脚本要同时钉住三件事：
 *
 * | 断言组 | 防的是什么 |
 * | --- | --- |
 * | 人格链在位 | 三个成员缺一个，`assemble()` 恒 0 字 |
 * | 装配产出非空 | 「服务在、但产不出」与「服务不在」症状一样，只有读产出能分清 |
 * | 装配不抛错 | 装配失败不该让整轮对话发不出去 |
 *
 * ## 为什么必须真装载，不能 grep
 *
 * 本仓库已经栽过三次（记忆日志 2026-11-08 第十三 / 十五 / 十六段）：
 * 「A 写、B 读、中间少根线」这种断裂，`grep` 恒真——因为字符串确实在
 * 两个文件里都出现过。唯一口径是真装载一次，读插件**自己的视图**。
 *
 * 用法：node cordis-host/check-system-prompt.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { assembleSystemPrompt } from './lib/src/system-prompt.js'

/* 每次跑之前清空。`ondra-store-sqlite` 会在这个目录建库，
 * 沿用上一次的会让「起点」不确定——而只在第一次能过的脚本等于没有脚本。 */
const dataDir = new URL('../.shots/system-prompt-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

/* 人格链四个成员 + 它们的数据前提。
 *
 * `ondra-path-layout` / `ondra-store-sqlite` 不是人格的一部分，但
 * `persona-loader` 的可用性依赖数据根（它要扫描用户人设目录）。少这两个，
 * 脚本会在一个与本轮无关的地方失败。 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-persona-loader',
  'ondra-persona-core',
  'ondra-persona-vars',
  'ondra-persona-assemble',
]

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href
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

console.log('=== 系统提示词装配 · 端到端核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) console.log(`  ! ${item.id}：${item.reason}`)

/* ---------------------------------------------------------------- *
 * 1. 人格链四个成员都在位
 * ---------------------------------------------------------------- */

console.log('\n--- 1. 人格链成员 ---')
const loader = ctx.get('ondra-persona-loader')
const core = ctx.get('ondra-persona-core')
const vars = ctx.get('ondra-persona-vars')
const assemble = ctx.get('ondra-persona-assemble')

check('ondra-persona-loader 已注册', loader !== undefined)
check('ondra-persona-core 已注册', core !== undefined)
check('ondra-persona-vars 已注册', vars !== undefined)
check('ondra-persona-assemble 已注册', assemble !== undefined)

if (loader === undefined || core === undefined || vars === undefined || assemble === undefined) {
  console.log('\n成员缺席，无法继续。')
  await ctx.fiber.dispose()
  process.exit(1)
}

/* ---------------------------------------------------------------- *
 * 2. 人设包被找到了（这是本轮修的最上游一处）
 * ---------------------------------------------------------------- */

console.log('\n--- 2. 人设包 ---')
/*
 * `persona-core` 的 `available` 是这条链的**总闸**：它 false 的时候
 * `assemble()` 一定产 0 字，而且报告里只有一句 `no-core`，看不出根因是
 * 「loader 没装」还是「人设包丢了」。所以这一组断言必须分开验到人设包一级。
 */
check('persona-core 可用（不是 no-loader）', core.available === true, core.available ? undefined : String(core.reason))

const personas = loader.list()
check('加载器找到人设包', Array.isArray(personas) && personas.length > 0, `${String(personas?.length ?? 0)} 个`)
const active = loader.active()
check('有一个生效的人设', active !== undefined, active === undefined ? undefined : active.id)

/* ---------------------------------------------------------------- *
 * 3. 装配真的产得出（不是「服务在但空转」）
 * ---------------------------------------------------------------- */

console.log('\n--- 3. 装配产出 ---')
const prompt = assembleSystemPrompt(ctx)

check('装配不抛错（已由上一行隐含）', true)
check('产出非空', prompt.chars > 0, `${String(prompt.chars)} 字`)
check('含人格段', prompt.parts.some(part => part.id === 'persona'))
/*
 * 300 字是「真的有内容」的下限，不是审美判断：一个只有段标题的四段拼装
 * 也能到 40–60 字，而真人格（六槽位）实测 3.9k–7.7k。定 300 是为了
 * 让「人设包在、但槽位全空」这种半坏状态也能被抓到。
 */
check('人格正文有实质内容（> 300 字）', prompt.chars > 300, `${String(prompt.chars)} 字`)
check('没有「人格不可用」的缺项', !prompt.missing.some(item => item.startsWith('人格')), prompt.missing.join('；'))

/* ---------------------------------------------------------------- *
 * 4. 裁剪状态如实上报
 * ---------------------------------------------------------------- */

console.log('\n--- 4. 裁剪状态 ---')
/*
 * 这一组刻意**不假设** `truncated` 是 true 还是 false。
 *
 * 它的值取决于当前默认预算与所用的人设包：实测「哦鲸鲸」在 2600 下必裁，
 * 换一个更短的人设包可能就不裁。断言「一定被裁」会把测试写死在一个
 * 特定人设包上，换包就红——而红的是测试，不是产品（这类坑本仓库踩过四次）。
 *
 * 所以只验**自洽性**：报了裁剪，就必须真的超了预算；
 * 没报裁剪，装配报告里也不许有丢弃。
 */
const direct = assemble.assemble()
const reportDropped = direct.report?.droppedCount ?? 0
const reportOver = direct.report?.overBudget === true
if (prompt.truncated) {
  check('报裁剪时确实有丢弃或超预算', reportDropped > 0 || reportOver, `dropped=${String(reportDropped)} over=${String(reportOver)}`)
} else {
  check('未报裁剪时装配报告也没有丢弃', reportDropped === 0 && !reportOver, `dropped=${String(reportDropped)}`)
}

/* ---------------------------------------------------------------- *
 * 5. 幂等（同一进程内连调两次结果一致）
 * ---------------------------------------------------------------- */

console.log('\n--- 5. 幂等 ---')
const again = assembleSystemPrompt(ctx)
/*
 * 只比字符数，不比全文：全文可能因为「浓度」「时间感」这类含当前时刻的
 * 段落而变，那是设计如此，不是缺陷。字符数一致足以证明「没有累积追加」——
 * 而累积追加正是把系统提示词错拼进历史时最典型的表现。
 */
check('连调两次字符数一致', again.chars === prompt.chars, `${String(prompt.chars)} / ${String(again.chars)}`)

/* ---------------------------------------------------------------- */

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}

await ctx.fiber.dispose()
process.exit(failures.length === 0 ? 0 : 1)
