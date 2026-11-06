/**
 * O-117 `ondra-cocreate` 的对外契约（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「两个人一起做点什么时，谁提、谁改、什么时候收束？」**
 *
 * 只回答「分工与轮次」。每一轮只给**这一轮该谁开口、要解决什么、必须做到什么、
 * 绝对不许做什么**，一个字的内容都不生成——内容归对话链（O-033）。
 *
 * ## 六条硬裁决（每条都能单独否掉一种「更顺手」的做法）
 *
 * 1. **版数有硬上限，到点必须收束。** 没有上限的共创就是聊天：两个人各说各的，
 *    每一版都「再改改就好」，最后一版也没定。上限按**版数**算而不按发言次数算——
 *    发言次数谁都能刷（问一句答一句就翻一轮），版数是硬的。
 * 2. **「改」必须基于上一版，不许另起一稿。** 另起一稿之后版号就断了：
 *    谁也说不清在改的是第几版，也说不清上一版被丢掉的改动是不是有意的。
 * 3. **`handoff()` 必须带版号，对不上直接拒绝。** 两个人同时改的时候，
 *    后到的那个会当场抛 `stale-version`，而不是把别人的改动悄悄盖掉。
 *    这与 O-107 的 `advance(expected)` 是同一条道理。
 * 4. **收束时只问一句「这版算定稿吗」，不许自动定稿。**
 *    `final` 在类型上就是字面量 `false`：本插件**没有**「定稿」这个状态。
 *    定稿是人回答的；流程一旦能替人答，它就会在两轮之后就替人答。
 * 5. **不存作品正文。** 目标与交接备注都只校验、不留存（只记字符数）。
 *    正文归调用方与 O-010 记忆，那里有它自己的生命周期、可见性与遗忘权（O-103）。
 *    一个「流程档」里塞进正文，等于在遗忘权的十一个面之外又开一扇后门。
 * 6. **提出方与修改方不能是同一个。** 这一点靠**结构**保证，不靠提醒：
 *    角色由状态机轮换（`brief`/`review` 归 `author`，`make` 归 `maker`），
 *    调用方无权指定「这轮谁来改」。同一个人既提又改，共创就退化成独白——
 *    独白是对话链的正常形态，但它不该顶着一个叫「共创」的名字。
 *
 * ## 依赖纪律
 *
 * 身份 / 时钟 / 人设 / 配置四项全是**软依赖**，故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
 *
 * ## 明确不做
 *
 * 不生成内容、不存正文、不做界面、不装定时器、不主动发消息、不落盘。
 */

/** 本插件注册的服务键（连字符，非 `ondra:cocreate`）。全仓唯一归属。 */
export const COCREATE_SERVICE_KEY = 'ondra-cocreate'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会被模型侧直接拒绝，
 * 而且是在**运行期**才拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 四位当事人。
 *
 * `author`（提出方）与 `maker`（动手方）**是两个不同的角色，不是同一个人的两种心情**。
 * 它们在结构上永不重合：`author` 定目标、给意见、收束；`maker` 出稿、改稿。
 */
export type Party = 'author' | 'maker'

/** 会话阶段。顺序即语义：立题 → 出稿 ⇄ 意见 → 待收束 → 已收束。 */
export type Phase = 'idle' | 'brief' | 'make' | 'review' | 'closing' | 'closed'

/** 四拍 id（闭集）。`closing` 与 `closed` 不是拍，是「必须收束 / 已收束」两个状态。 */
export type RoundKind = 'brief' | 'make' | 'review' | 'close'

/** 四拍 id（只读，供外壳与自检枚举）。顺序即执行顺序。 */
export const ROUND_KINDS: readonly RoundKind[] = Object.freeze([
  'brief',
  'make',
  'review',
  'close',
] as const)

/**
 * 一拍的约束。
 *
 * `mustDo` / `mustNot` 是**给调用方的约束**，不是台词。这里一个字的内容都不给：
 * 一旦出现「你可以这样开头……」，内容就有了第二份来源，而那份来源不经过
 * 冻结前缀（O-033）与九步过滤（O-037）。
 */
export interface RoundBrief {
  /** 拍 id。 */
  readonly kind: RoundKind
  /** 这一拍该谁开口。 */
  readonly owner: Party
  /** 这一拍要解决什么（一句中文）。 */
  readonly intent: string
  /** 必须做到的事。 */
  readonly mustDo: readonly string[]
  /** 绝对不许做的事。**比 mustDo 更重要**：禁令漏一条，整拍就走偏。 */
  readonly mustNot: readonly string[]
}

/**
 * 共创进度快照。**不含目标原文、不含作品正文、不含任何一条交接备注。**
 *
 * `final` 是字面量 `false`：类型层面就没有「已定稿」这个分支。
 */
export interface CocreateSnapshot {
  /** 是否有一次进行中的共创（已收束的会话不算进行中）。 */
  readonly active: boolean
  /** 当前阶段。 */
  readonly phase: Phase
  /** 现在轮到谁开口；`idle` / `closed` 为 `null`。 */
  readonly owner: Party | null
  /** 已经交出去的版数（0 表示还停在立题）。 */
  readonly edition: number
  /** 版数硬上限。 */
  readonly maxEditions: number
  /** 还能再交几版（撞上限为 0）。 */
  readonly editionsLeft: number
  /** 已完成交接次数（**账目**，与 `edition` 分开记）。 */
  readonly rounds: number
  /** 是否已经只能收束（版数用尽，`handoff()` 一律拒绝）。 */
  readonly closing: boolean
  /** 会话开始时刻；没开为 `null`。 */
  readonly openedAt: number | null
  /** 收束时刻；没收束为 `null`。 */
  readonly closedAt: number | null
  /** 目标字符数（**只记长度，不记原文**）。 */
  readonly goalChars: number
  /** 最近一次交接时刻。 */
  readonly lastHandoffAt: number | null
  /** 恒为 `false`：本插件永不宣布定稿。 */
  readonly final: false
}

/** 一拍的可执行视图。 */
export interface CocreateRound {
  /** 进度快照。 */
  readonly snapshot: CocreateSnapshot
  /** 这一拍；没开或已收束为 `null`。 */
  readonly kind: RoundKind | null
  /** 这一拍该谁开口。 */
  readonly owner: Party | null
  /** 要解决什么。 */
  readonly intent: string
  /** 必须做到的事。 */
  readonly mustDo: readonly string[]
  /** 绝对不许做的事。 */
  readonly mustNot: readonly string[]
  /** 是否必须问出「这版算定稿吗」（只有收束拍为真）。 */
  readonly askFinal: boolean
  /** 一句中文。**不含台词、不含作品内容。** */
  readonly note: string
}

/** 累计统计。**只在内存**，不落盘。 */
export interface CocreateStats {
  /** 开过几次共创。 */
  readonly sessions: number
  /** 交接总次数。 */
  readonly handoffs: number
  /** 累计交出的版数。 */
  readonly editions: number
  /** 收束次数。 */
  readonly closes: number
  /** 被拒次数（版号不符 / 空交接 / 角色越界 / 撞上限）。 */
  readonly rejected: number
  /** 撞版数上限次数。**不为 0 说明共创确实被硬拦下来过。** */
  readonly capHits: number
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码闭集。 */
export type CocreateErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（目标为空、备注超长、版号不是非负整数）。 */
  | 'bad-request'
  /** 还没 `open()` 就想推进。 */
  | 'no-session'
  /** 已经收束，仍要推进。 */
  | 'already-done'
  /** 版数用尽，只能 `close()`。 */
  | 'round-cap'
  /** 版号对不上：调用方以为的版号与真实版号不一致。 */
  | 'stale-version'

/** 共创流程错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class CocreateError extends Error {
  /** 错误码。 */
  readonly code: CocreateErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: CocreateErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'CocreateError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface CocreateService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: CocreateErrorCode

  /**
   * 开一次共创：立题。重复调用等于「换一个题」——旧会话的版数与账目一律清零。
   * @param goal 要做出的东西（一句话）。**只校验，不留存**，只记字符数。
   */
  open(goal: string): CocreateRound

  /** 当前这一拍。**只读，不推进水位。** 外壳可以随便轮询。 */
  next(): CocreateRound

  /**
   * 兑现**当前**这一拍，推进水位。
   *
   * 必须由**真正把这一拍说出来**的那一方调用。
   * @param note 交接备注（一句），说清这一版改了什么 / 这一轮意见指向哪一处。
   *   **只校验，不留存**：空备注是「什么都没说就想交下一版」，一律拒绝。
   * @param expectedEdition 调用方认为当前是第几版。对不上抛 `stale-version`。
   */
  handoff(note: string, expectedEdition: number): CocreateRound

  /**
   * 收束：把决定权交回去。
   *
   * 返回的视图 `askFinal` 为真，意思是「现在必须原话问出『这版算定稿吗』」。
   * **本插件不记录答案，也不替人定稿**——`final` 恒为 `false`。
   */
  close(): CocreateRound

  /** 进度快照。**只读，不推进水位。** */
  snapshot(): CocreateSnapshot

  /** 累计统计快照。 */
  stats(): CocreateStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §15.5：相邻服务一律经服务键调用，不 import 源码。
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

/** O-003 时钟服务的结构对位子集。**不重写日历**，只取这两项。 */
export interface ClockLike {
  now(): number
  dayKey(at?: number): string
}

/** O-021 人设边界的结构对位子集（只用来数「有几条硬边界」，不读原文）。 */
export interface BoundaryItemLike {
  readonly id: string
  readonly hard: boolean
}

/** O-021 人格内核服务的结构对位子集。**只取边界条数**，不取任何人格正文。 */
export interface PersonaCoreLike {
  readonly available: boolean
  boundaries(personaId?: string): readonly BoundaryItemLike[]
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
