/**
 * O-140 `ondra-evidence-gate` 的对外契约。
 *
 * 定位：**写入路径上的确定性闸门**。它不生成、不提炼、不调模型，只回答一个问题：
 * 「这条候选记忆凭什么进来？」
 *
 * 为什么必须有这一层（手册 §2.2 原话）：「自我强化幻觉污染整库是提示词拦不住的，
 * 必须确定性代码闸门。」她断言某事 → 天真的写入路径记成事实 → 下一轮读回来当真理
 * 并更自信地重复。这个循环里每一环看起来都正常，日志全绿，只有记忆库慢慢变成
 * 一份她自己的臆想。
 *
 * ## 与 O-011 `ondra-memory-extract` 的分工（这是本文件最容易被误解的地方）
 *
 * O-011 的 `verify.ts` 里也有一套逐字校验，但它**只服务提炼这条路**：入参是本轮
 * `messages`，出口是「提炼结果的一条事实」。而本插件是**任何写入方都能调的门**：
 *
 * | 写入方 | 走 O-011 的 verify | 走本插件 |
 * |---|---|---|
 * | O-011 提炼 | ✅ | 也可再走一遍 |
 * | O-019 做梦补事实 | ❌（素材不是 messages，带来源标注） | ✅ |
 * | 用户手写 / 导入 / 通道转发 | ❌ | ✅ |
 *
 * 两套实现并存是**跨插件禁 import**（§6 禁令 4）的代价，不是疏忽。归一化口径
 * 逐字对齐 O-011 `verify.ts`，纪律写在 `src/text.ts` 文件头；本轮已用脚本比对过
 * 三处（O-011 / O-019 / 本插件）的 `EDGE_PUNCTUATION` 与 `normalizeForMatch` 正文。
 *
 * **建议（已登记，待裁决）**：给 `ExtractService` 补一个纯函数入口
 * `verify(evidence, materials)`，让本插件成为唯一闸门，把镜像从三份收成一份。
 *
 * ## 三个刻意的边界
 *
 * 1. **不判重**。`add / merge / append / conflict / drop` 是 O-012 的活。本插件只回答
 *    「这条配不配进库」，不回答「它和库里哪条是一件事」。
 * 2. **不算寿命、不算显著度**。那是 O-010。本插件输出的正文与引文原样交给 O-010。
 * 3. **不落记忆库**。本插件**只判定**，`accept` 之后写不写、写去哪儿，由调用方决定。
 *    `seed` 这个动作尤其如此——「想法进种子文件、不进记忆库」的落点不在本插件。
 *
 * ## 为什么它不消费 `ondra-llm-gateway`
 *
 * 这道闸的全部价值在于**它不是模型**。一旦让模型来判「这句有没有出处」，
 * 就等于用一个会编造的组件去检查另一个会编造的组件。所以本插件零模型调用、
 * 零网络、零定时器，`judge()` 是同步纯函数。
 */

/** 本插件注册的服务键（连字符，非 `ondra:evidence-gate`）。全仓唯一归属。 */
export const EVIDENCE_GATE_SERVICE_KEY = 'ondra-evidence-gate'

/**
 * 引文四类来源（手册 §2.2，与 O-011 的 `EVIDENCE_SOURCES` **必须逐字一致**）。
 *
 * - `USER`：用户自己说的话；
 * - `TOOL`：机器 / 工具 / 命令的返回；
 * - `ACT`：实际发生的动作或系统事件；
 * - `SELF`：她自己写下的散文。
 *
 * **维护纪律**：改这里必须同步改 O-011 `src/types.ts` 的 `EVIDENCE_SOURCES`。
 * 两边都按「未知来源 → 丢弃该条引文」处理，所以漏同步不会崩，只会静默少认一类来源。
 */
export const EVIDENCE_SOURCES = ['USER', 'TOOL', 'ACT', 'SELF'] as const

/** 引文来源。 */
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

/**
 * 四类来源各自**许可什么**（手册 §2.2 的表，逐条落地）。
 *
 * 这张表是给人读的说明书，也是 `sources.ts` 里判定逻辑的唯一依据。
 * 放在契约层而不是实现层，是因为界面（O-092）与自检（O-077）都要能读到它。
 */
export const SOURCE_PERMITS: Readonly<Record<EvidenceSource, string>> = Object.freeze({
  USER: '用户自己的话：可以支撑「他们决定了 / 他们要求 / 他们说过」这类归功断言',
  TOOL: '机器输出：数字的权威来源',
  ACT: '被调用的动作：可以支撑「这件事做了」',
  SELF: '她自己的散文：只许可第一人称判断，永不许可关于别人的裸事实',
})

/**
 * 门控结论。
 *
 * - `accept`：四类引文齐、逐字可查、数字有出处、归属站得住 → 可入库；
 * - `strip`：同上，但**正文里没有出处的数字已被剥掉**（剥的是含该数字的分句）→ 可入库，只是短了一截；
 * - `seed`：只有 SELF 引文、说的却是别人的事 → **不进记忆库**，进种子文件等验证；
 * - `reject`：没有存活引文、或归属站不住 → 丢弃。
 *
 * `strip` 与 `accept` 分开，是为了让调用方能把这个事实记下来——
 * 「她记住的这件事少了个数字」如果没人知道，下次就会有人去怀疑 O-010 的截断逻辑。
 */
export type GateAction = 'accept' | 'strip' | 'seed' | 'reject'

/**
 * 判定原因码。**稳定**，可被界面与自检按码分支，不必匹配中文文案。
 */
export const GATE_REASON_CODES = [
  /** 正文为空。 */
  'empty-text',
  /** 一条引文都没带。 */
  'no-evidence',
  /** 带了引文，但全部被丢掉（逐字查不到 / 太短 / 来源错标）。 */
  'all-quotes-dropped',
  /** 引文短于 `minQuoteChars`，做不了证据。 */
  'quote-too-short',
  /** 引文在本轮素材里找不到（可以少标点，不可以改字）。 */
  'quote-not-verbatim',
  /** 引文标成 A 类，却只出现在 B 类素材里。 */
  'source-mismatch',
  /** 来源标记不是四类之一。 */
  'bad-source',
  /** 一条候选带的引文超过 `maxEvidence`，多出来的被裁掉。 */
  'too-many-quotes',
  /** 正文里的数字没有被允许的来源覆盖。 */
  'digit-uncovered',
  /** 剥掉无出处的数字分句之后，正文什么都不剩了。 */
  'empty-after-strip',
  /** 关于别人的断言只有 SELF / ACT 引文，没有 USER 引文。 */
  'attribution-without-user',
  /** 只有 SELF 引文，说的却是别人的事（降级为 `seed`）。 */
  'self-only-bare-fact',
  /** 正文超过 `maxTextChars`，已截断。 */
  'text-truncated',
  /** 摘要超过 `maxSummaryChars`，已截断。 */
  'summary-truncated',
  /** 这段正文早已被用户要求忘记（墓碑命中）。 */
  'tombstoned',
  /** 门控自身抛了异常（不该发生；发生了也绝不冒泡到写入路径）。 */
  'internal-error',
] as const

/** 判定原因码。 */
export type GateReasonCode = (typeof GATE_REASON_CODES)[number]

/**
 * 一条素材（被校验的原文）。
 *
 * `source` 可省略：省略时只做「能不能找到」，不做「来源对不对」。
 * 这个设计是给**没有来源标注**的调用方留的活路——例如用户手写的记忆，
 * 只有一句正文，没有 `USER` 标签。硬要求标注会把这类写入整类挡死。
 */
export interface GateMaterial {
  /** 素材原文，**不裁剪**（裁剪会毁掉引文校验）。 */
  readonly text: string
  /** 素材自身的来源标注。 */
  readonly source?: EvidenceSource
  /** 素材下标（调用方自己的编号，会原样回传）。 */
  readonly index?: number
}

/** 一条待校验的引文。 */
export interface GateEvidence {
  /** 来源标记（大小写不敏感）。 */
  readonly source: EvidenceSource | string
  /** 引文。允许标点有出入，不允许改字。 */
  readonly quote: string
  /** 调用方认为它来自第几条素材（错了不影响判定，只是少一次快速命中）。 */
  readonly materialIndex?: number
}

/** 一次门控请求。 */
export interface GateRequest {
  /** 候选正文。 */
  readonly text: string
  /** 摘要（可选；省略时用正文前若干字代替）。 */
  readonly summary?: string
  /**
   * 主体：谁的事。`user` / `self` / 具体人名。
   *
   * 省略按 `user` 处理——**这是保守方向**：把「她自己的事」误判成「用户的事」
   * 只会多要一条 USER 引文（可能被拒），反过来会把她的猜测记成用户的画像（不可逆）。
   */
  readonly subject?: string
  /** 引文列表。 */
  readonly evidence?: readonly GateEvidence[]
  /** 可校验的素材池。省略等于「无源可查」，所有引文都会被丢掉。 */
  readonly materials?: readonly GateMaterial[]
  /** 通道标记（只用于日志，不参与判定）。 */
  readonly channel?: string
  /** 判定时刻；省略取当前时刻。 */
  readonly at?: number
}

/** 存活的引文（已归一化，可直接交给 O-010 的 `FactInput.evidence`）。 */
export interface KeptEvidence {
  /** 来源。 */
  readonly source: EvidenceSource
  /** 归一化后的引文。 */
  readonly quote: string
  /** 命中的素材下标（素材数组里的位置，从 0 起）。 */
  readonly materialIndex: number
}

/** 被丢掉的引文。**丢掉的原因必须留下**，否则「为什么这条没入库」永远查不出来。 */
export interface DroppedEvidence {
  /** 原始来源标记（可能是非法值，故不锁枚举）。 */
  readonly source: string
  /** 原始引文（未归一化，便于人眼比对）。 */
  readonly quote: string
  /** 丢弃原因码。 */
  readonly code: GateReasonCode
  /** 中文说明。 */
  readonly detail: string
}

/** 一个数字游程的覆盖情况。 */
export interface DigitFinding {
  /** 数字本身（已 NFKC 归一）。 */
  readonly run: string
  /** 覆盖它的引文来源；`null` 表示没有出处。 */
  readonly coveredBy: EvidenceSource | null
}

/** 一条判定原因（可能同时有多条：既剥了数字，又截了长度）。 */
export interface GateReason {
  /** 原因码。 */
  readonly code: GateReasonCode
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 判定结果。**纯数据，不含任何函数**，便于落日志与跨进程传。 */
export interface GateVerdict {
  /** 结论。 */
  readonly action: GateAction
  /** 处理后的正文（可能被剥了分句、被截断）。 */
  readonly text: string
  /** 处理后的摘要。 */
  readonly summary: string
  /** 存活引文。 */
  readonly evidence: readonly KeptEvidence[]
  /** 被丢引文。 */
  readonly dropped: readonly DroppedEvidence[]
  /** 数字覆盖情况。 */
  readonly digits: readonly DigitFinding[]
  /** 原因（按发生顺序）。 */
  readonly reasons: readonly GateReason[]
  /** 正文或摘要是否被截断过。 */
  readonly truncated: boolean
}

/** 定位结果（给调试与界面用）。 */
export interface LocateHit {
  /** 命中的素材下标。 */
  readonly materialIndex: number
  /** 该素材的来源标注（可能没有）。 */
  readonly source?: EvidenceSource
}

/** 不可用原因。本插件只有一个：被关掉了。 */
export type GateUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，进程重启归零；要持久审计请读 `evidence_gate_log`）。 */
export interface GateCounters {
  /** 判定次数。 */
  readonly decisions: number
  /** 各结论的次数。 */
  readonly byAction: Readonly<Record<GateAction, number>>
  /** 累计存活引文数。 */
  readonly quotesKept: number
  /** 累计被丢引文数。 */
  readonly quotesDropped: number
  /** 累计被剥掉的数字个数。 */
  readonly digitsStripped: number
  /** 累计因墓碑命中被拒的次数。 */
  readonly tombstoned: number
}

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface GateStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GateUnavailableReason
  /** 记忆内核是否在位（在位才有墓碑闸）。 */
  readonly coreAvailable: boolean
  /**
   * 墓碑闸的形态：`service` 走 O-010 的 `tombstoned()`；`absent` 表示内核缺席，
   * **这道闸没跑**——如实报出来，不假装查过。
   */
  readonly tombstoneGate: 'service' | 'absent'
  /** 决策日志是否可写。 */
  readonly logging: boolean
  /** 决策日志行数。 */
  readonly logRows: number
  /** 累计计数。 */
  readonly counters: GateCounters
  /** 最近一次内部错误（没有则省略）。 */
  readonly lastError?: string
}

/** 证据门控服务。 */
export interface EvidenceGateService {
  /** 是否可用（`enable=false` 时不可用；本插件没有别的不可用原因）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GateUnavailableReason

  /**
   * 判定一条候选。**同步、纯判定、不写库、不抛错**。
   *
   * 不抛错是硬承诺：它站在写入路径上，抛一个异常等于「她刚才那句话没记住」，
   * 而真因可能只是一条引文格式不对。内部异常一律转成 `reject` + `internal-error`。
   * @param request 请求。
   */
  judge(request: GateRequest): GateVerdict
  /**
   * 批量判定。**不做批内判重**（那是 O-012 的活），只逐条判定并累计计数。
   * @param requests 请求列表。
   */
  judgeAll(requests: readonly GateRequest[]): readonly GateVerdict[]
  /**
   * 只做逐字定位，不判定。给界面「这句话到底出自哪里」用。
   * @param quote 引文。
   * @param materials 素材池。
   */
  locate(quote: string, materials: readonly GateMaterial[]): LocateHit | undefined
  /** 统计快照。 */
  stats(): GateStats
}

/** 日志门面的最小形状（Cordis Logger 的结构对位子集）。 */
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/**
 * O-010 记忆内核的结构对位子集。
 *
 * **只镜像本插件真正调用的一个成员**：`tombstoned()`。
 * 镜像得越少，漂移面越小——本插件不写库、不读记录、不算寿命，
 * 所以没有理由把 `MemoryCoreService` 整个抄过来。
 */
export interface MemoryCoreLike {
  readonly available: boolean
  tombstoned(text: string): boolean
}

/* ------------------------------------------------------------------ *
 * 上游存储端口的结构对位（不 import O-006 / O-007 源码）
 *
 * 只镜像本插件用到的 7 个成员：建表、写一行、读几行、删几行、计数。
 * 不用 `raw`（原始 SQL 面）——一旦用上自定义 SQL，本插件就绑死 SQLite，
 * 而审计日志这种东西在内存后端也该能跑。
 * ------------------------------------------------------------------ */

/** 列类型（与 O-006 的 `ColumnType` 一致）。 */
export type ColumnTypeLike = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明。 */
export interface ColumnSpecLike {
  readonly name: string
  readonly type: ColumnTypeLike
  readonly notNull?: boolean
  readonly primaryKey?: boolean
  readonly default?: string
}

/** 索引声明。 */
export interface IndexSpecLike {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique?: boolean
}

/** 表声明。 */
export interface TableSpecLike {
  readonly name: string
  readonly columns: readonly ColumnSpecLike[]
  readonly indexes?: readonly IndexSpecLike[]
  readonly strict?: boolean
}

/** 建表结果（只用到 `issues`）。 */
export interface EnsureResultLike {
  readonly table: string
  readonly created: boolean
  readonly addedColumns: readonly string[]
  readonly createdIndexes: readonly string[]
  readonly issues: readonly {
    readonly code: string
    readonly table: string
    readonly column?: string
    readonly detail: string
  }[]
}

/** 一行数据。 */
export type RowLike = Record<string, unknown>

/** 过滤算子。 */
export type FilterOpLike = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'

/** 过滤条件。 */
export interface FilterLike {
  readonly column: string
  readonly op: FilterOpLike
  readonly value?: unknown
}

/** 查询条件。 */
export interface SelectQueryLike {
  readonly where?: readonly FilterLike[]
  readonly orderBy?: readonly { readonly column: string; readonly direction?: 'asc' | 'desc' }[]
  readonly limit?: number
  readonly offset?: number
}

/** 存储端口的结构对位子集。 */
export interface StoreLike {
  /** 后端标识。 */
  readonly provider: string
  /** 端口状态。 */
  readonly state: string
  ensureTable(spec: TableSpecLike): EnsureResultLike
  insert(table: string, row: RowLike): void
  delete(table: string, key: RowLike): number
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
}
