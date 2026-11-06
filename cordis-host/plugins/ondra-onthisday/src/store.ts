/**
 * 当天冻结点的读写。
 *
 * ## 落点与写法
 *
 * `user/onthisday.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 只存「选了哪几条」与「哪几条已经记过账」，**不存记忆正文**。
 * 正文已经在记忆库里了，再抄一份到 JSON 上是把隐私面扩大一倍，
 * 而且会立刻过期（用户订正一条记忆后，两份正文就分叉了）。
 *
 * 代价是：清晰度话术（「记不太清了」）每次重新按当前 R 算。
 * 这是刻意的——**冻结「选择」，不冻结「读数」**。
 * 冻住读数会出现「面板说只剩个模糊的影子、注入行里却写得清清楚楚」，
 * 那种矛盾没人能解释。
 *
 * ## 为什么必须有这个文件
 *
 * 两个理由，都不是「优化」：
 * 1. **同一天内答案不能变。** 前缀缓存要求稳定段恒定；每轮重选会让
 *    ④ 这块在「A B C」与「A C B」之间跳，命中率接近 0（手册 §8.5）。
 * 2. **记账不能重复。** 「带出即加固」如果每轮都做，同一条记忆一天被加固十几次，
 *    它的半衰期会被刷到封顶——看起来像「她特别记得这件事」，实际是记账重入。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { SHELVES } from './types.js'
import type { Shelf } from './types.js'
import { STATE_VERSION } from './types.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 记账表上限。一天最多给 10 条（`cap` 上界），留十倍余量就够。 */
export const ACCOUNTED_MAX = 128

/** 冻结点里的一条。 */
export interface FrozenItem {
  /** 记忆 id。 */
  readonly memoryId: string
  /** 命中哪一档。 */
  readonly shelf: Shelf
  /** 隔了几个自然日。 */
  readonly daysAgo: number
  /** 隔了几年。 */
  readonly yearsAgo: number
  /** 是否走了闰日折叠。 */
  readonly leapFolded: boolean
}

/** 一张完整的状态。 */
export interface OnThisDayState {
  /** 存档版本。 */
  readonly version: number
  /** 这是哪一天算的（`YYYY-MM-DD`；空串表示还没算过）。 */
  readonly dayKey: string
  /** 当天选中的几条（顺序即最终顺序）。 */
  readonly items: readonly FrozenItem[]
  /** 当天命中但没给出的条数。 */
  readonly dropped: number
  /** 算这一天的时扫过多少条。 */
  readonly scanned: number
  /** 算这一天时是否没扫完。 */
  readonly truncated: boolean
  /** 算这一天时发现的问题。 */
  readonly issues: readonly string[]
  /** 算出这些的时刻。 */
  readonly frozenAt: number
  /** 当天已经记过账的记忆 id。 */
  readonly accounted: readonly string[]
}

/**
 * 这一天的结果算过了没有。
 *
 * 判据是 `frozenAt > 0`，不是 `items.length > 0`：
 * 「今天算过了，但一条都没命中」和「今天还没算过」是两件不同的事，
 * 前者不该被反复重算（每次重算都要扫一遍库），后者必须重算。
 * @param state 状态。
 * @param dayKey 今天的自然日键。
 */
export function isFrozenFor(state: OnThisDayState, dayKey: string): boolean {
  return state.dayKey === dayKey && state.frozenAt > 0
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个非负整数。 */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1_000_000, Math.max(0, Math.trunc(value)))
}

/** 读一个档位。 */
function shelfOf(value: unknown): Shelf | undefined {
  return SHELVES.find(item => item === value)
}

/**
 * 归一化一条冻结项。档位不认识的整条丢弃——
 * 档位是排序与上限的唯一依据，猜一个会让它排到错误的位次上。
 * @param raw 原始值。
 */
function normalizeItem(raw: unknown): FrozenItem | undefined {
  if (!isRecord(raw)) return undefined
  const memoryId = raw['memoryId']
  const shelf = shelfOf(raw['shelf'])
  if (typeof memoryId !== 'string' || memoryId === '' || shelf === undefined) return undefined
  return Object.freeze({
    memoryId,
    shelf,
    daysAgo: count(raw['daysAgo']),
    yearsAgo: count(raw['yearsAgo']),
    leapFolded: raw['leapFolded'] === true,
  })
}

/**
 * 空状态。
 * @param dayKey 自然日键；省略表示「还没算过」。
 */
export function emptyState(dayKey = ''): OnThisDayState {
  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    items: Object.freeze([]),
    dropped: 0,
    scanned: 0,
    truncated: false,
    issues: Object.freeze([]),
    frozenAt: 0,
    accounted: Object.freeze([]),
  })
}

/**
 * 把任意读到的值归一化成状态。**永不抛错**。
 * @param raw `JSON.parse` 的结果。
 */
export function normalizeState(raw: unknown): OnThisDayState {
  if (!isRecord(raw)) return emptyState()
  // 版本不认识就当作「还没算过」：这一块重算一次的代价是十几毫秒，
  // 而猜迁移的代价是「今天给出的还是上周选的那几条」。
  if (count(raw['version']) !== STATE_VERSION) return emptyState()

  const dayKey = typeof raw['dayKey'] === 'string' ? raw['dayKey'] : ''
  const items: FrozenItem[] = []
  const rawItems = Array.isArray(raw['items']) ? raw['items'] : []
  for (const entry of rawItems) {
    const normalized = normalizeItem(entry)
    // 同一条只留一次：id 重复会让「另有 N 条」算错，也会让同一行注入两遍。
    if (normalized !== undefined && !items.some(item => item.memoryId === normalized.memoryId)) {
      items.push(normalized)
    }
  }

  const accounted: string[] = []
  const rawAccounted = Array.isArray(raw['accounted']) ? raw['accounted'] : []
  for (const entry of rawAccounted) {
    if (typeof entry === 'string' && entry !== '' && !accounted.includes(entry)) {
      accounted.push(entry)
    }
    if (accounted.length >= ACCOUNTED_MAX) break
  }

  const issues: string[] = []
  const rawIssues = Array.isArray(raw['issues']) ? raw['issues'] : []
  for (const entry of rawIssues) {
    if (typeof entry === 'string' && entry !== '') issues.push(entry.slice(0, 200))
    if (issues.length >= 8) break
  }

  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    items: Object.freeze(items),
    dropped: count(raw['dropped']),
    scanned: count(raw['scanned']),
    truncated: raw['truncated'] === true,
    issues: Object.freeze(issues),
    frozenAt: count(raw['frozenAt']),
    accounted: Object.freeze(accounted),
  })
}

/**
 * 从磁盘读。读不到或读坏了返回 `undefined`（调用方据此判断「今天还没算过」）。
 * @param file 绝对路径；`undefined` 表示没有路径服务（纯内存模式）。
 */
export function readState(file: string | undefined): OnThisDayState | undefined {
  if (file === undefined) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return undefined
    return normalizeState(JSON.parse(text) as unknown)
  } catch {
    // 文件不存在 / 权限不足 / JSON 半截，都按「没有存档」处理。
    // 不在这里打日志：调用方更清楚这一次是首次运行还是存档坏了。
    return undefined
  }
}

/**
 * 原子写。
 * @param file 绝对路径；`undefined` 时返回 `false`。
 * @param state 状态。
 */
export function writeState(file: string | undefined, state: OnThisDayState): boolean {
  if (file === undefined) return false
  const tmp = file + TMP_SUFFIX
  try {
    const payload = JSON.stringify({
      version: STATE_VERSION,
      dayKey: state.dayKey,
      items: state.items,
      dropped: state.dropped,
      scanned: state.scanned,
      truncated: state.truncated,
      issues: state.issues,
      frozenAt: state.frozenAt,
      accounted: state.accounted,
    })
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
