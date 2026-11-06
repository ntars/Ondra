/**
 * O-144 `ondra-reflex` 的对外契约：**反射弧自写 + 链路结晶**（手册 §8.6）。
 *
 * 手册原文：「反射弧与链路结晶（O-144）：同工具×同因失败 3 次→自动写
 * `R-auto-<cause>-<tool>`；跨器官 ≥3 步成功链固化为 skill；全部零模型调用。」
 *
 * ## 这一条的全部价值在最后四个字
 *
 * 「零模型调用」不是省钱的补充说明，是**这套学习为什么能不失控**的原因：
 * 每一次成型都能指着一条计数说「因为这条链走了三遍」，不需要解释一个概率，
 * 也不会因为某次模型抽风就长出一条怪规则。
 *
 * ## 三样东西本包刻意不自己定义
 *
 * 1. **八类归因**：`cause` 一律取 O-139 `ondra-failure-attrib` 的 `classify()` 返回值。
 *    本包**不枚举那八个字符串**——两套类目最坏的结果不是不一致，而是同一次失败
 *    在两个账上记成两类，然后两边各自长出一条互相矛盾的规则。
 * 2. **处方文字**：`hint` 直接引用 O-139 的 `prescription()`。反射只说「什么时候该有这条规则」，
 *    不说「该怎么办」——后者的真源在 O-139，抄一份就是第二个真源。
 * 3. **伤口与 chronic**：本包只读 `woundOf()`，不记伤口、不扫 chronic。
 *
 * ## 一条命名冲突，必须在这里说清
 *
 * 手册写的是 `R-auto-<cause>-<tool>`，而手册 §8.4 要求键名匹配 `^[a-z][a-z0-9_-]{1,63}$`。
 * 两句话直接冲突：`R-auto-…` 以大写开头，**过不了**那条正则。
 *
 * 处理方式：两者都留，各归其位。
 * - `id` = `R-auto-<cause>-<tool>`，**手册逐字**，给人看、给日志看、给界面看；
 * - `key` = `r-auto-<cause>-<slug>`，**过得了 §8.4**，凡是要当键用的地方（将来注册成
 *   skill 名、写进配置、当表主键）一律用它。
 *
 * 这不是折中，是两边都必须成立：把 id 改成小写就违背了手册的形状；把 key 写成大写
 * 就会在模型侧被拒。留一个 `keySafe` 字段把这件事**显式化**，比藏起来好。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const REFLEX_SERVICE_KEY = 'ondra-reflex'

/** 手册逐字的前缀（大写 R，故意不合 §8.4，只作展示 id 用）。 */
export const REFLEX_PREFIX = 'R-auto-'

/** 用作 key 时的小写前缀。 */
export const REFLEX_KEY_PREFIX = 'r-auto-'

/** 键名 / slug 的唯一合法形状（手册 §8.4）。 */
export const KEY_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 一条自动写出来的反射。 */
export interface ReflexRule {
  /** 展示 id：`R-auto-<cause>-<tool>`（**手册逐字**）。 */
  readonly id: string
  /** 键名：`r-auto-<cause>-<slug>`（过 §8.4，可当键用）。 */
  readonly key: string
  /** `key` 是否与 `id` 只差大小写（即工具名里没有被替换掉的字符）。 */
  readonly keySafe: boolean
  /** 归因（取值来自 O-139，本包不枚举）。 */
  readonly cause: string
  /** 工具名（原样，未归一化）。 */
  readonly tool: string
  /** 同工具×同因累计失败了几次。 */
  readonly hits: number
  /** 第一次失败的刻。 */
  readonly firstAt: number
  /** 最近一次失败的刻。 */
  readonly lastAt: number
  /** 处方一句话。**来自 O-139 的 `prescription()`**；取不到时为空串。 */
  readonly hint: string
  /** `hint` 的来源。`none` 表示 O-139 没给（不能编，所以留空）。 */
  readonly hintSource: 'attrib' | 'none'
}

/** 一条走完的成功链。 */
export interface ChainSummary {
  /** 依次调用的工具名（原样）。 */
  readonly tools: readonly string[]
  /** 起点。 */
  readonly startedAt: number
  /** 终点（最后一步的时刻）。 */
  readonly lastAt: number
}

/** 一条结晶出来的 skill 候选。 */
export interface SkillCandidate {
  /** 候选名：`chain-<8 位十六进制>`（过 §8.4）。 */
  readonly slug: string
  /** 链签名：工具名按顺序用 `>` 连起来（截到 `signature-steps` 步）。 */
  readonly signature: string
  /** 签名对应的工具序列（原样）。 */
  readonly steps: readonly string[]
  /** 这条链被走过几次。 */
  readonly repeats: number
  /** 跨了几个器官（= 不同工具数）。 */
  readonly organs: number
  /** 第一次走通的刻。 */
  readonly firstAt: number
  /** 最近一次走通的刻。 */
  readonly lastAt: number
}

/** 不可用原因。 */
export type ReflexReason =
  /** 总开关关着。 */
  | 'disabled'
  /** O-139 缺席：不知道原因就不写反射（绝不把「不知道」当成 `unknown` 类）。 */
  | 'no-attrib'

/** 累计统计。 */
export interface ReflexStats {
  readonly at: number
  readonly available: boolean
  readonly reason?: ReflexReason
  /** 收到多少个工具结果。 */
  readonly results: number
  /** 成功 / 失败。 */
  readonly successes: number
  readonly failures: number
  /** 没有工具名的结果数（不猜）。 */
  readonly unnamed: number
  /** 判不出原因的结果数（O-139 缺席或抛错）。**与 `unknown` 类无关**。 */
  readonly unclassified: number
  /**
   * 形状反常的结果数：是个对象，但既没有布尔 `isError` 也没有 `error`。
   *
   * 与 O-139 同口径仍按成功处理（上游成功时不一定会带 `isError: false`），
   * 但这个数单独露出来——否则「一串凭空的成功步」与「真的一串成功」长得一样。
   */
  readonly unshaped: number
  /** 写出来的反射条数。 */
  readonly rules: number
  /** 因达到阈值而新写出来的反射条数。 */
  readonly formed: number
  /** 因为是新规则但账本已满而被拒收的次数。 */
  readonly refusedRules: number
  /** 走完的链条数（不管够不够格）。 */
  readonly chains: number
  /** 步数不够 / 只跨一个器官 / 首见（还没重复够）而被跳过的链。 */
  readonly shortChains: number
  readonly singleOrgan: number
  readonly firstSight: number
  /** 结晶出来的候选条数。 */
  readonly candidates: number
  /** 因候选上限被拒的新候选数。 */
  readonly candidateRefused: number
  /** 没有 agent 归属、无法归链的成功步数。 */
  readonly orphanSteps: number
  /** 落盘失败次数 / 读回的坏行数。 */
  readonly storeErrors: number
  readonly badRows: number
  /** 状态是否落盘（重启后还能接着数）。 */
  readonly persisted: boolean
}

/** 对外服务。 */
export interface ReflexService {
  readonly available: boolean
  readonly reason?: ReflexReason

  /** 全部反射（新的在前）。 */
  rules(): readonly ReflexRule[]
  /** 某一条反射。 */
  ruleOf(tool: string, cause: string): ReflexRule | undefined
  /** 全部 skill 候选（重复次数多的在前）。 */
  candidates(): readonly SkillCandidate[]

  /**
   * 手动喂一个工具结果。正常路径由 `tools/result` 事件驱动；这个方法给自检与审计用。
   * @param execution 上游 `ToolExecution` 子集。
   * @param result 上游 `ToolExecutionResult` 子集。
   */
  observe(execution: unknown, result: unknown): void

  /** 统计。 */
  stats(): ReflexStats
  /** 卸载：清账本。幂等。 */
  dispose(): void
}

/* ------------------------------------------------------------------ *
 * 上游与同仓形状的结构对位（一律不 import，§3.3-1）
 * ------------------------------------------------------------------ */

/** 上游 `ToolErrorInfo` 的子集。 */
export interface ToolErrorInfoLike {
  readonly name?: string
  readonly code?: string
  readonly reason?: string
}

/** 上游 `ToolFailure` 的子集。 */
export interface ToolFailureLike {
  readonly message?: string
  readonly info?: ToolErrorInfoLike
}

/** 上游 `ToolResultLike`。判别只看 `isError`。 */
export interface ToolResultLike {
  readonly isError?: boolean
  readonly error?: ToolFailureLike
}

/** 上游 `ToolExecution` 的子集。 */
export interface ToolExecutionLike {
  readonly name?: string
  readonly agent?: unknown
}

/**
 * O-139 `ondra-failure-attrib` 的结构对位子集。
 *
 * **只要三个方法**：`classify`（拿类目）、`prescription`（拿处方文字）、
 * `woundOf`（读已累计的次数）。不调 `noteFailure` / `noteSuccess`——
 * 记账是 O-139 的事，本包再记一次就是第二本账。
 */
export interface AttribLike {
  readonly available: boolean
  classify(input: { readonly tool: string; readonly code?: string; readonly message?: string }): { readonly cause: string }
  prescription(cause: string): { readonly hint: string } | undefined
  woundOf(tool: string): { readonly byCause?: Readonly<Record<string, number>> } | undefined
}

/** 日志形状（Cordis logger 的子集）。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-001 身份服务的形状（只取日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 的字段声明形状（只取本包用到的成员）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
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

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 一行数据（O-006 的 `Row`）。 */
export type StoreRow = Record<string, unknown>

/** 列声明（O-006 的 `ColumnSpec` 子集）。 */
export interface StoreColumnLike {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'
  readonly notNull?: boolean
  readonly primaryKey?: boolean
  readonly default?: string
}

/** 表声明（O-006 的 `TableSpec` 子集）。 */
export interface StoreTableLike {
  readonly name: string
  readonly columns: readonly StoreColumnLike[]
  readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[]; readonly unique?: boolean }[]
  readonly strict?: boolean
}

/** 查询（O-006 的 `SelectQuery` 子集）。 */
export interface StoreQueryLike {
  readonly where?: readonly { readonly column: string; readonly op: 'eq'; readonly value?: unknown }[]
  readonly orderBy?: readonly { readonly column: string; readonly direction?: 'asc' | 'desc' }[]
  readonly limit?: number
}

/** O-006 `ondra-store-sqlite` 的结构对位子集。 */
export interface StorePortLike {
  readonly state: 'open' | 'degraded' | 'closed'
  ensureTable(spec: StoreTableLike): { readonly table: string; readonly created: boolean }
  upsert(table: string, row: StoreRow): void
  select(table: string, query?: StoreQueryLike): StoreRow[]
  transaction<T>(fn: () => T): T
}
