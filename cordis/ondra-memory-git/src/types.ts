/**
 * O-099 `ondra-memory-git` 的对外契约：把记忆的**生命周期**翻译成「版本线」。
 *
 * ## 一句话定位
 *
 * 「记忆 Git 化」在这里**不是真的跑 git**（禁装依赖、插件也不许起子进程），
 * 而是把 O-010 已经存好的字段投影成一套仓库语义：
 *
 * - 每条记忆有一个**阶段**（活跃 / 沉底 / 封存 / 已遗忘）——对应「工作区 / 归档 / 只读 / 删除」；
 * - 每条记忆有一个**版本深度**（`revisions + 1`）——对应「提交了几次」；
 * - 最近一次订正有**可读的差异**（`oldText` → `text`）——对应「diff」；
 * - 人可以给某一刻打**检查点标签**，标签绑定 O-009 的真快照 id——对应「tag」。
 *
 * ## 为什么没有 `commit()` / `push()` / 完整历史（本文件最重要的一条）
 *
 * 最诱人的做法是单开一张 `memory_version` 表，每次订正塞一份正文快照，
 * 于是就能给出完整的 `git log`。代价有三条，任何一条都足以否掉它：
 *
 * 1. **正文会翻倍**：记忆正文上限 200 字，逐版存 5 次就是 5 份。隐私面按版本数线性放大，
 *    而「被遗忘权」（O-103）要删的时候就得删每一版——漏一版就是留了残留。
 * 2. **多一个真源**：正文的真源是 `memory_fact.text`。版本表一旦存在，
 *    两边必然漂开（有人直连库改一条，版本表不知道），且**两处都说得通**。
 * 3. **O-010 本来就没存**：`MemoryRecord` 只有 `revisions` 计数与最近一份 `oldText`。
 *    要完整历史就必须改 O-010 的表结构——那是「必须改上游」，按任务纪律应当 `blocked`。
 *
 * 所以本插件的能力边界**诚实地画在「最近一次」上**：`CAPABILITY = 'latest-only'`。
 * 这不是漏实现，是刻意把「可解释的少」摆在「看起来完整却偷偷多存一份」前面。
 *
 * ## 与 O-009 的分工（检查点标签）
 *
 * 真备份（`VACUUM INTO`）归 O-009 `ondra-snapshot`：它保证「结构完整、数据不缺」。
 * 本插件**只存一张映射表**（`标签 → 快照 id`）与一句人话备注。
 * 于是：
 * - 快照文件丢了 → 标签还在，但 `checkout()` 会如实说「找不到那份快照」；
 * - 标签删了 → 快照**不删**（快照归 O-009 的 KEEP 策略管，跨插件删别人的备份是越界）。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（master-plan §15.5 / 18.5），全部结构对位镜像。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const MEMORY_GIT_SERVICE_KEY = 'ondra-memory-git'

/**
 * 本插件能提供的历史粒度。
 *
 * - `latest-only`：只有「最近一次订正」的前后文本可 diff，更早的版本已被 O-010 覆盖。
 *
 * 保留成常量而不是写死在注释里，是为了让消费方**在编译期就能读到这个上限**，
 * 而不是画完一个「历史时间轴」之后才发现只有两个点。
 */
export const CAPABILITY = 'latest-only' as const

/** 能力标识类型。 */
export type GitCapability = typeof CAPABILITY

/**
 * 记忆阶段。**顺序即界面渲染顺序**：从「还在用」到「只剩记录」。
 *
 * 这四个值不是新造的状态机，而是 O-010 三个真实状态位 + 一个「记录已不在」的事实拼出来的：
 * `sealed` 优先于 `archived`（封存比沉底更重，两者可能同时为真）。
 */
export const MEMORY_STAGES = ['active', 'archived', 'sealed', 'forgotten'] as const

/** 一个记忆阶段。 */
export type MemoryStage = (typeof MEMORY_STAGES)[number]

/** 一个阶段的说明书。 */
export interface StageDoc {
  /** 阶段 id。 */
  readonly id: MemoryStage
  /** 中文名。给日志与应用外壳显示，**不进提示词**。 */
  readonly zh: string
  /** 能否从 O-010 读到记录本体。`forgotten` 恒为 `false`（只剩墓碑事实）。 */
  readonly readable: boolean
  /** 一句话说明。 */
  readonly doc: string
}

/** 四阶段说明书 —— **阶段语义的唯一真源**。 */
const STAGE_TABLE: Record<MemoryStage, StageDoc> = {
  active: {
    id: 'active',
    zh: '活跃',
    readable: true,
    doc: '还在正常参与：会被召回、会被注入，也会按寿命自然衰减。',
  },
  archived: {
    id: 'archived',
    zh: '沉底',
    readable: true,
    doc: '超过归档窗口没被带出，已沉底。数据还在、按类检索仍能翻到，但不再占主动位。',
  },
  sealed: {
    id: 'sealed',
    zh: '封存',
    readable: true,
    doc: '被明确封存：不主动注入、不参与回忆。按类检索仍可能翻到——它是「收起来」不是「删掉」。',
  },
  forgotten: {
    id: 'forgotten',
    zh: '已遗忘',
    readable: false,
    doc: '真删并写了墓碑，禁止合并时复活。只剩「这段内容被忘过」这一条事实，正文不可读。',
  },
}

/** 阶段表的只读出口。 */
export const STAGE_SPECS: Readonly<Record<MemoryStage, StageDoc>> = Object.freeze(STAGE_TABLE)

/**
 * 检查点标签的命名正则。
 *
 * 比服务键更紧（不允许以 `-` 开头），因为标签会进文件键与日志，
 * 且人要在清单里一眼扫过去——允许 `-` 开头会让 `-old` / `old` 看起来一样。
 */
export const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** 最多同时存在多少个检查点标签。 */
export const MAX_TAGS = 32

/** 差异片段：一段连续的同类文本。 */
export interface DiffHunk {
  /** 片段种类：未变 / 新增 / 删除。 */
  readonly kind: 'equal' | 'insert' | 'delete'
  /** 片段文本。 */
  readonly text: string
}

/**
 * 一次差异的完整结果。
 *
 * **只在内存里算，永不落盘**：落盘就等于存了第二份正文。
 */
export interface DiffResult {
  /** 记忆 id。 */
  readonly id: string
  /** 订正前的正文（来自 `oldText`）。 */
  readonly from: string
  /** 订正后的正文（来自 `text`）。 */
  readonly to: string
  /** 差异片段（按原文顺序）。 */
  readonly hunks: readonly DiffHunk[]
  /** 新增字符数。 */
  readonly insertedChars: number
  /** 删除字符数。 */
  readonly deletedChars: number
  /** 是否因为超长而只算了前一段（正文上限 200 字，正常不会触发）。 */
  readonly truncated: boolean
  /** 计算时刻。 */
  readonly at: number
}

/** 一次订正的「版本视图」。**元数据 + 预览，不含全文**。 */
export interface VersionView {
  /** 记忆 id。 */
  readonly id: string
  /** 当前阶段。 */
  readonly stage: MemoryStage
  /** 阶段中文名。 */
  readonly stageZh: string
  /**
   * 版本深度 = `revisions + 1`。
   *
   * 0 次订正时为 1（只有初版）。**这是「提交了几次」的等价物**，
   * 但不代表能读出中间每一版（见 `CAPABILITY`）。
   */
  readonly depth: number
  /** 订正次数（O-010 原值）。 */
  readonly revisions: number
  /** 被提起次数。 */
  readonly timesSaid: number
  /** 被检索命中次数。 */
  readonly hits: number
  /** 写入时刻。 */
  readonly createdAt: number
  /** 最近一次被带出的时刻。 */
  readonly lastSeenAt: number
  /** 当前寿命 S（小时）。 */
  readonly stabilityHours: number
  /** 当前强度 0–1。 */
  readonly strength: number
  /** 距离掉到地板还有多少小时。 */
  readonly remainingHours: number
  /** 是否「重要」（决定归档窗口 90 天 / 30 天）。 */
  readonly important: boolean
  /** 寿命类别（11 类之一）。 */
  readonly category: string
  /** 五类标签（episode / fact / …）。 */
  readonly kind: string
  /** 是否有上一版正文可 diff。 */
  readonly hasPreviousText: boolean
  /** 正文预览（截断，**不返回全文**——要看全文由界面走 O-017 的审计口）。 */
  readonly preview: string
}

/** 一个检查点（标签 + 快照绑定）。 */
export interface Checkpoint {
  /** 标签名（符合 `TAG_RE`）。 */
  readonly label: string
  /** 绑定的 O-009 快照 id。 */
  readonly snapshotId: string
  /** 一句人话备注（为什么在这一刻打点）。 */
  readonly note: string
  /** 打点时刻。 */
  readonly at: number
  /** 该快照现在是否还在磁盘上（`false` 表示被 KEEP 策略轮转掉了）。 */
  readonly present: boolean
}

/** `checkout()` 的结果。**它只登记待恢复，不换库**。 */
export interface CheckoutOutcome {
  /** 是否成功登记。 */
  readonly ok: boolean
  /** 标签名。 */
  readonly label: string
  /** 绑定的快照 id。 */
  readonly snapshotId: string
  /** 拒绝原因码（`ok=false` 时有）。 */
  readonly refusal?: GitErrorCode
  /** 中文说明。 */
  readonly detail: string
}

/** 落盘的状态。**只存标签映射，绝不存正文**。 */
export interface GitState {
  /** 存档版本。 */
  readonly version: number
  /** 检查点列表（顺序即打点顺序）。 */
  readonly tags: readonly TagRecord[]
}

/** 落盘的一条标签记录。 */
export interface TagRecord {
  /** 标签名。 */
  readonly label: string
  /** 快照 id。 */
  readonly snapshotId: string
  /** 备注。 */
  readonly note: string
  /** 时刻。 */
  readonly at: number
}

/** 统计快照。 */
export interface GitStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 能力粒度（恒为 `latest-only`，写进统计是为了让人一眼看到上限）。 */
  readonly capability: GitCapability
  /** 已有检查点数量。 */
  readonly checkpoints: number
  /** O-009 当前持有的快照份数（缺席为 0）。 */
  readonly snapshots: number
  /** 累计算过多少次视图。 */
  readonly viewed: number
  /** 累计算过多少次差异。 */
  readonly diffed: number
  /** 累计失败次数（不阻断，只记账）。 */
  readonly failed: number
  /** 落盘失败次数。 */
  readonly writeFailures: number
}

/** 不可用原因。 */
export type GitUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 记忆内核缺席：没有记录可看。 */
  | 'no-core'

/** 错误码。**只用闭集内的值**，不临时编新码。 */
export type GitErrorCode =
  | 'no-core'
  | 'core-unavailable'
  | 'no-snapshot'
  | 'not-found'
  | 'bad-label'
  | 'too-many-tags'
  | 'write-failed'

/** 版本线错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class GitError extends Error {
  /** 错误码。 */
  readonly code: GitErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: GitErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface MemoryGitService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GitUnavailableReason
  /** 能力粒度。 */
  readonly capability: GitCapability

  /** 四阶段说明书（全量，固定四条）。 */
  stages(): readonly StageDoc[]

  /**
   * 单条记忆的版本视图。**只读**：不推进任何状态。
   * @param id 记忆 id。
   * @param at 时刻（算强度用）。
   * @returns 记录不存在时 `undefined`。
   */
  view(id: string, at?: number): VersionView | undefined

  /**
   * 最近一次订正的差异。**纯函数，不写库、不落盘**。
   * @param id 记忆 id。
   * @returns 没订正过（`oldText` 为空）或记录不存在时 `undefined`。
   */
  diff(id: string): DiffResult | undefined

  /** 检查点列表（按打点顺序）。 */
  tags(): readonly Checkpoint[]

  /**
   * 打一个检查点：调 O-009 `create()` 拿真快照，存 `标签 → 快照 id`。
   *
   * **O-009 缺席时拒绝**（而不是存一个空快照 id 假装成功）——
   * 存假 id 会让 `checkout()` 到恢复那一刻才发现没用，而那时用户已经信了。
   * @param label 标签名。
   * @param note 备注。
   */
  tag(label: string, note?: string): Checkpoint

  /**
   * 删标签。**不动快照文件**：快照归 O-009 的 KEEP 策略。
   * @param label 标签名。
   * @returns 是否真的删了一个。
   */
  dropTag(label: string): boolean

  /**
   * 把标签指向的快照登记为「待恢复」。
   *
   * **不换库**：真正的 `restore()` 归 O-009，且必须人再确认一次。
   * 这是「不做自动回滚」的落地方式——本插件最多把票递到手上。
   * @param label 标签名。
   */
  checkout(label: string): CheckoutOutcome

  /** 统计快照。 */
  stats(): GitStats
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§15.5：不 import 源码）
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

/** O-002 路径服务的结构对位子集。目录归它建，本插件不自己 mkdir。 */
export interface PathLike {
  readonly display: string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

/** O-003 时钟服务的结构对位子集（只要「现在」）。 */
export interface ClockLike {
  now(): number
}

/**
 * O-010 `ondra-memory-core` 的结构对位子集。
 *
 * 只取三样：单条读取、分页列举、强度计算。
 * **不取 `revise()` / `forget()` / `seal()`**：订正与删除归 O-017 的审计口与
 * 应用外壳的确认流程，本插件只读。镜像一个写方法，就一定会有人从版本线直接改库。
 */
export interface MemoryCoreLike {
  readonly available: boolean
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: {
    readonly state?: 'active' | 'archived' | 'sealed'
    readonly limit?: number
    readonly offset?: number
    readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
  }): readonly MemoryRecordLike[]
  strengthOf(record: MemoryRecordLike, at?: number): StrengthLike
}

/** 记忆记录的最小形状（只镜像本插件真正读的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly kind: string
  readonly category: string
  readonly text: string
  readonly summary: string | null
  readonly important: boolean
  readonly stabilityHours: number
  readonly timesSaid: number
  readonly hits: number
  readonly revisions: number
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly archived: boolean
  readonly sealed: boolean
  readonly oldText: string | null
}

/** 强度视图的最小形状。 */
export interface StrengthLike {
  readonly stabilityHours: number
  readonly strength: number
  readonly remainingHours: number
}

/**
 * O-009 `ondra-snapshot` 的结构对位子集。
 *
 * 只取 `create` / `list` / `stage`：**不取 `restore()`**。
 * 不镜像 `restore()` 是刻意的：换库这种不可逆动作必须由人经 O-009 的二次确认执行，
 * 本插件不许有那条路径。
 */
export interface SnapshotLike {
  readonly available: boolean
  readonly unavailableReason: string | null
  create(reason?: string): { readonly ok: boolean; readonly record?: { readonly id: string } }
  list(): readonly { readonly id: string }[]
  stage(id: string): { readonly ok: boolean }
}

/** O-005 段声明的结构对位子集。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置段声明的结构对位子集。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number } | undefined
}

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}
