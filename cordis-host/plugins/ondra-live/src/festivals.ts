/**
 * 节日表。**只有这一份**，`service.ts` 与面板都从这里取。
 *
 * 分两张表，因为它们的事实来源不同：
 *
 * - **公历节日**是「每年同一个日期」，用 `MM-DD` 直接查表，永远不会错；
 * - **农历节日**是「每年不同的公历日期」，必须先拿到农历月日（由 `branches/*` 给），
 *   再查 `月-日`。所以本文件**不碰历法**，只做映射——历法归分支，映射归这里。
 *
 * ## 三条克制的取舍
 *
 * 1. **闰月不过节**。农历闰五月初五不是端午，传统上不过。闰月里的节日一律不报，
 *    否则一个闰年会出现两个端午。
 * 2. **浮动公历节日不做**（母亲节 = 5 月第二个周日、父亲节 = 6 月第三个周日）。
 *    它们要「第几个周几」的规则引擎，属另一件事；写一半比不写更糟，
 *    已登记在 README「待裁决」。
 * 3. **地方性节日不做**（小年南北差一天、二月二等）。同一天在不同地区叫法不同，
 *    报一个就等于替用户选了他的家乡。
 */

import { partsOf } from './solar.js'
import type { LunarSnapshot } from './types.js'

/** 公历固定节日。键是 `MM-DD`。 */
const SOLAR_FESTIVALS: Readonly<Record<string, string>> = Object.freeze({
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
})

/** 农历传统节日。键是 `月-日`（非闰月）。 */
const LUNAR_FESTIVALS: Readonly<Record<string, string>> = Object.freeze({
  '1-1': '春节',
  '1-15': '元宵节',
  '2-2': '龙抬头',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
})

/** 公历节日表（只读出口，面板可用它渲染「今年还有哪些节日」）。 */
export const SOLAR_FESTIVAL_TABLE: Readonly<Record<string, string>> = SOLAR_FESTIVALS

/** 农历节日表（只读出口）。 */
export const LUNAR_FESTIVAL_TABLE: Readonly<Record<string, string>> = LUNAR_FESTIVALS

/**
 * 某天的公历节日。
 * @param dayKey 自然日键。
 */
export function solarFestivalsOf(dayKey: string): readonly string[] {
  const { month, day } = partsOf(dayKey)
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const name = SOLAR_FESTIVALS[key]
  return name === undefined ? [] : [name]
}

/**
 * 某天的农历节日。
 *
 * 除夕不在表里：它取决于「腊月有几天」，只能看第二天是不是正月初一。
 * 所以需要 `today` 与 `tomorrow` 两份农历快照，两份都在才算得出来。
 * @param today 当天的农历快照（没有农历分支时为 `null`）。
 * @param tomorrow 第二天的农历快照。
 */
export function lunarFestivalsOf(
  today: LunarSnapshot | null,
  tomorrow: LunarSnapshot | null,
): readonly string[] {
  if (today === null) return []
  // 闰月不过节：闰五月初五不是端午。
  if (today.leap) return []

  const out: string[] = []
  const name = LUNAR_FESTIVALS[`${today.month}-${today.day}`]
  if (name !== undefined) out.push(name)

  // 除夕：腊月最后一天。判据是「明天是正月初一」，而不是「今天是腊月三十」——
  // 腊月有时只有二十九天，按三十判会在一半的年份里漏掉。
  if (today.month === 12 && tomorrow !== null && tomorrow.month === 1 && tomorrow.day === 1) {
    out.push('除夕')
  }
  return out
}
