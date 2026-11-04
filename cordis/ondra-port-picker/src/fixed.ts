/**
 * `fixed` 分支：在区间里**顺序扫描**（台账的 `9060–9079`）。
 *
 * ## 为什么升序，不轮转
 *
 * 这个分支的用途是「防火墙只放行 20 个号」。号必须可预测：轮转会让
 * 「上次是 9063」变成排查时的一条假线索，而真正的信息是「区间里还有没有空号」。
 *
 * ## 为什么要跳过两类号
 *
 * 1. **账本里还活着的号**：同一个进程里刚发出去，可能正要被绑。
 * 2. **宿主 `webServer` 已绑的号**：那是 `endpoint` 的号。给监听方就是 `EADDRINUSE`，
 *    而且报错在对方的代码里，不在本包——最难查的一种。
 *
 * 跳过的号**不算进 `tried`**：`tried` 的语义是「真的去绑过但失败的号」。
 * 两者混在一起，「试了 5 个都不行」就分不清是「被占」还是「刚发出去」。
 *
 * ## 扫不完要如实说
 *
 * `maxScan` 到顶就停，并在 `detail` 里写清「区间共 N 个、只试了 M 个」。
 * 悄悄只试前 64 个然后说「没有空号」，会让人去查一个不存在的占用。
 */

import { candidatesOf, formatTried, validateRange } from './policy.js'
import type { PickOutcome, PortRange, PortSource } from './types.js'

/** `fixed` 分支需要的依赖。 */
export interface FixedBranchDeps {
  /** 试绑一个具体端口（内部会计数、内部会超时）。 */
  readonly probe: (port: number, host: string) => Promise<boolean>
  /** 这个号是不是还在账本上。 */
  readonly taken: (port: number) => boolean
  /** 单轮最多试几个号。 */
  readonly maxScan: number
  /** 宿主 `webServer` 已绑的号（要避开）；拿不到为 `null`。 */
  readonly bound: number | null
  /** 发号出口。 */
  readonly accept: (port: number, host: string, source: PortSource) => PickOutcome
  /** 失败出口。 */
  readonly fail: (reason: 'bad-range' | 'no-free-port', detail?: string) => PickOutcome
}

/**
 * 在区间里挑一个能绑上的号。
 * @param deps 依赖。
 * @param host 绑定地址。
 * @param range 区间。
 */
export async function pickFixed(
  deps: FixedBranchDeps,
  host: string,
  range: PortRange,
): Promise<PickOutcome> {
  const verdict = validateRange(range)
  if (!verdict.ok) return deps.fail('bad-range', verdict.detail)

  const candidates = candidatesOf(range, deps.maxScan)
  const tried: number[] = []

  for (const port of candidates) {
    if (deps.bound !== null && port === deps.bound) continue
    if (deps.taken(port)) continue
    tried.push(port)
    const free = await deps.probe(port, host)
    if (!free) continue
    return deps.accept(port, host, 'range-scan')
  }

  const skipped = candidates.length - tried.length
  const truncated = range.end - range.start + 1 > candidates.length
  const detail =
    `区间 ${range.start}–${range.end} 共 ${range.end - range.start + 1} 个号，` +
    `本轮候选 ${candidates.length} 个（上限 ${deps.maxScan}），${formatTried(tried)}` +
    (skipped > 0 ? `，跳过 ${skipped} 个（账本或宿主已占）` : '') +
    (truncated ? '，区间未扫完' : '')
  return deps.fail('no-free-port', detail)
}
