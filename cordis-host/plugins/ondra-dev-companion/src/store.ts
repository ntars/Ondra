/**
 * 「说过没」台账的读写。
 *
 * ## 落点与写法
 *
 * `user/dev-companion.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 为什么只存水位，不存判定
 *
 * 判定用的 `streak` / `firstFailAt` / 指纹全在内存。跨重启保留它们，
 * 等于相信「关机前那条错误」和「开机后这条错误」是同一个——
 * 而一次重启之后人大概率已经换了一件事在做。
 *
 * 落盘只为一件事：**重启之后不要重复说同一句话**。
 *
 * ## 存什么、不存什么
 *
 * 存：最近一次出声时刻、最近一次「绿了」的时刻、四个调门的计数、重来次数。
 *
 * **不存事件明细、不存错误正文、不存指纹、不存文件名。** 一份「开发者陪伴」
 * 如果需要记得你昨天哪个文件编译失败，它就已经在记录你的工作内容了。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import { emptyLedger, normalizeLedger } from './rules.js'
import type { DevLedger } from './rules.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 台账（读不到就是空台账）。 */
  readonly ledger: DevLedger
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
}

/**
 * 从磁盘读台账。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 */
export function readLedger(filePath: string | undefined): LoadResult {
  if (filePath === undefined) return { ledger: emptyLedger(), fresh: true }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { ledger: emptyLedger(), fresh: true }
    return {
      ledger: emptyLedger(),
      fresh: false,
      issue: '读不到陪伴台账：' + String(code ?? '未知错误'),
    }
  }
  if (text.trim() === '') return { ledger: emptyLedger(), fresh: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ledger: emptyLedger(),
      fresh: false,
      issue: '陪伴台账不是合法 JSON，已按「没说过」处理',
    }
  }
  return { ledger: normalizeLedger(parsed), fresh: false }
}

/**
 * 写台账：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘。
 * @param filePath 绝对路径。
 * @param ledger 台账。
 */
export function writeLedger(filePath: string, ledger: DevLedger): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      lastCueAt: ledger.lastCueAt,
      lastCelebrateAt: ledger.lastCelebrateAt,
      tones: {
        quiet: ledger.tones.quiet,
        companion: ledger.tones.companion,
        release: ledger.tones.release,
        celebrate: ledger.tones.celebrate,
      },
      resets: ledger.resets,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
