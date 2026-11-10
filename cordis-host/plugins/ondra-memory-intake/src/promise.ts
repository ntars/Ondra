/**
 * 把一轮对话里的承诺与待办捡出来。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-memory-prospective` 有两张表、有精确的正则抽取（`detect()`）、有
 * 完整的提醒算术，但**全仓没有任何一个调用方**。用户说「明天提醒我把合同
 * 打出来」，`detect()` 能一字不差地认出来，可没人问它——于是：
 *
 * ```
 * 用户说了一句话 → （空） → 承诺表空 → 话由源空 → 主动开口只能靠通用句
 * ```
 *
 * 症状不是报错，是「她从来不记得你交代过什么」，以及「她主动说话时永远
 * 没有由头」。这条边接上，`ondra-proactive-reason` 才第一次真的有东西可说。
 *
 * ## 三条刻意的边界
 *
 * 1. **只认用户说的话。** 她自己的「我明天帮你查」也会被正则命中，但那是
 *    她的话，不是用户交代的事。把两者混进同一张表的后果是：她会对着自己
 *    虚构的承诺发提醒。故 `role !== 'user'` 一律跳过。
 * 2. **抽取逻辑一行都不复制。** 认什么词、几个字到几个字、什么算时间词，
 *    全部由 `prospective.detect()` 回答。这里只做「喂进去、接回来、落库」。
 *    复制一份的后果是两套判据慢慢漂开，而症状是「设置里改了长度限制，
 *    但只对其中一条路径生效」。
 * 3. **不阻断对话。** 整段 try/catch：抽取失败、落库失败都只记日志。
 *    她回话的质量不该被「待办表写不进去」影响。
 *
 * ## 为什么先查重
 *
 * 同一句「明天提醒我交周报」在一轮里可能被 `detect()` 返回一次，下一轮用户
 * 复述「明天那个周报记得吧」又命中一次。不去重的后果是待办表里三条一样的，
 * 上限（默认 3 条）被一件事吃光，之后真的新交代的事反而写不进去。
 */

import type { DetectedLike, ProspectiveLike } from './types.js'

/** 一轮里各条用户原话。 */
export interface SpokenLine {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** 采集结果。 */
export interface CatchResult {
  /** 新记的承诺条数。 */
  readonly promises: number
  /** 新记的待办条数。 */
  readonly todos: number
  /** 因重复而跳过的条数。 */
  readonly duplicates: number
  /** 为什么一条都没记（`undefined` = 正常跑完了）。 */
  readonly reason?: string
}

/** 什么都没记的结果。 */
const NOTHING: CatchResult = Object.freeze({ promises: 0, todos: 0, duplicates: 0 })

/**
 * 从一轮对话里捡承诺与待办。
 *
 * @param prospective 承诺与待办服务，缺席时传 `undefined`。
 * @param lines 本轮的原话（含角色）。
 * @param log 日志门面。
 * @param at 本轮时刻。
 */
export function catchPromises(
  prospective: ProspectiveLike | undefined,
  lines: readonly SpokenLine[],
  log: { warn?(message: string, ...args: readonly unknown[]): void },
  at: number | undefined,
): CatchResult {
  if (prospective === undefined) return { ...NOTHING, reason: 'no-prospective' }
  if (!prospective.available) return { ...NOTHING, reason: prospective.reason ?? 'unavailable' }

  // 只有用户说的话能变成「交代给她的事」。
  const spoken = lines.filter((line) => line.role === 'user' && line.text.trim() !== '')
  if (spoken.length === 0) return NOTHING

  let promises = 0
  let todos = 0
  let duplicates = 0

  /*
   * 已在库里的正文，用于查重。
   *
   * 只按**整句相等**判重，不做相似度：模板化的短句（「记得喝水」）两两都有
   * 很高的字面相似度，按相似度判重会把「记得买牛奶」和「记得买面包」判成
   * 同一件事。宁可多记一条（用户能自己删），不可错并。
   */
  const existing = new Set<string>()
  try {
    for (const todo of prospective.listTodos()) existing.add(normalize(todo.text))
    for (const item of prospective.dueForReminder(at)) existing.add(normalize(item.promise.text))
  } catch (error) {
    // 读不到已有条目就往下走：查重是优化，不是前提。
    log.warn?.('读已有承诺与待办失败（本次不查重）：%s', messageOf(error))
  }

  for (const line of spoken) {
    let detected: readonly DetectedLike[] = []
    try {
      detected = prospective.detect(line.text, at)
    } catch (error) {
      log.warn?.('抽取承诺与待办失败（这句跳过）：%s', messageOf(error))
      continue
    }

    for (const item of detected) {
      const key = normalize(item.text)
      if (key === '') continue
      if (existing.has(key)) {
        duplicates += 1
        continue
      }

      try {
        if (item.kind === 'promise') {
          /*
           * 承诺要写记忆（`category=promise`），没有记忆内核时 `remember()` 会抛
           * `no-core`。这不是错误配置，是「记忆链还没接通」——此时退化成待办
           * 比整条丢掉好：待办不进记忆，照样能被提醒、能当话由。
           */
          try {
            prospective.remember(item.text, {
              ...item.dueAt === null ? {} : { dueAt: item.dueAt },
              ...at === undefined ? {} : { at },
            })
            promises += 1
          } catch {
            prospective.addTodo(item.text, at)
            todos += 1
          }
        } else {
          prospective.addTodo(item.text, at)
          todos += 1
        }
        existing.add(key)
      } catch (error) {
        // 上限已满（`promise-full` / 待办满）也走这里：那是产品设定，不是缺陷。
        log.warn?.('记一条「%s」失败：%s', item.text, messageOf(error))
      }
    }
  }

  return { promises, todos, duplicates }
}

/** 判重用的归一化：只去空白与句末标点，不动字。 */
function normalize(text: string): string {
  return text.replace(/\s+/gu, '').replace(/[。！？.!?，,、；;：:]+$/u, '')
}

/** 取错误消息。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
