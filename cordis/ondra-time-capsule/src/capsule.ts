/**
 * 纯函数层：**校验、id、标题派生、视图投影**。
 *
 * 这一层不碰文件、不碰时钟、不碰 ctx，全部输入都是参数。
 * 好处是「胶囊到底怎么判到期」「标题到底怎么截」这类规则可以被单独对拍，
 * 不必先起一个真服务。
 */

import {
  MAX_HOLD_DAYS,
  MAX_TITLE_CHARS,
  MIN_HOLD_DAYS,
  MIN_TEXT_CHARS,
} from './types.js'
import type { CapsuleRecord, CapsuleState, CapsuleView } from './types.js'
import type { Calendar } from './calendar.js'
import { daysLeft, isDue } from './calendar.js'

/** 去掉首尾空白，并把连续的三个以上换行压成两个（正文里保留段落，不保留空屏）。 */
export function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 数「看起来几个字」。
 *
 * 用 `Array.from` 而不是 `text.length`：后者按 UTF-16 码元数，
 * 一个常用汉字算 1，但表情符号算 2、部分生僻字也算 2。按字符数更接近人的直觉。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return Array.from(text).length
}

/** 从正文派生标题：取第一句，超长截断并加省略号。 */
export function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0] ?? ''
  const firstSentence = firstLine.split(/(?<=[。！？!?；;])/)[0] ?? firstLine
  const chars = Array.from(firstSentence.trim())
  if (chars.length === 0) return ''
  if (chars.length <= MAX_TITLE_CHARS) return chars.join('')
  return chars.slice(0, MAX_TITLE_CHARS - 1).join('') + '…'
}

/**
 * 造一个胶囊 id：`c-<36 进制时刻>-<序号>`。
 *
 * 为什么不用随机数：随机 id 无法解释「这颗是哪一批写的」，
 * 而 36 进制时刻既能排顺序，又符合 `^[a-z][a-z0-9_-]{1,63}$` 这把尺子。
 * @param at 写入时刻。
 * @param seq 同毫秒内序号（0 起），避免同一毫秒写两颗时撞 id。
 */
export function makeId(at: number, seq: number): string {
  return `c-${Math.trunc(at).toString(36)}-${seq}`
}

/** 一颗胶囊的状态。 */
export function stateOf(record: CapsuleRecord, now: number, calendar: Calendar): CapsuleState {
  if (record.openedAt > 0) return 'opened'
  return isDue(now, record.openAt, calendar) ? 'due' : 'locked'
}

/**
 * 投影成对外视图。**未开启的正文在这里被抹成 `null`。**
 *
 * 全插件只有这一处产出 `CapsuleView`，`list()` / `due()` / `create()` 全部经它。
 * 这样「封存期读不到正文」不是靠每个方法各自记得，而是结构上只有一条路。
 * @param record 记录。
 * @param now 现在。
 * @param calendar 日历。
 */
export function viewOf(record: CapsuleRecord, now: number, calendar: Calendar): CapsuleView {
  const state = stateOf(record, now, calendar)
  const opened = state === 'opened'
  return Object.freeze({
    id: record.id,
    title: record.title !== '' ? record.title : deriveTitle(record.text),
    state,
    openDay: calendar.dayKey(record.openAt),
    openAt: record.openAt,
    daysLeft: state === 'locked' ? daysLeft(now, record.openAt, calendar) : 0,
    createdAt: record.createdAt,
    openedAt: record.openedAt,
    factId: record.factId,
    // 只有已开封的才给正文；`locked` / `due` 恒为 null（结构性不可读）。
    text: opened && record.text !== '' ? record.text : null,
  })
}

/** 按开封日升序；同日按写入时刻升序。**已开封的排后面**（清单先看要开的）。 */
export function sortForList(a: CapsuleRecord, b: CapsuleRecord): number {
  const aOpened = a.openedAt > 0 ? 1 : 0
  const bOpened = b.openedAt > 0 ? 1 : 0
  if (aOpened !== bOpened) return aOpened - bOpened
  if (a.openAt !== b.openAt) return a.openAt - b.openAt
  return a.createdAt - b.createdAt
}

/**
 * 校验收到的正文。
 *
 * 返回 `undefined` 表示通过；否则带**错误码 + 中文说明**。
 * 刻意返回码而不是让调用方再算一次字数：同一条规则算两遍，
 * 迟早会出现「错误码说太长、提示说太短」这种自相矛盾。
 * @param text 正文。
 * @param limit 字数上限。
 */
export function checkText(text: string, limit: number): { code: 'text-too-short' | 'text-too-long'; message: string } | undefined {
  const count = charCount(text)
  if (count < MIN_TEXT_CHARS) {
    return {
      code: 'text-too-short',
      message: `正文至少 ${MIN_TEXT_CHARS} 字（现在 ${count} 字）。一两个字构不成一封信。`,
    }
  }
  if (count > limit) {
    return {
      code: 'text-too-long',
      message: `正文超过上限 ${limit} 字（现在 ${count} 字）。本插件不静默截断——请自行精简，或调高 max-text-chars。`,
    }
  }
  return undefined
}

/**
 * 校验开封日：必须落在 `[今天 + MIN_HOLD_DAYS, 今天 + MAX_HOLD_DAYS]`。
 *
 * 下限拒收而不自动拉到 7 天：见 `types.ts` 文件头——悄悄改日期比拒收更糟。
 * @param days 距今天数。
 */
export function checkHoldDays(days: number): string | undefined {
  if (!Number.isFinite(days)) return '开封日算不出来：请给出 openAt 时间戳或 afterDays 天数。'
  const rounded = Math.trunc(days)
  if (rounded < MIN_HOLD_DAYS) {
    return `至少要封 ${MIN_HOLD_DAYS} 天（现在 ${rounded} 天）。${MIN_HOLD_DAYS} 天以内的事请写进待办（ondra-memory-prospective），那才是提醒该待的地方。`
  }
  if (rounded > MAX_HOLD_DAYS) {
    return `最多封 ${MAX_HOLD_DAYS} 天（现在 ${rounded} 天）。再远多半是年份写错了。`
  }
  return undefined
}
