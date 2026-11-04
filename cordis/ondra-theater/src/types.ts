/**
 * O-112 `ondra-theater` 的对外契约（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「几个角色同场时，下一句该谁说？」**
 *
 * 只管这一句。说什么、用什么语气、发到哪个通道，全部不归这里。
 *
 * ## 为什么需要它
 *
 * 一个角色时不需要调度：她说什么都是她。两个以上角色同场时，问题立刻变成三个：
 * **谁先说、谁接谁、什么时候停**。没有这三个答案，多角色会退化成两种东西——
 * 要么一个人自问自答（第二个角色只是换了名字的同一张嘴），
 * 要么无限演下去（每一句都在等下一句，而下一句永远有人接）。
 *
 * ## 四条硬裁决（写死在类型与常量上，不做成配置）
 *
 * 1. **同一角色不许连续两次发言。** `nextSpeakerOf()` 永远跳过刚说过的那一位，
 *    座位顺序即发言顺序。这条不是偏好：一旦允许连说，第二个角色就再没有开口的理由，
 *    而劣化成独白是**悄悄**发生的，没人会在某一句上发现自己正在独白。
 * 2. **角色数硬上限 4，超了当场拒绝。** `MAX_ROLES` 是常量，`open()` 直接抛
 *    `too-many-roles`，**不排队**。排队会让第五个人在若干轮之后突然开口，
 *    而那时场上早没人记得他为什么在场。
 * 3. **每场必须有收束条件。** 轮数上限（`maxRounds × 座位数`）+ 冷场判据
 *    （静默超过 `disperseMs`），两条任一命中即收场。少一条就会有「演到没人说话为止」。
 * 4. **离场必须先收束。** **契约里没有 `leave()`**——要少一个人，只能 `close()` 之后
 *    重新 `open()`。做成方法就一定会有「先让他退场，剩下的继续说」这个分支，
 *    而那个分支会让剩下的人对着一个空座位说话。
 *
 * ## 三条「不」
 *
 * - **不出台词。** `TurnPlan` 里没有 `say` / `text` / `line` 字段，只有 `intent` /
 *   `maxSentences` / `mustNot`。台词归 O-033 / O-037，本插件连一个能放台词的口子都不留。
 * - **不装配人格。** 归 O-021 `ondra-persona-core`；本插件只读人设 id 当座位标签。
 * - **不落盘。** 场次是一次性的：存档会诱导「跨重启续演」，而续演时观众早换了人。
 *
 * ## 与相邻插件的共享形状（§15.3 / §15.5）
 *
 * `TurnPlan.mustNot` / `maxSentences` 与 O-108 `ondra-absence` 的 `RegreetPlan`、
 * O-107 `ondra-first-meet` 的 `ScriptBeat` **同形但不同源**。按 §18.5 **不 import 对方源码**：
 * 任一方单独卸载，另一方都不该编译失败。字段名与语义必须一致，改一处要几处一起改。
 */

/** 本插件注册的服务键（连字符，非 `ondra:theater`）。全仓唯一归属。 */
export const THEATER_SERVICE_KEY = 'ondra-theater'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会被模型侧在**运行期**拒绝——
 * 写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 角色数硬上限。**不是配置的默认值，是天花板**：配置只能往下压，不能往上抬。
 *
 * 四个以上的角色同场时，每一轮都要等四下，观众（与提示词预算）都撑不住；
 * 更实际的原因是 §9 的上下文预算——四张嘴已经能把一段对话的预算吃干净。
 */
export const MAX_ROLES = 4

/**
 * 角色数下限。**一个人不是剧场，是独白。**
 *
 * 少于两人直接拒绝入场，而不是「先演着看看」：单人场在第一条裁决下最多只能说一句，
 * 让调用方开一个注定只能说一句的场，等于把错误推迟到他自己发现为止。
 */
export const MIN_ROLES = 2

/**
 * 角色 id 的允许形状。
 *
 * 比服务键宽松一点（允许大写与点），因为角色 id 往往直接来自人设包目录名；
 * 但仍然拒绝空格与路径分隔符——它会进日志、进统计、进外接的参数里。
 */
export const ROLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** 收场原因（闭集）。**只有这四个**，多一个就多一条「为什么会散」的歧义。 */
export type CloseReason =
  /** 轮数到顶：`maxRounds × 座位数` 句说完了。 */
  | 'rounds-reached'
  /** 冷场：距上一句（或开场）超过 `disperseMs` 没人接。 */
  | 'dispersed'
  /** 调用方主动收场。 */
  | 'manual'

const CLOSE_REASONS: readonly CloseReason[] = ['rounds-reached', 'dispersed', 'manual']

/** 收场原因闭集（只读，供外壳与自检枚举）。 */
export const CLOSE_REASON_LIST: readonly CloseReason[] = Object.freeze(CLOSE_REASONS)

/**
 * 一句话的意图（闭集）。
 *
 * 刻意只有四种，且**不含「说什么」**：意图是给下游选句用的标签，
 * 不是句子本身。加一个 `apologize` 之类的意图，就等于在这里开始写剧本。
 */
export type TurnIntent =
  /** 开场：本场第一句，把场子立起来。 */
  | 'open'
  /** 接话：接上一位的话头。 */
  | 'respond'
  /** 过渡：一轮刚说完，换口气。 */
  | 'bridge'
  /** 收尾：本场最后一句。 */
  | 'close'

const TURN_INTENTS: readonly TurnIntent[] = ['open', 'respond', 'bridge', 'close']

/** 意图闭集（只读）。 */
export const TURN_INTENT_LIST: readonly TurnIntent[] = Object.freeze(TURN_INTENTS)

/**
 * 恒定禁令。**每一句都带，不看意图、不看轮次、不做成配置。**
 *
 * 四条都对应一种「看起来很正常、实际上把别人那一轮吃掉」的写法：
 * 复述上一位（没在听）、替别人发言（抢戏）、拉场外角色进来（场上的人白站了）、
 * 越过句数上限（多说的那句是从下一轮借的）。
 */
const MUST_NOT_LIST: readonly string[] = [
  '不复述上一位刚说过的话——重复是最明显的「没在听」',
  '不替场上其他角色发言——谁说话由调度决定，不由台词决定',
  '不把不在场的角色拉进来——场外角色一律不存在，不许「某某刚说」',
  '不越过句数上限——超出的部分不是多说一句，是把别人那一轮吃掉',
]

/** 恒定禁令（只读）。 */
export const MUST_NOT: readonly string[] = Object.freeze(MUST_NOT_LIST)

/** 座位。座位号即发言顺序，**顺序在开场时定死**，演到一半不重排。 */
export interface Seat {
  /** 角色 id（调用方给的稳定键，也是降级时的显示名）。 */
  readonly id: string
  /** 显示名（调用方给的名字，或从 O-021 读到的人设 id，或就是 id）。 */
  readonly name: string
  /** 座位号（0 起）。 */
  readonly seat: number
}

/** 开场时调用方给的角色。 */
export interface RoleInput {
  /** 角色 id，必须匹配 `ROLE_ID_RE`。 */
  readonly id: string
  /** 显示名；省略时按 O-021 的人设 id → 角色 id 逐级回退。 */
  readonly name?: string
}

/** 开场的入参。 */
export interface SceneRequest {
  /** 场次 id；省略时由本插件按开场时刻生成。只用于日志与对账，不参与调度。 */
  readonly sceneId?: string
  /** 场次标签（例如「三个人在厨房」）；**只是标签，不参与调度、不进提示词**。 */
  readonly label?: string
  /** 在场的角色，**顺序即发言顺序**。2–4 人。 */
  readonly roles: readonly RoleInput[]
}

/** 一句的调度结果。**没有一个字段能放台词。** */
export interface TurnPlan {
  /** 场次 id。 */
  readonly sceneId: string
  /** 本场第几句（1 起）。 */
  readonly turn: number
  /** 第几轮（1 起）。座位数说满一轮。 */
  readonly round: number
  /** 座位号（0 起）。 */
  readonly seat: number
  /** 该说话的角色 id。 */
  readonly speakerId: string
  /** 该说话的角色显示名。 */
  readonly speakerName: string
  /** 这一句的意图。 */
  readonly intent: TurnIntent
  /** 句数上限（收尾句恒为 1）。 */
  readonly maxSentences: number
  /** 恒定四条禁令。 */
  readonly mustNot: readonly string[]
  /** 说完这句是否必须收场。 */
  readonly closesAfter: boolean
  /** 本场还剩几句（不含这一句）。 */
  readonly remainingTurns: number
  /** 一句中文说明（给日志与外壳看，**不是台词**）。 */
  readonly note: string
}

/**
 * `next()` 的三种结果。
 *
 * 分成三种而不是 `TurnPlan | null`：`null` 会把「已收场」和「该收场了但还没 close」
 * 糊成一种，而后者是**必须由调用方去 close** 的状态——离场必须先收束，
 * 收束这件事不能由一次读悄悄代劳。
 */
export type NextResult =
  | { readonly kind: 'turn'; readonly plan: TurnPlan }
  | {
      readonly kind: 'should-close'
      readonly reason: CloseReason
      readonly note: string
    }
  | { readonly kind: 'closed'; readonly reason: CloseReason; readonly note: string }

/** 场次快照（只读）。 */
export interface TheaterView {
  /** 是否还开着（未收场）。 */
  readonly open: boolean
  /** 场次 id；没有场为 `null`。 */
  readonly sceneId: string | null
  /** 场次标签；没给为 `null`。 */
  readonly label: string | null
  /** 座位（顺序即发言顺序）。 */
  readonly seats: readonly Seat[]
  /** 当前轮次（1 起；已收场时停在最后一轮）。 */
  readonly round: number
  /** 本场已说几句。 */
  readonly turns: number
  /** 本场总句数上限（`maxRounds × 座位数`）。 */
  readonly maxTurns: number
  /** 还剩几句。 */
  readonly remainingTurns: number
  /** 上一位说话的角色 id；还没人说话为 `null`。 */
  readonly lastSpeakerId: string | null
  /** 下一位该说话的角色 id；已收场为 `null`。 */
  readonly nextSpeakerId: string | null
  /** 距上一句（或开场）的毫秒数；没有场为 `null`。 */
  readonly idleMs: number | null
  /** 是否已经/已经该收场。 */
  readonly shouldClose: boolean
  /** 该收场的原因；不该收场为 `null`。 */
  readonly shouldCloseBecause: CloseReason | null
  /** 已收场的原因；还开着为 `null`。 */
  readonly closedReason: CloseReason | null
}

/** 累计统计。**只在内存**，不落盘——重启即散场，统计跟着清零是对的。 */
export interface TheaterStats {
  /** 累计开过多少场（含已经散掉的）。 */
  readonly scenes: number
  /** 累计说过多少句（`advance()` 的次数）。 */
  readonly turns: number
  /** 累计收场次数。 */
  readonly closes: number
  /** 其中自动收场的次数（轮数到顶或冷场）。 */
  readonly autoCloses: number
  /** 被拒绝的开场次数（超员 / 单人 / 重复 / 已有场未散）。 */
  readonly refusals: number
  /** 当前是否还开着场。 */
  readonly open: boolean
  /** 最近一次收场的原因。 */
  readonly lastCloseReason?: CloseReason
}

/** 错误码。消费方可按码分支，不必匹配中文文案。 */
export type TheaterErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（roles 不是数组、角色 id 形状不对、场次 id 非法）。 */
  | 'bad-request'
  /** 角色少于两人：一个人不是剧场。 */
  | 'too-few-roles'
  /** 角色超过硬上限（4，或配置压低后的值）：当场拒绝，**不排队**。 */
  | 'too-many-roles'
  /** 角色 id 重复：同一个人坐两个座位，轮转就会变成他一个人的独白。 */
  | 'duplicate-role'
  /** 已有一场没散，不许直接换人（离场必须先收束）。 */
  | 'scene-open'
  /** 没有开着的场。 */
  | 'not-open'
  /** 场已收场。 */
  | 'closed'

/** 剧场错误。带稳定错误码。 */
export class TheaterError extends Error {
  /** 错误码。 */
  readonly code: TheaterErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: TheaterErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'TheaterError'
    this.code = code
    this.detail = detail
  }
}

/** 判定口径（毫秒与计数，换算只在 `settings.ts` 做一次）。 */
export interface StagePolicy {
  /** 角色数上限（≤ `MAX_ROLES`）。 */
  readonly maxRoles: number
  /** 轮数上限。 */
  readonly maxRounds: number
  /** 每句句数上限。 */
  readonly maxSentences: number
  /** 冷场判据（毫秒）。 */
  readonly disperseMs: number
}

/** 对外服务。 */
export interface TheaterService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: TheaterErrorCode

  /**
   * 开场。**已有一场没散时抛 `scene-open`**：换人必须先收场，不接受中途换人。
   * @param request 场面。
   * @param at 时刻，省略用时钟服务。
   */
  open(request: SceneRequest, at?: number): TheaterView

  /** 下一句该谁说。**纯读**：不推进、不收场，随便轮询都安全。 */
  next(at?: number): NextResult

  /**
   * 记「上一位说完了」并推进。**唯一会推进游标的方法。**
   * @param speakerId 说话的角色 id；给了就校验，防止外壳记错人导致同一个人连说两句。
   * @param at 时刻。
   */
  advance(speakerId?: string, at?: number): TheaterView

  /** 收场。**唯一能让座位上的人离开的方法**（没有 `leave()`）。 */
  close(at?: number): TheaterView

  /** 场次快照。**纯读**。没有场时为 `null`。 */
  snapshot(at?: number): TheaterView | null

  /** 累计统计快照。 */
  stats(): TheaterStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §18.5：相邻服务一律经服务键调用，不 import 源码。
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟服务的结构对位子集。**不重写日历**，只取「现在」。 */
export interface ClockLike {
  now(): number
}

/** O-021 人设内核的结构对位子集。**只读人设 id**，不取任何槽位正文。 */
export interface KernelLike {
  /** 人设 id（O-021 的 `KernelView` 只有这个字段能当名字用）。 */
  readonly personaId: string
}

/** O-021 人设内核服务的结构对位子集。 */
export interface PersonaCoreLike {
  kernel(personaId?: string): KernelLike | undefined
}

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 段声明的结构对位。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果的结构对位。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源服务的结构对位。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
