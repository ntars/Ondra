/**
 * 验证 ondra-boot-settle 的核心假设，不启动整个内核。
 *
 * 要证明的一件事：一个「apply 时拿不到依赖」的插件，在依赖就绪后被
 * `fiber.restart()` 重新跑一遍，**能不能拿到依赖**。这是整个补丁的地基——
 * 如果 restart 不会重跑 apply，或者重跑时看不见新服务，其它都不用谈。
 *
 * 场景刻意做得和真机一样：
 *   1. 存储晚 50ms 才 `ctx.provide`（真机上就是开库那几十毫秒）；
 *   2. 消费者在 apply 里同步 `ctx.get`，拿不到就把 `available` 记成 false
 *      （与 `memory-pool` / `snapshot` 的降级分支同形）；
 *   3. 补丁等 `store` 就绪，然后 `restart` 消费者。
 *
 * 期望输出：`RESULT consumer false -> true`，退出码 0。
 *
 * 用法：
 *   node tool/boot_settle_probe.mjs
 *
 * 它从本机装的 `dsh` 反查 cordis 的位置，不写死路径；没装 dsh 时直接跳过
 * （退出码 3 并说明），不当作失败——和 Flutter 侧「没装 dsh 就 skip」同一口径。
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 从 `which dsh` 反查 cordis 包的位置。 */
function resolveCordis() {
  let bin
  try {
    bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
  if (!bin) return null
  // dsh 的 bin 是一个指向 <pkg>/lib/bin.js 的符号链接。
  const real = realpathSync(bin)
  const dshRoot = dirname(dirname(real))
  const require = createRequire(join(dshRoot, 'package.json'))
  try {
    return require.resolve('@deepseek-ai/cordis')
  } catch {
    return null
  }
}

const cordisPath = resolveCordis()
if (!cordisPath) {
  console.log('SKIP 没找到 dsh / @deepseek-ai/cordis（npm i -g @deepseek-ai/dsh）')
  process.exit(3)
}

const { Context } = await import(cordisPath)
const ctx = new Context()

// 1) 慢存储：50ms 后才 provide。
ctx.plugin({
  name: 'slow-store',
  apply(c) {
    setTimeout(() => c.provide('store', { ready: true }), 50)
  },
})

// 2) 消费者：apply 时同步 get，拿不到就降级（与真插件的降级分支同形）。
ctx.plugin({
  name: 'consumer',
  apply(c) {
    const store = c.get('store')
    c.effect(() => c.provide('consumer', { available: store !== undefined }), 'consumer')
  },
})

// 3) 补丁：等 store 就绪 → 宽限 → 重启消费者。
let checks = 0
ctx.plugin({
  name: 'settle',
  apply(c) {
    c.inject(['store'], () => {
      setTimeout(async () => {
        let fiber
        for (const runtime of c.registry.values()) {
          for (const f of runtime.fibers) if (f.name === 'consumer') fiber = f
        }
        if (!fiber) {
          console.log('FAIL 没找到 consumer 的 fiber')
          process.exit(1)
        }
        const before = c.get('consumer')?.available
        await fiber.restart()
        const after = c.get('consumer')?.available
        checks += 1
        console.log(`RESULT consumer ${before} -> ${after}`)
        if (after !== true) {
          console.log('FAIL 重启后仍拿不到依赖')
          process.exit(1)
        }
        // 再重启一次：确认可重复，不会因为已经重启过就失效。
        await fiber.restart()
        const again = c.get('consumer')?.available
        checks += 1
        console.log(`RESULT consumer ${after} -> ${again}（第二次）`)
        process.exit(again === true && checks === 2 ? 0 : 1)
      }, 60)
    })
  },
})

setTimeout(() => {
  console.log('FAIL 3 秒内没有走完（inject 回调没触发？）')
  process.exit(2)
}, 3000)
