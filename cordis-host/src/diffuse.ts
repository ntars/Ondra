/**
 * 跨会话的情绪弥散 —— 宿主侧的**唯一落笔处**。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-emotion-diffuse` 从算术到幂等闸、间隔闸、标记表全都写完了，文档、
 * 参数表、边界情形一应俱全。它缺的不是代码，是**调用方**：
 *
 * ```
 * claim({ boundaryKey })          ← 全仓零调用方
 * ondra-emotion-diffuse           ← 不在默认启用名单里
 * ```
 *
 * 于是「换一场会话，上一场剩下的心情还剩多少」这件事从来没有发生过。
 * 症状不是报错，是**她每次都像刚开完一场没断过的对话**——而基线心情
 * 是合法状态，所以没有任何一处会说「我断了」。这正是本仓第五次踩同一个形态：
 *
 * | 轮次 | 缺的调用方 | 症状 |
 * | --- | --- | --- |
 * | 二十二 | `session/event` 发出方 | 六张表从建库起 0 行 |
 * | 二十三 | `ctx.get('llm')` 注册方 | `memory_fact` 恒 0 |
 * | 二十四 | `feel()` / `comfort()` | `emotion_state` 恒 0 |
 * | 本轮 | `claim()` + `setAxis()` | 心情跨不过会话边界 |
 *
 * ## 为什么落笔在宿主，不在插件
 *
 * 插件**刻意**没把 `setAxis` 放进自己的结构对位接口里（`EmotionLike` 只有
 * `state` 与 `available`），`applied` 的类型写成字面量 `false`。这是有意的
 * 设计：它只算不写。于是「谁来写」必须有答案，而这个答案只能是宿主——
 * 它是唯一同时看得到「会话正在开始」与「情绪服务在位」的位置。
 *
 * 界面不行：它不知道 `minGapMinutes` 那道闸，也拿不到标记表，重复调就会
 * 把残差乘两遍（0.4 → 0.16），现象是「她越聊越淡」，查不出是弥散算多了。
 *
 * ## 为什么在推理之前，不在这一轮结束之后
 *
 * 顺序错了会把刚发生的事也一起衰减掉：
 *
 * ```
 * 错：这一轮的情绪事件 → 弥散 ×0.4        （这轮的起伏被抹平）
 * 对：弥散 → 这一轮的情绪事件              （先结算上一场，再记这一场）
 * ```
 *
 * 而且弥散必须在**装配系统提示词之前**：六态、语域、句长系数都从心情读，
 * 上一场的余温若在这一步之后才结算，她这一轮说话用的就是旧值——
 * 用户感知到的是「隔了一夜，她还是昨天那个语气」。
 *
 * ## 三道闸都不在这里重写
 *
 * 幂等（同一 `boundaryKey` 只算一次）、间隔（不足 `minGapMinutes` 判同一场）、
 * 可用性（情绪内核缺席 / 配置关闭）全部归插件。这里只做三件事：
 * 生成边界键、把结果写回去、把「为什么没弥散」如实说出来。
 *
 * 尤其**不在调用方算间隔**：那会让「多久算一场会话」出现两处真源，
 * 而设置页里那个 `min-gap-minutes` 只改得动其中一处。
 */

import type { Context } from '@ntars/cordis'

/**
 * 弥散结果里宿主用得到的那几个字段。
 *
 * 只声明这几个而不是把插件的完整契约抄过来：抄一遍契约就等于在这里
 * 维护第二份形状，插件加字段时要改两处，漏一处就编译不过——那还是好的，
 * 更坏的是形状对得上、语义已经漂了。
 */
export interface DiffusePlanLike {
  /** 状态码。`diffused` 是唯一需要落笔的那一支。 */
  readonly status: 'diffused' | 'already' | 'no-gap' | 'no-emotion' | 'disabled' | 'bad-request'
  /** 目标心情。`status === 'diffused'` 时才是「该写进去的值」。 */
  readonly target: number
  /** 弥散前的心情。 */
  readonly moodBefore: number
  /** 目标减现值。 */
  readonly delta: number
  /** 人话说明，只进日志，不进提示词（§4.3 禁报数）。 */
  readonly note: string
}

/** 弥散服务的结构对位子集。 */
export interface DiffuseLike {
  readonly available: boolean
  readonly reason?: string
  claim(request: {
    readonly boundaryKey: string
    readonly familiarity?: number
    readonly at?: number
  }): DiffusePlanLike
}

/**
 * 关系服务的读侧子集。
 *
 * 只取 `relation()`：`familiarity` 的真源在那边（由累计互动次数推导），
 * 这里**不重算**。在宿主再写一份 `min(1, n/5000)` 就会有两处真源，
 * 而漂的那一处通常是改不到的那一处。
 */
export interface RelationLike {
  readonly available: boolean
  relation(at?: number): { readonly familiarity: number } | undefined
}

/**
 * 读一次熟悉度。
 *
 * ## 为什么缺省是 0 而不是 0.5
 *
 * `familiarity` 参与 `retain = 0.4 × (1 − familiarity × 0.5)`：
 * 0 表示「陌生人，保留四成残差」，1 表示「极熟，只保留两成」。
 * 读不到时按**最保守**的那一端（0）处理——把不认识的当成很熟，
 * 会让她在第一次见面时就把上一场的情绪抹得比自己还干净，那是装熟。
 *
 * @param ctx 宿主上下文。
 * @param at 时刻。
 */
export function familiarityOf(ctx: Context, at?: number): number {
  const stage = ctx.get('ondra-emotion-stage') as RelationLike | undefined
  if (stage === undefined || stage.available !== true) return 0
  try {
    const rel = stage.relation(at)
    const value = rel?.familiarity
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
  } catch {
    // 读关系是附带动作：它抛错不该让「这一轮能不能弥散」变成未知。
    return 0
  }
}

/**
 * 情绪服务的写侧子集。
 *
 * `setAxis` 的注释写明它是「剧本 / 调试 / 迁移用，日常不该用」——弥散正是
 * 那个例外：它不是「发生了一件事」（那要走 `feel` 并按 0.12 上限压小），
 * 而是「换了一场对话」的结算，量级上限 0.30 是另一套口径。
 */
export interface EmotionWriteLike {
  readonly available: boolean
  setAxis(axis: 'mood', value: number, at?: number): unknown
  save(at?: number): boolean
}

/** 一次弥散尝试的结果。给路由与检查脚本读。 */
export interface DiffuseOutcome {
  /**
   * 是否真的把心情写回去了。
   *
   * 与 `status === 'diffused'` 分开：插件算出 `diffused` 而写回失败
   * （情绪服务那一刻不可用）是另一种情况，两者的后续处置不同。
   */
  readonly written: boolean
  /** 插件给的状态码；插件缺席时为 `absent`。 */
  readonly status: DiffusePlanLike['status'] | 'absent' | 'write-failed'
  /** 写回前的心情。 */
  readonly moodBefore: number
  /** 写回后的心情（没写时与 `moodBefore` 相同）。 */
  readonly moodAfter: number
  /** 一句人话，只进日志。 */
  readonly note: string
}

/**
 * 算一次跨会话弥散，并把结果写回情绪内核。
 *
 * 永不抛错：弥散是**附带动作**，算不出来不该让这一轮对话发不出去。
 * 插件那边已经把「异常转成拒绝结果」做完了，这里只需要兜住
 * 「取服务 / 写回」这两步自己的异常。
 *
 * @param ctx 宿主上下文。
 * @param boundaryKey 本次会话边界的唯一键。见 `boundaryKeyOf()`。
 * @param at 结算时刻，省略用系统时间。
 */
export function diffuseAcrossSessions(
  ctx: Context,
  boundaryKey: string,
  at?: number,
): DiffuseOutcome {
  const moment = at ?? Date.now()
  const service = ctx.get('ondra-emotion-diffuse') as DiffuseLike | undefined
  const emotion = ctx.get('ondra-emotion-core') as EmotionWriteLike | undefined

  /*
   * 没有情绪服务时连问都不问：插件自己也会返回 `no-emotion`，
   * 但那要先过一次 `claim()` 的记账（`counters.noEmotion += 1`），
   * 而「服务根本没装」与「装了但不可用」在统计上是两件事。
   */
  if (emotion === undefined) {
    return Object.freeze({
      written: false,
      status: 'absent',
      moodBefore: 0,
      moodAfter: 0,
      note: '情绪内核没装载，无从弥散',
    })
  }

  if (service === undefined) {
    return Object.freeze({
      written: false,
      status: 'absent',
      moodBefore: 0,
      moodAfter: 0,
      note: '弥散服务没装载：心情跨不过会话边界',
    })
  }

  let plan: DiffusePlanLike
  try {
    /*
     * `familiarity` 必须真的传进来。
     *
     * 此前这里只传 `boundaryKey`，于是插件的 `normalizeFamiliarity(undefined)`
     * 一律回落到 0——公式里 `(1 − familiarity × 0.5)` 那一段永远是 `1 − 0`，
     * 整段白写。而 0 是「陌生人」的合法取值，所以没有任何一处报错。
     *
     * 真源是 `ondra-emotion-stage` 的 `relation().familiarity`（由累计互动
     * 次数推导），宿主只读不重算。
     */
    plan = service.claim({ boundaryKey, familiarity: familiarityOf(ctx, moment), at: moment })
  } catch (error) {
    // 插件的 `claim()` 承诺不抛，但「承诺不抛」与「不会抛」是两件事。
    // 真抛了也不该连累这一轮对话。
    return Object.freeze({
      written: false,
      status: 'absent',
      moodBefore: 0,
      moodAfter: 0,
      note: `弥散抛错，按未弥散处理：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const moodBefore = plan.moodBefore

  if (plan.status !== 'diffused') {
    return Object.freeze({
      written: false,
      status: plan.status,
      moodBefore,
      moodAfter: moodBefore,
      note: plan.note,
    })
  }

  /*
   * 差量为零时不必写。心情恰在基线（0.5）上时目标也是 0.5，
   * 写一次只会多一次无意义的 `settle`；而 `settle` 会把 `settledAt`
   * 推到当前时刻，等于重置了心情的回归计时——那是副作用，不是空操作。
   */
  if (Math.abs(plan.delta) < 1e-6) {
    return Object.freeze({
      written: false,
      status: 'already',
      moodBefore,
      moodAfter: moodBefore,
      note: '心情就在基线上，弥散是空操作',
    })
  }

  let moodAfter = moodBefore
  try {
    const snapshot = emotion.setAxis('mood', plan.target, moment) as
      | { readonly axes?: Readonly<Record<string, number>> }
      | undefined
    const value = snapshot?.axes?.['mood']
    moodAfter = typeof value === 'number' && Number.isFinite(value) ? value : plan.target
  } catch (error) {
    return Object.freeze({
      written: false,
      status: 'write-failed',
      moodBefore,
      moodAfter: moodBefore,
      note: `写回心情失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  /*
   * 写完立刻落盘。
   *
   * 弥散一场会话只发生一次，所以这一次磁盘写**不是每轮开销**。
   * 不落盘的代价很具体：写完心情、应用随即被关掉，重启后心情回到
   * 上一次存档的值（那是这一轮 `feel()` 之前的状态），弥散白算。
   */
  try {
    emotion.save(moment)
  } catch {
    // 落盘失败不影响本轮已生效的内存值；下一轮 `feel()` 之后还会再存一次。
  }

  return Object.freeze({
    written: true,
    status: 'diffused',
    moodBefore,
    moodAfter,
    note: plan.note,
  })
}

/**
 * 生成本次会话边界的唯一键。
 *
 * ## 为什么键里要有「轮次」而不是只有会话 id
 *
 * 只放 `sessionId` 时，同一个会话**永远只有一个键**：插件那边的幂等闸
 * （`mark.boundaryKey === key`）会把它判成 `already`，于是这场会话开一次
 * 之后再也不弥散——包括隔天接着聊的那一次。而「隔天接着聊」恰恰是最该
 * 弥散的时刻（睡了一夜，情绪早该回落到基线附近）。
 *
 * ## 为什么不用「日期」做键
 *
 * 反过来也不行：`2026-11-08` 这样的键会让同一天里「午饭前聊了两句、
 * 傍晚又回来」判成 `already`，而这两场之间隔了七八个小时，按产品口径
 * 就是两场会话。**「多久算一场」只该由插件的 `minGapMinutes` 回答**，
 * 键这一层不承担这个判断。
 *
 * ## 所以键 = 会话 id + 轮次序号
 *
 * 每一轮一个键 → 幂等闸恒不命中（除了同一轮被重试），间隔闸照常生效：
 * 30 分钟内连说十句只弥散第一句，隔了半小时再说才弥散第二句。
 * 这正是「换一场会话」的字面意思。
 *
 * @param sessionId 会话 id。
 * @param seq 本进程内的轮次序号（单调递增）。
 */
export function boundaryKeyOf(sessionId: string, seq: number): string {
  return `${sessionId}#${String(seq)}`
}
