/**
 * 纯函数层：**把「今天是什么日子」与「外面什么样」压成一段**。
 *
 * ## 为什么这一段由两个上游合成
 *
 * 节气与节日在 O-046（本机算，不联网），天气在 O-047（要发请求）。
 * 合成一段而不是两段，是因为它们回答同一个问题：「今天的背景是什么」。
 * 拆成两段会让简报变成四段——四段就不是第一屏了。
 *
 * ## 缺一个上游时说什么
 *
 * **明说缺的是哪一块**，不装作「今天没什么特别」：
 * 节气读不到与「今天确实不是节气」在用户那里是两件完全不同的事。
 * 两个都缺，这一段才是 `not-available`。
 *
 * ## 天气那句是引用，不是重写
 *
 * `weather.text` 是 O-047 已经写好的中文。这里**原样引用**，不重新措辞、
 * 不换算单位、不补一句「记得带伞」——关心的话归表达域，归 O-047 自己。
 */

import { SLOT_SPECS } from './types.js'
import type { BriefItem, DateFactsLike, WeatherFactsLike } from './types.js'
import { sourceOf } from './aggregate.js'

/**
 * 把几行话拼成一句。缺句号时补上——上游给的是短语，不是句子。
 * @param lines 若干行。
 */
function sentenceJoin(lines: readonly string[]): string {
  const kept = lines.map(line => line.trim()).filter(line => line !== '')
  return kept
    .map(line => (/[。！？]$/.test(line) ? line : `${line}。`))
    .join('')
}

/**
 * 「今天是什么日子」那一句。今天不是任何日子时往下看最近的节气。
 * @param facts 日期事实。
 * @returns 一句中文；实在没有可说的时候为 `null`。
 */
function dayLineOf(facts: DateFactsLike): string | null {
  const marks: string[] = []
  if (typeof facts.jieQi === 'string' && facts.jieQi !== '') marks.push(facts.jieQi)
  for (const festival of facts.festivals) {
    if (typeof festival === 'string' && festival !== '' && !marks.includes(festival)) marks.push(festival)
  }
  if (marks.length > 0) return `今天是${marks.join('、')}`

  const next = facts.nextJieQi
  if (next === null || next.name === '') return null
  if (next.daysAway <= 0) return `${next.name}就在这两天`
  return `再过${next.daysAway}天就是${next.name}`
}

/**
 * 投影「外面」这一段。
 * @param live 日期事实；`null` = 读不到。
 * @param weather 天气事实；`null` = 读不到或没配置坐标。
 */
export function ambientItemOf(live: DateFactsLike | null, weather: WeatherFactsLike | null): BriefItem {
  const spec = SLOT_SPECS.ambient
  const sources = Object.freeze([
    sourceOf(spec.owner, 'facts()', live !== null),
    sourceOf('ondra-weather', 'facts()', weather !== null),
  ])

  const lines: string[] = []
  const gaps: string[] = []

  if (live !== null) {
    const day = dayLineOf(live)
    if (day !== null) lines.push(day)
  } else {
    gaps.push('今天是什么日子这一块没有：日期事实服务读不到')
  }

  if (weather !== null) {
    const text = weather.text.trim()
    // 上游在位但没给出可说的话：不自己编一句，也不当作有内容。
    if (text !== '') lines.push(text)
  } else {
    gaps.push('天气这一块没有：要么没填坐标，要么这会儿取不到')
  }

  if (lines.length === 0) {
    // 日期事实读到了、今天确实不是任何日子，天气又没有 → 这是「空」，不是「读不到」。
    if (live !== null) {
      return Object.freeze({
        slot: spec.slot,
        zh: spec.zh,
        state: 'empty',
        title: '今天不是节气，也不是节日',
        detail: sentenceJoin(gaps),
        sources,
      })
    }
    return Object.freeze({
      slot: spec.slot,
      zh: spec.zh,
      state: 'not-available',
      title: '外面这一块今天读不到',
      detail: '日期事实与天气两个服务都没起来或都没给出可说的话——不是「今天没什么特别」，是读不到。',
      sources,
    })
  }

  return Object.freeze({
    slot: spec.slot,
    zh: spec.zh,
    state: 'ready',
    title: lines[0],
    detail: sentenceJoin([...lines.slice(1), ...gaps]),
    sources,
  })
}
