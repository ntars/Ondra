/**
 * 把一轮对话里「她自己没答上来的事」记进缺口池。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-drive-gap` 有完整的缺口池：三源判定（`detect()`）、张力派生式、
 * 四条件唤醒、判重加压、内感受片段。但**它的六个对外方法在全仓零调用方**：
 *
 * ```
 * open() / dueForWake() / fragment() / markDelivered() / recheck() / dueForDream()
 *                 ↑ 没有任何一个上游问过它们
 * ```
 *
 * 于是池子从建库起就是空的，`highestTension()` 恒 `undefined`，
 * `ondra-proactive-reason` 的 `sources.gap` 永远是「装上了但没内容」。
 * 症状不是报错，是「她从来不会想起什么没弄明白的事」。
 *
 * 这与上一轮 `promise.ts` 补的是同一类洞：上游能力写得很完整，
 * 缺的是**没人往里写**。区别只在于这次写的是「困惑」而不是「待办」。
 *
 * ## 三条刻意的边界
 *
 * 1. **只认她自己说的话。** 「不知道」是她的自认无知；用户说「我不知道」
 *    是用户在说自己，不该变成她的执念。故 `role !== 'assistant'` 一律跳过。
 * 2. **判据一行都不复制。** 认哪些词、「你/她」怎么否决、取整句还是取关键词，
 *    全部由 `gap.detect()` 回答。这里只做「喂进去、接回来、落库」。
 * 3. **不阻断对话。** 整段 try/catch：判定失败、落库失败都只记日志。
 *
 * ## 为什么只接第一源
 *
 * 缺口三源里：
 *
 * | 源 | 写入时机 | 本轮接不接 |
 * | --- | --- | --- |
 * | `model-unsure` | 她自己的话里出现「不知道 / 查不到」 | **接** |
 * | `tool-empty` | 搜索工具返回空 | 不接：要拿到工具返回值，属器官宿主那一层 |
 * | `request-failed` | 请求失败（断网 / 超时） | 不接：同上 |
 *
 * 只接第一源的理由不是省事，是它**唯一有现成数据**：她每轮的话都在
 * `flush()` 的入参里，不需要新增任何上游。另两源要拿工具结果与错误分类，
 * 那是 `ondra-organ-host` 的 `onToolResult()` 才有的视角，硬塞进来会变成
 * 「在 intake 里猜工具结果」，而猜错的代价是往池子里写假执念。
 */

import type { SpokenLine } from './promise.js'
import type { DriveGapLike, GapDetectionLike } from './types.js'

/** 采集结果。 */
export interface GapCatchResult {
  /** 判定命中几句（含被拒收的）。 */
  readonly detected: number
  /** 真的新建了几条。 */
  readonly opened: number
  /** 判重并入已有条目的条数。 */
  readonly merged: number
  /** 为什么一条都没记（`undefined` = 正常跑完了）。 */
  readonly reason?: string
}

/** 什么都没记的结果。 */
const NOTHING: GapCatchResult = Object.freeze({ detected: 0, opened: 0, merged: 0 })

/**
 * 从一轮对话里捡「她自己没答上来」的句子，写进缺口池。
 *
 * @param gap 缺口池服务，缺席时传 `undefined`。
 * @param lines 本轮的原话（含角色）。
 * @param log 日志门面。
 * @param at 本轮时刻。
 */
export function catchGaps(
  gap: DriveGapLike | undefined,
  lines: readonly SpokenLine[],
  log: { warn?(message: string, ...args: readonly unknown[]): void },
  at: number | undefined,
): GapCatchResult {
  if (gap === undefined) return { ...NOTHING, reason: 'no-drive-gap' }
  if (!gap.available) return { ...NOTHING, reason: gap.reason ?? 'unavailable' }

  // 只有她自己的话能变成「她没弄明白的事」。
  const spoken = lines.filter((line) => line.role === 'assistant' && line.text.trim() !== '')
  if (spoken.length === 0) return NOTHING

  let detected = 0
  let opened = 0
  let merged = 0

  /*
   * 一轮只记**一条**。
   *
   * 一段回复里出现两次「不知道」极常见（「不知道你吃没吃」+「这家店我也
   * 查不到」），两句话往往是同一件事的两个说法。把它们都写进池子的后果是
   * 同一件事占两条、各自往 80 涨，于是她为同一件事被叫醒两次——而这正是
   * `similarity()` 那套判重想避免的事。池子自己的判重能挡住，但它只在
   * 「确实很像」时生效；直接一轮取第一条更省事，也更符合「一次困惑」的语义。
   *
   * 取第一条而不是最长那条：句子在回复里的顺序通常就是思路的顺序，
   * 先冒出来的那个「答不上来」往往才是真卡住的地方。
   */
  for (const line of spoken) {
    let detection: GapDetectionLike | undefined
    try {
      detection = gap.detect(line.text)
    } catch (error) {
      log.warn?.('判缺口失败（这句跳过）：%s', messageOf(error))
      continue
    }
    if (detection === undefined) continue

    detected += 1
    try {
      const result = gap.open(
        {
          text: detection.text,
          source: 'model-unsure',
          // 不传 `query`：`model-unsure` 没有归并键，只能按正文相似度判重
          // （见 `classifySourceQuery` 的注释）。传一个空的反而绕开判重。
        },
        at,
      )
      if (!result.accepted) {
        log.warn?.('缺口被拒收（%s）：%s', result.refusal ?? 'unknown', detection.text)
        return { detected, opened, merged }
      }
      if (result.created) opened += 1
      else merged += 1
    } catch (error) {
      log.warn?.('写缺口失败（这句跳过）：%s', messageOf(error))
    }
    // 一轮只记一条：见上面的注释。
    return { detected, opened, merged }
  }

  return { detected, opened, merged }
}

/** 取错误消息。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
