/**
 * 学习节奏存档的读写。
 *
 * ## 落点与写法
 *
 * `user/study.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * 用「临时文件 + rename」而不是直接 `writeFileSync` 覆盖，是因为覆盖写在中途崩溃时
 * 会留下半份 JSON：下一次读只能整份丢弃，而丢的是「今天学了多久」。
 * 原子替换最坏情况是保住上一份完整读数——少算一段，好过读出一份坏的。
 *
 * ## 存什么、不存什么
 *
 * 存：日键、相位、段起点、打点水位、今日毫秒数、四个计数、两个冷却锚点。
 *
 * **不存学了什么。** 不存科目名（虽然 `start(subject)` 收了这个参数）、
 * 不存笔记正文、不存进度、不存正确率。一个学伴如果需要知道你刚才在读哪一页，
 * 它就已经从「陪」变成了「督」——而它越界的方式会非常自然：先加一个「最近科目」
 * 做统计，再加一个「每周科目分布」，最后它手上就有一份学习记录，
 * 那份记录迟早会被拿去评价人。
 *
 * ## 丢了会怎样
 *
 * 只有今日计数会清零，进行中的段会断。代价是「今天已经学了多久」少算一部分，
 * 最坏结果是今天少提一句休息。**刻意不做冗余副本**：为这几个数在别处再存一份，
 * 等于把同一个计数变成两个真源，而两个真源迟早会给出两个不一样的「今天学了多久」。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import { emptyState, normalizeState } from './session.js'
import type { StudyState } from './session.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 状态（读不到就是空状态）。 */
  readonly state: StudyState
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
      issue: '读不到学习节奏存档：' + String(code ?? '未知错误'),
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
      issue: '学习节奏存档不是合法 JSON，已按空状态处理',
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
export function writeState(filePath: string, state: StudyState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      dayKey: state.dayKey,
      phase: state.phase,
      // 跨天不清：没有它，第二天首读会报「从来没有开始过」。
      everStarted: state.everStarted,
      focusStartAt: state.focusStartAt,
      restStartAt: state.restStartAt,
      lastTickAt: state.lastTickAt,
      focusMsToday: state.focusMsToday,
      segmentsDoneToday: state.segmentsDoneToday,
      segmentsBrokenToday: state.segmentsBrokenToday,
      breaksToday: state.breaksToday,
      breaksDeclinedToday: state.breaksDeclinedToday,
      lastPromptAt: state.lastPromptAt,
      lastDeclineAt: state.lastDeclineAt,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
