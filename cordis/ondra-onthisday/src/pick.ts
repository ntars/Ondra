/**
 * 取材：扫库 → 判档 → 去重 → 排序 → 截断。
 *
 * ## 为什么是全库分页扫描，不是「取最近 N 条再过滤」
 *
 * O-036 的内联实现只能取 `last-seen` 升序的前 N 条再按日历日过滤
 * （它的 README 已经写明「只能近似取材」）。后果很具体：
 * 库里 3000 条记忆、窗口 500 条时，「三年前的今天」只要不在那 500 条里，
 * 就永远不会被想起来——而这块注入看起来一切正常，日志全绿。
 *
 * 本文件按「返回几条就前进几条」翻页扫到 `scanLimit` 为止，
 * **不假设页大小**：存储层把 `limit` 夹到 `maxSelectRows` 时，
 * 如果按请求的页大小前进，会在第一页就误判「到底了」，
 * 于是只扫了最前面的几十条。这是最容易写错、也最不容易发现的一处。
 *
 * ## 为什么排序要三个关键字加一个兜底
 *
 * 档位（周年 > 整年 > 整月）→ 年数降序 → 显著度降序 → id 升序。
 * 最后一个 id 不是装饰：同档同年同显著度的两条，没有它顺序就取决于
 * 数据库返回顺序，而「今天注入的是 A 还是 B」会在同一天内抖动，
 * 前缀缓存跟着失效。id 是稳定的，用它兜底。
 */

import { dayNumberOf, matchShelf, partsAt } from './calendar.js'
import type { CalendarPartsLike, ClockLike, GraphLike, MemoryCoreLike, MemoryRecordLike } from './types.js'
import type { Config } from './settings.js'
import type { Shelf } from './types.js'
import { GRAPH_DEDUPE_WEIGHT, GRAPH_DEDUPE_WINDOW, SHELF_ORDER, TEXT_KEY_CHARS } from './types.js'

/** 一条命中档位的候选。 */
export interface Candidate {
  /** 记忆本体（只读快照，强度要用新鲜的记录另算）。 */
  readonly record: MemoryRecordLike
  /** 命中哪一档。 */
  readonly shelf: Shelf
  /** 隔了几个自然日。 */
  readonly daysAgo: number
  /** 隔了几年。 */
  readonly yearsAgo: number
  /** 是否走了闰日折叠。 */
  readonly leapFolded: boolean
}

/** 扫描入参。 */
export interface ScanInput {
  /** 记忆内核。 */
  readonly core: MemoryCoreLike
  /** 时间服务，可为空（为空时按本机时区拆日期）。 */
  readonly clock: ClockLike | undefined
  /** 配置。 */
  readonly settings: Config
  /** 今天（已拆好）。 */
  readonly today: CalendarPartsLike
  /** 今天的日历日序号。 */
  readonly todayNumber: number
}

/** 扫描结果。 */
export interface ScanOutput {
  /** 命中档位的候选（未去重、未排序）。 */
  readonly candidates: readonly Candidate[]
  /** 实际扫过的行数。 */
  readonly scanned: number
  /** 是否因为扫描上限而没扫完。 */
  readonly truncated: boolean
}

/**
 * 扫一遍记忆库，挑出今天命中档位的候选。
 *
 * 任何异常都由调用方兜住（这里只负责把 `core.listFacts` 的错原样抛出）——
 * 「扫到一半失败」不应该返回半份结果，半份结果看着像「今天只有一条」。
 * @param input 入参。
 */
export function scan(input: ScanInput): ScanOutput {
  const { core, clock, settings, today, todayNumber } = input
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  let offset = 0
  let scanned = 0
  let exhausted = false

  while (scanned < settings.scanLimit) {
    const want = Math.min(settings.pageSize, settings.scanLimit - scanned)
    const page = core.listFacts({ limit: want, offset, orderBy: 'created-at' })
    if (page.length === 0) {
      exhausted = true
      break
    }
    // 按「返回几条就前进几条」推进，而不是按请求的页大小：
    // 存储层会把 limit 夹到 maxSelectRows，按请求值前进会静默跳行。
    offset += page.length
    scanned += page.length

    for (const record of page) {
      // 翻页期间有新写入时，同一行可能出现在两页里；按 id 去重。
      if (seen.has(record.id)) continue
      seen.add(record.id)

      // 封存 = 「不主动注入、不参与回忆」（手册 §2.4）。任何开关都不放开这一条。
      if (record.sealed === true) continue
      // 归档 = 「只忘不删」，默认参与；见 README 与台账的口径说明。
      if (record.archived === true && !settings.includeArchived) continue

      const memory = partsAt(record.createdAt, clock)
      if (memory === undefined) continue
      const memoryNumber = dayNumberOf(memory)

      const hit = matchShelf({
        today,
        todayNumber,
        memory,
        memoryNumber,
        leapFold: settings.leapFold,
        shelfAnniversary: settings.shelfAnniversary,
        shelfYearDay: settings.shelfYearDay,
        shelfMonthDay: settings.shelfMonthDay,
      })
      if (hit === undefined) continue

      candidates.push(
        Object.freeze({
          record,
          shelf: hit.shelf,
          daysAgo: hit.daysAgo,
          yearsAgo: hit.yearsAgo,
          leapFolded: hit.leapFolded,
        }),
      )
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    scanned,
    truncated: !exhausted,
  })
}

/**
 * 正文的字面指纹：去空白、去标点、取前 N 字。
 *
 * 不用整段比对：同一条记忆被修订过之后，正文只差一两个字，
 * 整段比对会把它们当成两件事。
 * @param text 正文。
 */
export function textKeyOf(text: string): string {
  const stripped = text
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】《》…—·,.!?;:'"()[\]<>]/g, '')
  return stripped.slice(0, TEXT_KEY_CHARS)
}

/**
 * 排序比较器。
 * @param left 左。
 * @param right 右。
 */
export function compareCandidate(left: Candidate, right: Candidate): number {
  const byShelf = SHELF_ORDER[left.shelf] - SHELF_ORDER[right.shelf]
  if (byShelf !== 0) return byShelf
  // 同年数里越久远越优先：一年前的事用户自己还记得，三年前的可能真忘了。
  // 这也是手册「越模糊越容易被想起」在选条上的形态。
  if (left.yearsAgo !== right.yearsAgo) return right.yearsAgo - left.yearsAgo
  if (left.record.salience !== right.record.salience) {
    return right.record.salience - left.record.salience
  }
  return left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0
}

/** 选择入参。 */
export interface SelectInput {
  /** 候选（顺序无所谓，内部会排）。 */
  readonly candidates: readonly Candidate[]
  /** 最多给几条。 */
  readonly cap: number
  /** 图谱，可为空。 */
  readonly graph: GraphLike | undefined
  /** 是否用图谱去重。 */
  readonly graphDedupe: boolean
  /** 问题收集器（中文短句，直接给面板看）。 */
  readonly issues: string[]
}

/** 选择结果。 */
export interface SelectOutput {
  /** 最终选中的几条（已排序）。 */
  readonly picked: readonly Candidate[]
  /** 命中但没给出的条数（含被合并的同主题条目）。 */
  readonly dropped: number
  /** 被合并掉的同主题 / 同正文条数。 */
  readonly merged: number
}

/**
 * 从候选里选出最终的几条。
 *
 * 两级去重：
 * 1. 字面——正文指纹相同（同一件事被写了两遍）；
 * 2. 图谱——`relatedness ≥ 0.72`（`same_topic` 下沿），说明图谱已经认定同主题。
 *
 * 图谱查询按「已经选中的几条当种子」一次问完，不是两两问：
 * 候选上百条时两两问会变成上百次边查询，而实际只需要知道
 * 「这条和我已经留下的像不像」。
 * @param input 入参。
 */
export function select(input: SelectInput): SelectOutput {
  const sorted = [...input.candidates].sort(compareCandidate)
  const picked: Candidate[] = []
  const textKeys = new Set<string>()
  let merged = 0

  // 图谱只在前若干条候选上参与判定：再靠后的候选在有条目靠前时本来就选不上。
  let graphUsable = input.graphDedupe && input.graph !== undefined && input.graph.available

  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index]
    const key = textKeyOf(candidate.record.text)
    if (key !== '' && textKeys.has(key)) {
      merged += 1
      continue
    }

    if (graphUsable && index < GRAPH_DEDUPE_WINDOW && picked.length > 0) {
      const graph = input.graph as GraphLike
      try {
        const related = graph.relatedness(
          [candidate.record.id],
          picked.map(item => item.record.id),
          { minWeight: GRAPH_DEDUPE_WEIGHT },
        )
        const weight = related[candidate.record.id]
        if (typeof weight === 'number' && weight >= GRAPH_DEDUPE_WEIGHT) {
          merged += 1
          continue
        }
      } catch (error) {
        // 图谱坏了不该让「那年今日」变成空白：退回纯字面去重，并说清是哪一步坏的。
        graphUsable = false
        input.issues.push(
          '图谱去重失败，已退回字面去重：' + (error instanceof Error ? error.message : String(error)),
        )
      }
    }

    if (key !== '') textKeys.add(key)
    picked.push(candidate)
    if (picked.length >= input.cap) break
  }

  return Object.freeze({
    picked: Object.freeze(picked),
    dropped: Math.max(0, input.candidates.length - picked.length),
    merged,
  })
}
