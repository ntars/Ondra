/**
 * 停顿计算的**纯函数**：标点附加、卡限、深夜放大。
 *
 * 手册 §9.2 对顺序有一句非常具体的话：
 *
 * > `minDelayMs=300`、`maxDelayMs=6000`；**先卡限→乘深夜 1.6（23:00–06:00）→再卡限**
 *
 * 这三个动作的顺序不能换：
 *
 * - 先乘再卡（只卡一次）：40 字 ÷ 6 字/秒 = 6667ms，先乘 1.6 得 10667，
 *   卡到 6000——深夜和白天一模一样，**系数等于没写**。
 * - 只卡不乘：深夜没有变慢，用户感觉不到「她困了」。
 * - 卡 → 乘 → 卡：短消息（600ms）在深夜变 960ms，长消息仍是 6000。
 *   这才是「慢」的正确形状：**慢在犹豫上，不慢在长句上**。
 *
 * 标点附加表来自 `PUNCT_SPECS`（手册原值），这里只做计数：
 * 句末与句中按出现次数算；`……` 与 `——` **按一串算一次**，
 * 否则「……」会被算成 1000ms——那是两倍的犹豫，不是四倍。
 */

import { PUNCT_SPECS } from './types.js'

/** 一次停顿计算要用的三个附加值。 */
export interface PauseConfig {
  /** 句末标点附加（毫秒）。 */
  readonly periodMs: number
  /** 省略号/破折号附加（毫秒）。 */
  readonly ellipsisMs: number
  /** 句中逗号/分号附加（毫秒）。 */
  readonly commaMs: number
}

/** 按 id 取一类标点的字符集（**唯一来源是 `PUNCT_SPECS`**，不手抄第二份）。 */
function charsOf(id: string): ReadonlySet<string> {
  const spec = PUNCT_SPECS.find(item => item.id === id)
  return new Set(spec ? spec.chars : [])
}

const PERIOD_CHARS = charsOf('period')
const COMMA_CHARS = charsOf('comma')

/**
 * 数「一串同一个符号」出现了几次。
 * @param chars 字符数组。
 * @param mark 目标符号。
 */
function countRuns(chars: readonly string[], mark: string): number {
  let runs = 0
  let prev = false
  for (const ch of chars) {
    const hit = ch === mark
    if (hit && !prev) runs += 1
    prev = hit
  }
  return runs
}

/**
 * 标点附加总毫秒。
 * @param text 一条消息。
 * @param cfg 三个附加值。
 */
export function extraPauseMs(text: string, cfg: PauseConfig): number {
  const chars = Array.from(text)
  let total = 0
  for (const ch of chars) {
    if (PERIOD_CHARS.has(ch)) total += cfg.periodMs
    else if (COMMA_CHARS.has(ch)) total += cfg.commaMs
  }
  total += countRuns(chars, '…') * cfg.ellipsisMs
  total += countRuns(chars, '—') * cfg.ellipsisMs
  return total
}

/** 夹到区间内并取整。 */
export function clampMs(value: number, min: number, max: number): number {
  const low = Math.min(min, max)
  const high = Math.max(min, max)
  const safe = Number.isFinite(value) ? value : low
  return Math.round(Math.min(high, Math.max(low, safe)))
}

/**
 * 判是否落在时段内（支持跨零点）。
 *
 * `start === end` 判为**空窗口**（与 O-003 口径一致）：手滑写成
 * `23:00–23:00` 不应该变成「全天深夜」。
 * @param minuteOfDay 当天第几分钟（0–1439）。
 * @param start 起点（分钟）。
 * @param end 终点（分钟）。
 */
export function inWindow(minuteOfDay: number, start: number, end: number): boolean {
  if (start === end) return false
  if (start < end) return minuteOfDay >= start && minuteOfDay < end
  return minuteOfDay >= start || minuteOfDay < end
}

/**
 * 单条打字时长。
 *
 * `chars / cps × 1000 + 标点附加` → 卡限 → 乘深夜系数 → 再卡限。
 * @param chars 字数（已去空白）。
 * @param text 正文（算标点附加）。
 * @param cps 字速（字/秒）。
 * @param cfg 三个附加值。
 * @param min 下限。
 * @param max 上限。
 * @param night 是否深夜。
 * @param factor 深夜系数。
 */
export function typingDelay(
  chars: number,
  text: string,
  cps: number,
  cfg: PauseConfig,
  min: number,
  max: number,
  night: boolean,
  factor: number,
): number {
  const speed = cps > 0 ? cps : 6
  const base = (Math.max(0, chars) / speed) * 1000 + extraPauseMs(text, cfg)
  const clamped = clampMs(base, min, max)
  if (!night || factor <= 1) return clamped
  return clampMs(clamped * factor, min, max)
}
