/**
 * 记录的读写。
 *
 * ## 落点与写法
 *
 * `user/ambient.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：最近一次输入的时刻、最近一次空闲声明的时刻、三个计数。
 *
 * **不存按键明细。** 没有键值、没有按下与抬起的时刻、没有间隔序列、没有窗口名、
 * 没有应用名、没有输入内容。这一条不是克制，是定义：
 *
 * - 键值能直接还原输入；
 * - **间隔序列同样能还原**——击键动力学足以从节奏里反推出「打的是拼音还是英文」
 *   「打的是不是一串密码」。所以「只存时刻不存字」并不安全，
 *   **不存明细**才安全。内存里的密度窗口是过程量，进程一结束就没了。
 *
 * ## 丢了会怎样
 *
 * 下一次会当成「从没观测过」：`confidence` 为 `none`，`state` 退回 `quiet`
 * （不知道就别打扰），`nudge()` 恒不值得。代价是那一次格外安静；
 * **刻意不做冗余副本**——把同一份存在感在别处再存一遍，等于让「主人在不在」
 * 有两个真源，而两个真源迟早会给出两个不同的答案。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import { emptyRecord, normalizeRecord } from './react.js'
import type { AmbientRecord } from './react.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 记录（读不到就是空记录）。 */
  readonly record: AmbientRecord
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
}

/**
 * 从磁盘读记录。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 */
export function readRecord(filePath: string | undefined): LoadResult {
  if (filePath === undefined) return { record: emptyRecord(), fresh: true }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { record: emptyRecord(), fresh: true }
    return {
      record: emptyRecord(),
      fresh: false,
      issue: '读不到键鼠反应档：' + String(code ?? '未知错误'),
    }
  }
  if (text.trim() === '') return { record: emptyRecord(), fresh: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      record: emptyRecord(),
      fresh: false,
      issue: '键鼠反应档不是合法 JSON，已按「从没观测过」处理',
    }
  }
  return { record: normalizeRecord(parsed), fresh: false }
}

/**
 * 写记录：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘，
 * 而「存了什么」必须是一眼能读完的清单——这份清单本身也是一条隐私承诺。
 * @param filePath 绝对路径。
 * @param record 记录。
 */
export function writeRecord(filePath: string, record: AmbientRecord): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      lastAt: record.lastAt,
      lastIdleAt: record.lastIdleAt,
      beats: record.beats,
      bursts: record.bursts,
      ignored: record.ignored,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
