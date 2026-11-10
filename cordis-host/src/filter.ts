/**
 * 表达层的**闸门**：她打好字、还没发出去的那一瞬间，过九道手。
 *
 * ## 它补的是哪条断掉的边
 *
 * `ondra-filter-chain`（O-037）九个步骤、九张句式表、锚点检测、事后评审，
 * 一份不少地写完了。四个上游也全都在名单里：
 *
 * | 上游 | 用它做什么 | 缺了少哪一步 |
 * | --- | --- | --- |
 * | `ondra-persona-core` | 硬约束字面 + 关系 `cautions` | 硬红线、关系越线 |
 * | `ondra-emotion-stage` | 当前阶序 | 阶段越线 |
 * | `ondra-emotion-express` | 困 / 炸毛时收紧长度 | 长度兜底仍是 400 |
 * | `ondra-llm-gateway` | 事后评审那一次打分 | 评审一律 `degraded` 放行 |
 *
 * 缺的只有一件事：**没有任何地方调 `run()`**。于是 `stats().runs` 从建库起
 * 一直是 0，而日志干净、界面正常、`available` 为 true——
 * 与本仓前九次同族（`speakReply` / `publishTurn` / `applyTurn` / `presence` /
 * `recordTurn` / `claim` / `project` / `ingest` / `diffuse`）同一个形态：
 * **组件完好，中间少一根线，两边都不报错。**
 *
 * ## 为什么接在这里：塑形之前，`done` 之前
 *
 * ```
 * 模型原文 ─→ 九步过滤（本文件）─→ 口语化塑形（oral）─→ 分条记账 ─→ done
 * ```
 *
 * 两个顺序都不能挪：
 *
 * 1. **必须在 `shapeReply()` 之前。** 九步里八步靠 `splitSentences()` 断句，
 *    而口语化会去句末句号、省主语。让过滤看一句没有句号的文本，
 *    「删掉第三句旁白」就无从判起——句号是它唯一的边界依据。
 *    反过来的话，症状是「过滤链装了但几乎从不命中」，而计数照涨。
 * 2. **必须在 `done` 之前。** 界面用 `done` 的完整文本覆盖流式正文。
 *    放在之后就是「界面上有那句旁白、记忆里没有」——两处不一致。
 *
 * ## 删空了怎么办：放行原文，但说出来
 *
 * 插件的裁决是 `ok=false` + `needsRegenerate=true`，明写「删空不编话」。
 * 但「重新生成」这一步只有对话链能做，而此刻模型已经跑完了——
 * 宿主若真的拒收，用户看到的是一个**空白气泡**，比那句旁白糟得多。
 *
 * 所以这里的选择是：`ok=false` 时用**过滤前的原文**，并在 stderr 留一行、
 * 在探针里计一次 `blocked`。理由与 `tts` 的 `held` 同一条——
 * 用户能看见的那句话，不该被一个「宁缺」的原则换成空气。
 *
 * ## 为什么本轮不做锚点注入与事后评审
 *
 * - `anchors()` 只交一句话，把它注进提示词要动冻结前缀的口径（O-033 / O-036），
 *   那是另一条链的事，塞在这里会让前缀在回合中间变。
 * - `review()` 要再叫一次模型、拿 1–100 分、低于阈值还要重写。它属于
 *   「这一轮已经结束」之后的异步动作，而宿主目前的 `stream()` 只有一条
 *   收尾路径。硬接会让 `done` 多等一次模型往返（2–8 秒），
 *   用户感知是「说完之后卡住」，比不做评审糟。
 *
 * 两件都如实记进探针的 `note`，不假装做了。
 */

import type { Context } from '@ntars/cordis'

/** 单步结果（结构对位子集，不 import 插件源码）。 */
interface StepLike {
  readonly step: string
  readonly beforeChars: number
  readonly afterChars: number
  readonly changed: boolean
  readonly removed: number
}

/** 一次过滤的结果（结构对位子集）。 */
interface ChainLike {
  readonly ok: boolean
  readonly text: string
  readonly originalChars: number
  readonly finalChars: number
  readonly steps: readonly StepLike[]
  readonly needsRegenerate: boolean
  readonly hardCut: boolean
  readonly maxChars: number
}

/** 过滤服务（结构对位子集）。 */
interface FilterPort {
  readonly available: boolean
  readonly reason?: string
  run(input: {
    readonly text: string
    readonly userText?: string
    readonly recent?: readonly string[]
    readonly at?: number
  }): ChainLike
  stats(): {
    readonly available: boolean
    readonly reason?: string
    readonly runs: number
    readonly lastRemoved: number
    readonly lastNeedsRegenerate: boolean
    readonly reviews: number
    readonly steers: number
    readonly roundLimited: number
    readonly sources: {
      readonly persona: boolean
      readonly stage: boolean
      readonly express: boolean
      readonly gateway: boolean
    }
  }
}

/** 一次过滤的结论。 */
export interface FilterOutcome {
  /** 真正该进下一环的那句。插件缺席、关掉、或判删空时是原文。 */
  readonly text: string
  /** 走的是哪条路。`filtered` 才算真过了一遍。 */
  readonly status: 'filtered' | 'blocked' | 'unchanged' | 'absent' | 'off' | 'empty'
  /** 被哪一步动过手（只在 `filtered` 时有值）。 */
  readonly steps: readonly string[]
  /** 摘掉几句。 */
  readonly removed: number
  /** 是否硬切过（唯一会切在句中的情况）。 */
  readonly hardCut: boolean
}

/** 过滤探针读数。给设置页与诊断接口用。 */
export interface FilterProbe {
  /** `ondra-filter-chain` 在不在。 */
  readonly loaded: boolean
  /** 用户关没关（`filter-chain` 段的 `enable`）。 */
  readonly enabled: boolean
  /** 插件自报可用。 */
  readonly available: boolean
  /** 一句话说清「为什么现在不过滤」。正常时为空串。 */
  readonly note: string
  /** 本轮没做的两件事，如实说出来。 */
  readonly pending: readonly string[]
  /**
   * 插件账本。
   *
   * `runs` 长期为 0 → `run()` 一次都没被调过，宿主那根线断了；
   * `runs` 涨而 `lastRemoved` 恒 0 → 在跑但一句都没命中。
   */
  readonly stats?: {
    readonly runs: number
    readonly lastRemoved: number
    readonly lastNeedsRegenerate: boolean
    readonly reviews: number
    readonly steers: number
    readonly roundLimited: number
    readonly sources: {
      readonly persona: boolean
      readonly stage: boolean
      readonly express: boolean
      readonly gateway: boolean
    }
  } | undefined
}

/** 读过滤服务。 */
function portOf(ctx: Context): FilterPort | undefined {
  return ctx.get('ondra-filter-chain') as FilterPort | undefined
}

/**
 * 过一遍九步。
 *
 * **永不抛错**：过滤是减法，它挂了这一轮对话必须照常成立。
 * @param ctx 宿主上下文。
 * @param text 模型原文。
 * @param userText 用户这一轮说的话（判 4-gram 复读与锚点用）。
 */
export function filterReply(ctx: Context, text: string, userText: string): FilterOutcome {
  const pass = Object.freeze({
    text,
    steps: Object.freeze([]) as readonly string[],
    removed: 0,
    hardCut: false,
  })
  const filter = portOf(ctx)
  if (filter === undefined) return Object.freeze({ ...pass, status: 'absent' })
  if (filter.available !== true || filter.reason === 'disabled') {
    return Object.freeze({ ...pass, status: 'off' })
  }
  if (text.trim() === '') return Object.freeze({ ...pass, status: 'empty' })

  try {
    const result = filter.run({ text, userText, at: Date.now() })
    const touched = result.steps.filter(step => step.changed).map(step => step.step)
    /*
     * 判删空时放行原文。
     *
     * 不退回 `''`：那会让气泡彻底空白，而用户已经在等这一句了。
     * 也不拿一句「嗯…」顶上：那是宿主在替她说话，比旁白更假。
     */
    if (!result.ok) {
      process.stderr.write(
        `[host] 过滤判整段拒收（${result.needsRegenerate ? '删空' : '过短'}，`
        + `原文 ${String(result.originalChars)} 字 → ${String(result.finalChars)} 字）：`
        + '本轮放行原文，等对话链重生成后才能真拒\n',
      )
      return Object.freeze({ ...pass, status: 'blocked' })
    }
    return Object.freeze({
      text: result.text,
      status: result.text === text ? 'unchanged' : 'filtered',
      steps: Object.freeze(touched),
      removed: result.steps.reduce((sum, step) => sum + step.removed, 0),
      hardCut: result.hardCut,
    })
  } catch (error) {
    process.stderr.write(`[host] 过滤异常（本轮放行原文）：${String(error)}\n`)
    return Object.freeze({ ...pass, status: 'absent' })
  }
}

/**
 * 只读探针。不跑过滤、不动计数。
 * @param ctx 宿主上下文。
 */
export function filterProbe(ctx: Context): FilterProbe {
  const filter = portOf(ctx)
  if (filter === undefined) {
    return Object.freeze({
      loaded: false,
      enabled: false,
      available: false,
      note: '输出过滤插件没装载',
      pending: Object.freeze([]) as readonly string[],
    })
  }
  const pending = Object.freeze([
    '锚点纠偏还没有注进提示词（要动冻结前缀，归对话链那一侧）',
    '事后评审还没接（要再叫一次模型，会让 done 多等一次往返）',
  ]) as readonly string[]
  let stats: FilterProbe['stats']
  try {
    stats = filter.stats()
  } catch {
    // 读不到就整格省掉，不编一个全零的假账本。
  }
  if (filter.available !== true || filter.reason === 'disabled') {
    return Object.freeze({
      loaded: true,
      enabled: false,
      available: false,
      note: '输出过滤关着（在设置里打开「输出过滤」的总开关才会删句）',
      pending,
      ...(stats === undefined ? {} : { stats }),
    })
  }
  return Object.freeze({
    loaded: true,
    enabled: true,
    available: true,
    note: '',
    pending,
    ...(stats === undefined ? {} : { stats }),
  })
}
