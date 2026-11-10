/**
 * 六层预算的**纯算术与排版**：不碰 ctx、不读文件、不写日志。
 *
 * 把这一层单独拆出来的理由：预算错误是"静默"的——装少了没人报错，
 * 只是模型开始忘事。拆成纯函数后，可以用几行脚本对任意一组条目复现
 * 「这一层到底装进去哪几条、为什么这几条」，而不用起插件。
 *
 * 四条写死在这里、防止下一轮有人顺手改的边界：
 *
 * 1. **层内顺序 = 分数 → priority → 注册序号。** 第三级是**稳定序**：
 *    没有它，同分同优先级的条目顺序取决于 Map 的迭代顺序，
 *    同一份配置在两次启动里可能排出两种前缀，缓存命中率随之腰斩。
 *
 * 2. **常驻条目按 priority → 序号排，绝不按分数排。** 常驻进的是冻结前缀（§8.5），
 *    按分数排等于让前缀跟着这一轮的话题变——那正是 §8.5 点名要消灭的写法。
 *
 * 3. **撞限整条丢，永不切字。** 只有「这条进 / 不进」，没有 `slice`。
 *    截断会让一条设定只剩半句，而模型会把半句当完整设定用。
 *
 * 4. **`stop` 与 `skip` 只差一个 `break`，但两者语义不同**，见 `settings.ts` 的理由。
 */

import { charCount, digestOf, foldText } from './meter.js'
import type { FitPolicy } from './settings.js'
import {
  ALLOCATED_TOKENS,
  LAYER_BUDGETS,
  LAYER_IDS,
  TOTAL_TOKENS,
} from './types.js'
import type {
  ConstantBlock,
  DroppedEntry,
  LayerId,
  LayerSpec,
  LayerUsage,
  PackRequest,
  TokenMeter,
  WorldbookBlock,
  WorldbookEntry,
} from './types.js'

/**
 * 六层的中性名。
 *
 * **刻意不是语义名**（「世界观 / 地点 / 人物」那种）：手册没给层名，
 * 猜一个会让作者按别家习惯归层，然后条目全挤进一个桶被静默丢光。
 * 这里只给序数名，语义由作者在条目里声明（见 `types.ts` 文件头第 1 条）。
 */
const LAYER_LABELS: Readonly<Record<LayerId, string>> = Object.freeze({
  l1: '第一层',
  l2: '第二层',
  l3: '第三层',
  l4: '第四层',
  l5: '第五层',
  l6: '第六层',
})

/** 常驻段标题。稳定不变（它进冻结前缀）。 */
const CONSTANT_HEADING = '【世界书 · 常驻设定】'

/**
 * 六层声明（顺序固定）。
 * @returns 六层声明。
 */
export function layerSpecs(): readonly LayerSpec[] {
  return LAYER_IDS.map((id, order) => ({
    id,
    order,
    label: LAYER_LABELS[id],
    budget: LAYER_BUDGETS[id],
  }))
}

/**
 * 一层的标题。
 * @param id 层 id。
 */
export function layerHeading(id: LayerId): string {
  return '【世界书 · ' + LAYER_LABELS[id] + '】'
}

/**
 * 解析本次生效的层预算。
 *
 * 覆盖值只影响**这一层**，绝不把省下的差额挪给别的层：
 * 挪用会让「层预算」失去意义——谁都能说自己该多分一点。
 * @param overrides 请求里的覆盖值。
 */
export function resolveBudgets(overrides?: Partial<Record<LayerId, number>>): Readonly<Record<LayerId, number>> {
  const out: Record<LayerId, number> = { ...LAYER_BUDGETS }
  if (overrides !== undefined) {
    for (const id of LAYER_IDS) {
      const value = overrides[id]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      out[id] = Math.max(0, Math.trunc(value))
    }
  }
  return out
}

/** 打包入参。 */
export interface PackInput {
  /** 全部已登记条目。 */
  readonly entries: readonly WorldbookEntry[]
  /** 请求。 */
  readonly request: PackRequest
  /** 撞限策略。 */
  readonly fitPolicy: FitPolicy
  /** 是否加层标题。 */
  readonly includeHeadings: boolean
  /** 是否写「另有 N 条未展开」。 */
  readonly annotateDropped: boolean
  /** 计量器。 */
  readonly meter: TokenMeter
}

/** 候选在层内的排序信息。 */
interface Ranked {
  readonly entry: WorldbookEntry
  readonly score: number
}

/**
 * 层内排序：分数降序 → priority 降序 → 注册序号升序（稳定）。
 * @param a 左。
 * @param b 右。
 */
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.entry.priority !== b.entry.priority) return b.entry.priority - a.entry.priority
  return a.entry.seq - b.entry.seq
}

/**
 * 常驻排序：priority 降序 → 注册序号升序。**不看分数**（见文件头第 2 条）。
 * @param a 左。
 * @param b 右。
 */
function compareConstant(a: WorldbookEntry, b: WorldbookEntry): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  return a.seq - b.seq
}

/**
 * 渲染常驻段（冻结前缀）。
 * @param entries 全部条目（只取常驻且启用的）。
 * @param includeHeadings 是否加标题。
 * @param meter 计量器。
 */
export function renderConstant(
  entries: readonly WorldbookEntry[],
  includeHeadings: boolean,
  meter: TokenMeter,
): ConstantBlock {
  const picked = entries.filter(entry => entry.constant && entry.enabled).slice().sort(compareConstant)
  if (picked.length === 0) {
    return { text: '', chars: 0, tokens: 0, ids: [], digest: digestOf('') }
  }
  const lines: string[] = []
  if (includeHeadings) lines.push(CONSTANT_HEADING)
  for (const entry of picked) lines.push('- ' + entry.title + '：' + foldText(entry.text))
  const text = lines.join('\n')
  return {
    text,
    chars: charCount(text),
    tokens: meter(text),
    ids: picked.map(entry => entry.id),
    digest: digestOf(text),
  }
}

/**
 * 按六层预算打包。
 * @param input 入参。
 */
export function packLayers(input: PackInput): WorldbookBlock {
  const { entries, request, fitPolicy, includeHeadings, annotateDropped, meter } = input
  const budgets = resolveBudgets(request.budgets)
  const byId = new Map<string, WorldbookEntry>()
  for (const entry of entries) byId.set(entry.id, entry)

  // 1. 候选去重（同一个 id 交两遍只算一次，分数取最大）。
  const scores = new Map<string, number>()
  for (const candidate of request.candidates ?? []) {
    const score = typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : 0
    const prev = scores.get(candidate.id)
    scores.set(candidate.id, prev === undefined ? score : Math.max(prev, score))
  }

  // 2. 先按「能不能参与」筛一遍，逐条给出原因——丢也要丢得有据。
  const dropped: DroppedEntry[] = []
  const live = new Map<LayerId, Ranked[]>()
  for (const id of LAYER_IDS) live.set(id, [])
  for (const [id, score] of scores) {
    const entry = byId.get(id)
    if (entry === undefined) {
      dropped.push({
        id,
        title: '',
        tokens: 0,
        code: 'unknown',
        detail: '候选里的 id 没有登记过（世界书文件里没有它，或已被 remove）',
      })
      continue
    }
    if (!entry.enabled) {
      dropped.push({
        id,
        layer: entry.layer,
        title: entry.title,
        tokens: entry.tokens,
        code: 'disabled',
        detail: '条目被作者关掉了（enabled=false）',
      })
      continue
    }
    if (request.onlyLayer !== undefined && entry.layer !== request.onlyLayer) {
      dropped.push({
        id,
        layer: entry.layer,
        title: entry.title,
        tokens: entry.tokens,
        code: 'layer-skipped',
        detail: '本次只装「' + request.onlyLayer + '」层',
      })
      continue
    }
    // 常驻已经在冻结前缀里，不再参与本轮的候选装箱（但它照样占层预算，见下面第 3 步）。
    if (entry.constant) continue
    const bucket = live.get(entry.layer)
    if (bucket !== undefined) bucket.push({ entry, score })
  }

  // 3. 逐层：常驻先占额 → 候选按序装 → 撞限按策略处理。
  const perLayer: LayerUsage[] = []
  const included: WorldbookEntry[] = []
  const lines: string[] = []
  let overBudget = false
  let totalUsed = 0

  for (const layer of LAYER_IDS) {
    const budget = budgets[layer]
    const constants = entries.filter(entry => entry.constant && entry.enabled && entry.layer === layer)
    let used = 0
    for (const entry of constants.slice().sort(compareConstant)) {
      if (used + entry.tokens > budget) {
        // 常驻自己超了层预算：仍报出来，但**不装**（宁可少一条，也不破预算）。
        overBudget = true
        dropped.push({
          id: entry.id,
          layer,
          title: entry.title,
          tokens: entry.tokens,
          code: 'over-budget',
          detail: '常驻条目自己就超过了本层预算（' + entry.tokens + ' > ' + budget + '），未进提示词',
        })
        continue
      }
      used += entry.tokens
    }
    const constantTokens = used

    const ranked = (live.get(layer) ?? []).slice().sort(compareRanked)

    // 互斥槽：同层同槽只留第一名，其余记 slot-lost（丢的原因要能解释）。
    const slotWinner = new Map<string, string>()
    for (const item of ranked) {
      const slot = item.entry.slot
      if (slot.length === 0) continue
      if (!slotWinner.has(slot)) slotWinner.set(slot, item.entry.id)
    }

    const layerIncluded: string[] = []
    let layerDropped = 0
    let stopped = false
    for (const item of ranked) {
      const entry = item.entry
      if (entry.slot.length > 0 && slotWinner.get(entry.slot) !== entry.id) {
        layerDropped += 1
        dropped.push({
          id: entry.id,
          layer,
          title: entry.title,
          tokens: entry.tokens,
          code: 'slot-lost',
          detail: '与「' + String(slotWinner.get(entry.slot)) + '」同属互斥槽「' + entry.slot + '」，本轮取分数更高的那条',
        })
        continue
      }
      if (stopped) {
        layerDropped += 1
        dropped.push({
          id: entry.id,
          layer,
          title: entry.title,
          tokens: entry.tokens,
          code: 'over-budget',
          detail: '本层已撞限（fitPolicy=stop），后面的不再尝试',
        })
        continue
      }
      if (used + entry.tokens > budget) {
        layerDropped += 1
        dropped.push({
          id: entry.id,
          layer,
          title: entry.title,
          tokens: entry.tokens,
          code: 'over-budget',
          detail: '本层剩 ' + Math.max(0, budget - used) + ' token，这条要 ' + entry.tokens + ' token',
        })
        if (fitPolicy === 'stop') stopped = true
        continue
      }
      used += entry.tokens
      layerIncluded.push(entry.id)
      included.push(entry)
    }

    totalUsed += used
    perLayer.push({
      id: layer,
      budget,
      used,
      constantTokens,
      included: layerIncluded,
      dropped: layerDropped,
    })

    if (layerIncluded.length > 0) {
      if (includeHeadings) {
        const suffix = annotateDropped && layerDropped > 0 ? '（另有 ' + layerDropped + ' 条未展开）' : ''
        lines.push(layerHeading(layer) + suffix)
      }
      for (const id of layerIncluded) {
        const entry = byId.get(id)
        if (entry !== undefined) lines.push('- ' + entry.title + '：' + foldText(entry.text))
      }
    }
  }

  const text = lines.join('\n')
  const sumBudgets = LAYER_IDS.reduce((sum, id) => sum + budgets[id], 0)
  return {
    text,
    chars: charCount(text),
    tokens: meter(text),
    included,
    dropped,
    perLayer,
    budget: sumBudgets,
    // 内容真的顶破总量上限（只有 override 抬高某层时才可能）也算超。
    overBudget: overBudget || totalUsed > TOTAL_TOKENS,
    digest: digestOf(text),
  }
}

/** 空产物（没有条目、或被关掉时用，避免调用方拿 `undefined` 再判空）。 */
export function emptyBlock(): WorldbookBlock {
  return {
    text: '',
    chars: 0,
    tokens: 0,
    included: [],
    dropped: [],
    perLayer: LAYER_IDS.map(id => ({
      id,
      budget: LAYER_BUDGETS[id],
      used: 0,
      constantTokens: 0,
      included: [],
      dropped: 0,
    })),
    budget: ALLOCATED_TOKENS,
    overBudget: false,
    digest: digestOf(''),
  }
}
