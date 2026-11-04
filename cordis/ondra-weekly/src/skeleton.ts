/**
 * 纯投影层：**把上游读数整理成四段骨架**。
 *
 * 这一层不碰 ctx、不碰文件，全部输入是「已经取到的上游值」或「上游不在」。
 * 好处是「空周到底怎么写」「读不到和没有怎么分开」这两条规则可以被单独对拍，
 * 不必先起一个真服务。
 *
 * ## 一条贯穿全文件的判据
 *
 * **上游在 + 这周没有 → `no-material`；上游不在 → `not-available`。**
 * 两者在界面上一句话之差，在用户那里差得很远：
 * 前者是「这周很安静」，后者是「我不知道这周安不安静」。合并成一档，
 * 降级的机器会长期显示一个平静的空周，而那正是最该被人看见的故障。
 *
 * ## 第二条：素材不是成稿
 *
 * `material` 里放的是**可以引用的原话片段**，不是写好的句子。
 * 一旦这里开始产出成句的段落，周报的口气就由插件决定了，
 * 而口气属于人格层——那是另一个真源。
 */

import { SECTION_SPECS } from './types.js'
import type {
  DiaryRefLike,
  FactLike,
  SectionId,
  SectionState,
  WeeklyCount,
  WeeklyRange,
  WeeklySection,
  WeeklySource,
} from './types.js'

/** 单条素材的截断长度。再长就不像骨架，像正文了。 */
const SNIPPET_CHARS = 48

/** 记忆段的上游材料。`present=false` 表示上游不在（不是「没有」）。 */
export interface MomentsMaterial {
  /** 上游在不在。 */
  readonly present: boolean
  /** 落在窗口内的记忆（已按写入时间倒序）。 */
  readonly facts: readonly FactLike[]
  /** 窗口内条数。 */
  readonly count: number
  /** 是否全量。`false` = 扫描被截断，`count` 只是下界。 */
  readonly exact: boolean
}

/** 承诺段的上游材料。 */
export interface PromiseMaterial {
  /** 上游在不在。 */
  readonly present: boolean
  /** 未结算条数。 */
  readonly open: number
  /** 逾期未结算条数。 */
  readonly overdue: number
  /** 未结算的原话（已按紧迫度倒序）。 */
  readonly items: readonly string[]
  /** 原话是否读到了。`false` 时条数仍可信。 */
  readonly readItems: boolean
}

/** 日记段的上游材料。 */
export interface DiaryMaterial {
  /** 上游在不在。 */
  readonly present: boolean
  /** 窗口内篇数。 */
  readonly count: number
  /** 是否全量。 */
  readonly exact: boolean
  /** 窗口内日记的标题（已按日期倒序）。 */
  readonly titles: readonly string[]
  /** 标题是否读到了。`false` 时篇数仍可信。 */
  readonly readEntries: boolean
}

/** 取错误文本。 */
export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 把一段正文压成一行素材：折空白、去首尾、超长截断。
 * @param text 原文。
 */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_CHARS) return flat
  return `${flat.slice(0, SNIPPET_CHARS)}…`
}

/** 造一个来源项。 */
export function sourceOf(service: string, field: string, ok: boolean): WeeklySource {
  return Object.freeze({ service, field, ok })
}

/** 造一个计数。 */
export function countOf(key: string, zh: string, value: number, window: 'week' | 'now', exact: boolean): WeeklyCount {
  return Object.freeze({ key, zh, value: Math.max(0, Math.trunc(value)), window, exact })
}

/** 取一段的静态说明，并按状态拼出公共字段。 */
function sectionOf(
  id: SectionId,
  state: SectionState,
  material: readonly string[],
  counts: readonly WeeklyCount[],
  sources: readonly WeeklySource[],
  note: string,
): WeeklySection {
  const spec = SECTION_SPECS[id]
  return Object.freeze({
    id,
    title: spec.title,
    ask: spec.ask,
    mustMention: spec.mustMention,
    maySkip: spec.maySkip,
    state,
    material: Object.freeze([...material]),
    counts: Object.freeze([...counts]),
    sources: Object.freeze([...sources]),
    note,
  })
}

/** 记忆段：「这周留下的事」。 */
export function momentSectionOf(material: MomentsMaterial, maxItems: number): WeeklySection {
  const sources = [sourceOf('ondra-memory-core', 'listFacts({state:active, orderBy:created-at})', material.present)]
  if (!material.present) {
    return sectionOf(
      'moments',
      'not-available',
      [],
      [],
      sources,
      '记忆服务（ondra-memory-core）没装载或没起来，这一段读不到。不是「这周没记住」——是读不到。',
    )
  }
  if (material.count === 0) {
    return sectionOf(
      'moments',
      'no-material',
      [],
      [countOf('new-memories', '本周新记住的事', 0, 'week', material.exact)],
      sources,
      '记忆服务回报：这一周没有新记忆。这段就写「这周没留下新的事」，不要拿旧事来填。',
    )
  }
  const lines = material.facts.slice(0, maxItems).map(item => snippetOf(item.text))
  const tail = material.exact ? '' : '（只扫了最近若干条，实际可能更多，这个数是下界）'
  return sectionOf(
    'moments',
    'has-material',
    lines,
    [countOf('new-memories', '本周新记住的事', material.count, 'week', material.exact)],
    sources,
    `这一周新记住 ${material.count} 条${tail}，这里列出最近 ${lines.length} 条。`,
  )
}

/** 承诺段：「这周悬着的事」。 */
export function promiseSectionOf(material: PromiseMaterial, maxItems: number): WeeklySection {
  const sources = [
    sourceOf('ondra-memory-prospective', 'stats().promises', material.present),
    sourceOf('ondra-memory-prospective', 'listOpen()', material.present && material.readItems),
  ]
  if (!material.present) {
    return sectionOf(
      'promises',
      'not-available',
      [],
      [],
      sources,
      '承诺服务（ondra-memory-prospective）没装载或没起来，这一段读不到。',
    )
  }
  const counts = [
    countOf('open-promises', '悬着的承诺', material.open, 'now', true),
    countOf('overdue-promises', '已过期', material.overdue, 'now', true),
  ]
  if (material.open === 0 && material.overdue === 0) {
    return sectionOf(
      'promises',
      'no-material',
      [],
      counts,
      sources,
      '眼下没有悬着的承诺。这段这周没有材料——已经办完的承诺不在这里重复。',
    )
  }
  const lines = material.items.slice(0, maxItems).map(item => snippetOf(item))
  const unread = material.readItems ? '' : '；原话没读到，这一段只报条数'
  const note = material.open === 0
    ? `眼下没有未结算的承诺，但有过期未结算的 ${material.overdue} 条${unread}。这是此刻的存量，不是本周新增。`
    : `眼下还悬着 ${material.open} 条承诺${material.overdue > 0 ? `，其中 ${material.overdue} 条已过期` : ''}${unread}。这是此刻的存量，不是本周新增。`
  return sectionOf('promises', 'has-material', lines, counts, sources, note)
}

/** 日记段：「她自己写的」。 */
export function diarySectionOf(material: DiaryMaterial, maxItems: number): WeeklySection {
  const sources = [
    sourceOf('ondra-diary', 'list()', material.present),
    sourceOf('ondra-diary', 'entry()', material.present && material.readEntries),
  ]
  if (!material.present) {
    return sectionOf('diary', 'not-available', [], [], sources, '日记服务（ondra-diary）没装载或没起来，这一段读不到。')
  }
  if (material.count === 0) {
    return sectionOf(
      'diary',
      'no-material',
      [],
      [countOf('diary-entries', '这周的日记', 0, 'week', material.exact)],
      sources,
      '这一周她一篇日记都没写。这段就写「这周没有日记」，不要替她补写。',
    )
  }
  const lines = material.titles.slice(0, maxItems)
  const tail = material.exact ? '' : '（只读了最近若干篇，实际可能更多）'
  const unread = material.readEntries ? '标题只是索引，正文归日记服务。' : '标题没读到，这里只有日期。'
  return sectionOf(
    'diary',
    'has-material',
    lines,
    [countOf('diary-entries', '这周的日记', material.count, 'week', material.exact)],
    sources,
    `这一周写下 ${material.count} 篇日记${tail}。${unread}`,
  )
}

/**
 * 安静段：说明前三段空在哪。
 * @param others 前三段（不含本段）。
 */
export function quietSectionOf(others: readonly WeeklySection[]): WeeklySection {
  const unavailable = others.filter(item => item.state === 'not-available')
  const empty = others.filter(item => item.state === 'no-material')
  const withMaterial = others.filter(item => item.state === 'has-material')

  // 服务键去重：同一服务在几段里各出现一次，这里只报一次「读到了没有」。
  const merged = new Map<string, boolean>()
  for (const section of others) {
    for (const source of section.sources) {
      const known = merged.get(source.service)
      merged.set(source.service, known === undefined ? source.ok : known && source.ok)
    }
  }
  const sources = [...merged].map(([service, ok]) => sourceOf(service, 'sections', ok))

  if (unavailable.length === others.length && others.length > 0) {
    return sectionOf(
      'quiet',
      'not-available',
      [],
      [],
      sources,
      '三段上游全都读不到，连「这周很安静」都说不准——安静与读不到不是一回事。这一段只写「读不到」。',
    )
  }

  if (empty.length === others.length && others.length > 0) {
    return sectionOf(
      'quiet',
      'has-material',
      ['这周三段都没有材料：没记住新事、没写日记、也没有悬着的承诺。', '骨架照出四段，每段都只写「这周没有材料」，不编事。'],
      [],
      sources,
      '三段都真的回了「没有材料」，所以这周确实安静。要写成「这周很安静」，不能编一件小事来凑。',
    )
  }

  const lines: string[] = []
  if (withMaterial.length > 0) lines.push(`有材料：${withMaterial.map(item => item.title).join('、')}。`)
  if (empty.length > 0) lines.push(`这周没有材料：${empty.map(item => item.title).join('、')}。`)
  if (unavailable.length > 0) lines.push(`读不到：${unavailable.map(item => item.title).join('、')}（读不到不等于没有）。`)

  return sectionOf(
    'quiet',
    'has-material',
    lines,
    [],
    sources,
    '这一段只说哪几段空着、为什么空，不评价这一周过得好不好。',
  )
}

/** 段账目。 */
export function tallyOf(sections: readonly WeeklySection[]): {
  readonly sections: number
  readonly withMaterial: number
  readonly empty: number
  readonly unavailable: number
} {
  const withMaterial = sections.filter(item => item.state === 'has-material').length
  const empty = sections.filter(item => item.state === 'no-material').length
  const unavailable = sections.filter(item => item.state === 'not-available').length
  return Object.freeze({ sections: sections.length, withMaterial, empty, unavailable })
}

/**
 * 整周是否真的安静。
 *
 * **只看前三段，且必须全是 `no-material`**：任何一段 `not-available` 都不能算安静——
 * 「读不到」推出的结论是「不知道」，不是「没有」。
 * @param others 前三段。
 */
export function isQuiet(others: readonly WeeklySection[]): boolean {
  if (others.length === 0) return false
  return others.every(item => item.state === 'no-material')
}

/**
 * 一句话自述。**只说事，不评价、不打分、不是周报正文。**
 * @param range 窗口。
 * @param sections 四段。
 * @param quiet 是否整周安静。
 * @param missing 缺席的上游。
 */
export function summaryOf(
  range: WeeklyRange,
  sections: readonly WeeklySection[],
  quiet: boolean,
  missing: readonly string[],
): string {
  const tally = tallyOf(sections.filter(item => item.id !== 'quiet'))
  const parts: string[] = []

  if (quiet) {
    parts.push(
      `${range.fromKey} 到 ${range.toKey}：这一周没有留下材料——没记住新事、没写日记、也没有悬着的承诺。骨架照出四段，但别替这周编事。`,
    )
  } else if (tally.unavailable > 0) {
    parts.push(
      `这一周读到 ${tally.withMaterial} 段、${tally.empty} 段没有材料、${tally.unavailable} 段读不到（缺：${missing.join('、')}）。读不到不等于没有，骨架里已逐段标明。`,
    )
  } else {
    parts.push(`这一周读到 ${tally.withMaterial} 段材料、${tally.empty} 段没有材料。`)
  }

  parts.push(`窗口 ${range.fromKey} 到 ${range.toKey}，共 ${range.days} 天。`)
  if (!range.clock) parts.push('日界退回本机时区，窗口可能差一天。')
  return parts.join('')
}

/**
 * 从日记引用里挑出落在窗口内的那几篇。
 * @param refs 日记引用（按日期倒序）。
 * @param inRange 判断某日是否在窗口内。
 */
export function diaryRefsInRange(
  refs: readonly DiaryRefLike[],
  inRange: (dayKey: string) => boolean,
): readonly DiaryRefLike[] {
  return refs.filter(item => inRange(item.dayKey))
}
