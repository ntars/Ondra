/**
 * 声音链的**中段**：一整段话，分成几条、每条之间等多久。
 *
 * ## 它补的是哪条断掉的边
 *
 * `ondra-rhythm`（O-038，纯函数）与 `ondra-rhythm-typing`（O-039，时间线）
 * 两个包各自完整，缺的是**谁来问**：
 *
 * ```
 * 塑形（O-040）→ （空）→ 分条计划 → 时间线 → 呼吸感（O-041）
 *                  ↑
 *            三个包互相指认，圈外零调用方
 * ```
 *
 * `ctx.get('ondra-rhythm')` 只被 `rhythm-typing` 取，`rhythm-typing` 只被
 * `breath` 取。从任一包出发做静态普查，都会看到「消费方未装载 → 装了空转」，
 * 于是三个一起被判无效。这是本仓第五次同族漏判（前四次：
 * `emotion-diffuse` / `memory-heal` / `memory-dream` / `oral`），
 * 判据漏掉的都是同一件事：**读者是用户的感官，不是另一个插件**。
 *
 * ## 接在哪一步，以及为什么只接一半
 *
 * 接在 `done` 帧**之前**：模型最后一个字落下之后，界面先亮「她在打字」，
 * 按她自己的节奏停一小会儿，再落定。这一小段停顿的价值是「她不是
 * 一瞬间吐出整段答案」——正是这两个包存在的理由。
 *
 * ### 为什么不做「拆成多条气泡」
 *
 * 分条的本义是**发出多条消息**，那在 QQ / 微信里成立（对面看到的是
 * 一条条陆续到达）。但本应用是单窗单气泡、且正文已经在流式过程中
 * 逐字显示完了——再把已经显示过的字收回去、一条条重打一遍，
 * 是纯粹的体验倒退：40 字一条、6 字每秒，一段 200 字的回答要多等 20 秒
 * 才能看全。
 *
 * 所以这里只用计划里**还没被流式覆盖的那一段**：首字延迟
 * （0.8–2 秒，`firstDelay()`）。这条是纯收益——真实的人在看到消息之后
 * 也要过一两秒才开始回。其余三条（长停顿、深夜放大、自我修正）
 * 在没有多气泡的前提下无处落脚，如实记在探针里，不假装用了。
 *
 * ## 为什么 hold 有硬上限
 *
 * `firstDelayMs` 是可配的（上限 20000）。用户把它调到 15 秒是想要
 * 「她慢慢回」，但那是消息场景的口径；在单窗里按住 `done` 十五秒，
 * 用户看到的是「卡住了」。这里夹到 2000ms：超过它，收益（像人）
 * 抵不过风险（像坏了），差额写进探针让读者知道被夹过。
 */

import type { Context } from '@ntars/cordis'

/** 一条分条结果（结构对位子集，不 import 插件源码）。 */
interface PieceLike {
  readonly index: number
  readonly text: string
  readonly chars: number
  readonly delayMs: number
  readonly pauseMs: number
  readonly longPause: boolean
}

/** 分条计划（结构对位子集）。 */
interface PlanLike {
  readonly messages: readonly PieceLike[]
  readonly totalMs: number
  readonly chars: number
  readonly cps: number
  readonly maxMessages: number
  readonly maxCharsPerMessage: number
  readonly night: boolean
  readonly longPauses: number
  readonly selfCorrected: boolean
  readonly mergedCount: number
  readonly overflowCount: number
}

/** 节奏服务（结构对位子集）。 */
interface RhythmPort {
  readonly available: boolean
  readonly reason?: string
  readonly maxMessages: number
  plan(request: { readonly text: string; readonly at?: number }): PlanLike
  delayOf(text: string, at?: number): number
  firstDelay(rng?: () => number): number
  stats(): {
    readonly turns: number
    readonly messages: number
    readonly cappedTurns: number
    readonly overflowTurns: number
    readonly longPauses: number
    readonly selfCorrections: number
    readonly avgMessages: number
    readonly avgChars: number
  }
}

/** 打字时间线（结构对位子集）。 */
interface TypingPort {
  readonly available: boolean
  readonly reason?: string
  readonly rhythmReady: boolean
  schedule(text: string, options?: { readonly at?: number }): {
    readonly steps: readonly { readonly index: number; readonly text: string; readonly waitMs: number; readonly phase: string }[]
    readonly totalMs: number
    readonly source: 'rhythm' | 'oneshot'
    readonly degraded: string | null
  }
  stats(): {
    readonly runs: number
    readonly sent: number
    readonly aborted: number
    readonly superseded: number
    readonly degraded: number
    readonly failed: number
    readonly active: number
    readonly avgElapsedMs: number
  }
}

/** 呼吸感（结构对位子集）。 */
interface BreathPort {
  readonly available: boolean
  readonly reason?: string
  readonly typingReady: boolean
  presence(conversationId?: string, phase?: 'thinking' | 'typing' | 'paused' | 'idle'): { readonly show: boolean; readonly phase: string; readonly reason: string }
  peek(at?: number): { readonly used: number; readonly cap: number; readonly remaining: number }
  stats(): {
    readonly takes: number
    readonly deniedQuota: number
    readonly deniedDuplicate: number
    readonly presences: number
  }
}

/** 一次「按住 done」的结果。 */
export interface HoldOutcome {
  /** 实际停了多少毫秒。0 表示不停。 */
  readonly holdMs: number
  /** 走的是哪条路。`planned` 才算真算过计划。 */
  readonly status: 'planned' | 'absent' | 'off' | 'skipped'
  /** 没停的原因码。 */
  readonly reason?: string
  /** 计划里分了几条（只读展示，不拆发）。 */
  readonly pieces?: number
  /** 配置给的首字延迟被夹到上限前的原值。仅当被夹过时存在。 */
  readonly clampedFrom?: number
}

/**
 * 算「开口前的半拍」有多长。
 *
 * ## 为什么它不需要正文
 *
 * 这一格要的是 `firstDelay()`——**首字延迟**，语义是「她读完了，
 * 过多久开始回」。它在 O-038 的定义里就是与正文长度无关的一个随机区间
 * （`firstDelayMinMs`–`firstDelayMaxMs`）。所以宿主可以在**第一帧
 * 正文到达之前**就问它，这才是它该被问的时刻。
 *
 * ## 为什么不能等到正文全到再问（上一版的错）
 *
 * 上一版在 `inference.run` 返回之后才算这半拍，也就是**全部正文都已经
 * 流式显示完**之后。那时用户屏幕上已经有一整段回答了，再停两秒只是
 * 「最后一句卡了一下」——不是「她在开口前想了一下」。两者观感相反：
 * 前者像坏了，后者才像人。首字延迟放在末尾，语义就只剩「拖慢收尾」。
 *
 * **永不抛错**：节奏是语感增强，它挂了这一轮必须照常开口。
 * @param ctx 宿主上下文。
 * @param rng 随机源，测试注入用。
 */
export function planFirstWord(ctx: Context, rng?: () => number): HoldOutcome {
  const { rhythm, typing } = portsOf(ctx)
  if (rhythm === undefined && typing === undefined) {
    return Object.freeze({ holdMs: 0, status: 'absent', reason: 'not-loaded' })
  }
  if (rhythm === undefined) {
    return Object.freeze({ holdMs: 0, status: 'off', reason: 'no-rhythm' })
  }
  if (rhythm.available !== true || rhythm.reason === 'disabled') {
    return Object.freeze({ holdMs: 0, status: 'off', reason: 'disabled' })
  }

  try {
    const raw = rhythm.firstDelay(rng)
    const holdMs = Math.max(0, Math.min(HOLD_MAX_MS, Math.round(raw)))
    hostCounters.holds += 1
    hostCounters.lastHoldMs = holdMs
    return Object.freeze({
      holdMs,
      status: 'planned',
      ...(raw > HOLD_MAX_MS ? { clampedFrom: Math.round(raw) } : {}),
    })
  } catch (error) {
    hostCounters.skipped += 1
    process.stderr.write(`[host] 首字延迟取值异常（本轮不停顿）：${messageOf(error)}\n`)
    return Object.freeze({ holdMs: 0, status: 'skipped', reason: 'error' })
  }
}

/**
 * 只算「这一段会分成几条」，用于账本展示，**不改发送行为**。
 *
 * ## 为什么单独一格，且不参与发送
 *
 * 分条的本义是发多条消息。本应用是单窗单气泡、正文早已在流式过程中
 * 逐字显示完，把显示过的字收回去再一条条重打是纯粹的倒退
 * （40 字/条、6 字/秒，一段 200 字要多等 20 秒）。
 *
 * 但**不拆发不等于不算**：`rhythm.stats().turns` 与 `typing.schedule()`
 * 的分条账本是她「会不会分条说话」的唯一证据。不算的话，
 * 面板上永远是 0，读起来像「插件没接线」——而其实接得好好的，
 * 只是这个形态不拆气泡。所以算一次、记账、如实展示，不假装用过。
 *
 * **永不抛错**。
 * @param ctx 宿主上下文。
 * @param text 已经塑形完的那句（与 `done` / 记忆 / 朗读共用同一个字符串）。
 */
export function planPieces(ctx: Context, text: string): number {
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') return 0
  const { rhythm, typing } = portsOf(ctx)
  if (rhythm === undefined && typing === undefined) return 0
  try {
    /*
     * 优先 `schedule()`：它内部第一件事就是 `rhythm.plan(...)`，
     * 是两个包联动的那条真线；只调 `plan()` 会让 `typing` 的账本永远为空。
     */
    const schedule = typing !== undefined && typing.available === true ? typing.schedule(body) : undefined
    const plan = schedule === undefined && rhythm !== undefined && rhythm.available === true
      ? rhythm.plan({ text: body })
      : undefined
    const pieces = schedule !== undefined
      ? schedule.steps.length
      : plan !== undefined
        ? plan.messages.length
        : 0
    hostCounters.lastPieces = pieces
    return pieces
  } catch (error) {
    hostCounters.skipped += 1
    process.stderr.write(`[host] 分条计划异常（不影响发送）：${messageOf(error)}\n`)
    return 0
  }
}

/** 节奏探针读数。给设置页与诊断接口用。 */
export interface RhythmProbe {
  /** 三个包各自在不在。 */
  readonly loaded: { readonly rhythm: boolean; readonly typing: boolean; readonly breath: boolean }
  /** 三个包各自自报可用。 */
  readonly available: { readonly rhythm: boolean; readonly typing: boolean; readonly breath: boolean }
  /** 用户关掉了哪个（`reason='disabled'`）。 */
  readonly disabled: readonly string[]
  /** 一句话说清「现在为什么不像人打字」。全都正常时为空串。 */
  readonly note: string
  /** 分条计划的三本账。`turns=0` 说明宿主那条线没接上。 */
  readonly rhythm?: ReturnType<RhythmPort['stats']> | undefined
  /** 时间线的账：`runs` 涨说明真的排过时间线。 */
  readonly typing?: ReturnType<TypingPort['stats']> | undefined
  /** 呼吸感今日额度。 */
  readonly breath?:
    | {
        readonly stats: ReturnType<BreathPort['stats']>
        readonly quota: { readonly used: number; readonly cap: number; readonly remaining: number }
      }
    | undefined
  /**
   * 宿主视角的调用计数。
   *
   * 与上面三个插件的账本分开报，因为它们的口径不同：`typing.runs` 只统计
   * `run()`（真正逐条发送的那条路），而单窗形态下宿主走的是 `schedule()`
   * （纯预览）。两个数一起看才分得清「没接线」与「走的是预览路径」。
   */
  readonly host: {
    /** 宿主问过几次分条计划。 */
    readonly holds: number
    /** 上一轮按住 `done` 的毫秒数。 */
    readonly lastHoldMs: number
    /** 上一轮计划分几条。 */
    readonly lastPieces: number
    /** 计划异常被跳过的次数。 */
    readonly skipped: number
  }
}

/** 首字延迟的硬上限（毫秒）。理由见文件头末段。 */
export const HOLD_MAX_MS = 2000

/**
 * 宿主侧的调用计数。
 *
 * ## 为什么要在宿主另记一个数
 *
 * `ondra-rhythm-typing` 的 `stats().runs` 只统计 `run()`——而单窗形态下
 * 宿主只调 `schedule()`（纯预览、按设计不记账）。于是探针里 `runs` 恒为 0，
 * 读起来像「计时器从没被用过」，实际每一轮都问了它。
 *
 * 这种「插件自报全零 / 宿主其实调过」的分歧，本仓在 `emotionApplied`
 * 那一格栽过一次（计数器统计在调用之外）。所以这里把宿主视角单独记：
 * 两个数一起看，才能分清「没接线」与「接了但走的是预览路径」。
 */
const hostCounters = {
  holds: 0,
  lastHoldMs: 0,
  lastPieces: 0,
  skipped: 0,
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读三个服务。全部走 `ctx.get`，晚装载能自愈。 */
function portsOf(ctx: Context): {
  rhythm: RhythmPort | undefined
  typing: TypingPort | undefined
  breath: BreathPort | undefined
} {
  const read = (key: string): unknown => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }
  return {
    rhythm: read('ondra-rhythm') as RhythmPort | undefined,
    typing: read('ondra-rhythm-typing') as TypingPort | undefined,
    breath: read('ondra-breath') as BreathPort | undefined,
  }
}

/**
 * 此刻该不该显示「正在输入」。
 *
 * 直接问 O-041：阶段 → 显示的那张表归它，宿主不写第二份。
 * 没有它时缺省显示（正文已经在界面上流着，「正在回复」的三点也在，
 * 这里只是把她的阶段说出来，不改显示）。
 * @param ctx 宿主上下文。
 * @param conversationId 会话 id。
 * @param phase 宿主这一帧要报的阶段。省略时问 O-039 的 `phaseOf`。
 */
export function presenceOf(
  ctx: Context,
  conversationId: string,
  phase?: 'thinking' | 'typing' | 'paused' | 'idle',
): { show: boolean; phase: string; reason: string } {
  const { breath } = portsOf(ctx)
  if (breath === undefined || breath.available !== true) {
    return { show: true, phase: phase ?? 'typing', reason: 'no-breath' }
  }
  try {
    /*
     * 阶段**由宿主告知**，不让插件去猜。
     *
     * ## 为什么必须传这一格
     *
     * `breath.presence()` 不传阶段时读的是 `typing.phaseOf()`，而那张
     * `active` 表**只在 O-039 的 `run()` 期间有内容**。本宿主是单窗
     * 单气泡，走的是 `schedule()`（纯预览、按设计不开 run），于是
     * `phaseOf` 恒 `idle` → `presence()` 恒 `show:false`。
     *
     * 症状是「呼吸感装载正常、`available` 全 true、配置读得到，而界面
     * 永远不显示她在打字」——本仓第六次同族：装配齐全、取值链上空。
     * 若不传这一格，宿主报出去的 `presence` 帧就是一条恒为 `false` 的死帧。
     *
     * 判定表仍归插件（`presence.ts` 那四行），宿主只负责说出「现在是哪一阶段」。
     */
    const view = breath.presence(conversationId, phase)
    return { show: view.show, phase: view.phase, reason: view.reason }
  } catch (error) {
    process.stderr.write(`[host] 读呼吸感失败（按显示处理）：${messageOf(error)}\n`)
    return { show: true, phase: phase ?? 'typing', reason: 'error' }
  }
}

/**
 * 只读探针。
 *
 * 与 `voiceProbe()` / `oralProbe()` 同一条纪律：六种「不像人打字」的原因
 * 必须分开说，因为修法完全不同（装插件 / 去设置里打开 / 改宿主接线 / 什么都不用做）。
 * @param ctx 宿主上下文。
 */
export function rhythmProbe(ctx: Context): RhythmProbe {
  const { rhythm, typing, breath } = portsOf(ctx)
  const disabled: string[] = []
  if (rhythm !== undefined && (rhythm.available !== true || rhythm.reason === 'disabled')) disabled.push('rhythm')
  if (typing !== undefined && (typing.available !== true || typing.reason === 'disabled')) disabled.push('typing')
  if (breath !== undefined && (breath.available !== true || breath.reason === 'disabled')) disabled.push('breath')

  const loaded = {
    rhythm: rhythm !== undefined,
    typing: typing !== undefined,
    breath: breath !== undefined,
  }
  const available = {
    rhythm: rhythm !== undefined && rhythm.available === true,
    typing: typing !== undefined && typing.available === true,
    breath: breath !== undefined && breath.available === true,
  }

  let note = ''
  if (!loaded.rhythm && !loaded.typing) note = '分条与计时都没装载'
  else if (disabled.length > 0) note = '已在设置里关掉：' + disabled.join('、')
  else if (typing !== undefined && typing.rhythmReady !== true) note = '计时在，但它取不到分条计划（只会一次性整段发出）'

  const rhythmStats = rhythm !== undefined ? safe(() => rhythm.stats()) : undefined
  const typingStats = typing !== undefined ? safe(() => typing.stats()) : undefined
  const breathPart =
    breath !== undefined
      ? (() => {
          const stats = safe(() => breath.stats())
          const quota = safe(() => breath.peek())
          if (stats === undefined || quota === undefined) return undefined
          return { stats, quota }
        })()
      : undefined

  /*
   * `turns` 长期为 0 是这里唯一能抓到「宿主没接线」的证据：三个包都装载、
   * `available` 全 true、配置段也读得到，却一次都没被调过。
   * 这种「一切正常却没效果」在本仓已经踩过五次，所以单独说一句。
   *
   * 判据取 **宿主计数** 而不是 `rhythmStats.turns`：后者是插件的账本，
   * 它在「宿主调过但插件自己报 0」时会给出与事实相反的结论。
   */
  if (note === '' && hostCounters.holds === 0) {
    note = '三个包都在，但还没有一轮问过它（说一句话就会记账）'
  }

  return Object.freeze({
    loaded,
    available,
    disabled,
    note,
    ...(rhythmStats === undefined ? {} : { rhythm: rhythmStats }),
    ...(typingStats === undefined ? {} : { typing: typingStats }),
    ...(breathPart === undefined ? {} : { breath: breathPart }),
    host: Object.freeze({
      holds: hostCounters.holds,
      lastHoldMs: hostCounters.lastHoldMs,
      lastPieces: hostCounters.lastPieces,
      skipped: hostCounters.skipped,
    }),
  })
}

/** 读一格账本，读不到就整格省掉，不编一个全零的假账本。 */
function safe<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * 等一会儿。
 *
 * **不接取消信号**：这里等的是「她开口前的半拍」，最长 2 秒
 * （`HOLD_MAX_MS` 已夹死）。用户按停止键时那一帧会走 `aborted` 分支、
 * 根本不进这里，所以没有「取消了还在等」的窗口。
 * @param ms 毫秒。
 */
export function pause(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.floor(ms))
  })
}
