/**
 * 纯函数层：**把上游数字投影成读数，并说清「这个数从哪来」。**
 *
 * 这一层不碰 ctx、不碰文件，全部输入是「已经取到的上游值或 `undefined`」。
 * 好处是「上游缺席时到底该怎么显示」这条规则可以被单独对拍，
 * 不必先起一个真服务。
 *
 * ## 一条贯穿全文件的判据
 *
 * **上游没给 → `value: null` → `state: 'unknown'` → `note` 说清缺谁。**
 * 不许用 0 顶替、不许用上一轮缓存顶替、不许插值。
 * 一个错的数字比没有数字糟得多——没有数字只会让人问一句，
 * 错的数字会让人据此做决定。
 */

import { READING_SPECS, STATE_CUTS } from './types.js'
import type {
  ReadingId,
  ReadingState,
  TrustReading,
  TrustReadingSource,
} from './types.js'

/** 把比例夹到 0–1；非有限数返回 `null`（**不返回 0**）。 */
export function ratioOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** 把计数取整；非有限数或负数返回 `null`。 */
export function countOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

/**
 * 比例 → 档位。
 *
 * 两刀都从既有参数反推：0.35 低于「有来往」的水平，0.7 是 master-plan §9.1
 * 落定阶要求的信任下限。**不引入第三条线**。
 * @param value 比例或 `null`。
 */
export function stateOf(value: number | null): ReadingState {
  if (value === null) return 'unknown'
  if (value < STATE_CUTS.low) return 'low'
  if (value < STATE_CUTS.high) return 'mid'
  return 'high'
}

/** 造一个来源项。 */
export function sourceOf(service: string, field: string, ok: boolean): TrustReadingSource {
  return Object.freeze({ service, field, ok })
}

/** 一个读数项的说明（从真源表取，不复制文字）。 */
function specZhOf(id: ReadingId): string {
  return READING_SPECS[id].zh
}

/**
 * 关系类读数（`trust` / `intimacy` / `familiarity`）。
 * @param id 项 id。
 * @param relation 关系快照；上游缺席为 `undefined`。
 */
export function relationReadingOf(
  id: 'trust' | 'intimacy' | 'familiarity',
  relation:
    | {
        readonly trust: number
        readonly intimacy: number
        readonly familiarity: number
        readonly days: number
        readonly interactions: number
      }
    | undefined,
): TrustReading {
  const zh = specZhOf(id)
  if (relation === undefined) {
    return Object.freeze({
      id,
      zh,
      value: null,
      state: 'unknown',
      note: `关系服务（ondra-emotion-stage）没装载或没起来，${zh}这一项这会儿读不到。不是 0——是读不到。`,
      sources: Object.freeze([sourceOf('ondra-emotion-stage', 'relation()', false)]),
    })
  }

  const value = ratioOf(relation[id])
  const tail = id === 'familiarity' ? `由 ${relation.interactions} 次互动推导` : `相处 ${relation.days} 天`

  return Object.freeze({
    id,
    zh,
    value,
    state: stateOf(value),
    note:
      value === null
        ? `关系服务返回的 ${id} 不是有效数字，这一项按读不到处理。`
        : `${zh}取自关系服务，${tail}。`,
    sources: Object.freeze([sourceOf('ondra-emotion-stage', `relation().${id}`, value !== null)]),
  })
}

/**
 * 履约率读数。
 *
 * 分母**只算已结算的**（`kept + broken`），不含 `open`：
 * 把未结算的算进分母，拖着不办会让比例虚高——那是最容易被刷的一项。
 * @param stats 承诺统计；上游缺席为 `undefined`。
 */
export function promiseReadingOf(
  stats:
    | {
        readonly promises: {
          readonly open: number
          readonly kept: number
          readonly broken: number
          readonly expired: number
          readonly total: number
        }
        readonly overdue: number
      }
    | undefined,
): TrustReading {
  const zh = specZhOf('promise-kept')
  const id: ReadingId = 'promise-kept'

  if (stats === undefined) {
    return Object.freeze({
      id,
      zh,
      value: null,
      state: 'unknown',
      note: '承诺服务（ondra-memory-prospective）没装载，履约率这一项读不到。',
      sources: Object.freeze([sourceOf('ondra-memory-prospective', 'stats().promises', false)]),
    })
  }

  const kept = Math.max(0, Math.trunc(stats.promises.kept))
  const broken = Math.max(0, Math.trunc(stats.promises.broken))
  const settled = kept + broken

  if (settled === 0) {
    return Object.freeze({
      id,
      zh,
      value: null,
      state: 'unknown',
      note:
        stats.promises.open > 0
          ? `还没有结算过的承诺（${stats.promises.open} 条未到期）。没结算过就是没数据，不按 100% 算。`
          : '还没有过承诺，这一项没有数据。',
      sources: Object.freeze([sourceOf('ondra-memory-prospective', 'stats().promises', true)]),
    })
  }

  const value = ratioOf(kept / settled)
  const overdueTail = stats.overdue > 0 ? `，另有 ${stats.overdue} 条已过期未结算（不进分母）` : ''

  return Object.freeze({
    id,
    zh,
    value,
    state: stateOf(value),
    note: `已结算 ${settled} 条：守约 ${kept}、违约 ${broken}${overdueTail}。`,
    sources: Object.freeze([sourceOf('ondra-memory-prospective', 'stats().promises', true)]),
    detail: Object.freeze({ kept, broken, settled, open: stats.promises.open }),
  })
}

/**
 * 记忆存量读数（唯一一项计数型）。
 *
 * `value` 是**活跃条数**，不是比例。故意不给「占总量百分之几」：
 * 那个比例的分母（含已沉底、已封存）随时在变，算出来只会让人误读成「记忆覆盖度」。
 * @param active 活跃条数；`undefined` = 读不到。
 * @param pinned 钉子条数；`undefined` = 读不到。
 */
export function memoryReadingOf(active: number | null, pinned: number | null): TrustReading {
  const zh = specZhOf('memory-cover')
  const id: ReadingId = 'memory-cover'

  if (active === null) {
    return Object.freeze({
      id,
      zh,
      value: null,
      state: 'unknown',
      note: '记忆服务（ondra-memory-core）没装载或没起来，记忆存量这一项读不到。',
      sources: Object.freeze([sourceOf('ondra-memory-core', 'countFacts()', false)]),
    })
  }

  const pinnedText =
    pinned === null ? '钉子数读不到（审计服务未装载）' : `其中 ${pinned} 条被钉住（钉住的不参与衰减）`

  return Object.freeze({
    id,
    zh,
    value: active,
    // 计数型没有「高/低」的意义，恒为 `mid`；界面按计数画，不按档位画。
    state: 'mid',
    note: `还有 ${active} 条记忆活着，${pinnedText}。这是计数，不是比例。`,
    sources: Object.freeze([
      sourceOf('ondra-memory-core', 'countFacts()', true),
      sourceOf('ondra-memory-audit', 'pinned()', pinned !== null),
    ]),
    detail: Object.freeze({ active, pinned: pinned ?? 0 }),
  })
}

/**
 * 一句话总结。
 *
 * **刻意不报比例、不评价、不鼓励**：
 * 「信任 68%，继续加油！」这类话会被当成评分系统，然后开始刷分
 * （O-097 / O-100 同一条理由）。这里只说「读到了几项、缺了谁、哪一项最低」。
 * @param readings 全部读数。
 * @param missing 缺席的上游。
 */
export function summaryOf(readings: readonly TrustReading[], missing: readonly string[]): string {
  const known = readings.filter(item => item.value !== null)
  if (known.length === 0) {
    return missing.length === 0
      ? '一项读数都没取到，检查各上游服务是否已装载。'
      : `一项读数都没取到。缺：${missing.join('、')}。`
  }

  // 只指「最弱那一项」，不全指一遍（全指等于没指，O-097 同一条）。
  const ratios = known.filter(item => READING_SPECS[item.id].ratio && typeof item.value === 'number')
  const weakest = ratios.length > 0
    ? ratios.reduce((low, item) => ((item.value as number) < (low.value as number) ? item : low))
    : undefined

  const parts: string[] = []
  parts.push(`读到 ${known.length} 项、读不到 ${readings.length - known.length} 项。`)
  if (weakest !== undefined) parts.push(`其中最低的是「${weakest.zh}」。`)
  if (missing.length > 0) parts.push(`缺：${missing.join('、')}。`)
  return parts.join('')
}
