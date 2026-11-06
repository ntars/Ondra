/**
 * 从上游收集候选（**纯组装，不排序、不判冷却**）。
 *
 * ## 三个上游各给什么
 *
 * | 上游 | 方法 | 得到 | 权重来自 |
 * |---|---|---|---|
 * | O-129 `ondra-drive-gap` | `highestTension()` | 张力最高的那条执念 | `tension / 100` |
 * | O-016 `ondra-memory-prospective` | `dueForReminder()` | 到点/宽限期内的承诺 | `urgency`（上游的反向权重） |
 * | 同上 | `listTodos()` | 未完成的待办 | 由「离过期还有多少」推 |
 * | O-031 `ondra-emotion-express` | `stateOf()` | 六态里的偏离态 | 固定档位表 |
 *
 * 权重**只在同种类内比较**（见 `types.ts` 文件头：手册说的是「优先级」不是「加权」）。
 * 所以这里的数值只需要保证同一来源内部单调，不需要跨来源可比。
 *
 * ## 为什么每个上游都包 try/catch
 *
 * 器官 ABI 的 C3：**器官错误不得传播**。这几个上游都会写库，
 * 一次磁盘满就可能抛错；本插件抛错会让「取话由」整段失败，
 * 而症状是「她突然不主动了」且没有任何原因码。
 *
 * ## 为什么要按话题去重
 *
 * 同一件事可能同时出现在两个上游里（她答应过「明天交周报」，记忆里也有一条近期事件）。
 * 不去重的后果有两个：① `note()` 会把两个 topic 各记一次，冷却表翻倍；
 * ② `pick` 用了其中一条之后，另一条立刻又成为「未冷却的最高分」，
 * 于是同一件事在几分钟内被说两遍——正是 72 小时冷却要防的那件事。
 */

import { EMOTION_SEEDS, KIND_ORDER, UNKNOWN_EMOTION_WEIGHT } from './types.js'
import type {
  CandidateSeed,
  DriveGapLike,
  EventSeed,
  ExpressLike,
  LogLike,
  ProspectiveLike,
  ReasonInput,
  ReasonKind,
  SourceStatus,
} from './types.js'
import { topicOf } from './topics.js'

/** 收集依赖。全部用取值函数：上游晚装载能自愈，早卸载立刻反映。 */
export interface CollectDeps {
  /** O-016 承诺与待办（一张服务两个来源）。 */
  readonly prospective: () => ProspectiveLike | undefined
  /** O-129 缺口池。 */
  readonly gap: () => DriveGapLike | undefined
  /** O-031 情绪表达。 */
  readonly express: () => ExpressLike | undefined
  /** 日志。 */
  readonly log: LogLike
}

/** 收集结果。 */
export interface CollectResult {
  /** 候选（未排序、未判冷却，但**已按话题去重**）。 */
  readonly seeds: readonly CandidateSeed[]
  /** 各来源是否在位。 */
  readonly sources: SourceStatus
}

/** 夹到 0–1。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 取错误消息。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 造一条候选。 */
function seed(
  kind: ReasonKind,
  key: string,
  text: string,
  weight: number,
  dueAt: number,
  source: string,
): CandidateSeed {
  return Object.freeze({
    kind,
    key,
    topic: topicOf(kind, key, text),
    text,
    weight: clamp01(weight),
    dueAt,
    source,
  })
}

/** 把调用方给的事件表转成候选。 */
function fromEvents(kind: ReasonKind, events: readonly EventSeed[] | undefined): CandidateSeed[] {
  if (events === undefined) return []
  const out: CandidateSeed[] = []
  for (const event of events) {
    const text = typeof event.text === 'string' ? event.text.trim() : ''
    if (text === '') continue
    const key = typeof event.key === 'string' && event.key.trim() !== '' ? event.key.trim() : ''
    const weight = typeof event.weight === 'number' ? event.weight : 0.5
    out.push(seed(kind, key, text, weight, typeof event.at === 'number' ? event.at : 0, 'caller'))
  }
  return out
}

/**
 * 按话题去重：同一话题只留**优先级最高**的那条（同优先级留权重高的）。
 *
 * 不做「合并正文」：两条候选的正文是两种说法，合成一句就是编造。
 */
function dedupeByTopic(seeds: readonly CandidateSeed[]): readonly CandidateSeed[] {
  const order = (kind: ReasonKind): number => {
    const index = KIND_ORDER.indexOf(kind)
    return index < 0 ? KIND_ORDER.length : index
  }
  const kept = new Map<string, CandidateSeed>()
  for (const item of seeds) {
    const existing = kept.get(item.topic)
    if (existing === undefined) {
      kept.set(item.topic, item)
      continue
    }
    const better =
      order(item.kind) < order(existing.kind) ||
      (order(item.kind) === order(existing.kind) && item.weight > existing.weight)
    if (better) kept.set(item.topic, item)
  }
  return Object.freeze([...kept.values()])
}

/**
 * 收集候选。
 * @param input 入参。
 * @param at 时刻。
 * @param deps 依赖。
 */
export function collect(input: ReasonInput, at: number, deps: CollectDeps): CollectResult {
  const seeds: CandidateSeed[] = []
  let gapReady = false
  let promiseReady = false
  let emotionReady = false

  // 1. 缺口 / 执念（§5.1 的第一位）。
  const gap = deps.gap()
  if (gap !== undefined) {
    gapReady = true
    try {
      const top = gap.highestTension(at)
      if (top !== undefined && top.status === 'open' && top.text.trim() !== '') {
        seeds.push(seed('gap', top.id, top.text, top.tension / 100, 0, 'ondra-drive-gap'))
      }
    } catch (error) {
      deps.log.warn('取缺口池失败（本轮少一类话由）：%s', messageOf(error))
    }
  }

  // 2. 承诺与待办（O-016 一张服务两个来源）。
  const prospective = deps.prospective()
  if (prospective !== undefined) {
    promiseReady = true
    try {
      for (const item of prospective.dueForReminder(at)) {
        const text = item.promise.text.trim()
        if (text === '') continue
        seeds.push(
          seed(
            'promise',
            item.promise.id,
            text,
            item.urgency,
            item.promise.dueAt,
            'ondra-memory-prospective',
          ),
        )
      }
    } catch (error) {
      deps.log.warn('取承诺到期失败（本轮少一类话由）：%s', messageOf(error))
    }

    try {
      for (const todo of prospective.listTodos()) {
        if (todo.done) continue
        const text = todo.text.trim()
        if (text === '') continue
        // 离过期越近越重：刚建的待办不值得主动提，快过期的才值得。
        const total = Math.max(1, todo.expiresAt - todo.createdAt)
        const left = Math.max(0, todo.expiresAt - at)
        seeds.push(seed('todo', todo.id, text, 1 - left / total, 0, 'ondra-memory-prospective'))
      }
    } catch (error) {
      deps.log.warn('取待办失败（本轮少一类话由）：%s', messageOf(error))
    }
  }

  // 3. 情绪偏离（§9.3 的第二位）。
  const express = deps.express()
  if (express !== undefined) {
    emotionReady = true
    try {
      const view = express.stateOf(at)
      const spec = EMOTION_SEEDS[view.state]
      if (spec !== undefined) {
        seeds.push(seed('emotion', view.state, spec.text, spec.weight, 0, 'ondra-emotion-express'))
      } else if (view.state !== 'calm' && view.state !== 'soft') {
        // O-031 若改了状态名，退化成一条弱候选而不是崩掉。
        seeds.push(
          seed('emotion', view.state, '心里有点动静，想跟你说一声', UNKNOWN_EMOTION_WEIGHT, 0, 'ondra-emotion-express'),
        )
      }
    } catch (error) {
      deps.log.warn('取情绪状态失败（本轮少一类话由）：%s', messageOf(error))
    }
  }

  // 4. 调用方给的：近期事件 / 时间线 / 环境 / 台词池。
  seeds.push(...fromEvents('recent', input.events))
  seeds.push(...fromEvents('timeline', input.timeline))
  seeds.push(...fromEvents('ambient', input.ambient))

  const pool = input.pool
  if (pool !== undefined) {
    for (const line of pool) {
      const text = typeof line === 'string' ? line.trim() : ''
      if (text === '') continue
      // 台词池是兜底：权重固定 0.2，且它的种类序位本来就最低。
      seeds.push(seed('pool', '', text, 0.2, 0, 'caller'))
    }
  }

  const callerUsed =
    input.events !== undefined ||
    input.timeline !== undefined ||
    input.ambient !== undefined ||
    input.pool !== undefined

  return {
    seeds: dedupeByTopic(seeds),
    sources: Object.freeze({
      gap: gapReady,
      promise: promiseReady,
      emotion: emotionReady,
      caller: callerUsed,
    }),
  }
}
