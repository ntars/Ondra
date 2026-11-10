/**
 * O-044 `ondra-proactive-quota` 的对外契约。
 *
 * 定位：**她此刻还想不想说、还能不能再说一句**。这是投递链上的第二问，
 * 第一问（此刻能不能发）归 O-042 `ondra-proactive-gate`。
 *
 * ```
 * 话由（O-043） → 本插件（愿意说吗 / 今天还剩几句 / 是不是该退场了）
 *              → O-042（能发吗：静默 / 速率 / 内容 / 冷却）
 *              → 发送 → 本插件 commit() 记账
 * ```
 *
 * ## 先划清三块地盘，否则这个插件会变成第二份门控
 *
 * 手册 §5.2 把「时机 / 话由 / 分寸」拆成三个插件（gate / reason / quota）。
 * 落到代码上最容易犯的错是「顺手把别人的闸再实现一遍」，那样两个插件会在
 * 同一件事上给出不同答案，而症状是「她说的话时多时少，查不出规律」。
 *
 * | 判定 | 归属 | 本插件 |
 * |---|---|---|
 * | 静默时段 / 深夜 / 速率 / 冷却 / 去重 / 内容红线 / 熔断 | O-042 | **一律不碰** |
 * | 群聊不主动（§5.7 红线） | O-042（`policy` 闸，无开关） | **不接 `kind` 参数**，不做第二份拦截 |
 * | 每日额度的**衰减**（≥3 天减半、≥7 天归零） | O-042 的 `budgetOf()` | **只消费**，绝不重算 |
 * | 额度的**档位**（她整体多主动） | 本插件 | `PROFILE_QUOTA` 唯一表 |
 * | 两次主动之间的最小间隔 | 本插件 | `minIntervalMinutes` |
 * | 性格化沉默（放弃率） | 本插件 | 确定性抽签，无状态 |
 * | 连续无回应 → 退场句 | 本插件 | `proactiveSinceUser` + 沉默天数 |
 * | 一键静音 | 执行在 O-042 的 `mute()` | 只做**入口转发**与状态展示 |
 *
 * ## 三条「不说」的形态
 *
 * 1. **`defer`（等一会儿再说）**——只有一种情况：离上次主动还没到最小间隔。
 *    时间到了自然该说，丢掉等于把她刚想说的事扔了。
 * 2. **`drop`（这一轮不说了）**——额度用完、今天说过退场句了、抽到放弃、被静音。
 *    重排只会在半小时后把同样的话再说一遍，那不是节制，是催。
 * 3. **`retreat`（只说一句退场句）**——手册 §9.3 的退场规则。它是**允许发**的，
 *    只是形态被压成一句。调用方不该把它当拒绝。
 *
 * ## 为什么没有「每天最多说几条」的第二份计数
 *
 * 「今天说了几句」的真源在 O-042 的 `GateState.dayCount`，本插件只经 `peek()`
 * 读它。再存一份的下场是：两边都能数、两边都会漂，而面板显示 2、判定用 3 的
 * 时候没有任何报错。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§18.5），相邻服务一律结构对位。
 */

/** 本插件注册的服务键（连字符，非 `ondra:proactive-quota`）。全仓唯一归属。 */
export const QUOTA_SERVICE_KEY = 'ondra-proactive-quota'

/** 服务键 / 工具名 / 配置键的形状（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名。与 O-042 的 `proactive-state.json` **分两个文件**（两个写者不共用一个 JSON）。 */
export const STATE_FILE_NAME = 'proactive-quota.json'

/* ------------------------------------------------------------------ *
 * 手册给定的硬参数（§5.2 / §9.3）
 * ------------------------------------------------------------------ */

/** 额度档位。只有三档，第四档是 `enable=false`。 */
export type QuotaProfile = 'slow' | 'standard' | 'fast'

/**
 * 档位 → 每日主动条数。**本插件唯一的一张额度表**。
 *
 * `standard` 取 3 是 §9.3 原值（`dailyQuota=3`）。`slow` / `fast` 手册没给，
 * 由「标准的一半 / 两倍」推得并登记待裁决——**不另立一套刻度**。
 * `off` 不在这张表里：关掉由 `enable=false` 表达，两个「关」会让人以为关了一个
 * 还有一个在工作。
 */
const PROFILE_QUOTA_TMP: Record<QuotaProfile, number> = {
  slow: 1,
  standard: 3,
  fast: 6,
}

/** 档位额度表（只读出口）。 */
export const PROFILE_QUOTA: Readonly<Record<QuotaProfile, number>> = Object.freeze(PROFILE_QUOTA_TMP)

/**
 * 每日主动条数的上界。与 O-042 的 `HARD_DAILY_QUOTA` 同值，
 * 但**不引用它**（跨包不 import）：两边各自锁 20，谁先改都不会让另一侧放开。
 */
export const HARD_DAILY_QUOTA = 20

/** 两次主动之间的最小间隔（分钟）。手册没给，自定并登记待裁决。 */
export const DEFAULT_MIN_INTERVAL_MINUTES = 90

/** 性格化沉默的放弃率（§9.3 原值 30%）。 */
export const DEFAULT_GIVE_UP_RATE = 0.3

/** 用户开口之后，她主动说几次就改说退场句（§9.3 原话「已主动说 2 次」）。 */
export const RETREAT_AFTER_PROACTIVE = 2

/** 连续多少天没说话就改说退场句（§9.3 原话「silentDays≥2」）。 */
export const RETREAT_SILENT_DAYS = 2

/** 退场句每天最多几条。手册只写「只说一句」，上限自定并登记待裁决。 */
export const RETREAT_PER_DAY = 1

/** 一天的毫秒数（沉默天数用它折算，与 O-042 的 `silentDaysOf` 同口径）。 */
export const DAY_MS = 86_400_000

/** 一分钟的毫秒数。 */
export const MINUTE_MS = 60_000

/* ------------------------------------------------------------------ *
 * 判定的形状
 * ------------------------------------------------------------------ */

/** 被哪一道判定拦下（放行时是 `pass`）。顺序即执行顺序。 */
export type PlanGate = 'pass' | 'policy' | 'quota' | 'interval' | 'retreat' | 'give-up'

/** 全部判定名（计数表按它建，固定键）。 */
const PLAN_GATE_TMP: readonly PlanGate[] = ['pass', 'policy', 'quota', 'interval', 'retreat', 'give-up']

/** 判定名出口。 */
export const PLAN_GATES: readonly PlanGate[] = Object.freeze(PLAN_GATE_TMP)

/** 判定结论的动作。`retreat` 是**允许发**，只是形态被压成一句。 */
export type PlanAction = 'send' | 'retreat' | 'defer' | 'drop'

/** 稳定原因码。消费方可按码分支，不必匹配中文文案。 */
export type PlanCode =
  /** 放行，正常说。 */
  | 'ok'
  /** 总开关关掉了。 */
  | 'disabled'
  /** 一键静音中（§5.7）。 */
  | 'muted'
  /** 今日额度为 0（连续沉默 ≥7 天，或档位配额为 0）。 */
  | 'quota-zero'
  /** 今日额度用完了。 */
  | 'quota-exhausted'
  /** 离上次主动还没到最小间隔。`defer`，时到即可。 */
  | 'interval'
  /** 该说退场句了（且今天还没说过）。 */
  | 'retreat'
  /** 今天的退场句已经说过了。 */
  | 'retreat-sent'
  /** 抽到性格化沉默（这一次不说）。 */
  | 'give-up'
  /** 判定本身抛错（本插件内部错误）。 */
  | 'internal-error'

/** 一次判定请求。 */
export interface QuotaRequest {
  /**
   * 这次想说的是哪件事（由头的话题键，如 `gap:g-123`）。
   *
   * 只用于性格化沉默的抽签种子：**同一件事在同一个间隔窗口里抽一次，结果固定**。
   * 不带话题键时用空串——那意味着「这一轮的沉默抽签与具体事由无关」。
   */
  readonly topicKey?: string
  /**
   * 外部给定的抽签值（0–1）。省略则按 `(日键, 话题键, 间隔窗口)` 算确定性哈希。
   *
   * 存在的意义只有两个：评估集要可复现、面板要能演示「她今天这条会放弃」。
   * 正常路径不要传——传了就等于绕开「重试不能改抽签结果」这条保护。
   */
  readonly draw?: number
  /** 判定时刻，省略用系统时间。 */
  readonly at?: number
}

/** 额度视图。 */
export interface QuotaView {
  /** 档位。 */
  readonly profile: QuotaProfile
  /** 档位（或高级覆盖）给出的**未经衰减**的额度。 */
  readonly base: number
  /** 今日生效额度（含 O-042 的沉默衰减）。`source==='local'` 时等于 `base`。 */
  readonly effective: number
  /** 今日已发的主动条数（来自 O-042）。 */
  readonly used: number
  /** 还剩几条（不小于 0）。 */
  readonly remaining: number
  /**
   * 数值来源。
   * - `gate`：读的是 O-042 的日计数与衰减，**可信**；
   * - `local`：O-042 缺席，本插件没有日计数，`used`/`remaining` 只是空转值，
   *   判定里因此**跳过额度闸**（见 README 已知限制 1）。
   */
  readonly source: 'gate' | 'local'
}

/** 连续无回应的视图。 */
export interface StreakView {
  /** 用户开口之后她已主动说了几次。 */
  readonly sinceUser: number
  /** 连续沉默天数。`undefined` = 既没有自己的记录、也没有 O-042 可问。 */
  readonly silentDays: number | undefined
  /** 是否已到退场线（`silentDays ≥ 2` 或 `sinceUser ≥ 2`）。 */
  readonly retreat: boolean
  /** 今天还能发几条退场句。 */
  readonly retreatLeft: number
}

/** 两次主动间隔的视图。 */
export interface IntervalView {
  /** 上次主动发出的时刻（`0` = 从未）。 */
  readonly lastAt: number
  /** 距上次过了多久。 */
  readonly sinceMs: number
  /** 还要等多久（`0` = 不用等）。 */
  readonly remainMs: number
  /** 配置的最小间隔。 */
  readonly intervalMs: number
}

/** 一份判定结论。 */
export interface QuotaPlan {
  /** 能不能发。等价于 `action === 'send' || action === 'retreat'`。 */
  readonly allow: boolean
  /** 该做什么。 */
  readonly action: PlanAction
  /** 被哪一道拦下（放行与退场时是 `pass` / `retreat`）。 */
  readonly gate: PlanGate
  /** 稳定原因码。 */
  readonly code: PlanCode
  /** 一句中文说明（可直接进日志与面板）。 */
  readonly detail: string
  /** 需要等多久再试（`0` = 不用等）。`defer` 时必然大于 0。 */
  readonly deferMs: number
  /** 额度视图。 */
  readonly quota: QuotaView
  /** 连续无回应视图。 */
  readonly streak: StreakView
  /** 间隔视图。 */
  readonly interval: IntervalView
  /** 这一次是否抽到了性格化沉默。 */
  readonly giveUp: boolean
  /** 是否该改说退场句（与 `action==='retreat'` 不等价：可能已说过）。 */
  readonly retreat: boolean
  /** 判定时刻。 */
  readonly at: number
}

/**
 * 要合并进 `GateRequest` 的两个覆盖值。
 *
 * 这是本插件与 O-042 之间**唯一的数值通道**，也是「只能有一份衰减」的落点：
 * 我们把**未衰减的档位额度**与**更新过的沉默天数**交给它，衰减仍由它的
 * `budgetOf()` 算一次。反过来（我们先衰减再传）会被它再衰减一次，
 * 症状是「选了快速档，实际只有 1 条」。
 */
export interface QuotaPatch {
  /** 未衰减的档位额度。 */
  readonly dailyQuota: number
  /** 连续沉默天数；`undefined` = 不知道（让它自己按 `lastUserAt` 推）。 */
  readonly silentDays?: number
}

/**
 * 落盘状态。
 *
 * **全部 readonly**：实现里每次变更都构造新对象。存档形状与运行期状态是同一份类型，
 * 少一套转换就少一处漂移。
 */
export interface QuotaState {
  /** 存档版本。读到不认识的版本按空状态处理（不猜迁移）。 */
  readonly version: number
  /** 上次主动发出的时刻（`0` = 从未）。间隔闸只看它。 */
  readonly lastProactiveAt: number
  /** 用户上次开口之后她已主动说了几次。退场判据的一半。 */
  readonly proactiveSinceUser: number
  /** 用户上次开口的时刻（`0` = 不知道）。退场判据的另一半。 */
  readonly lastUserAt: number
  /** 退场句的当日键（`YYYY-MM-DD`）。 */
  readonly retreatDayKey: string
  /** 当日已发退场句条数。 */
  readonly retreatDayCount: number
  /** 一键静音截止时刻（`0` = 没静音）。**只在 O-042 缺席时生效**。 */
  readonly mutedUntil: number
}

/** 记账入参。 */
export interface CommitOptions {
  /** 这一条是不是退场句。 */
  readonly retreat?: boolean
}

/** 记账结论。 */
export interface CommitOutcome {
  /** 记账时刻。 */
  readonly at: number
  /** 记账后「用户开口以来她主动说了几次」。 */
  readonly sinceUser: number
  /** 今天已发退场句条数。 */
  readonly retreatDayCount: number
}

/** 静音结论。 */
export interface MuteOutcome {
  /** 静音截止时刻。 */
  readonly until: number
  /** 谁在真正执行拦截：`gate`（O-042 在位）还是 `self`（只有本插件知道）。 */
  readonly via: 'gate' | 'self'
}

/** 不可用原因。只有「配置关掉」才算真的不可用（§15-49 的教训）。 */
export type QuotaUnavailableReason = 'disabled'

/** 统计快照。 */
export interface QuotaStats {
  /** 判定次数。 */
  readonly calls: number
  /** 放行（正常说）次数。 */
  readonly allowed: number
  /** 退场句次数（**也计入放行**，单列出来是为了看得见）。 */
  readonly retreats: number
  /** 延后次数。 */
  readonly deferred: number
  /** 丢弃次数。 */
  readonly dropped: number
  /** 抽到放弃的次数。 */
  readonly gaveUp: number
  /** 每道判定的命中次数（含 `pass`）。 */
  readonly byGate: Readonly<Record<PlanGate, number>>
  /** 记账次数（她真的说了）。 */
  readonly marks: number
  /** 用户开口上报次数。 */
  readonly userSpoke: number
  /** 落盘成功次数。 */
  readonly writes: number
  /** 落盘失败次数。 */
  readonly writeFailures: number
  /** 判定内部错误次数。 */
  readonly errors: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 今日额度视图。 */
  readonly quota: QuotaView
}

/** 额度服务。 */
export interface QuotaService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: QuotaUnavailableReason
  /** 状态是否真的落盘了。`false` = 重启后「上次主动时刻」与退场计数清零。 */
  readonly stored: boolean

  /**
   * 判一次「此刻愿不愿意说」。**一个字节都不改状态**（§15-73）。
   * @param request 请求。
   * @param at 时刻，省略用 `request.at` 或系统时间。
   */
  plan(request?: QuotaRequest, at?: number): QuotaPlan

  /** 只读：今日额度视图。 */
  quota(at?: number): QuotaView

  /** 只读：间隔视图。 */
  interval(at?: number): IntervalView

  /** 只读：连续无回应视图。 */
  streak(at?: number): StreakView

  /** 交给 O-042 的两个覆盖值（合并进 `GateRequest`）。 */
  patch(at?: number): QuotaPatch

  /** 记账：她真的发出去了一条（`retreat: true` 表示退场句）。**只有这里会写盘**。 */
  commit(options?: CommitOptions, at?: number): CommitOutcome

  /** 上报「用户开口了」：清零连续无回应。 */
  noteUserSpoke(at?: number): void

  /** 一键静音（§5.7）：在位时转发给 O-042，缺席时自己记。 */
  mute(ms: number, at?: number): MuteOutcome

  /** 取消静音。 */
  unmute(): void

  /** 强制落盘。 */
  flush(): boolean

  /** 统计快照。 */
  stats(): QuotaStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码）
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

/** O-005 的字段声明形状。 */
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

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-003 时钟的结构对位子集（只用到自然日键）。 */
export interface ClockLike {
  /** 自然日键 `YYYY-MM-DD`（生效时区）。 */
  dayKey(epoch?: number): string
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user', ...segments: string[]): string
  /** 确保私有文件可用：父目录 0700、文件 0600。 */
  prepareFile(filePath: string): string
}

/** O-042 的预算视图（只取本插件要读的字段）。 */
export interface BudgetViewLike {
  /** 自然日键。 */
  readonly dayKey: string
  /** 今日生效额度（O-042 已按沉默天数衰减）。 */
  readonly quota: number
  /** 今日已用的主动条数。 */
  readonly used: number
  /** 还剩几次。 */
  readonly remaining: number
  /** 连续沉默天数。 */
  readonly silentDays: number
}

/** O-042 的只读快照（只取本插件要读的字段）。 */
export interface GateSnapshotLike {
  /** 判定时刻。 */
  readonly at: number
  /** 今日预算。 */
  readonly budget: BudgetViewLike
  /** 一键静音截止。 */
  readonly mutedUntil: number
}

/** O-042 门控服务的结构对位子集。**只调只读与静音入口，不调 `gate()`**。 */
export interface GateLike {
  /** 只读快照（O-042 保证它不消耗、不记账）。 */
  peek(at?: number): GateSnapshotLike
  /** 一键静音，返回截止时刻。 */
  mute(ms: number, at?: number): number
  /** 取消静音。 */
  unmute(): void
}
