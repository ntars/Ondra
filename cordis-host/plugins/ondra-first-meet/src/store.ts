/**
 * 初见进度的读写。
 *
 * ## 落点与写法
 *
 * `user/first-meet.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：是否见过、初见时刻、走到第几拍、已兑现的节拍 id、是否被打断、重来次数。
 *
 * **「对方说了什么」一个字都不存。** 初见那天人往往会说真名、说处境、说来这儿的原因——
 * 那些属于记忆系统（O-010），有它自己的生命周期、可见性与遗忘权（O-103）；
 * 把它们顺手塞进一个「流程存档」，等于在遗忘权的十一个面之外又开了一扇后门。
 *
 * ## 丢了会怎样
 *
 * 初见会从头再走一遍。代价是重复一段十几秒的开场；**刻意不做冗余副本**——
 * 为一份进度在别处再存一遍，等于让「她见过我没有」有两个真源，
 * 而两个真源迟早会给出两个答案。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import type { BeatId } from './types.js'
import { emptyState, normalizeState } from './progress.js'
import type { MeetState } from './progress.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 状态（读不到就是空状态）。 */
  readonly state: MeetState
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
      issue: '读不到初见进度档：' + String(code ?? '未知错误'),
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
      issue: '初见进度档不是合法 JSON，已按「没见过」处理',
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
 * @param delivered 已兑现的节拍（单独传，便于调用方明确「写的就是这一份」）。
 */
export function writeState(filePath: string, state: MeetState, delivered: readonly BeatId[]): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      met: state.met,
      metAt: state.metAt,
      position: state.position,
      delivered,
      done: state.done,
      interrupted: state.interrupted,
      restarts: state.restarts,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
