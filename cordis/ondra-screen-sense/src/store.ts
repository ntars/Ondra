/**
 * 在场状态的读写。
 *
 * ## 落点与写法
 *
 * `user/screen-sense.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：最近一次读到的时刻、最近一次读不到的时刻、当前段起点、当前类目、
 * 换手时刻数组、四个计数。
 *
 * **不存窗口标题、应用名、文件路径、网址、截图、画面摘要。** 一个「在场感」
 * 如果需要记得主人在看哪个文件，它就已经不是在场感了。这条不是克制，是定义：
 * 只要能还原「主人在看什么」，这个插件就已经变成了监视器，而监视器一旦存在，
 * 迟早会被拿去做别的用途。
 *
 * ## 丢了会怎样
 *
 * 下一次会当成「从没读到过」：`state` 为 `unknown`，`hint().say` 为 `null`，
 * 于是不会有任何一句关于「你在忙什么」的话。代价是那一次安静得有点空；
 * **刻意不做冗余副本**——把同一份在场状态在别处再存一遍，等于让「她在不在忙」
 * 有两个真源，而两个真源迟早会给出两个不同的答案。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import { emptyState, normalizeState } from './classify.js'
import type { ScreenState } from './classify.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 状态（读不到就是空状态）。 */
  readonly state: ScreenState
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
      issue: '读不到在场状态档：' + String(code ?? '未知错误'),
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
      issue: '在场状态档不是合法 JSON，已按「从没读到过」处理',
    }
  }
  return { state: normalizeState(parsed), fresh: false }
}

/**
 * 写状态：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘，
 * 而「存了什么」必须是一眼能读完的清单。
 * @param filePath 绝对路径。
 * @param state 状态。
 */
export function writeState(filePath: string, state: ScreenState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      lastAt: state.lastAt,
      lastMissAt: state.lastMissAt,
      segmentStart: state.segmentStart,
      category: state.category,
      handovers: state.handovers,
      glitches: state.glitches,
      notes: state.notes,
      dropped: state.dropped,
      misses: state.misses,
      resets: state.resets,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
