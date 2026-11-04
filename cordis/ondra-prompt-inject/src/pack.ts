/**
 * 装箱算法 —— 手册 §2.6 的「装箱制」**唯一实现**。
 *
 * ```
 *   候选（已过闸）
 *     │
 *     ├─ 核心段（① ②）──── 整块装，不参与预算比较
 *     │
 *     └─ 其余六块 ── 全局按权重降序，逐条试：
 *                     放得下就装；放不下就跳过这条，继续试下一条
 * ```
 *
 * ## 为什么不能「按块整体停」
 *
 * 「⑤ 装不下就停」会让排在后面的 ⑥⑦⑧ 永远进不来，而它们里面往往有短句
 * （「记住她怕黑」只有 6 个字）。手册原话是「装不下就跳过这条、继续试下一条」，
 * 所以这里对**条目**做判定，不对**块**做判定。
 *
 * ## 为什么最后还要再收一次
 *
 * 段标题的字数取决于「这一块掉了几条」——而掉几条只有装完才知道。
 * 先按「没有未展开说明」的标题预留，装完再把多出来的那几十个字收掉
 * （从权重最低的那条开始退），比「先装后算、超了不管」可靠。
 * 收敛是单调的（每轮至少退一条），最多退到只剩核心段为止。
 */

import { RIPPLE_DISCLAIMER, headingOf } from './format.js'
import { BLOCK_SPECS } from './types.js'
import type { BlockId, BlockSpec, DropReason, DroppedItem, InjectionItem, PackedSegment } from './types.js'

/** 装箱入参。 */
export interface PackInput {
  /** 候选条目（顺序无关，内部按块与权重重排）。 */
  readonly items: readonly InjectionItem[]
  /** 预算（字符）。 */
  readonly budgetChars: number
  /** 是否给每段加标题。 */
  readonly includeHeadings: boolean
  /**
   * 装之前的最后一道闸（记忆池「不参与注入」）。
   * 返回原因表示拒绝，返回 `undefined` 表示放行。
   */
  readonly guard?: (item: InjectionItem) => DropReason | undefined
}

/** 装箱结果。 */
export interface PackOutput {
  /** 八段（按固定顺序，空段也在）。 */
  readonly segments: readonly PackedSegment[]
  /** 装进去的条目 id（按段顺序）。 */
  readonly ids: readonly string[]
  /** 掉的全部条目。 */
  readonly dropped: readonly DroppedItem[]
  /** 用了多少字符。 */
  readonly usedChars: number
  /** 核心段占了多少字符。 */
  readonly coreChars: number
  /** 是否超预算。 */
  readonly overBudget: boolean
}

/** 取块声明。 */
function specOf(id: BlockId): BlockSpec {
  const hit = BLOCK_SPECS.find(spec => spec.id === id)
  if (hit === undefined) throw new Error(`未知的注入块：${id}`)
  return hit
}

/** 一段的正文（含免责句）。 */
function bodyOf(spec: BlockSpec, lines: readonly string[]): string {
  if (lines.length === 0) return ''
  const body = lines.join('\n')
  return spec.id === 'ripple' ? `${body}\n${RIPPLE_DISCLAIMER}` : body
}

/** 段的总字符数（标题 + 换行 + 正文）。 */
function segmentChars(heading: string, text: string): number {
  if (text.length === 0) return 0
  if (heading.length === 0) return text.length
  return heading.length + 1 + text.length
}

/** 打包状态（八块各自的已装条目）。 */
interface State {
  readonly buckets: ReadonlyMap<BlockId, readonly InjectionItem[]>
  readonly packed: ReadonlyMap<BlockId, readonly InjectionItem[]>
}

/** 出一份段表。 */
function buildSegments(state: State, includeHeadings: boolean): {
  segments: PackedSegment[]
  ids: string[]
  usedChars: number
  coreChars: number
} {
  const segments: PackedSegment[] = []
  const ids: string[] = []
  let usedChars = 0
  let coreChars = 0
  for (const spec of BLOCK_SPECS) {
    const packed = state.packed.get(spec.id) ?? []
    const bucket = state.buckets.get(spec.id) ?? []
    const text = bodyOf(spec, packed.map(item => item.text))
    const droppedCount = bucket.length - packed.length
    const heading = packed.length === 0 ? '' : headingOf(spec, droppedCount, includeHeadings)
    const chars = segmentChars(heading, text)
    usedChars += chars
    if (spec.core) coreChars += chars
    for (const item of packed) ids.push(item.id)
    segments.push(
      Object.freeze({
        id: spec.id,
        order: spec.order,
        heading,
        text,
        chars,
        items: packed.length,
        dropped: droppedCount,
        core: spec.core,
      }),
    )
  }
  return { segments, ids, usedChars, coreChars }
}

/**
 * 装箱。
 * @param input 入参。
 */
export function pack(input: PackInput): PackOutput {
  const budget = Math.max(0, Math.trunc(input.budgetChars))
  const dropped: DroppedItem[] = []
  const accepted: InjectionItem[] = []

  // 1. 过闸（池判定）。被拒的不进候选，也不计入「未展开」。
  for (const item of input.items) {
    const reason = input.guard === undefined ? undefined : input.guard(item)
    if (reason === undefined) {
      accepted.push(item)
    } else {
      dropped.push(Object.freeze({ id: item.id, block: item.block, chars: item.chars, reason }))
    }
  }

  // 2. 按块分组，组内按权重降序（同权重按 id，保证两次结果一致）。
  const bucketMap = new Map<BlockId, InjectionItem[]>()
  for (const spec of BLOCK_SPECS) bucketMap.set(spec.id, [])
  for (const item of accepted) {
    const bucket = bucketMap.get(item.block)
    if (bucket === undefined) continue
    bucket.push(item)
  }
  for (const bucket of bucketMap.values()) {
    bucket.sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
  }

  // 3. 核心段整块装。
  const packedMap = new Map<BlockId, InjectionItem[]>()
  for (const spec of BLOCK_SPECS) packedMap.set(spec.id, [])
  for (const spec of BLOCK_SPECS) {
    if (!spec.core) continue
    const bucket = bucketMap.get(spec.id)
    if (bucket === undefined) continue
    packedMap.set(spec.id, [...bucket])
  }

  // 4. 预留非核心块的标题（按「没有未展开说明」的长度算）。
  let reserved = 0
  if (input.includeHeadings) {
    for (const spec of BLOCK_SPECS) {
      if (spec.core) continue
      const bucket = bucketMap.get(spec.id)
      if (bucket === undefined || bucket.length === 0) continue
      reserved += spec.title.length + 1
    }
  }

  // 5. 全局按权重降序逐条试装。
  const candidates: InjectionItem[] = []
  for (const spec of BLOCK_SPECS) {
    if (spec.core) continue
    const bucket = bucketMap.get(spec.id)
    if (bucket === undefined) continue
    candidates.push(...bucket)
  }
  candidates.sort((left, right) => {
    if (right.weight !== left.weight) return right.weight - left.weight
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })

  const coreEstimate = buildSegments(
    { buckets: bucketMap, packed: packedMap },
    input.includeHeadings,
  ).coreChars

  /** 按给定的标题预留跑一遍贪心。 */
  const runGreedy = (reserve: number): void => {
    for (const spec of BLOCK_SPECS) {
      if (spec.core) continue
      packedMap.set(spec.id, [])
    }
    let used = coreEstimate + reserve
    for (const item of candidates) {
      const packed = packedMap.get(item.block)
      if (packed === undefined) continue
      const extra = item.chars + (packed.length > 0 ? 1 : 0)
      if (used + extra > budget) continue
      packed.push(item)
      used += extra
    }
  }

  runGreedy(reserved)
  // 一条都没装进去的块不会产生标题，把它的预留退回来再装一次——
  // 否则「预留了 6 个块的标题、实际只装进 2 个块」会白白少装好几条。
  // 只退一轮：退完之后预留只会更小，反复迭代的收益是 0。
  let released = reserved
  for (const spec of BLOCK_SPECS) {
    if (spec.core) continue
    const bucket = bucketMap.get(spec.id)
    const packed = packedMap.get(spec.id)
    if (bucket === undefined || packed === undefined) continue
    if (bucket.length > 0 && packed.length === 0) released -= spec.title.length + 1
  }
  if (released !== reserved) runGreedy(Math.max(0, released))

  // 6. 收尾：段标题里的「另有 N 条未展开」会把字数再抬一点，从权重最低的那条开始退。
  let built = buildSegments({ buckets: bucketMap, packed: packedMap }, input.includeHeadings)
  let guard = 0
  while (built.usedChars > budget && guard < candidates.length + 1) {
    guard += 1
    let victim: InjectionItem | undefined
    let victimBlock: BlockId | undefined
    for (const spec of BLOCK_SPECS) {
      if (spec.core) continue
      const packed = packedMap.get(spec.id)
      if (packed === undefined || packed.length === 0) continue
      const last = packed[packed.length - 1]
      if (victim === undefined || last.weight < victim.weight) {
        victim = last
        victimBlock = spec.id
      }
    }
    if (victim === undefined || victimBlock === undefined) break
    const packed = packedMap.get(victimBlock)
    if (packed === undefined) break
    packed.pop()
    built = buildSegments({ buckets: bucketMap, packed: packedMap }, input.includeHeadings)
  }

  // 7. 没装进去的都记下来（核心段全装，不会出现在这里）。
  const packedIds = new Set(built.ids)
  for (const item of candidates) {
    if (packedIds.has(item.id)) continue
    dropped.push(Object.freeze({ id: item.id, block: item.block, chars: item.chars, reason: 'over-budget' }))
  }

  return Object.freeze({
    segments: Object.freeze(built.segments),
    ids: Object.freeze(built.ids),
    dropped: Object.freeze(dropped),
    usedChars: built.usedChars,
    coreChars: built.coreChars,
    overBudget: built.usedChars > budget,
  })
}

/** 导出给自检用的内部函数（纯函数，无副作用）。 */
export { bodyOf, segmentChars, specOf }
