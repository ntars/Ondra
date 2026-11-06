/**
 * 当日计数的读写。
 *
 * ## 落点与写法
 *
 * `user/digital-health.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：日键、当日累计毫秒、连续段起点、末次打点、已提醒档位、提醒次数、冷却起点、打点次数。
 *
 * **一个字的正文都不存。** 不存窗口标题、不存应用名、不存输入内容、不截屏。
 * 一个「健康护栏」如果需要知道你刚才在写什么，它就已经越界了——
 * 而它越界的方式会非常自然：先加一个「最近活跃应用」字段做统计，再加一个
 * 「常用时段分布」，最后它就变成了一份使用记录。
 *
 * ## 丢了会怎样
 *
 * 只有当日累计会清零（重启那一刻的连续段也会断）。代价是「今天已经用了多久」
 * 少算一部分，最坏结果是今天少劝一句。**刻意不做冗余副本**：
 * 为这点数据在别处再存一份，等于把同一个计数变成两个真源，
 * 而两个真源迟早会给出两个不一样的「今天用了多久」。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import { emptyState, normalizeState } from './health.js'
import type { HealthState } from './health.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 状态（读不到就是空状态）。 */
  readonly state: HealthState
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
}

/**
 * 从磁盘读状态。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 * @param dayKey 当前自然日键。
 */
export function readState(filePath: string | undefined, dayKey: string): LoadResult {
  if (filePath === undefined) return { state: emptyState(dayKey), fresh: true }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { state: emptyState(dayKey), fresh: true }
    return {
      state: emptyState(dayKey),
      fresh: false,
      issue: '读不到数字健康存档：' + String(code ?? '未知错误'),
    }
  }
  if (text.trim() === '') return { state: emptyState(dayKey), fresh: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      state: emptyState(dayKey),
      fresh: false,
      issue: '数字健康存档不是合法 JSON，已按空状态处理',
    }
  }
  return { state: normalizeState(parsed, dayKey), fresh: false }
}

/**
 * 写状态：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘，
 * 而「存了什么」必须是能一眼读完的一份清单。
 * @param filePath 绝对路径。
 * @param state 状态。
 */
export function writeState(filePath: string, state: HealthState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      dayKey: state.dayKey,
      dayMs: state.dayMs,
      sessionStart: state.sessionStart,
      lastPulseAt: state.lastPulseAt,
      acknowledged: state.acknowledged,
      nudges: state.nudges,
      lastNudgeAt: state.lastNudgeAt,
      pulses: state.pulses,
      // 跨天不清：没有它，第二天首读会报「从来没有收到过活动」。
      everPulsed: state.everPulsed,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
