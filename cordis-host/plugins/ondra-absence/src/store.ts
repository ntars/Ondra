/**
 * 空窗时刻档的读写。
 *
 * ## 落点与写法
 *
 * `user/absence.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：首次时刻、末次时刻、最近一次「提过一句」的时刻、两个计数、重来次数。
 *
 * **不存上次聊了什么，也不存离开原因。** 一个「空窗期礼仪」如果需要知道你
 * 为什么三天没来，它就已经从礼仪变成了考勤。而考勤记录最自然的下一步，
 * 就是拿它去解释她的情绪——那是最难查的一类错误归因。
 *
 * ## 丢了会怎样
 *
 * 下一次会当成「第一次记录」：`gap` 为 `null`，`greet()` 返回 `null`，
 * 于是不会有任何一句关于间隔的话。代价是那一次回归显得平淡；
 * **刻意不做冗余副本**——为两个时刻在别处再存一遍，等于让「多久没见」
 * 有两个真源，而两个真源迟早会给出两个不同的间隔。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import { emptyState, normalizeState } from './gap.js'
import type { AbsenceState } from './gap.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 状态（读不到就是空状态）。 */
  readonly state: AbsenceState
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
}

/**
 * 从磁盘读状态。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 */
export function readState(filePath: string | undefined): LoadResult {
  if (filePath === undefined) return { state: emptyState(), fresh: true }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { state: emptyState(), fresh: true }
    return {
      state: emptyState(),
      fresh: false,
      issue: '读不到空窗时刻档：' + String(code ?? '未知错误'),
    }
  }
  if (text.trim() === '') return { state: emptyState(), fresh: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      state: emptyState(),
      fresh: false,
      issue: '空窗时刻档不是合法 JSON，已按「从没记录过」处理',
    }
  }
  return { state: normalizeState(parsed), fresh: false }
}

/**
 * 写状态：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘，
 * 而「存了什么」必须是能一眼读完的一份清单。
 * @param filePath 绝对路径。
 * @param state 状态。
 */
export function writeState(filePath: string, state: AbsenceState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      firstSeenAt: state.firstSeenAt,
      lastSeenAt: state.lastSeenAt,
      lastMentionAt: state.lastMentionAt,
      touches: state.touches,
      mentions: state.mentions,
      restarts: state.restarts,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
