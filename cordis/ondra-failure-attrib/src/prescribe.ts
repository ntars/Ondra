/**
 * 处方表与重试预算。
 *
 * ## 这张表里只有两行是手册原文，其余是推导——必须逐行标出来
 *
 * 手册给了八类的**名字**、给了「`arg_error` 永不自动重试」、给了「伤口下次成功
 * 才闭合」「5 分钟 chronic」，但**没给每类的处方内容**。所以 `derived: false`
 * 只出现在 `arg_error` 那一行；其余七行标 `derived: true`，并在 `source` 里
 * 写清是按什么推的。这不是形式主义：将来主人拍板改了某一条，得能一眼看出
 * 哪几条是「我们自己的判断」。
 *
 * ## 处方的方向：补信息，不是催重试
 *
 * 手册对这件事说得最重：「**Agent 犯错是结构性的（脑子里缺信息）不是 bug**——
 * 让不知道密码的人重试 100 次还是登不进去，正解是沙箱隔离 + 分析缺什么再补进去。」
 *
 * 所以八张处方里只有两张的方向是「再试一次」（超时、网络，都是暂态），
 * 其余六张的方向全是「先补上缺的那一块」。这张表如果写成「八类都重试」，
 * 就等于把手册最想否掉的那件事又做了一遍。
 *
 * ## `arg_error` 的铁律为什么不放在表里
 *
 * 表可以被配置覆盖、可以被将来的人改。铁律不行。
 * 所以 `retryBudget()` 的**第一行**就是 `if (cause === 'arg_error') return 0`，
 * 在查表之前。要违反它，必须删掉那一行代码——而不是改一个配置值。
 */

import type { Cause, Prescription, RetryVerdict } from './types.js'

/** 八张处方。**键必须覆盖全部八类**，缺一个编译期就报（`Record<Cause, …>`）。 */
export const PRESCRIPTIONS: Readonly<Record<Cause, Prescription>> = Object.freeze({
  tool_missing: Object.freeze({
    cause: 'tool_missing' as Cause,
    verdict: 'manual' as RetryVerdict,
    action: 'install' as const,
    hint: '这个工具不存在：先确认它有没有装，再换一条能走的路，别原地重试',
    needsHuman: true,
    derived: true,
    source: '推导（手册只给了类名）：缺件类，处方是补齐而不是重试',
  }),
  arg_error: Object.freeze({
    cause: 'arg_error' as Cause,
    verdict: 'never' as RetryVerdict,
    action: 'fix-args' as const,
    hint: '参数不对，重试一百次还是同一个错：先看清要什么，再补上缺的那一项',
    needsHuman: false,
    derived: false,
    source: '§8.6 原文「`arg_error` 永不自动重试」',
  }),
  permission: Object.freeze({
    cause: 'permission' as Cause,
    verdict: 'never' as RetryVerdict,
    action: 'escalate' as const,
    hint: '没有权限，再试也不会突然有：这件事要人来授权',
    needsHuman: true,
    derived: true,
    source: '推导（与 `arg_error` 同构：重试不改变前提）',
  }),
  timeout: Object.freeze({
    cause: 'timeout' as Cause,
    verdict: 'retry' as RetryVerdict,
    action: 'retry-later' as const,
    hint: '这次没赶上，退一步再试一次',
    needsHuman: false,
    derived: true,
    source: '推导：暂态类，退避重试有效',
  }),
  network: Object.freeze({
    cause: 'network' as Cause,
    verdict: 'retry' as RetryVerdict,
    action: 'retry-later' as const,
    hint: '网络这一下没通，退一步再试一次',
    needsHuman: false,
    derived: true,
    source: '推导：暂态类，退避重试有效',
  }),
  not_found: Object.freeze({
    cause: 'not_found' as Cause,
    verdict: 'manual' as RetryVerdict,
    action: 'supplement' as const,
    hint: '要找的东西不在那儿：先确认它在哪，再动手',
    needsHuman: false,
    derived: true,
    source: '推导：目标不存在，重试只会再找不到一次',
  }),
  conflict: Object.freeze({
    cause: 'conflict' as Cause,
    verdict: 'manual' as RetryVerdict,
    action: 'inspect' as const,
    hint: '两边对不上：先看清哪一边是对的，再决定改谁',
    needsHuman: false,
    derived: true,
    source: '推导：契约冲突要先裁决，重试只会再撞一次',
  }),
  unknown: Object.freeze({
    cause: 'unknown' as Cause,
    verdict: 'retry' as RetryVerdict,
    action: 'inspect' as const,
    hint: '不知道为什么失败：只试一次，再不行就交给人',
    needsHuman: false,
    derived: true,
    source: '推导：未知类限一次，避免「盲目重试 100 次」',
  }),
})

/** `unknown` 类最多自动重试几次（沿用原 O-089 口径：只试一次）。 */
export const UNKNOWN_RETRY_CAP = 1

/**
 * 一个原因最多还能重试几次。
 *
 * **第一行是铁律**：`arg_error` 恒 0，在查表之前。改表改不掉它。
 * @param cause 归因。
 * @param maxRetries 可重试类的次数上限（来自配置）。
 */
export function retryBudget(cause: Cause, maxRetries: number): number {
  if (cause === 'arg_error') return 0
  const prescription = PRESCRIPTIONS[cause]
  if (prescription.verdict !== 'retry') return 0
  const cap = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.trunc(maxRetries) : 0
  if (cause === 'unknown') return Math.min(UNKNOWN_RETRY_CAP, cap)
  return cap
}

/**
 * 还能不能再试一次。
 * @param cause 归因。
 * @param attempts 已经试过几次（不含这一次）。
 * @param maxRetries 可重试类的次数上限。
 */
export function shouldRetry(cause: Cause, attempts: number, maxRetries: number): boolean {
  const tried = Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0
  return tried < retryBudget(cause, maxRetries)
}

/**
 * 取处方。**永远返回一张**：八类全覆盖，没有「查不到」这条路。
 * @param cause 归因。
 */
export function prescriptionOf(cause: Cause): Prescription {
  return PRESCRIPTIONS[cause]
}
