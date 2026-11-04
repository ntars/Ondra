/**
 * `system` 分支：**让内核分配**（等价手册 §6.4 的 `--port 0`）。
 *
 * ## 为什么它是最稳的
 *
 * 号是内核在**绑定成功的那一刻**定下来的，中间不存在「探测到空闲 → 别人抢走」的窗口。
 * 代价只有一个：每次启动号都不同，写不进防火墙白名单。那是运维不便利，不是故障。
 *
 * ## 为什么还要重试一次
 *
 * 内核理论上不会把一个「账本里还活着」的号发出来——但账本是本包的记账，
 * 它记的是「发出过的号」，不是「被占用的号」（见 `ledger.ts`）。两者在
 * `reserve()` 之后会短暂不一致。真撞上时再要一次，比返回一个重复号便宜得多。
 *
 * ## 本文件不 import 任何人的 Config
 *
 * 依赖只有四个函数。这样这个分支可以被单独对着一个假的 `assign` 对拍，
 * 而不需要把整个服务装起来。
 */

import type { PickOutcome, PortSource } from './types.js'

/** `system` 分支需要的依赖。 */
export interface SystemBranchDeps {
  /** 让内核分配一个空闲端口并读出来（内部会计数、内部会超时）。 */
  readonly assign: (host: string) => Promise<number | null>
  /** 这个号是不是还在账本上（过期的不算）。 */
  readonly taken: (port: number) => boolean
  /** 发号出口（服务里唯一的那个）。 */
  readonly accept: (port: number, host: string, source: PortSource) => PickOutcome
  /** 失败出口（服务里唯一的那个）。 */
  readonly fail: (reason: 'probe-failed', detail?: string) => PickOutcome
}

/** 最多向内核要几次。 */
const MAX_ATTEMPTS = 2

/**
 * 让内核挑一个号。
 * @param deps 依赖。
 * @param host 绑定地址。
 */
export async function pickSystem(deps: SystemBranchDeps, host: string): Promise<PickOutcome> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const port = await deps.assign(host)
    if (port === null) return deps.fail('probe-failed', '内核没有分配端口')
    if (deps.taken(port)) continue
    return deps.accept(port, host, 'os-assigned')
  }
  return deps.fail('probe-failed', `内核连续 ${MAX_ATTEMPTS} 次给出的号都在账本里`)
}
