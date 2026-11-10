/**
 * 核对空谷核心的装配结果。
 *
 * ## 为什么单独跑一次 loadCore，而不是只看宿主启动日志
 *
 * 宿主日志里「装配完成：装载 134 项」这句话只说明循环走完了，
 * 不说明每一项都真的完成了 `apply`。`loadCore` 的返回值是逐项
 * try/catch 的真实结果，跳过项带着原因——这才是可核对的证据。
 *
 * ## 为什么这个文件放在 cordis-host/ 下而不是 tools/
 *
 * 它 import 了 `@ntars/cordis`，而该包只在 `cordis-host` 的依赖里。
 * 放在 `tools/` 会因为 Node 从脚本所在目录向上找 node_modules 而
 * 解析失败。目录位置在这里不是风格问题，是能否运行的问题。
 *
 * ## 为什么要传满整份启用名单
 *
 * 宿主默认一个核心插件都不装，`loadCore` 在没有启用名单时会把全部成员
 * 标成「默认禁用」并计入 skipped。那是运行时的正确行为，却是这份核对的
 * 错误输入：它要验的是「每个成员能不能起来」，不是「默认策略对不对」。
 * 不传名单的结果恒为 0 成功、134 跳过、退出码 1，看起来像全线故障，
 * 实际什么都没测。所以这里显式启用全部成员，让每一行 try/catch 都真的执行。
 *
 * 用法：
 *   node cordis-host/check-core.mjs
 *
 * 退出码：全部装载成功为 0，有跳过项为 1。
 */

import { Context } from '@ntars/cordis'
import { loadCore, MIGRATED_PLUGIN_COUNT, members } from './plugins/ondra-core/lib/index.js'

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href

// 显式启用全部成员，绕开「默认禁用」这条运行时策略。
const enableAll = members.map((member) => member.id)

const startedAt = Date.now()
const result = await loadCore(ctx, { enable: enableAll })
const elapsed = Date.now() - startedAt

console.log('=== 空谷核心装配结果 ===')
console.log(`声明成员数：${String(MIGRATED_PLUGIN_COUNT)}`)
console.log(`启用名单：  ${String(enableAll.length)}`)
console.log(`成功装载：  ${String(result.loaded.length)}`)
console.log(`跳过：      ${String(result.skipped.length)}`)
console.log(`耗时：      ${String(elapsed)} ms`)

if (result.skipped.length > 0) {
  console.log('')
  console.log('--- 跳过明细 ---')
  for (const item of result.skipped) {
    console.log(`  ${item.id}：${item.reason}`)
  }
}

// 销毁根 Fiber 会触发全部插件的 effect 清理函数。不清理的话脚本会因为
// 残留的定时器与监听器不退出——有些插件确实在 apply 里挂了定时器。
await ctx.fiber.dispose()

process.exitCode = result.skipped.length > 0 ? 1 : 0
