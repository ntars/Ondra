/**
 * 纯判定层：**不碰网络、不碰文件、不碰时钟**。
 *
 * 这一层的每个函数都是「输入 → 输出」，所以能被逐条对拍；`service.ts` 只负责
 * 按顺序调它们。把判定与副作用混在一起，是「端口被抢」和「代码写错」分不开的
 * 主要原因——两种都会表现为「启动失败」。
 */

import { NAME_RE } from './types.js'
import type { PortBranch, PortIntent, PortRange, PortReason, PortSource } from './types.js'

/** 一次区间校验的结果。 */
export interface RangeVerdict {
  readonly ok: boolean
  readonly reason?: PortReason
  readonly detail?: string
}

/** 回环网段的下界与上界（IPv4）。 */
const LOOPBACK_PREFIX = '127'

/**
 * 是不是回环地址字面量。
 *
 * 只认三种写法：`127.x.x.x`、`::1`（含 `[::1]`）、`localhost`。
 * **刻意不认** `0.0.0.0` / `::` / 空串——上游 `webServer` 也明确拒绝通配地址
 * （「binding every interface would expose remote code execution to the network」），
 * 本包与它保持一致：不帮用户「顺手」开公网。
 * @param host 地址。
 */
export function isLoopbackHost(host: string): boolean {
  const text = host.trim().toLowerCase()
  if (text === '') return false

  // `[::1]` 是 URL 里的写法，配置里也可能被抄进来。
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  if (bare === 'localhost') return true
  if (bare === '::1') return true

  const parts = bare.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== LOOPBACK_PREFIX) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 收一个端口号。非整数、越界、NaN 一律 `null`（不夹紧：夹紧会把 0 悄悄变成 1024）。
 * @param value 原始值。
 */
export function normalizePort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (!Number.isInteger(value)) return null
  if (value < 1 || value > 65535) return null
  return value
}

/**
 * 校验一段固定区间。
 *
 * 四条都**不修正**：下界大于上界就报错，不交换——交换之后配置页显示 9079–9060，
 * 实际却按 9060–9079 跑，下一次有人照着配置页排查会查错方向。
 * @param range 区间。
 */
export function validateRange(range: PortRange): RangeVerdict {
  const start = normalizePort(range.start)
  const end = normalizePort(range.end)

  if (start === null || end === null) {
    return { ok: false, reason: 'bad-range', detail: '区间端点必须是 1–65535 的整数' }
  }
  if (start < 1024) {
    return { ok: false, reason: 'bad-range', detail: `下界 ${start} 小于 1024，绑定需要特权，本包不做` }
  }
  if (start > end) {
    return { ok: false, reason: 'bad-range', detail: `下界 ${start} 大于上界 ${end}（不自动交换，请改配置）` }
  }
  return { ok: true }
}

/**
 * 按升序生成候选号，最多 `maxScan` 个。
 *
 * 为什么升序而不是「从上次用过的下一个开始」：固定分支的用途就是防火墙白名单，
 * 号必须是可预测的。轮转会让「上次是 9063」变成排查时的一条假线索。
 * @param range 区间。
 * @param maxScan 上限。
 */
export function candidatesOf(range: PortRange, maxScan: number): readonly number[] {
  const out: number[] = []
  const limit = Math.max(0, Math.trunc(maxScan))
  for (let port = range.start; port <= range.end && out.length < limit; port += 1) {
    out.push(port)
  }
  return out
}

/**
 * 这个来源有没有竞态窗口。
 * @param source 号从哪儿来。
 */
export function raceOf(source: PortSource): 'none' | 'window' {
  return source === 'web-server' ? 'none' : 'window'
}

/**
 * 把 `purpose` 收成合法短名；不合规就记 `unnamed`（**不抛**，它只进日志）。
 * @param value 原始值。
 */
export function purposeOf(value: unknown): string {
  if (typeof value !== 'string') return 'unnamed'
  const text = value.trim()
  return NAME_RE.test(text) ? text : 'unnamed'
}

/**
 * 把试过的号折成一句。
 * @param tried 试过的号。
 */
export function formatTried(tried: readonly number[]): string {
  if (tried.length === 0) return '一个都没试'
  const head = tried.slice(0, 8).join('、')
  return tried.length <= 8 ? `试过 ${head}` : `试过 ${head} 等 ${tried.length} 个`
}

/**
 * 原因码 → 一句能照做的话。
 *
 * 每个码都必须回答「下一步改哪里」。只写「失败」等于没写。
 * @param reason 原因码。
 */
export function describeReason(reason: PortReason): string {
  switch (reason) {
    case 'disabled':
      return '端口挑选关着：把 `enable` 打开，或让调用方自己决定端口'
    case 'bad-host':
      return '绑定地址不是回环：改成 `127.0.0.1` 或 `::1`（本包不提供公网绑定）'
    case 'bad-range':
      return '固定区间不合法：下界须 ≥1024、上界 ≤65535、下界不大于上界'
    case 'bad-port':
      return '端口号不合法：须是 1–65535 的整数'
    case 'no-free-port':
      return '区间里没有空闲端口：缩小占用、扩大区间，或改用 `system` 分支'
    case 'no-endpoint':
      return '宿主 `webServer` 还没绑定端口：地址拼不出来，等它 listen 之后再问（本包不替它编一个号）'
    case 'probe-failed':
      return '内核没能分配端口：先确认回环地址可用，再看是否有端口耗尽'
    case 'not-reserved':
      return '账本里没有这个号：先 `reserve()` 或 `pick()`'
    case 'disposed':
      return '插件已卸载：重新装载后再挑端口'
    default:
      return '未知原因'
  }
}

/**
 * 分支的中文名（日志与界面共用一处）。
 * @param branch 分支。
 */
export function describeBranch(branch: PortBranch): string {
  return branch === 'fixed' ? '固定区间' : '系统分配'
}

/**
 * 意图的中文名。两个词在日志里必须能分开，否则排障时看不出「给了个被占的号」是
 * 谁的错。
 * @param intent 意图。
 */
export function describeIntent(intent: PortIntent): string {
  return intent === 'endpoint' ? '取地址' : '给监听方'
}
