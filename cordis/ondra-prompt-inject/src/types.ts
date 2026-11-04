/**
 * O-036 `ondra-prompt-inject` 的对外契约：**八块装配 + 装箱制 + 「另有 N 条未展开」**。
 *
 * 这一层只做一件事：把「她这轮该想起什么」变成一段有预算上限的正文，
 * 并且**一条都不静默丢**——装不下的条数写在段标题里。
 *
 * ## 七件必须先说清的事
 *
 * 1. **装箱制，不是「取最近 N 条」。** 手册 §2.6 原话：按权重全局排序逐条装，
 *    装不下就跳过这条、继续试下一条（不是整段停）。所以本插件的核心循环里
 *    **没有 `slice`、没有 `topK`**，只有「这一条放不放得下」。
 *    任何形式的「取前 N 条」都会让一条重要记忆因为排在 8 位之后而永远不出现，
 *    而日志里一切正常。
 *
 * 2. **核心段永不参与装箱。** ① 到期提醒与 ② 钉住这两块整块豁免预算，
 *    宁可 `overBudget: true`。理由：这两块是「她说好要做的事」与「用户亲手钉住的」，
 *    被预算挤掉一次，用户看到的是「她忘了我们的约定」——那是产品事故，不是省钱。
 *
 * 3. **装不下要写进段标题。** `另有 N 条未展开，chain_recall 可查`。
 *    手册给的是 `另有 N 条未展开（chain_recall 可查）`，本插件把括号改成逗号，
 *    因为段标题本身已经带一层括号，嵌两层会读成「另有 N 条未展开（可查（…））」。
 *
 * 4. **`dropped` 与 `suppressed` 是两件事。** 前者是「装不下」，后者是「已经见过」。
 *    合并成一个数字，O-142 就分不清「该调大预算」还是「该释放已见」。
 *
 * 5. **本插件不碰人格段。** 人格四段归 O-023、由 O-033 在 `begin()` 里冻结成前缀；
 *    注入是**易变段**，每轮都可能不同，写进前缀就是把缓存命中率打回 0（§8.5）。
 *    两段各有一份预算，**合并计数不在这里做**（见 README「已知限制」）。
 *
 * 6. **`expand()` 是「正文留盘按需展开」的落点。** 手册 §1.7 要求首轮一次大块、
 *    正文留盘按需展开。本插件只提供按 id 取回原文的服务方法；
 *    面向模型的工具入口（`chain_recall`）归 O-132 / O-138 的门面，本插件不自己注册工具
 *    （注册工具要 `inject: ['tools']`，那会让上游缺席时整插件 PENDING）。
 *
 * 7. **上游缺席不改行为，只改内容并留痕。** 少一个来源就少一块，并在
 *    `degradations` 里写清少了谁。**不许因为少一个增强项就整段不出。**
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。
 */

/** 本插件注册的服务键（连字符，非 `ondra:prompt-inject`）。全仓唯一归属。 */
export const INJECT_SERVICE_KEY = 'ondra-prompt-inject'

/**
 * 挂进宿主 `systemPrompt` 的运行时上下文名。
 *
 * 带 `ondra:` 前缀是因为宿主里还有别的贡献者（工作目录、沙箱策略、子代理委派），
 * 裸名字迟早撞上；撞上时宿主会抛「already registered」，整条装配链一起挂。
 */
export const PROMPT_CONTEXT_NAME = 'ondra:injection'

/**
 * 上面那条上下文在宿主里的排序位。
 *
 * 宿主 `@ntars/ondra-system-prompt` 的 `CONTEXT_ORDERS` 目前用到 210
 * （`WEB_SURFACE`），本插件取 220 附在其后：本机路径与端点先说完，再说「她记得什么」。
 *
 * **本插件不 import 宿主包**（§18.5 的结构对位纪律），所以这个数字无法在编译期
 * 与宿主核对。宿主新增位或调整既有位时，必须回来重看这一行。
 */
export const PROMPT_CONTEXT_ORDER = 220

/**
 * 宿主 `systemPrompt` 服务的最小结构对位——只声明本插件真正调用的那一个方法。
 *
 * 少声明是刻意的：多声明一个字段，宿主改名时本插件就在编译期挂掉，
 * 而调用方其实根本不碰那个字段。
 */
export interface SystemPromptLike {
  /**
   * 注册一段运行时上下文。
   * @param entry 上下文声明。
   * @returns 撤销函数（随 `ctx.effect` 一起撤）。
   */
  context(entry: {
    readonly name: string
    readonly order: number
    readonly text: string | ((...args: never[]) => string)
    readonly interpolate?: boolean
    readonly required?: boolean
  }): () => void
}

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 一、八块
 * ------------------------------------------------------------------ */

/**
 * 八块的 id，**数组顺序即装配顺序**（手册 §2.6 的 ①~⑧）。
 *
 * 名字不许改：`ondra-142`（注入去重）与 `ondra-125`（提示词预览）
 * 会按这八个 id 判断「哪一块没了」，改名等于让它们静默失配。
 */
export const BLOCK_IDS = [
  'promises',
  'pinned',
  'persons',
  'anniversary',
  'recall',
  'lessons',
  'ripple',
  'resurface',
] as const

/** 块 id。 */
export type BlockId = (typeof BLOCK_IDS)[number]

/** 一块的声明。 */
export interface BlockSpec {
  /** 块 id。 */
  readonly id: BlockId
  /** 装配序号 0–7（手册 §2.6 的 ①~⑧）。 */
  readonly order: number
  /** 段标题（含方括号，逐字对齐手册）。 */
  readonly title: string
  /**
   * 是否核心段（永不参与装箱）。
   *
   * 手册只说「核心段永不参与装箱」，**没点名是哪几块**。本插件取 ① ②：
   * 到期提醒与钉住是「她答应过的」与「用户亲手钉的」，被预算挤掉等于失约。
   * 登记待裁决（见 README）。
   */
  readonly core: boolean
  /** 条数上限。`0` 表示不限（只受预算约束）。 */
  readonly cap: number
  /** 装箱基准权重（越大越先装）。核心段的权重不参与比较。 */
  readonly weight: number
  /** 取材来源（服务键），只用于报告与文档。 */
  readonly source: string
  /** 这一块的一句话说明（给界面与日志用）。 */
  readonly doc: string
}

/** 八块声明表 —— **装配顺序与上限的唯一真源**。 */
const BLOCK_TMP: readonly BlockSpec[] = [
  {
    id: 'promises',
    order: 0,
    title: '【说好的事】',
    core: true,
    cap: 3,
    weight: 0,
    source: 'ondra-memory-prospective',
    doc: '到期该提醒的承诺。手册没给条数，取 3（可配）。',
  },
  {
    id: 'pinned',
    order: 1,
    title: '【不能忘的】',
    core: true,
    cap: 8,
    weight: 0,
    source: 'ondra-memory-audit',
    doc: '用户钉住的记忆。手册逐字：≤8 条。',
  },
  {
    id: 'persons',
    order: 2,
    title: '【我认识的人】',
    core: false,
    cap: 5,
    weight: 600,
    source: 'ondra-memory-recall',
    doc: 'person 类记忆，按「重要度 × 强度」排。手册逐字：≤5 条。',
  },
  {
    id: 'anniversary',
    order: 3,
    title: '【那年今日】',
    core: false,
    cap: 3,
    weight: 350,
    source: 'ondra-memory-core',
    doc: '整 365 天 / 整 30 天的记忆。手册逐字：≤3 条。',
  },
  {
    id: 'recall',
    order: 4,
    title: '【这会儿想起来的】',
    core: false,
    cap: 0,
    weight: 500,
    source: 'ondra-memory-recall',
    doc: '按当前来信召回。**不设条数上限**（手册 §12.1 P0 第二条：召回不按条数砍）。',
  },
  {
    id: 'lessons',
    order: 5,
    title: '【记下的道理】',
    core: false,
    cap: 3,
    weight: 400,
    source: 'ondra-memory-core',
    doc: '语义归纳（lesson / reflection 两类）。手册逐字：≤3 条。',
  },
  {
    id: 'ripple',
    order: 6,
    title: '【顺着话头想起来的】',
    core: false,
    cap: 0,
    weight: 300,
    source: 'ondra-memory-humanlike',
    doc: '水波纹扩散，**带免责句**。手册没给条数，只受预算。',
  },
  {
    id: 'resurface',
    order: 7,
    title: '【今天想起来的】',
    core: false,
    cap: 1,
    weight: 200,
    source: 'ondra-memory-core',
    doc: '30 天没被带出、强行补 1 条（手册 §2.4）。',
  },
]

/** 八块声明表（冻结）。 */
export const BLOCK_SPECS: readonly BlockSpec[] = Object.freeze(BLOCK_TMP)

/* ------------------------------------------------------------------ *
 * 二、预算
 * ------------------------------------------------------------------ */

/**
 * 预算档位。
 *
 * 数值逐字来自手册 §2.6：「2600 字符（省 token 派）/ 24000 字符（记忆优先派）/
 * 1200 字（二人小规模派）」。默认 `standard`（2600），与手册「默认 2600」一致。
 *
 * **只是界面可一键填的预设值，不是三个开关**——真源是 `budgetChars` 一个数字。
 */
export interface BudgetPreset {
  /** 档位 id。 */
  readonly id: 'small' | 'standard' | 'large'
  /** 字符数。 */
  readonly chars: number
  /** 中文名。 */
  readonly label: string
  /** 什么时候用这一档。 */
  readonly doc: string
}

/** 三个预设档。 */
const PRESET_TMP: readonly BudgetPreset[] = [
  {
    id: 'small',
    chars: 1200,
    label: '二人小规模',
    doc: '预算最紧的一档。核心段（到期提醒 + 钉住）照样整块进，超了会如实报 overBudget。',
  },
  {
    id: 'standard',
    chars: 2600,
    label: '省 token',
    doc: '默认档（手册 §2.6）。',
  },
  {
    id: 'large',
    chars: 24000,
    label: '记忆优先',
    doc: '预算最宽的一档，手册实测「1000 条时封顶 24000 字符」。',
  },
]

/** 三个预设档（冻结）。 */
export const BUDGET_PRESETS: readonly BudgetPreset[] = Object.freeze(PRESET_TMP)

/* ------------------------------------------------------------------ *
 * 三、条目与结果
 * ------------------------------------------------------------------ */

/**
 * 一条可注入的条目。
 *
 * `id` 是**跨插件记账用的稳定键**（O-142 的「已见 id」就是它）。
 * 前缀按来源分域：`mem:` 记忆、`pin:` 钉住、`promise:` 承诺、`todo:` 待办。
 * 同一个记忆同时出现在两块时，先装的块占位，后一块跳过——**一条记忆只出现一次**。
 */
export interface InjectionItem {
  /** 稳定 id（`mem:<factId>` / `pin:<factId>` / `promise:<id>`）。 */
  readonly id: string
  /** 属于哪一块。 */
  readonly block: BlockId
  /** 原始 id（记忆 id / 承诺 id），`expand()` 用它取回原文。 */
  readonly ref: string
  /** 行正文（**不含** `- [类] ` 前缀，格式化归 `format.ts`）。 */
  readonly text: string
  /** 这一行的字符数（含前缀，按 `formatLine` 的结果算）。 */
  readonly chars: number
  /** 装箱权重，越大越先装。 */
  readonly weight: number
  /** 取材来源（服务键）。 */
  readonly source: string
}

/** 掉了一条，为什么掉。 */
export interface DroppedItem {
  /** 条目 id。 */
  readonly id: string
  /** 属于哪一块。 */
  readonly block: BlockId
  /** 白丢了多少字。 */
  readonly chars: number
  /** 原因。 */
  readonly reason: DropReason
}

/** 掉的原因。**三种处置完全不同，不许合并成一个数字**。 */
export type DropReason =
  /** 预算装不下（该调大预算）。 */
  | 'over-budget'
  /** 条数超过这一块的上限（该调上限，或这条本来就不该进）。 */
  | 'block-cap'
  /** 记忆池判定「不参与注入」（海马体永不注入，改预算没用）。 */
  | 'pool-denied'

/** 被「已见」挡下的条目（不算未展开）。 */
export interface SuppressedItem {
  /** 条目 id。 */
  readonly id: string
  /** 属于哪一块。 */
  readonly block: BlockId
}

/** 装好的一段。 */
export interface PackedSegment {
  /** 块 id。 */
  readonly id: BlockId
  /** 装配序号。 */
  readonly order: number
  /** 段标题（含「另有 N 条未展开」的说明）；`includeHeadings: false` 时为空串。 */
  readonly heading: string
  /** 正文（行之间用 `\n`）。 */
  readonly text: string
  /** 标题 + 正文的字符数。 */
  readonly chars: number
  /** 装进去几条。 */
  readonly items: number
  /** 这一块掉了几条（**没静默丢**，数字就在这儿）。 */
  readonly dropped: number
  /** 这一块是否豁免装箱（核心段）。 */
  readonly core: boolean
}

/** 降级说明。 */
export interface Degradation {
  /** 种类。 */
  readonly kind: DegradationKind
  /** 一句人话。 */
  readonly note: string
}

/** 降级种类。 */
export type DegradationKind =
  /** 承诺/待办服务缺席：① 整块不出。 */
  | 'no-prospective'
  /** 审计服务缺席：② 整块不出（钉住拿不到）。 */
  | 'no-audit'
  /** 记忆内核缺席：③④⑥⑧ 与「钉住的正文」都拿不到。 */
  | 'no-core'
  /** 召回服务缺席：③⑤ 整块不出。 */
  | 'no-recall'
  /** 拟人化服务缺席：⑦ 整块不出。 */
  | 'no-humanlike'
  /** 衰减服务缺席：行尾不带「记不太清了」这类话术。 */
  | 'no-decay'
  /** 记忆池服务缺席：不判「海马体永不注入」。 */
  | 'no-pool'
  /** 超预算（核心段豁免之后仍然装不下）。 */
  | 'over-budget'
  /** 核心段单独就超了预算——**仍然整块带上**。 */
  | 'core-exempt'
  /** 那年今日的扫描被上限截断（可能漏掉更老的周年）。 */
  | 'anniversary-scan-capped'
  /** ⑦ 没有召回种子（本轮没有话头或召回为空），水波纹不扩散。 */
  | 'no-seed'
  /** 某一块取材时抛错，已跳过（C3：错误不传播）。 */
  | 'block-error'

/** 一次装箱的完整结果。 */
export interface InjectionPlan {
  /** 预算（字符）。 */
  readonly budgetChars: number
  /** 实际用了多少字符（含段标题）。 */
  readonly usedChars: number
  /** 剩余多少（可为负：为负说明核心段把预算顶穿了）。 */
  readonly remainingChars: number
  /** 是否超预算。 */
  readonly overBudget: boolean
  /** 核心段占了多少字（解释 `overBudget` 的成因）。 */
  readonly coreChars: number
  /** 八段（**按固定顺序**，可能为空段但一定存在）。 */
  readonly segments: readonly PackedSegment[]
  /** 实际装进去的条目 id（O-142 拿它记账）。 */
  readonly ids: readonly string[]
  /** 被「已见」挡下的（不算未展开）。 */
  readonly suppressed: readonly SuppressedItem[]
  /** 掉了哪些（完整清单，**不截断**）。 */
  readonly dropped: readonly DroppedItem[]
  /** 降级与告警。 */
  readonly degradations: readonly Degradation[]
  /** 内容的指纹（djb2，8 位十六进制）：变了才需要重推。 */
  readonly digest: string
  /** 本轮时刻。 */
  readonly at: number
}

/** 渲染结果。 */
export interface RenderedInjection {
  /** 八段拼起来的正文（段之间空一行）。 */
  readonly text: string
  /** 整段字符数。 */
  readonly chars: number
  /** 装箱报告。 */
  readonly plan: InjectionPlan
}

/** 装箱入参。 */
export interface PackRequest {
  /** 临时预算（字符）。省略取配置值。 */
  readonly budgetChars?: number
  /** 当前来信（话头）。空串合法：无话头时 ⑤ 不出，其余照常。 */
  readonly query?: string
  /** 时刻；省略取当前时刻。 */
  readonly at?: number
  /**
   * 已见 id 集合（O-142 的记账）。
   *
   * 首轮传空集 → 一次大块；之后传「已经进过上下文的 id」→ 只推增量。
   * **压缩信号触发释放**是 O-142 的事：它把集合清空再调一次即可。
   */
  readonly seen?: ReadonlySet<string>
  /** 只装这几块（预览用）。省略装全部。 */
  readonly only?: readonly BlockId[]
  /** 是否给每段加中文标题。省略取配置值。 */
  readonly includeHeadings?: boolean
}

/** `expand()` 的结果。 */
export interface ExpandedItem {
  /** 条目 id。 */
  readonly id: string
  /** 记忆 id（`ref`）。 */
  readonly ref: string
  /** 正文；取不到时为空串（**不编一句假正文**）。 */
  readonly text: string
  /** 是否取到。 */
  readonly found: boolean
}

/** 统计快照。 */
export interface InjectionStats {
  /** 是否可用（只受总开关影响）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: InjectionReason
  /** 当前预算。 */
  readonly budgetChars: number
  /** 上一次装了多少字。 */
  readonly lastUsedChars: number
  /** 上一次是否超预算。 */
  readonly lastOverBudget: boolean
  /** 上一次进了几条。 */
  readonly lastItems: number
  /** 上一次掉了几条。 */
  readonly lastDropped: number
  /** 上一次被「已见」挡了几条。 */
  readonly lastSuppressed: number
  /** 累计装箱次数。 */
  readonly plans: number
  /** 各块在位情况（拿不到来源的块为 `false`）。 */
  readonly sources: Readonly<Record<BlockId, boolean>>
}

/** 不可用原因。**只有配置关掉**才算不可用（降级 ≠ 不可用）。 */
export type InjectionReason = 'disabled'

/** 注入服务。 */
export interface InjectionService {
  /** 是否可用（只受总开关影响）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: InjectionReason

  /** 三个预算预设（供界面一键填 `budgetChars`）。 */
  budgets(): readonly BudgetPreset[]
  /** 当前生效的预算（字符）。 */
  budget(): number

  /**
   * 只装箱、不渲染。
   * @param request 入参。
   */
  plan(request?: PackRequest): InjectionPlan

  /**
   * 装箱 + 渲染成一段正文。
   * @param request 入参。
   */
  render(request?: PackRequest): RenderedInjection

  /**
   * 按 id 取回原文（「正文留盘按需展开」）。
   * @param ids 条目 id 或原始记忆 id 都认。
   * @param at 时刻（算清晰度用）。
   */
  expand(ids: readonly string[], at?: number): readonly ExpandedItem[]

  /** 统计快照。 */
  stats(): InjectionStats
}

/* ------------------------------------------------------------------ *
 * 四、上游镜像（不 import，结构对位）
 * ------------------------------------------------------------------ */

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

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  /** 注册一个段，返回撤销函数。 */
  register(section: SectionDeclLike, owner?: string): () => void
  /** 解析一个段的四层合并结果。 */
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 一条记忆（镜像 O-010 的 `MemoryRecord`，只镜像注入要用的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly kind: string
  readonly category: string
  readonly channel: string
  readonly text: string
  readonly salience: number
  readonly timesSaid: number
  readonly revisions: number
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly archived: boolean
  readonly sealed: boolean
  readonly important: boolean
}

/** 条件查询（镜像 O-010 的 `FactQuery`）。 */
export interface FactQueryLike {
  readonly category?: string
  readonly kind?: string
  readonly state?: string
  readonly subject?: string
  readonly ids?: readonly string[]
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: string
}

/** O-010 记忆内核的结构对位子集。 */
export interface CoreLike {
  readonly available: boolean
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  dueForResurfacing(days?: number, limit?: number): readonly MemoryRecordLike[]
}

/** 一条承诺（镜像 O-016 的 `PromiseRecord`）。 */
export interface PromiseLike {
  readonly id: string
  readonly factId: string
  readonly text: string
  readonly dueAt: number
  readonly state: string
  readonly remindedAt: number
}

/** 一条提醒（镜像 O-016 的 `ReminderItem`）。 */
export interface ReminderLike {
  readonly promise: PromiseLike
  readonly hoursLeft: number
  readonly urgency: number
  readonly inGrace: boolean
}

/** O-016 承诺/待办的结构对位子集。 */
export interface ProspectiveLike {
  readonly available: boolean
  dueForReminder(at?: number): readonly ReminderLike[]
}

/** 一条钉住记录（镜像 O-017 的 `PinRecord`）。 */
export interface PinLike {
  readonly id: string
  readonly pinnedAt: number
  readonly note: string
}

/** O-017 审计的结构对位子集。 */
export interface AuditLike {
  readonly available: boolean
  pinned(): readonly PinLike[]
}

/** 一条召回命中（镜像 O-014 的 `RecallHit`）。 */
export interface RecallHitLike {
  readonly id: string
  readonly text: string
  readonly category: string
  readonly kind: string
  readonly score: number
  readonly strength: number | null
  readonly createdAt: number
  readonly important: boolean
  readonly archived: boolean
  readonly factors: {
    readonly importance: number
    readonly keyword: number
    readonly freshness: number
  }
}

/** 召回结果（镜像 O-014 的 `RecallResult`）。 */
export interface RecallResultLike {
  readonly ok: boolean
  readonly hits: readonly RecallHitLike[]
  readonly note?: string
}

/** O-014 召回的结构对位子集。 */
export interface RecallLike {
  readonly available: boolean
  search(request: { readonly text: string; readonly at?: number }): RecallResultLike
}

/** 一条水波纹（镜像 O-018 的 `RippleItem`）。 */
export interface RippleItemLike {
  readonly id: string
  readonly text: string | null
  readonly ring: number
  readonly weight: number
  readonly score: number
}

/** 水波纹结果（镜像 O-018 的 `RippleResult`）。 */
export interface RippleResultLike {
  readonly ok: boolean
  readonly items: readonly RippleItemLike[]
}

/** O-018 拟人化的结构对位子集。 */
export interface HumanlikeLike {
  readonly available: boolean
  ripple(seed: string, options?: { readonly at?: number; readonly maxRings?: number }): RippleResultLike
}

/** 清晰度（镜像 O-013 的 `ClarityView`）。 */
export interface ClarityLike {
  readonly phrase: string
  readonly strength: number
}

/** O-013 衰减的结构对位子集（只用来拿行尾话术）。 */
export interface DecayLike {
  readonly available: boolean
  /** 按强度取话术（召回命中没有整条记录，只有 `strength`）。 */
  clarityOf(strength: number): ClarityLike
  /** 按记录取话术（走 O-010 的 `strengthOf()`，不自己算）。 */
  clarityOfRecord(record: MemoryRecordLike, at?: number): ClarityLike
}

/** 注入资格（镜像 O-131 的 `InjectionEligibility`）。 */
export interface EligibilityLike {
  readonly eligible: boolean
  readonly reason: string
}

/** O-131 池的结构对位子集。 */
export interface PoolLike {
  readonly available: boolean
  eligibleForInjection(factId: string, at?: number): EligibilityLike
}

/** 取材要用到的全部上游（全部可缺席）。 */
export interface Sources {
  readonly prospective: () => ProspectiveLike | undefined
  readonly audit: () => AuditLike | undefined
  readonly core: () => CoreLike | undefined
  readonly recall: () => RecallLike | undefined
  readonly humanlike: () => HumanlikeLike | undefined
  readonly decay: () => DecayLike | undefined
  readonly pool: () => PoolLike | undefined
}
