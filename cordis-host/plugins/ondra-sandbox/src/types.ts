/**
 * O-119 `ondra-sandbox` 的对外契约：**能力分级沙箱**（策略层，L9 扩展池，〔薄〕档）。
 *
 * ## 它回答哪一句话
 *
 * > **「这只插件这一次能干多大的事？」**
 *
 * 答案不是布尔，是**四级**（read / suggest / act / spend）加一张有期限、有次数的票据。
 * 没票不放行，票过期不放行，票用完了不放行，等级不够不放行。
 *
 * ## 为什么是「票」而不是「开关」
 *
 * 开关只有两种状态，而「能干多大的事」至少有四档，且随时间变化。
 * 票把这个决定拆成三个可答的问题：谁（`subject`）、做什么（`action`）、
 * 到什么时候为止（`expiresAt` + `maxUses`）。三样都能在事后指着说清楚，
 * 而一句「已授权」在事后什么都查不出来。
 *
 * ## 与 `ondra-organ-gate` 的边界（**最容易混的一处，写死在这里**）
 *
 * | | `ondra-organ-gate`（器官门控） | 本包（能力沙箱） |
 * |---|---|---|
 * | 管什么 | 器官**能不能用宿主门面** | **某次具体动作**该不该放行 |
 * | 判定依据 | 器官清单里声明的 `capabilities` | 票据（等级 + 期限 + 次数 + 确认串） |
 * | 生命周期 | 装载时一次性授权，随进程存续 | 每张票单独计时、单独计数、可单独吊销 |
 * | 缺省姿态 | default-deny（没声明就抛 `CapabilityDeniedError`） | default-deny（没票就抛 `SandboxDeniedError`） |
 * | 错误类 | `CapabilityDeniedError` | `SandboxDeniedError`（**刻意不同名**，两处 catch 不会互相吞） |
 * | 作用域 | 进程内、按器官 | 按 `subject + action` |
 *
 * 一句话：**那边是「你有没有资格拿这把钥匙」，这边是「这一次你拿这把钥匙开哪扇门、
 * 开到几点、开几次」。** 两层都要过，谁也不能替代谁——这正是本包**不**复用
 * `CapabilityDeniedError` 的原因：如果同名，调用方一个 catch 就会把「没资格」和
 * 「票过期」混成同一件事，而这两件事的处置完全不同（前者要找宿主改清单，后者重新申票）。
 *
 * ## 刻意不做（四条）
 *
 * - **不接管宿主权限系统。** 不调 `ctx.tools.restrict`，不改任何插件的注册表。
 * - **不实现器官 ABI。** 不碰 `ondra-organ-host` 的门面，也不假装自己是器官。
 * - **不做界面。** 状态走服务键，渲染归应用外壳。
 * - **不存调用内容。** 盘上只有票据本身（谁、做什么、到几时、用了几次），
 *   不存参数、不存返回值、不存调用理由——存了就等于在本地攒一份行为日志。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const SANDBOX_SERVICE_KEY = 'ondra-sandbox'

/**
 * 键形状硬约束（手册 §8.4）。服务键 / 配置键 / 票据 id 都必须匹配。
 *
 * 带冒号的写法在**运行期**才被模型侧拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const KEY_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 动作名的形状。比 `KEY_RE` 多放行 `.` 与 `-`，因为动作天然是两段
 * （`file.write` / `net-post`），但**仍然不放行冒号、空格、斜杠**：
 * 动作名要能原样进日志与报告，任何需要转义的名字都会让「谁干的」变得难以对账。
 */
export const ACTION_RE = /^[a-z][a-z0-9_.-]{1,95}$/

/**
 * 主体名的形状（谁在申票）。
 *
 * 同样不放行冒号：主体最常见是插件名（`ondra-diary`）或插件名加段（`ondra-diary.writer`），
 * 两种都已经在 `.` 里表达了，再加冒号只会多出一种「看起来像命名空间但其实不是」的写法。
 */
export const SUBJECT_RE = /^[a-z][a-z0-9._-]{1,63}$/

/** 票据档文件名（落在 `user/` 区域）。只存票据，不存调用内容。 */
export const STATE_FILE_NAME = 'sandbox-tickets.json'

/** 存档版本。改了结构必须加一，否则旧档会被当新档读。 */
export const STATE_VERSION = 1

/**
 * 四级能力（闭集，序即「越权程度」）。
 *
 * 为什么是这四级而不是 Continua 的连续分值：连续值需要解释「0.62 分算不算能发消息」，
 * 而四级每个边界都能用一句人话说明（见 `LEVEL_SPECS` 的 `doc`）。
 */
export type SandboxLevel = 'read' | 'suggest' | 'act' | 'spend'

/** 四级（只读，供外壳、单测与自检枚举）。 */
export const LEVELS: readonly SandboxLevel[] = Object.freeze(['read', 'suggest', 'act', 'spend'])

/**
 * 级别序。**由 `LEVELS` 派生**，不手写第二份——手写就一定会有一处把 `act`
 * 写在 `suggest` 前面，而那类错只在某次「顺手放开一点」时触发。
 */
export const LEVEL_RANK: Readonly<Record<SandboxLevel, number>> = Object.freeze(
  Object.fromEntries(LEVELS.map((level, index) => [level, index])) as Record<SandboxLevel, number>,
)

/** 单级的静态说明。纯数据，无副作用，可被界面与审计直接读。 */
export interface LevelSpec {
  /** 级别。 */
  readonly level: SandboxLevel
  /** 序（0 起）。 */
  readonly rank: number
  /** 中文名，只给日志与界面。 */
  readonly title: string
  /** 是否必须二次确认（显式 `confirm` 串等于动作名）。**`spend` 恒为真，不可配。** */
  readonly needsConfirm: boolean
  /** 一句话说明这一级允许什么。 */
  readonly doc: string
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}

/**
 * 四级表 —— **本包全部级别语义的唯一真源**。
 *
 * `spend` 的 `needsConfirm` 是字面量 `true` 而不是配置项：做成开关就等于允许
 * 「这次不用确认」，而那个开关一定会在某次赶时间时被关掉，之后不会再打开。
 */
export const LEVEL_SPECS: Readonly<Record<SandboxLevel, LevelSpec>> = Object.freeze({
  read: Object.freeze({
    level: 'read',
    rank: LEVEL_RANK.read,
    title: '只读',
    needsConfirm: false,
    doc: '读世界状态、读文件、看历史。不改任何东西，也发不出任何东西。',
  }),
  suggest: Object.freeze({
    level: 'suggest',
    rank: LEVEL_RANK.suggest,
    title: '建议',
    needsConfirm: false,
    doc: '产出草案、建议、提示词片段：可以交给人看，但不落状态、不调外部。',
  }),
  act: Object.freeze({
    level: 'act',
    rank: LEVEL_RANK.act,
    title: '行动',
    needsConfirm: false,
    doc: '改状态、调工具、发消息。会留下可见后果，但不动钱、不动能量、不对外付费。',
  }),
  spend: Object.freeze({
    level: 'spend',
    rank: LEVEL_RANK.spend,
    title: '花费',
    needsConfirm: true,
    doc: '花钱、花能量、发付费外部请求。**必须二次确认**：调用方要把动作名原样放进 confirm。',
  }),
})

/**
 * 固定错误码。消费方按码分支，不必匹配中文文案。
 *
 * 刻意**没有**通用的 `denied`：把「没票」「等级不够」「票被吊销」压成一个码，
 * 排查时就得读中文，而中文文案是会改的。
 */
export type SandboxErrorCode =
  /** 参数不合法（主体/动作名不合形状、级别不在闭集、ttl 或次数越界、票 id 未知）。 */
  | 'bad-request'
  /** 总开关关掉了。 */
  | 'disabled'
  /** 策略拒绝：没票、等级不够、票被吊销、票据档已满、spend 未确认。 */
  | 'sandbox-denied'
  /** 票已过期（`at >= expiresAt`）。**`detail` 里带截止时刻。** */
  | 'ticket-expired'
  /** 票的次数用完了。 */
  | 'ticket-exhausted'

/** 票据的终态原因。 */
export type EndReason =
  /** 到了 `expiresAt`。 */
  | 'deadline'
  /** 次数用尽。 */
  | 'uses'
  /** 被显式吊销。 */
  | 'revoke'

/** 票据（对外视图里的）状态。 */
export type TicketState =
  /** 还能用。 */
  | 'live'
  /** 已过期。 */
  | 'expired'
  /** 次数用尽。 */
  | 'exhausted'
  /** 已吊销。 */
  | 'revoked'

/**
 * 一条票据的**落盘形状**。
 *
 * 字段逐个列出、不用索引签名：盘上「存了什么」必须是能一眼读完的一份清单。
 * 注意这里**没有**任何调用内容（参数、返回值、理由）——见文件头第四条。
 */
export interface TicketRecord {
  /** 票据 id（`KEY_RE` 形状，全档唯一）。 */
  readonly id: string
  /** 谁（`SUBJECT_RE`）。 */
  readonly subject: string
  /** 做什么（`ACTION_RE`）。 */
  readonly action: string
  /** 最高可做到哪一级。 */
  readonly level: SandboxLevel
  /** 签发时刻。 */
  readonly issuedAt: number
  /** 截止时刻（含语义：`at >= expiresAt` 即过期）。 */
  readonly expiresAt: number
  /** 已用次数。 */
  readonly uses: number
  /** 次数上限。 */
  readonly maxUses: number
  /** 最近一次用掉的时刻；没用过为 `null`。 */
  readonly lastUsedAt: number | null
  /** 终态时刻；还活着为 `null`。**过期时这里存的是 `expiresAt`，不是「发现过期的那一刻」。** */
  readonly endedAt: number | null
  /** 终态原因；还活着为 `null`。 */
  readonly endedBy: EndReason | null
}

/** 票据的对外视图：比落盘形状多一个算出来的 `state` 与剩余次数。 */
export interface TicketView extends TicketRecord {
  /** 状态（`live` / `expired` / `exhausted` / `revoked`）。 */
  readonly state: TicketState
  /** 剩余次数（不会为负）。 */
  readonly remaining: number
}

/** 拒绝原因。每个都必须能一句话说清，否则「没放行」与「没判定」同形。 */
export type DenyReason =
  /** 这个主体在这个动作上一张票都没有。 */
  | 'no-ticket'
  /** 有票，但等级低于本次要求的等级。 */
  | 'level-too-low'
  /** 票已过期。 */
  | 'ticket-expired'
  /** 票的次数用完了。 */
  | 'ticket-exhausted'
  /** 票被吊销了。 */
  | 'ticket-revoked'
  /** `spend` 级要求确认，但调用方没给 `confirm`。 */
  | 'confirm-required'
  /** 给了 `confirm`，但与动作名不一致。 */
  | 'confirm-mismatch'
  /** 票据档已满（且没有可回收的终态票据）。 */
  | 'ticket-cap'

/** 一次判定的结果。**纯数据**，调用方可以原样写日志或交给界面。 */
export interface Decision {
  /** 是否放行。 */
  readonly allowed: boolean
  /** 判定时刻。 */
  readonly at: number
  /** 本次要求的等级。 */
  readonly level: SandboxLevel
  /** 命中的票据 id；没票时省略。 */
  readonly ticketId?: string
  /** 票上的等级；没票时省略。 */
  readonly ticketLevel?: SandboxLevel
  /** 放行后剩余次数；只有 `allowed=true` 才有。 */
  readonly remaining?: number
  /** 票的截止时刻；有票就带上，方便调用方提前续票。 */
  readonly expiresAt?: number
  /** 票的终态时刻（过期/用尽/吊销时的那一秒）。**这就是「什么时候过的期」。** */
  readonly endedAt?: number
  /** 终态原因。 */
  readonly endedBy?: EndReason
  /** 拒绝原因；`allowed=true` 时省略。 */
  readonly reason?: DenyReason
  /** 一句人话，直接进日志与报告。 */
  readonly detail: string
}

/** 申票请求。 */
export interface GrantRequest {
  /** 谁。 */
  readonly subject: string
  /** 做什么。 */
  readonly action: string
  /** 最高到哪一级。 */
  readonly level: SandboxLevel
  /** 有效期毫秒；省略用配置默认值，超过上限会被夹到上限。 */
  readonly ttlMs?: number
  /** 次数上限；省略用配置默认值，超过上限会被夹到上限。 */
  readonly uses?: number
}

/** 过闸请求。 */
export interface CheckRequest {
  /** 谁。 */
  readonly subject: string
  /** 做什么。 */
  readonly action: string
  /** 本次想做哪一级；省略按 `read` 算（最保守的假设）。 */
  readonly level?: SandboxLevel
  /**
   * 二次确认串。**`act` 以下不需要，`spend` 必填且必须等于 `action`。**
   *
   * 为什么要求「等于动作名」而不是一个布尔：布尔只要一次 `true` 就会被复制粘贴到
   * 所有调用点，而把动作名再写一遍至少要求调用方知道自己在做什么。
   */
  readonly confirm?: string
}

/** 票据档快照。 */
export interface Snapshot {
  /** 判定时刻。 */
  readonly at: number
  /** 全部票据（新的在前），**含已终态的**——过期票据必须查得到。 */
  readonly tickets: readonly TicketView[]
  /** 还活着的张数。 */
  readonly live: number
  /** 已终态的张数。 */
  readonly ended: number
  /** 票据档是否真的落盘。`false` = 重启后全部票作废。 */
  readonly stored: boolean
}

/** 累计统计。**只在内存**，不落盘（落盘就会变成一份行为日志）。 */
export interface SandboxStats {
  /** 统计时刻。 */
  readonly at: number
  /** 签发张数。 */
  readonly grants: number
  /** 过闸次数。 */
  readonly checks: number
  /** 放行次数。 */
  readonly allows: number
  /** 拒绝次数。 */
  readonly denials: number
  /** 因超出 `maxTickets` 被回收的终态票据数。 */
  readonly pruned: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启后票据全作废。** */
  readonly writeFailures: number
  /** 当前还活着的张数。 */
  readonly live: number
  /** 当前已终态的张数。 */
  readonly ended: number
  /** 票据档是否真的落盘。 */
  readonly stored: boolean
  /** 各拒绝原因的次数。 */
  readonly byReason: Readonly<Record<string, number>>
  /** 各等级被放行的次数。 */
  readonly byLevel: Readonly<Record<SandboxLevel, number>>
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 对外服务。 */
export interface SandboxService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: SandboxErrorCode
  /** 票据档是否真的落盘。 */
  readonly stored: boolean

  /** 四级表（只读副本，供界面与审计）。 */
  levels(): readonly LevelSpec[]

  /**
   * 签一张票。**默认拒绝的起点**：没有票就没有任何能力。
   *
   * `ttlMs` / `uses` 会被夹到配置上限，不抛错——夹紧比拒绝更有用，
   * 而夹过的痕迹写在返回值里（`expiresAt` / `maxUses`）。
   */
  grant(req: GrantRequest): TicketView

  /**
   * 过闸：判定并**消耗一次**。
   *
   * 放行返回 `Decision`；拒绝**抛 `SandboxDeniedError`**，不静默返回 false。
   * 静默拒绝会让调用方以为「这次没生效」，然后换个名字再试一次。
   */
  check(req: CheckRequest): Decision

  /** 吊销一张票。幂等：已终态的票再吊销不报错。 */
  revoke(ticketId: string): TicketView

  /** 只读快照。**含已终态的票**，过期也能查出是哪张、什么时候过的期。 */
  snapshot(at?: number): Snapshot

  /** 累计统计快照。 */
  stats(): SandboxStats
}

/** 沙箱拒绝。**类名刻意不与 `CapabilityDeniedError` 相同**（见文件头边界表）。 */
export class SandboxDeniedError extends Error {
  /** 固定错误码。 */
  readonly code: SandboxErrorCode
  /** 拒绝原因（`bad-request` / `disabled` 时省略）。 */
  readonly reason: DenyReason | undefined
  /** 命中的票 id（有的话）。 */
  readonly ticketId: string | undefined
  /** 完整判定（有的话），调用方可以直接写日志。 */
  readonly decision: Decision | undefined

  /**
   * @param code 固定错误码。
   * @param message 中文说明。
   * @param extra 补充：拒绝原因、票 id、判定。
   */
  constructor(
    code: SandboxErrorCode,
    message: string,
    extra?: { readonly reason?: DenyReason; readonly ticketId?: string; readonly decision?: Decision },
  ) {
    super(message)
    this.name = 'SandboxDeniedError'
    this.code = code
    this.reason = extra?.reason
    this.ticketId = extra?.ticketId
    this.decision = extra?.decision
  }
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §15.5：相邻服务一律经服务键调用，不 import 源码。
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
  debug?(message: string, ...args: readonly unknown[]): void
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟服务的结构对位子集。本包只用「现在」，不重写日历。 */
export interface ClockLike {
  now(): number
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  /** 数据根的用户可见写法（不暴露机器绝对路径）。 */
  readonly display: string
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
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
