/**
 * O-103 `ondra-forget-right` 的对外契约：**一次说清「要忘掉的东西散落在哪十一处」**。
 *
 * ## 这个插件要解决的不是「怎么删」，而是「删完之后还剩什么」
 *
 * 「被遗忘权」听起来是一个动作，实际是一张**清算清单**。一条记忆的正文在 O-010，
 * 钉子副本在 O-017，图边在 O-015，向量在 O-122，待办里可能又写了一遍（O-021），
 * 时间胶囊里可能封着同一件事（O-101），日记（O-045）与叙事日志（O-135）里
 * 各自留着一份摘录，而**数据库快照（O-009）里整份旧库还在**。
 *
 * 只删 O-010 那一行，用户点完「忘记」之后，其余八处全部还留着。
 * 那不是「忘了」，那是「说忘了其实没忘」——本插件存在的唯一理由就是拦住这件事。
 *
 * ## 十一面清算表（每面都要如实报「能不能删」）
 *
 * | 面 | 真源 | 上限能力 |
 * |---|---|---|
 * | `memory-fact` | O-010 正文 | **真删** |
 * | `memory-pin` | O-017 钉子 | **真删**（随 `forget()` 连带） |
 * | `memory-edge` | O-015 图边 | **真删**（随 `forget()` 连带） |
 * | `memory-vector` | O-122 向量 | **真删**（按 id `remove()`） |
 * | `todo` | O-021 待办 | **真删**（`dropTodo(id)`） |
 * | `promise` | O-021 承诺行 | **删不了**（契约里没有删承诺的方法，只有 `expire()` 转状态） |
 * | `capsule` | O-101 时间胶囊 | **真删**（仅未开封） |
 * | `lexicon` | O-137 台词样本 | **只能整份清空**（无按条删除入口） |
 * | `diary` | O-045 日记 | **删不了**（Markdown 一天一篇，无删除方法） |
 * | `trace` | O-135 叙事日志 | **删不了**（`prune()` 只按保留期） |
 * | `snapshot` | O-009 快照 | **不代删**（删快照是不可逆且归 O-009） |
 *
 * 后三面**不是漏实现**，是把「删不掉」如实写在纸上。给它们各编一个「已清除」的
 * 假回执，就等于把用户最需要看见的东西盖起来（§17-6 禁假开关的同一条道理）。
 *
 * ## 三条不可让的纪律
 *
 * 1. **两阶段**：`plan()` 只读、只出清单；`execute()` 必须带 `{ confirm: 'forget' }`。
 *    没有确认令牌的删除入口，迟早会被某个循环顺手调用一次。
 * 2. **先清下游、后删真源。** 反序的话，真源一没，id 列表就再也拼不出来，
 *    下游那七处永远清不掉，而日志里全是「已完成」。
 * 3. **任何一面失败都让 `complete = false`。** 「九面成功一面失败」不许报成成功——
 *    被遗忘权只有全对与没做到两种结果，中间那档叫「还以为删干净了」。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（master-plan §15.5 / 18.5），全部结构对位镜像。
 * 本插件**不直连任何数据表**：每一面都只调上游的公开方法，删不掉就如实标 `blind`。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const FORGET_RIGHT_SERVICE_KEY = 'ondra-forget-right'

/**
 * 清算面 id。闭集，**只用这十一面**。
 *
 * 加一面必须同时回答三件事：真源是谁、它有没有删除入口、删不掉时怎么报。
 * 答不全就不加——**宁可少报一面，不编一条「已清除」**。
 */
export const SURFACE_IDS = [
  /** O-010 记忆正文（真源）。 */
  'memory-fact',
  /** O-017 钉子副本。 */
  'memory-pin',
  /** O-015 图边（含孤儿边）。 */
  'memory-edge',
  /** O-122 向量索引。 */
  'memory-vector',
  /** O-021 待办（`dropTodo()` 可删）。 */
  'todo',
  /** O-021 承诺行（**无删除入口**，`expire()` 只转状态）。 */
  'promise',
  /** O-101 未开封的时间胶囊。 */
  'capsule',
  /** O-137 语感样本（存真人原话）。 */
  'lexicon',
  /** O-045 每日日记。 */
  'diary',
  /** O-135 回复决策日志（含脱敏摘录）。 */
  'trace',
  /** O-009 数据库快照（整份旧库）。 */
  'snapshot',
] as const

/** 一个清算面 id。 */
export type SurfaceId = (typeof SURFACE_IDS)[number]

/**
 * 能力上限（静态，来自上游**当前源码**的公开方法集）。
 *
 * `erase` 与 `erase-all` 必须分开：前者能只删这一条，后者只能把整份清掉。
 * 混成一档的话，「清空全部台词样本」会被渲染成「已忘记这个人」——
 * 那句话是假的，因为它连别人说的话一起清了，而且没清干净的部分照样写着。
 */
export const CAPABILITIES = [
  /** 能按条真删。 */
  'erase',
  /** 只能整份清空（没有按条入口）。 */
  'erase-all',
  /** 只能登记待办 / 打标记，数据还在。 */
  'stage',
  /** 完全没有删除入口（读得到、删不掉）。 */
  'blind',
  /** 上游未装载，这一面根本动不了（运行时降级档，见 `effectiveCapability`）。 */
  'absent',
] as const

/** 能力档位。 */
export type Capability = (typeof CAPABILITIES)[number]

/**
 * 运行时处置状态。
 *
 * `absent`（上游没装载）与 `blind`（装载了但删不掉）**必须分开**：
 * 前者装个插件就好，后者装多少插件都没用。混成一档，用户会白折腾半天。
 */
export const SCRUB_STATUSES = ['done', 'partial', 'skipped', 'failed', 'absent', 'blind'] as const

/** 处置状态。 */
export type ScrubStatus = (typeof SCRUB_STATUSES)[number]

/** 目标种类。 */
export const TARGET_KINDS = [
  /** 按记忆 id 删（最精确）。 */
  'fact',
  /** 按主体名删（删掉所有 `subject` 等于它的记忆）。 */
  'subject',
  /** 清空时间胶囊（未开封的那部分）。 */
  'capsule',
  /** 清空待办。 */
  'todo',
] as const

/** 目标种类。 */
export type TargetKind = (typeof TARGET_KINDS)[number]

/** 一个清算面的静态说明书（不含运行时数值）。 */
export interface SurfaceSpec {
  /** 面 id。 */
  readonly id: SurfaceId
  /** 中文名。 */
  readonly zh: string
  /** 提供方服务键；无真源时为空串。 */
  readonly service: string
  /** 用到的上游方法（**写清方法名，方便核对**）。 */
  readonly method: string
  /** 静态能力上限。 */
  readonly maxCapability: Capability
  /** 一句话说明这一面能不能删、为什么。 */
  readonly doc: string
}

/**
 * 十一面说明书。**顺序即清算顺序**（见 `SCRUB_ORDER` 的反向说明）。
 *
 * 顺序刻意按「下游 → 真源」排：`memory-fact` 在倒数第三（后面只剩三面彻底删不掉的），
 * 因为它是 id 的唯一来源。
 */
export const SURFACE_SPECS: readonly SurfaceSpec[] = Object.freeze([
  {
    id: 'todo',
    zh: '待办',
    service: 'ondra-memory-prospective',
    method: 'listTodos() / dropTodo(id)',
    maxCapability: 'erase',
    doc: '待办**不写记忆**（O-021 的分界线），所以它存的是独立一份原文。`dropTodo()` 能按条真删。',
  },
  {
    id: 'capsule',
    zh: '时间胶囊',
    service: 'ondra-time-capsule',
    method: 'list() / drop(id, { confirm: "drop" })',
    maxCapability: 'erase',
    doc: '未开封的胶囊里可能封着同一件事。**已开封的删不掉**——正文早已搬进记忆库，删它等于删记忆，而记忆另有一面在管。',
  },
  {
    id: 'memory-edge',
    zh: '记忆图边',
    service: 'ondra-memory-graph',
    method: 'forgetOf(id)',
    maxCapability: 'erase',
    doc: '指向被删记忆的边不清掉，会变成孤儿边继续参与扩散——检索会顺着一条指向空处的边走过去。',
  },
  {
    id: 'memory-vector',
    zh: '向量索引',
    service: 'ondra-memory-vector',
    method: 'remove(id)',
    maxCapability: 'erase',
    doc: '向量是按记忆 id 建的，所以能按 id 精确移除。**没有向量分支时这一面自动变成 `absent`**，不必处理。',
  },
  {
    id: 'memory-pin',
    zh: '记忆钉子',
    service: 'ondra-memory-audit',
    method: 'unpin(id) / forget(id, reason)',
    maxCapability: 'erase',
    doc: '钉住的记忆每轮都进注入。钉子不拔，被删的记忆仍会以「钉子指向空 id」的形态留在注入段里。',
  },
  {
    id: 'memory-fact',
    zh: '记忆正文',
    service: 'ondra-memory-core',
    method: 'forget(id, reason)',
    maxCapability: 'erase',
    doc: '**唯一真源**。它必须**在下游清完之后**才删：id 列表靠它拼出来，先删就再也拿不到清单。',
  },
  {
    id: 'promise',
    zh: '承诺行',
    service: 'ondra-memory-prospective',
    method: 'listOpen() / promiseOf(id)',
    maxCapability: 'blind',
    doc: '**`ProspectiveService` 里没有任何删承诺的方法**——只有 `expire()` 把状态转成 `expired`，原文 `text` 仍在表里。本插件只**数得出来**还剩几条，不假装删掉了。',
  },
  {
    id: 'lexicon',
    zh: '语感样本',
    service: 'ondra-lexicon',
    method: 'reset()',
    maxCapability: 'erase-all',
    doc: '存的是真人原话（`LexiconSample.text`）。**上游没有按条删除入口**，只有 `reset()` 整份清。清一次会连别人说的话一起清掉，所以默认不动，只报「未处理」。',
  },
  {
    id: 'diary',
    zh: '每日日记',
    service: 'ondra-diary',
    method: '—',
    maxCapability: 'blind',
    doc: '一天一篇 Markdown，`DiaryService` 里没有删除方法。本插件**不代删文件**：那是绕过服务边界。要删得由人在文件系统里自己删。',
  },
  {
    id: 'trace',
    zh: '回复决策日志',
    service: 'ondra-narrative-log',
    method: 'prune()',
    maxCapability: 'blind',
    doc: '`excerpt` 存着她当时说出口的那一段（已脱敏、已截断）。`prune()` 只按保留期清整天文件，**没有按 id 或按内容删除的入口**，且会连带删掉无关条目。',
  },
  {
    id: 'snapshot',
    zh: '数据库快照',
    service: 'ondra-snapshot',
    method: 'list()',
    maxCapability: 'blind',
    doc: '**最容易被漏掉的一面**：`VACUUM INTO` 做的是整份库副本，用户点完「忘记」之后，旧快照里那条记忆一个字都没少。本插件**不代调 `prune()`**——删快照不可逆，且是 O-009 的地盘。',
  },
] as const)

/**
 * 清算顺序：**下游在前、真源在中间、删不掉的在最后**。
 *
 * 理由只有一条，但很硬：`memory-fact` 是 id 列表的唯一来源。
 * 先删它，后面所有面都拿不到该删哪些 id，只能整面跳过——
 * 而跳过在报告里长得像「本来就没什么要删」。
 *
 * 后四面（`promise` / `lexicon` / `diary` / `trace` / `snapshot`）排在真源之后：
 * 它们反正不写数据，只需要**数一遍**还剩多少，放最后恰好是「删完之后再看一眼」。
 *
 * 刻意**不做成配置项**：调顺序的开关，一定能调出一个删不干净的顺序。
 */
export const SCRUB_ORDER: readonly SurfaceId[] = Object.freeze([
  'todo',
  'capsule',
  'memory-edge',
  'memory-vector',
  'memory-pin',
  'memory-fact',
  'promise',
  'lexicon',
  'diary',
  'trace',
  'snapshot',
] as const)

/** 一个目标。 */
export interface ForgetTarget {
  /** 种类。 */
  readonly kind: TargetKind
  /** `fact` / `subject` / `todo` 用：记忆 id 列表或主体名。 */
  readonly values: readonly string[]
  /** 人话原因（写进墓碑，也是报告里给用户看的那句）。 */
  readonly reason: string
}

/** 一个目标解析后的结果（含要删的 id 与来源说明）。 */
export interface ResolvedTarget {
  /** 种类。 */
  readonly kind: TargetKind
  /** 真正要删的记忆 id（已去重、已排序）。 */
  readonly ids: readonly string[]
  /** 解析不到任何 id 时的中文说明。 */
  readonly note: string
  /** 是否解析出了东西。 */
  readonly hit: boolean
}

/** 一面在计划里的样子。 */
export interface PlannedScrub {
  /** 面 id。 */
  readonly surface: SurfaceId
  /** 中文名。 */
  readonly zh: string
  /** 运行时能力（受上游在位影响）。 */
  readonly capability: Capability
  /** 打算动几条；`blind` / `absent` 面恒为 0。 */
  readonly targets: number
  /** 打算做什么（人话）。 */
  readonly intent: string
  /** 这一面**不会**被处理时的原因。 */
  readonly blockedBecause?: string
}

/** 一份计划。**只读产物，不动任何数据。** */
export interface ForgetPlan {
  /** 目标（回显，便于人核对）。 */
  readonly target: ForgetTarget
  /** 解析结果。 */
  readonly resolved: ResolvedTarget
  /** 十一面逐个说明（按 `SCRUB_ORDER`）。 */
  readonly scrubs: readonly PlannedScrub[]
  /** 会真删几面。 */
  readonly erasable: number
  /** 删不掉或不动几面。 */
  readonly residual: number
  /** 一句人话总结。 */
  readonly summary: string
  /** 给人看的不可逆警示（**执行前必须显示**）。 */
  readonly warning: string
}

/** 一面的执行结果。 */
export interface ScrubOutcome {
  /** 面 id。 */
  readonly surface: SurfaceId
  /** 中文名。 */
  readonly zh: string
  /** 处置状态。 */
  readonly status: ScrubStatus
  /** 实际动了几条。 */
  readonly affected: number
  /** 失败或跳过的人话原因。 */
  readonly detail: string
}

/** 一次执行的完整结果。 */
export interface ForgetRun {
  /** 本次执行 id（内存内唯一，用于日志对账）。 */
  readonly runId: string
  /** 目标。 */
  readonly target: ForgetTarget
  /** 十一面结果（按 `SCRUB_ORDER`）。 */
  readonly outcomes: readonly ScrubOutcome[]
  /** 是否**全部该删的都删掉了**。任何一面 `failed` 或该 `done` 的没 `done` 即为 false。 */
  readonly complete: boolean
  /** 真删成功的面数。 */
  readonly erasedSurfaces: number
  /** 删掉的总条数。 */
  readonly erasedItems: number
  /** 仍留着残余的面（**这是本插件最重要的输出**）。 */
  readonly residue: readonly SurfaceId[]
  /** 一句人话总结。 */
  readonly summary: string
  /** 执行时刻。 */
  readonly at: number
}

/** 残余扫描结果。 */
export interface ResidueReport {
  /** 逐面残余情况。 */
  readonly rows: readonly ResidueRow[]
  /** 仍有残余的面数。 */
  readonly residual: number
  /** 一句人话总结。 */
  readonly summary: string
}

/** 一面的残余情况。 */
export interface ResidueRow {
  /** 面 id。 */
  readonly surface: SurfaceId
  /** 中文名。 */
  readonly zh: string
  /** 这一面还剩多少条。`null` = 数不出来（**不用 0 顶替**）。 */
  readonly remaining: number | null
  /** 能不能数出来。 */
  readonly countable: boolean
  /** 人话说明。 */
  readonly note: string
}

/** 服务错误码。闭集。 */
export const FORGET_ERROR_CODES = [
  /** 配置关掉。 */
  'disabled',
  /** 目标为空或格式不对。 */
  'bad-target',
  /** 一条都没解析出来。 */
  'nothing-to-forget',
  /** 缺确认令牌。 */
  'confirm-required',
  /** 真源（O-010）不在位，删不了。 */
  'no-core',
] as const

/** 错误码。 */
export type ForgetErrorCode = (typeof FORGET_ERROR_CODES)[number]

/** 服务错误。 */
export class ForgetRightError extends Error {
  /** 错误码。 */
  readonly code: ForgetErrorCode

  /**
   * @param code 错误码。
   * @param detail 人话说明。
   */
  constructor(code: ForgetErrorCode, detail: string) {
    super(detail)
    this.name = 'ForgetRightError'
    this.code = code
  }
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type ForgetUnavailableReason = 'disabled'

/** 统计快照。**只在内存**，不落盘（落盘本身就是残留，见 README 隔离五问 2）。 */
export interface ForgetStats {
  /** 计划过几次。 */
  readonly planned: number
  /** 执行过几次。 */
  readonly executed: number
  /** 因缺确认令牌被拒几次。 */
  readonly refused: number
  /** 逐面累计删掉的条数（按面统计，便于发现「哪一面从来没删掉过东西」）。 */
  readonly erasedBySurface: Readonly<Record<string, number>>
  /** 累计失败的面数。 */
  readonly failedSurfaces: number
}

/** 本插件的对外服务。 */
export interface ForgetRightService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ForgetUnavailableReason

  /** 十一面说明书（静态，不含数值）。 */
  surfaces(): readonly SurfaceSpec[]

  /**
   * 出计划。**只读，不动任何数据。**
   * @param target 目标。
   * @param at 时刻，省略取现在。
   */
  plan(target: ForgetTarget, at?: number): ForgetPlan

  /**
   * 执行。**必须传 `{ confirm: 'forget' }`**，否则抛 `confirm-required`。
   *
   * 接受计划而不是目标：让「人看过的清单」与「实际执行的清单」是同一份。
   * 重新按目标算一遍，中间库里变了，人批的就不是这件事了。
   * @param plan 计划（必须来自 `plan()`）。
   * @param confirmation 二次确认。
   */
  execute(plan: ForgetPlan, confirmation: { readonly confirm: 'forget' }): ForgetRun

  /**
   * 残余扫描：现在还有哪几面留着东西。
   *
   * **不传目标就扫全量**（每面总数）；传了目标就只算跟它相关的。
   * @param target 目标，可省略。
   * @param at 时刻。
   */
  residue(target?: ForgetTarget, at?: number): ResidueReport

  /** 统计快照。 */
  stats(): ForgetStats
}

/* ------------------------------------------------------------------ *
 * 上游结构对位（§18.5：不 import 任何 ondra-* 源码，只声明用到的成员）
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

/** O-003 时钟服务的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** O-010 记忆内核的结构对位子集。**只镜像本插件真正调用的成员。** */
export interface MemoryCoreLike {
  readonly available: boolean
  /** 条件查询（用来按主体名找 id）。 */
  listFacts(query?: {
    readonly state?: string
    readonly subject?: string
    readonly ids?: readonly string[]
    readonly limit?: number
  }): readonly { readonly id: string; readonly subject: string | null }[]
  /** 条件计数。 */
  countFacts(query?: {
    readonly state?: string
    readonly subject?: string
    readonly ids?: readonly string[]
  }): number
  /** 真删并写墓碑。 */
  forget(id: string, reason: string): boolean
  /** 按 id 取一条（判存在）。 */
  getFact(id: string): { readonly id: string } | undefined
}

/** O-017 遗忘审计的结构对位子集。`forget()` 是**唯一执行口**（台账原话）。 */
export interface AuditLike {
  readonly available: boolean
  /** 真删 + 清钉子 + 清孤儿边，一次做完。 */
  forget(
    id: string,
    reason: string,
  ): {
    readonly forgotten: boolean
    readonly pinRemoved: boolean
    readonly edgesRemoved: number
    readonly edgesCleared: boolean
  }
  /** 拔钉。 */
  unpin(id: string): boolean
  /** 是否被钉住。 */
  isPinned(id: string): boolean
  /** 全部钉子（数得出来「还有几条指着空 id」）。 */
  pinned(): readonly { readonly id: string }[]
}

/** O-015 记忆图谱的结构对位子集。 */
export interface GraphLike {
  readonly available: boolean
  /** 记忆被删之后清边。 */
  forgetOf(id: string): number
}

/** O-122 向量索引的结构对位子集。 */
export interface VectorLike {
  readonly available: boolean
  /** 按 id 移除。 */
  remove(id: string): void
  /** 索引内文档数。 */
  count(): number
}

/** O-021 承诺与待办的结构对位子集。 */
export interface ProspectiveLike {
  readonly available: boolean
  /**
   * 未结算的承诺。**上游返回的是 `ReminderItem[]`**（`{ promise, urgency, ... }`），
   * 本插件只需要 `promise.factId`——承诺与记忆的关联键就在那里。
   */
  listOpen?(): readonly {
    readonly promise: { readonly id: string; readonly factId: string; readonly state: string }
  }[]
  /** 未完成的待办。 */
  listTodos?(): readonly { readonly id: string; readonly text: string; readonly done: boolean }[]
  /** 按条删待办。**删承诺没有对应方法**（只有 `expire()` 转状态）。 */
  dropTodo(id: string): boolean
}

/** O-101 时间胶囊的结构对位子集。 */
export interface CapsuleLike {
  readonly available: boolean
  /** 全部胶囊（已开封的 `text` 恒为 null）。 */
  list(at?: number): readonly {
    readonly id: string
    readonly title: string
    readonly state: string
    readonly openedAt: number
  }[]
  /** 删未开封的胶囊。 */
  drop(id: string, confirmation: { readonly confirm: 'drop' }): boolean
}

/** O-137 语感样本的结构对位子集。 */
export interface LexiconLike {
  /** 整份清空（**上游没有按条删除入口**）。 */
  reset(): void
  /** 样本条数。 */
  stats(): { readonly samples: number }
}

/** O-045 日记的结构对位子集。**只读，没有删除方法**（这一面注定是 `blind`）。 */
export interface DiaryLike {
  readonly available: boolean
  /** 最近的几篇。 */
  list(limit?: number): readonly { readonly dayKey?: string; readonly path?: string }[]
}

/** O-135 叙事日志的结构对位子集。 */
export interface NarrativeLogLike {
  readonly available: boolean
  /** 统计（含总条数）。 */
  stats(): { readonly entries: number; readonly capacity: number; readonly stored?: boolean }
  /** 只按保留期清整天文件。 */
  prune(): number
}

/** O-009 快照的结构对位子集。**只读清单，不代删。** */
export interface SnapshotLike {
  readonly available: boolean
  /** 全部快照，按新→旧。 */
  list(): readonly { readonly id: string; readonly createdAtMs: number }[]
}

/** O-005 字段声明的结构对位子集。 */
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

/** O-005 段声明的结构对位子集。 */
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
  ): { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number } | undefined
}
