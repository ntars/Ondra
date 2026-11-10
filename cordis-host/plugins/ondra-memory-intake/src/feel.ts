/**
 * 把一轮对话翻成一次情绪事件。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-emotion-core` 有完整的六维回归、十标签、化学池、气质四旋钮，
 * 下游有六个插件在 `ctx.get` 它（六态映射、应激倍率、冲突锁、弥散……），
 * 但**写入侧全仓零调用方**：
 *
 * ```
 * feel() / comfort() / inflict() / setAxis() / save()
 *              ↑ 五个写接口，一个调用方都没有
 * ```
 *
 * 于是 `emotion_state` 从建库起一直是 0 行，六态恒为「平静」，
 * 话由表里的 `emotion` 那一类永远产不出候选。症状不是报错，是
 * **「她心情从来没变过」**——这比报错更难察觉，因为平静是合法状态。
 *
 * ## 判据从哪来（本文件最重要的一条纪律）
 *
 * **只认客观触发的事实，不猜语义情绪。** 这是本项目反复踩过的坑：
 * 「这句话让她开心还是难过」需要情感分析，而情感分析必然引入一张
 * 没有出处的权重表，那就是第二真源，且永远说不清「为什么她因为这句难过」。
 *
 * 所以四个信号全部以**可观测的事实**为准入：
 *
 * | 信号 | 触发条件 | 为什么这个条件算「事实」 |
 * | --- | --- | --- |
 * | `stumble` | `ondra-drive-gap` 的 `detect()` 命中 | 判据在上游（O-129），本文件一行都不复制 |
 * | `apology` | 用户原话含道歉词 | 道歉是一个**言语行为**，不是一种情绪猜测；对应手册 §3.2 的 `comfort()` |
 * | `gratitude` | 用户原话含道谢 / 夸奖词 | 同上，是一个可枚举的言语行为 |
 * | `reunion` | 距上一轮超过阈值 | 纯时间差，零语义 |
 *
 * ## 位移量为什么这么小
 *
 * `FeelingInput` 的字段是**意图值**（-1–1），`emotion-core` 内部乘 0.12 上限
 * 再夹紧（手册 §3.2「单条消息情绪位移上限 0.12」）。所以这里写的 0.4 / 0.6
 * 落到轴上只有 0.048 / 0.072——**这是产品口径定好的量级，不是保守**。
 * 写 1.0 也只能动 0.12，而那会让「一句话」等于「十句话」。
 *
 * ## 刻意不做的事
 *
 * - **不判「这句话是正面还是负面」。** 见上。
 * - **不读她的回复内容当情绪源。** 她说什么由模型决定，把模型输出当情绪输入
 *   会形成回环：她越难过 → 说得越丧 → 判定越难过。`stumble` 只看上游判定，
 *   不看文本情绪。
 * - **不在这里落盘。** 存档归调用方（回合边界），本文件是纯函数。
 * - **不持有状态。** 冷却与节流在 `index.ts`，本文件每次调用都是独立判定。
 */

import type { SpokenLine } from './promise.js'

/**
 * 四种情绪信号。
 *
 * 顺序即**优先级**：一轮里同时命中多个时取靠前的那个（见 `readSignal`）。
 */
export type EmotionSignal = 'stumble' | 'apology' | 'gratitude' | 'reunion'

/**
 * 道歉词表。
 *
 * ## 为什么是这几个，不是更多
 *
 * 只收**明确的言语道歉**：承认错在自己、或请求对方消气。刻意不收
 * 「不好意思」之外的委婉说法（「那个……」「我可能有点」），因为委婉语
 * 与普通叙述在字面上无法区分，收进来就会把「我可能有点晚」判成道歉。
 *
 * 副作用是**会漏**：一句很委婉的道歉不会被认出来。这是刻意选的方向——
 * 漏一次的代价是「这次没被安慰」，错判一次的代价是「她莫名其妙就不生气了」，
 * 后者会让人觉得这套情绪是假的。**宁可漏，不可错。**
 */
export const APOLOGY_WORDS: readonly string[] = Object.freeze([
  '对不起',
  '抱歉',
  '不好意思',
  '是我错',
  '我错',
  '别生气',
  '别难过',
  '原谅我',
  '我道歉',
])

/**
 * 道谢 / 夸奖词表。
 *
 * 与道歉词表同一条纪律：只收**明确的**正面言语行为。刻意不收「还行」
 * 「不错」这类可褒可贬的词——它们在「这不太行」里也出现。
 */
export const GRATITUDE_WORDS: readonly string[] = Object.freeze([
  '谢谢',
  '多谢',
  '辛苦了',
  '辛苦啦',
  '真棒',
  '厉害',
  '做得好',
  '喜欢你',
  '好听',
  '好看',
])

/**
 * 「久别」的阈值（分钟）。
 *
 * ## 为什么是 30
 *
 * 手册 §3.2 的心情半衰期是 360 分钟，标签半衰期 45 分钟——30 分钟处在这两者
 * 之间：短于它，上一句的余温还在，谈不上「重新见面」；长于 45 分钟，
 * 标签已经衰减掉一半以上，再说「刚聊完」就不成立。
 *
 * 这个数不是手册给的，是本文件唯一的工程取值，改它之前先读这段。
 */
export const REUNION_MINUTES = 30

/**
 * 每个信号的位移（**意图值**，不是实际位移）。
 *
 * 实际落到轴上是这些数乘 0.12（标签乘 0.12 后夹到 0.6）。
 *
 * ## 逐条说明
 *
 * - `stumble`：她答不上来 → 张力涨得最多（这是「卡住」的生理对应），
 *   心情小幅下压，委屈与焦虑各记一点。**不投 pleasure**：答不上来不是
 *   「不开心」，是「不甘心」，两者的区别在张力上。
 * - `apology`：**不投任何轴**，直接走 `comfort()`。这是唯一有手册出处的一条
 *   （§3.2「道歉回升 0.08，保留一点嘴硬」），所以位移量交给上游算，
 *   本文件不写第二份。
 * - `gratitude`：愉悦与开心为主，唤醒略升（被夸会精神一点）。
 * - `reunion`：唤醒升、心情微升。**不投能量**——「久别重逢」是提得起劲，
 *   不是「体力回满」，后者归 O-048。
 */
export const SIGNAL_SHIFT: Readonly<Record<EmotionSignal, {
  readonly pleasure?: number
  readonly arousal?: number
  readonly dominance?: number
  readonly mood?: number
  readonly tension?: number
  readonly labels?: Readonly<Record<string, number>>
}>> = Object.freeze({
  stumble: Object.freeze({
    tension: 0.6,
    mood: -0.4,
    labels: Object.freeze({ hurt: 0.4, anxiety: 0.3 }),
  }),
  apology: Object.freeze({}),
  gratitude: Object.freeze({
    pleasure: 0.5,
    arousal: 0.2,
    labels: Object.freeze({ joy: 0.5, proud: 0.2 }),
  }),
  reunion: Object.freeze({
    arousal: 0.4,
    mood: 0.3,
  }),
})

/** 一轮情绪采集的结果。 */
export interface FeelCatchResult {
  /** 投出去了几次事件。 */
  readonly felt: number
  /** 其中走 `comfort()` 的次数。 */
  readonly comforted: number
  /** 认出的信号（只进日志）。 */
  readonly signal?: EmotionSignal
  /** 为什么一条都没投（`undefined` = 正常判定完了）。 */
  readonly reason?: string
}

/** 什么都没投的结果。 */
const NOTHING: FeelCatchResult = Object.freeze({ felt: 0, comforted: 0 })

/**
 * 在一段话里找词表命中。
 *
 * @param text 一段原话。
 * @param words 词表。
 * @returns 是否命中。
 */
function hasAny(text: string, words: readonly string[]): boolean {
  for (const word of words) if (text.includes(word)) return true
  return false
}

/**
 * 判这一轮该投哪个信号。
 *
 * ## 优先级为什么是这个顺序
 *
 * ```
 * stumble > apology > gratitude > reunion
 * ```
 *
 * - `stumble` 最前：她这轮卡住了，这是**关于她自己的事实**，比用户说了什么
 *   更该被记住。且它与用户的话不冲突（用户可以一边道谢一边问到答不上的事）。
 * - `apology` 在 `gratitude` 之前：「对不起，谢谢你听我说」这种句子里，
 *   道歉才是要处理的那件事。安慰优先级高于被夸。
 * - `reunion` 最后：它是「什么都还没发生」时的兜底，有具体信号时不该抢占。
 *
 * ## 为什么一轮只投一个
 *
 * 连投两个的后果是同一轮里情绪被推两次：用户说「对不起，谢谢」，
 * 先安慰（+0.08）再开心（+0.06），净效果接近零——而两个人都会觉得
 * 「刚才那一下好像没反应」。**一轮一次的粒度与「一句话一次反应」的直觉一致。**
 *
 * @param lines 本轮原话（含角色）。
 * @param gapDetected 上游 `detect()` 命中数（> 0 表示她这轮有答不上来的话）。
 * @param sinceLastTurnMs 距上一轮的毫秒数；`undefined` 表示没有上一轮。
 * @returns 信号；都不命中时 `undefined`。
 */
export function readSignal(
  lines: readonly SpokenLine[],
  gapDetected: number,
  sinceLastTurnMs: number | undefined,
): EmotionSignal | undefined {
  if (gapDetected > 0) return 'stumble'

  // 只认用户说的话：她的「对不起」是她在道歉，不该让她自己被安慰。
  const userText = lines
    .filter((line) => line.role === 'user')
    .map((line) => line.text)
    .join('\n')
  if (userText.trim() !== '') {
    if (hasAny(userText, APOLOGY_WORDS)) return 'apology'
    if (hasAny(userText, GRATITUDE_WORDS)) return 'gratitude'
  }

  if (sinceLastTurnMs !== undefined && sinceLastTurnMs >= REUNION_MINUTES * 60_000) return 'reunion'
  return undefined
}

/**
 * 情绪服务的结构对位（**只镜像写入要用的四个方法**）。
 *
 * ## 为什么只镜像写接口
 *
 * 本插件只做写入。读出状态（六态、快照）归 `ondra-emotion-express` 与
 * 各消费方——多镜像一个 `state()` 就多一处会漂的契约，而上游改签名时，
 * 本插件会因为一个自己从不调用的方法而编译失败（同一类教训见
 * `DriveGapLike` 的注释）。
 */
export interface EmotionLike {
  /** 是否可用（总开关）。 */
  readonly available: boolean
  /** 不可用原因，用于日志里说清「为什么没投出去」。 */
  readonly reason?: string
  /** 收到一次情绪事件（增量）。 */
  feel(input: {
    readonly pleasure?: number
    readonly arousal?: number
    readonly dominance?: number
    readonly mood?: number
    readonly energy?: number
    readonly tension?: number
    readonly labels?: Readonly<Record<string, number>>
    readonly source?: string
  }, at?: number): unknown
  /** 被安慰（§3.2：只降 0.08，保留嘴硬）。 */
  comfort(at?: number): unknown
  /** 落盘。**不自动触发**，由回合边界调（与 O-013 同一条纪律）。 */
  save(at?: number): boolean
}

/**
 * 投一次情绪事件。
 *
 * ## 为什么 `apology` 走 `comfort()` 而不是 `feel()`
 *
 * 手册 §3.2 给道歉定的位移是 **0.08**，且刻意只降不归零（「保留一点嘴硬」）。
 * 用 `feel({ pleasure: +0.67 })` 去凑 0.08 是**在调用方重算一遍上游的公式**——
 * 上游哪天把 0.08 改成 0.06，这里不会跟着变，而症状是「设置里改了道歉的效果，
 * 但只有一半生效」。
 *
 * ## 为什么落盘放在这里
 *
 * `save()` 的注释写明「不自动触发，存档时机由回合边界决定」。本函数就在
 * 回合边界上（每轮对话结束时调一次），是这条纪律指定的那个时机。
 * 放别处（比如定时器）会让「app 开多久」影响存档频率。
 *
 * @param emotion 情绪服务，缺席时传 `undefined`。
 * @param signal 信号种类。
 * @param log 日志门面。
 * @param at 本轮时刻。
 */
export function feelOnce(
  emotion: EmotionLike | undefined,
  signal: EmotionSignal | undefined,
  log: { warn?(message: string, ...args: readonly unknown[]): void },
  at: number | undefined,
): FeelCatchResult {
  if (emotion === undefined) return { ...NOTHING, reason: 'no-emotion' }
  if (!emotion.available) return { ...NOTHING, reason: emotion.reason ?? 'unavailable' }
  if (signal === undefined) return NOTHING

  try {
    if (signal === 'apology') {
      emotion.comfort(at)
      return { felt: 1, comforted: 1, signal }
    }
    const shift = SIGNAL_SHIFT[signal]
    emotion.feel({
      ...shift.pleasure === undefined ? {} : { pleasure: shift.pleasure },
      ...shift.arousal === undefined ? {} : { arousal: shift.arousal },
      ...shift.dominance === undefined ? {} : { dominance: shift.dominance },
      ...shift.mood === undefined ? {} : { mood: shift.mood },
      ...shift.tension === undefined ? {} : { tension: shift.tension },
      ...shift.labels === undefined ? {} : { labels: shift.labels },
      // `source` 只用于记账与排查，不参与计算（见 `FeelingInput` 注释）。
      source: `intake:${signal}`,
    }, at)
    return { felt: 1, comforted: 0, signal }
  } catch (error) {
    // 情绪写不进去不影响对话：下一轮照样能投。
    log.warn?.('投情绪事件失败（本轮跳过）：%s', error instanceof Error ? error.message : String(error))
    return { ...NOTHING, signal, reason: 'feel-failed' }
  }
}

/**
 * 把情绪存档落盘。
 *
 * ## 只在真投出去过之后调
 *
 * 一次都没投的轮次不需要写库：状态是按闭式公式算出来的，`settledAt` 就在
 * 存档里，重启后照样能补算到「此刻」。每轮无脑写一次只是把同一行覆盖一遍，
 * 换来的是每轮一次磁盘写。
 *
 * ## 为什么必须有人调 `save()`
 *
 * `EmotionRepository.save()` 的注释写明「不自动触发」，这是刻意的：
 * 写操作不交给「不知道第几个装载」的定时器（与 O-013 同一条纪律）。
 * 但这条纪律的另一面是——**如果没有任何地方调它，`emotion_state` 永远是 0 行**，
 * 而她每次重启都回到出厂基线。本轮之前正是这个状态。
 *
 * @param emotion 情绪服务。
 * @param log 日志门面。
 * @param at 本轮时刻。
 * @returns 是否写入成功。
 */
export function saveEmotion(
  emotion: EmotionLike | undefined,
  log: { warn?(message: string, ...args: readonly unknown[]): void },
  at: number | undefined,
): boolean {
  if (emotion === undefined || !emotion.available) return false
  try {
    const ok = emotion.save(at)
    if (!ok) log.warn?.('情绪存档写入失败（状态仍在内存里）')
    return ok
  } catch (error) {
    log.warn?.('情绪存档抛错（状态仍在内存里）：%s', error instanceof Error ? error.message : String(error))
    return false
  }
}

