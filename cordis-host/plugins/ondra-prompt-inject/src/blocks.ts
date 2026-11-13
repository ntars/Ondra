/**
 * 八块的**取材**：把「上游有什么」变成「这一轮候选条目」。
 *
 * ## 三条纪律
 *
 * 1. **每一块各自 try/catch**（C3：器官错误不得传播）。一块取材抛错，
 *    只让这一块空着并留一条 `block-error`，绝不把整轮注入打断——
 *    注入挂在对话主链路上，抛一次就是「她这轮不说话」。
 * 2. **条数上限只在这一层施加**，且被上限挡下的条目要**记进 `capDropped`**。
 *    在这里悄悄 `slice` 掉，报告里就永远看不到「因为上限丢了 4 条」。
 * 3. **⑤ 召回不设条数上限**（手册 §12.1 P0 第二条）。它只受预算约束，
 *    所以 `recall` 块的 `cap` 恒为 0；③ 的 ≤5 挡下的 person 类记忆会自然落到 ⑤，
 *    不会被丢掉——这是「上限只作用在块上、不作用在记忆上」的具体样子。
 */

import { formatLine, formatPromiseLine, formatSimpleLine } from './format.js'
import type { Config } from './settings.js'
import { capsOf } from './settings.js'
import { BLOCK_SPECS } from './types.js'
import type {
  BlockId,
  BlockSpec,
  Degradation,
  DroppedItem,
  InjectionItem,
  LogLike,
  MemoryRecordLike,
  RecallHitLike,
  Sources,
} from './types.js'

/** 一天多少毫秒。 */
const DAY_MS = 86_400_000

/** 取材入参。 */
export interface GatherInput {
  /** 当前时刻。 */
  readonly at: number
  /** 当前来信（话头）。 */
  readonly query: string
  /** 配置。 */
  readonly settings: Config
  /** 上游取值函数（全部可缺席）。 */
  readonly sources: Sources
  /** 日志。 */
  readonly log: LogLike
}

/** 取材结果。 */
export interface GatherOutput {
  /** 候选条目（已按块顺序排好，已去重）。 */
  readonly items: readonly InjectionItem[]
  /** 被条数上限挡下的。 */
  readonly capDropped: readonly DroppedItem[]
  /** 降级说明。 */
  readonly degradations: readonly Degradation[]
  /** 各块是否有来源（给 `stats()` 用）。 */
  readonly available: Readonly<Record<BlockId, boolean>>
}

/** 取块声明。 */
function specOf(id: BlockId): BlockSpec {
  const hit = BLOCK_SPECS.find(spec => spec.id === id)
  if (hit === undefined) {
    // 类型上不可能：BLOCK_IDS 与 BLOCK_SPECS 同源。留一个可读的兜底而不是 `!`。
    throw new Error(`未知的注入块：${id}`)
  }
  return hit
}

/**
 * 日历日序号（按本机时区的年月日折算）。
 *
 * 不用「毫秒差 ÷ 86400000」：那算的是「过了多少个 24 小时」，
 * 跨夏令时那天会差一天，于是「整 365 天」在切换日附近会漏掉一条。
 * @param timestamp 时刻。
 */
function dayIndex(timestamp: number): number {
  const date = new Date(timestamp)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/**
 * 是不是「那年今日」。
 *
 * 手册只给三种：≥1 年 / 整 365 天 / 整 30 天。这里用 `% 365 <= 1` 与 `% 30 <= 1`：
 * 闰年会差一天，而「差一天就漏掉」比「多带一条」糟得多。
 * @param createdAt 写入时刻。
 * @param at 当前时刻。
 */
export function anniversaryOf(createdAt: number, at: number): 'year' | 'month' | undefined {
  const days = dayIndex(at) - dayIndex(createdAt)
  if (days >= 365 && days % 365 <= 1) return 'year'
  if (days >= 30 && days % 30 <= 1) return 'month'
  return undefined
}

/** 记忆条目 id。**同一记忆在任何块里都是同一个 id**，去重与记账都靠它。 */
function memId(factId: string): string {
  return `mem:${factId}`
}

/** 把记忆记录变成一条候选。 */
function memoryItem(
  spec: BlockSpec,
  record: MemoryRecordLike,
  at: number,
  weight: number,
  clarity: string | undefined,
): InjectionItem {
  const text = formatLine({
    category: record.category,
    text: record.text,
    createdAt: record.createdAt,
    at,
    timesSaid: record.timesSaid,
    revisions: record.revisions,
    clarity,
  })
  return Object.freeze({
    id: memId(record.id),
    block: spec.id,
    ref: record.id,
    text,
    chars: text.length,
    weight,
    source: spec.source,
  })
}

/** 按权重（块基准 − 名次）给一批条目定权。 */
function weigh(spec: BlockSpec, index: number): number {
  return spec.weight - index
}

/**
 * 取八块候选。
 * @param input 入参。
 */
export function gather(input: GatherInput): GatherOutput {
  const { at, query, settings, sources, log } = input
  const caps = capsOf(settings)
  const items: InjectionItem[] = []
  const capDropped: DroppedItem[] = []
  const degradations: Degradation[] = []
  const used = new Set<string>()
  const available: Record<BlockId, boolean> = {
    promises: false,
    pinned: false,
    persons: false,
    anniversary: false,
    recall: false,
    lessons: false,
    ripple: false,
    resurface: false,
  }

  /** 记一条降级（同一 kind 只记一次，防噪声）。 */
  const degrade = (kind: Degradation['kind'], note: string): void => {
    if (degradations.some(item => item.kind === kind)) return
    degradations.push(Object.freeze({ kind, note }))
  }

  /** 加一条：去重 + 上限。 */
  const push = (spec: BlockSpec, item: InjectionItem): boolean => {
    if (used.has(item.id)) return false
    const cap = caps[spec.id]
    const count = items.filter(existing => existing.block === spec.id).length
    if (cap > 0 && count >= cap) {
      capDropped.push(
        Object.freeze({ id: item.id, block: spec.id, chars: item.chars, reason: 'block-cap' }),
      )
      return false
    }
    used.add(item.id)
    items.push(item)
    return true
  }

  /** 按强度取话术（召回命中用；`null` 表示内核不支持，不编）。 */
  const clarityOfStrength = (strength: number | null): string | undefined => {
    if (!settings.claritySuffix) return undefined
    if (strength === null) return undefined
    const decay = sources.decay()
    if (decay === undefined || !decay.available) return undefined
    try {
      const view = decay.clarityOf(strength)
      return view.phrase.length > 0 ? view.phrase : undefined
    } catch (error) {
      degrade('no-decay', `清晰度话术取不到（${messageOf(error)}），行尾不带「记不太清了」`)
      return undefined
    }
  }

  /** 取清晰度话术（拿不到就不带，**不自己写一份阈值**）。 */
  const clarityOf = (record: MemoryRecordLike): string | undefined => {
    if (!settings.claritySuffix) return undefined
    const decay = sources.decay()
    if (decay === undefined || !decay.available) return undefined
    try {
      const view = decay.clarityOfRecord(record, at)
      return view.phrase.length > 0 ? view.phrase : undefined
    } catch (error) {
      degrade('no-decay', `清晰度话术取不到（${messageOf(error)}），行尾不带「记不太清了」`)
      return undefined
    }
  }

  const core = sources.core()

  /* ---------------- ① 说好的事 ---------------- */
  {
    const spec = specOf('promises')
    const service = sources.prospective()
    if (service === undefined || !service.available) {
      degrade('no-prospective', '承诺/待办服务缺席：① 说好的事 整块不出')
    } else {
      available.promises = true
      try {
        const list = service.dueForReminder(at)
        const sorted = [...list].sort((left, right) => {
          if (right.urgency !== left.urgency) return right.urgency - left.urgency
          return left.hoursLeft - right.hoursLeft
        })
        sorted.forEach((reminder, index) => {
          const text = formatPromiseLine({
            text: reminder.promise.text,
            hoursLeft: reminder.hoursLeft,
            inGrace: reminder.inGrace,
          })
          push(
            spec,
            Object.freeze({
              id: `promise:${reminder.promise.id}`,
              block: spec.id,
              ref: reminder.promise.id,
              text,
              chars: text.length,
              weight: 1000 - index,
              source: spec.source,
            }),
          )
        })
      } catch (error) {
        degrade('block-error', `① 说好的事 取材失败：${messageOf(error)}`)
        log.warn('注入块 ① 取材失败（已跳过这一块）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ② 不能忘的 ---------------- */
  {
    const spec = specOf('pinned')
    const audit = sources.audit()
    if (audit === undefined || !audit.available) {
      degrade('no-audit', '审计服务缺席：② 不能忘的 整块不出（钉住拿不到）')
    } else if (core === undefined || !core.available) {
      degrade('no-core', '记忆内核缺席：② 的钉住只有 id、没有正文，整块不出')
    } else {
      available.pinned = true
      try {
        const pins = audit.pinned()
        pins.forEach((pin, index) => {
          let record: MemoryRecordLike | undefined
          try {
            record = core.getFact(pin.id)
          } catch (error) {
            log.warn('取钉住记忆 %s 失败：%s', pin.id, messageOf(error))
            return
          }
          if (record === undefined) return
          push(spec, memoryItem(spec, record, at, 1100 - index, clarityOf(record)))
        })
      } catch (error) {
        degrade('block-error', `② 不能忘的 取材失败：${messageOf(error)}`)
        log.warn('注入块 ② 取材失败（已跳过这一块）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ⑤ 的原料：本轮召回只跑一次 ---------------- */
  let hits: readonly RecallHitLike[] = []
  {
    const recall = sources.recall()
    if (recall === undefined || !recall.available) {
      degrade('no-recall', '召回服务缺席：③ 我认识的人 与 ⑤ 这会儿想起来的 都不出')
    } else if (query.length === 0) {
      // 没有话头时不检索：`search('')` 会把全库按「新鲜度」倒出来，
      // 那是「按层发牌」的活（O-018），不是召回。
      available.recall = true
    } else {
      available.recall = true
      try {
        const result = recall.search({ text: query, at })
        if (result.ok) hits = result.hits
      } catch (error) {
        degrade('block-error', `召回取材失败：${messageOf(error)}`)
        log.warn('召回取材失败（③⑤ 本轮为空）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ③ 我认识的人 ---------------- */
  {
    const spec = specOf('persons')
    const persons = hits
      .filter(hit => hit.category === 'person')
      .sort((left, right) => {
        const leftScore = left.factors.importance * (left.strength ?? 1)
        const rightScore = right.factors.importance * (right.strength ?? 1)
        return rightScore - leftScore
      })
    persons.forEach((hit, index) => {
      const text = formatLine({
        category: hit.category,
        text: hit.text,
        createdAt: hit.createdAt,
        at,
        clarity: clarityOfStrength(hit.strength),
      })
      push(
        spec,
        Object.freeze({
          id: memId(hit.id),
          block: spec.id,
          ref: hit.id,
          text,
          chars: text.length,
          weight: weigh(spec, index),
          source: spec.source,
        }),
      )
    })

    // ③ 整块空掉时兜底：身份事实是第三人称陈述（「用户自称小玖」），
    // 用户却用第一人称提问（「我是谁」），字面零重合，词法召回常常一条
    // person 类都挑不出来。
    //
    // **判据是 `persons.length === 0`，不是 `hits.length === 0`。**
    // 早先写的是后者，注释却写着「③ 会整块空掉」——两者不是一件事：
    // 召回到 3 条 daily 类的命中时 `hits.length` 是 3，③ 依然一条都挑不出来，
    // 而兜底因为「有命中」被跳过。实测就卡在这里：库里有 3 条 person 事实、
    // 注入侧 `sources.persons` 恒为 false，界面上她永远说不出对方是谁。
    //
    // 只走 push()：条数由 caps.persons 挡，预算由 pack() 的非核心段裁剪挡；
    // 海马体仍由 service.ts 的 guard() 统一拦截，兜底不绕过池判定。
    // query 为空时**不兜底**：无话头属于 O-018「按层发牌」，不是召回。
    if (query.length > 0 && persons.length === 0 && core !== undefined && core.available) {
      try {
        const fallback = core.listFacts({
          category: 'person',
          state: 'active',
          orderBy: 'salience',
          limit: caps.persons,
        })
        fallback.forEach((record, index) => {
          push(spec, memoryItem(spec, record, at, weigh(spec, index), clarityOf(record)))
        })
        if (fallback.length > 0 && settings.verbose) {
          log.info('注入块 ③ 没有 person 命中，按 person 类兜底取回 %d 条', fallback.length)
        }
      } catch (error) {
        degrade('block-error', `③ 我认识的人 兜底取材失败：${messageOf(error)}`)
        log.warn('注入块 ③ 兜底取材失败（已跳过兜底）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ④ 那年今日 ---------------- */
  {
    const spec = specOf('anniversary')
    if (core === undefined || !core.available) {
      degrade('no-core', '记忆内核缺席：④ 那年今日 整块不出')
    } else {
      available.anniversary = true
      try {
        // 按 `last-seen` 升序：最久没被带出的排在最前。O-010 的 `created-at` 是**降序**
        // （最新在前），用它扫「一年前的记忆」等于永远扫不到——库一大就整块失效。
        const rows = core.listFacts({
          limit: settings.anniversaryScanLimit,
          orderBy: 'last-seen',
        })
        if (rows.length >= settings.anniversaryScanLimit) {
          degrade(
            'anniversary-scan-capped',
            `那年今日只扫了最久未带出的 ${settings.anniversaryScanLimit} 条，其余周年可能漏`,
          )
        }
        const picked = rows
          .filter(row => !row.archived && !row.sealed && anniversaryOf(row.createdAt, at) !== undefined)
          .sort((left, right) => right.salience - left.salience)
        picked.forEach((record, index) => {
          push(spec, memoryItem(spec, record, at, weigh(spec, index), clarityOf(record)))
        })
      } catch (error) {
        degrade('block-error', `④ 那年今日 取材失败：${messageOf(error)}`)
        log.warn('注入块 ④ 取材失败（已跳过这一块）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ⑤ 这会儿想起来的 ---------------- */
  {
    const spec = specOf('recall')
    hits.forEach((hit, index) => {
      const text = formatLine({
        category: hit.category,
        text: hit.text,
        createdAt: hit.createdAt,
        at,
        clarity: clarityOfStrength(hit.strength),
      })
      push(
        spec,
        Object.freeze({
          id: memId(hit.id),
          block: spec.id,
          ref: hit.id,
          text,
          chars: text.length,
          weight: weigh(spec, index),
          source: spec.source,
        }),
      )
    })

    // ⑤ 整块空掉时兜底：非 person 事实（猫叫团子、在学大提琴）
    // 是第三人称陈述，用户却用第一人称提问，字面零重合，模型只能照人设编答案。
    //
    // **判据同样是「⑤ 自己落下了几条」，不是 `hits.length`。**
    // 两种命中的存在但 ⑤ 仍为空的情形：
    // ① 命中全是 person 类（那一类归 ③，`push()` 全局去重会让它在这里落不下）；
    // ② 命中的 id 已被前面的块取走。
    // 早先判 `hits.length === 0`，于是「有命中但一条都留不下」时兜底不跑，
    // ⑤ 空着，而 `available.recall` 为 true——诊断说这一块在，正文里却没有。
    //
    // 与 ③ 同一兜底口径：从内核按 salience 取少量 active 事实，筛掉 person 类
    // （那类由 ③ 兜底，push() 也会全局去重），让她这轮至少翻得到旧事。
    // 兜底不是召回命中，必须限量，否则每轮把整库塞进上下文；限量口径复用
    // caps.persons，不新增配置。只走 push()：预算由 pack() 的非核心段裁剪挡，
    // 海马体仍由 service.ts 的 guard() 统一拦，兜底不绕过池判定。
    // 这是词法层补丁而非语义检索；query 为空时不兜底（O-018 按层发牌）。
    const recallItems = items.filter(item => item.block === 'recall').length
    if (query.length > 0 && recallItems === 0 && core !== undefined && core.available) {
      try {
        const fallback = core
          .listFacts({ state: 'active', orderBy: 'salience', limit: settings.anniversaryScanLimit })
          .filter(row => row.category !== 'person')
          .slice(0, caps.persons)
        fallback.forEach((record, index) => {
          push(spec, memoryItem(spec, record, at, weigh(spec, index), clarityOf(record)))
        })
        if (fallback.length > 0 && settings.verbose) {
          log.info('注入块 ⑤ 一条都没落下，按 salience 兜底取回 %d 条', fallback.length)
        }
      } catch (error) {
        degrade('block-error', `⑤ 这会儿想起来的 兜底取材失败：${messageOf(error)}`)
        log.warn('注入块 ⑤ 兜底取材失败（已跳过兜底）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ⑥ 记下的道理 ---------------- */
  {
    const spec = specOf('lessons')
    if (core === undefined || !core.available) {
      degrade('no-core', '记忆内核缺席：⑥ 记下的道理 整块不出')
    } else {
      available.lessons = true
      try {
        const lessons = core.listFacts({ kind: 'lesson', limit: 50 })
        const reflections = core.listFacts({ kind: 'reflection', limit: 50 })
        const merged = [...lessons, ...reflections]
          .filter(row => !row.archived && !row.sealed)
          .sort((left, right) => right.salience - left.salience)
        merged.forEach((record, index) => {
          push(spec, memoryItem(spec, record, at, weigh(spec, index), clarityOf(record)))
        })
      } catch (error) {
        degrade('block-error', `⑥ 记下的道理 取材失败：${messageOf(error)}`)
        log.warn('注入块 ⑥ 取材失败（已跳过这一块）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ⑦ 顺着话头想起来的 ---------------- */
  {
    const spec = specOf('ripple')
    const humanlike = sources.humanlike()
    const seed = hits.length > 0 ? hits[0].id : undefined
    if (humanlike === undefined || !humanlike.available) {
      degrade('no-humanlike', '拟人化服务缺席：⑦ 顺着话头想起来的 整块不出')
    } else if (seed === undefined) {
      // 没有种子就没有扩散起点。**不拿第一条记忆凑数**——那是编一个话头。
      degrade('no-seed', '⑦ 没有召回种子，水波纹本轮不扩散')
    } else {
      available.ripple = true
      try {
        const ripple = humanlike.ripple(seed, { at, maxRings: settings.rippleRings })
        ripple.items
          .filter(item => item.text !== null && item.text.length > 0)
          .forEach((item, index) => {
            const body = item.text === null ? '' : item.text
            const text = formatSimpleLine('想到的', body)
            push(
              spec,
              Object.freeze({
                id: memId(item.id),
                block: spec.id,
                ref: item.id,
                text,
                chars: text.length,
                weight: weigh(spec, index),
                source: spec.source,
              }),
            )
          })
      } catch (error) {
        degrade('block-error', `⑦ 顺着话头想起来的 取材失败：${messageOf(error)}`)
        log.warn('注入块 ⑦ 取材失败（已跳过这一块）：%s', messageOf(error))
      }
    }
  }

  /* ---------------- ⑧ 今天想起来的 ---------------- */
  {
    const spec = specOf('resurface')
    if (core === undefined || !core.available) {
      degrade('no-core', '记忆内核缺席：⑧ 今天想起来的 整块不出')
    } else {
      available.resurface = true
      try {
        const rows = core.dueForResurfacing(30, 1)
        rows.forEach((record, index) => {
          push(spec, memoryItem(spec, record, at, weigh(spec, index), clarityOf(record)))
        })
      } catch (error) {
        degrade('block-error', `⑧ 今天想起来的 取材失败：${messageOf(error)}`)
        log.warn('注入块 ⑧ 取材失败（已跳过这一块）：%s', messageOf(error))
      }
    }
  }

  return Object.freeze({
    items: Object.freeze(items),
    capDropped: Object.freeze(capDropped),
    degradations: Object.freeze(degradations),
    available: Object.freeze(available),
  })
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 导出给测试与自检用的纯函数。 */
export { dayIndex, memId, specOf }
