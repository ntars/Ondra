/**
 * O-100 `ondra-memory-heal` 的对外契约：记忆库的**体检 + 可核对修复**。
 *
 * ## 一句话定位
 *
 * 「自愈」在这里**不是后台常驻的自我修复进程**（插件形态只允许 `apply(ctx)`，
 * 且 §17 明确不做常驻服务），而是三件事：
 *
 * 1. **巡检**（`diagnose()`）：按需扫一遍可修的问题，只输出清单，不改任何东西；
 * 2. **出计划**（`plan()`）：把每项按「能不能修」分三档，给人看清再动手；
 * 3. **逐项执行**（`apply()`）：必须传 `{ confirm: 'repair' }`，每项独立 try/catch。
 *
 * ## 三档之分（本文件最重要的一条）
 *
 * | 档 | 含义 | 例子 |
 * |---|---|---|
 * | `auto` | **无损**可修：删掉一条指向已不存在记忆的钉子，不损失任何数据 | `dangling-pin` |
 * | `confirm` | **不可逆或改语义**：必须人点名确认，绝不批量跑 | `tombstone-leak`（要再忘一次） |
 * | `advise` | **本插件修不了**：要么归别的插件，要么上游没给接口 | `empty-summary`（重写摘要归 O-019/O-035） |
 *
 * 把三档混成「自动全修」是最糟的设计：`advise` 那档一旦被自动执行，
 * 等于本插件替 O-019 重写摘要、替 O-012 合并记忆——那是越权。
 * 而 `confirm` 那档一旦自动执行，「忘记」就变成了无人复核的删除。
 *
 * ## 什么能查、什么查不了（诚实边界）
 *
 * **能查**（全部走已确认的公开服务方法）：
 * - 钉子指向的记忆已不存在 → `audit.pinned()` + `core.getFact()`；
 * - 活着的记忆正文已被墓碑覆盖 → `core.tombstoned(text)`；
 * - 最低曝光候选指向已消失的 id → `audit.scan().resurfaceDue` + `getFact()`；
 * - 活跃但强度归零却未沉底 → `core.strengthOf()`；
 * - 疑似重复组 → `dedupe.scan()`（只读清单，合并归 O-012）。
 *
 * **查不了**（上游没给接口，已写进 README 已知限制，不擅自直连表）：
 * - **孤儿边**：O-015 `GraphService` 只有 `edgeOf(from,to,relation)` / `neighbors(id)` /
 *   `forgetOf(id)`，**没有「列举全部边」的入口**。要查孤儿边只能直连 `memory_link` 表，
 *   那是绕过服务边界，本插件不做。
 * - **归档窗口违例**：`archiveDue()` 是批量无差别动作，没有「查询哪些该沉底」的只读面。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（master-plan §15.5 / 18.5），全部结构对位镜像。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const MEMORY_HEAL_SERVICE_KEY = 'ondra-memory-heal'

/**
 * 修复档位。**顺序即严重度递减**：`auto` 最安全，`advise` 最不该动。
 */
export const REPAIR_TIERS = ['auto', 'confirm', 'advise'] as const

/** 一个修复档位。 */
export type RepairTier = (typeof REPAIR_TIERS)[number]

/**
 * 问题种类。闭集，**只用这里列出的值**。
 *
 * 每加一种都要同时加：判定函数、档位、修复动作（或明确「无动作」）。
 * 没有修复动作的种类一律归 `advise`——不给它编一个「修了但什么也没变」的假方法（§17-6）。
 */
export const FINDING_CODES = [
  /** 钉子指向的记忆已不存在。 */
  'dangling-pin',
  /** 活着的记忆正文已被墓碑覆盖（该忘没忘干净）。 */
  'tombstone-leak',
  /** 最低曝光候选指向已消失的 id。 */
  'resurface-ghost',
  /** 活跃记忆强度归零却未沉底。 */
  'zero-strength',
  /** 正文够长但摘要为空。 */
  'empty-summary',
  /** 疑似重复组（只报告，不合并）。 */
  'duplicate-group',
  /** 钉子数量异常偏多。 */
  'pin-overflow',
] as const

/** 一个问题种类。 */
export type FindingCode = (typeof FINDING_CODES)[number]

/** 一种问题的说明书 —— **判定口径与档位的唯一真源**。 */
export interface FindingSpec {
  /** 问题种类。 */
  readonly code: FindingCode
  /** 中文名。给清单显示，**不进提示词**。 */
  readonly zh: string
  /** 档位。 */
  readonly tier: RepairTier
  /** 修复动作名；`advise` 档恒为 `null`（没有动作，不给假方法）。 */
  readonly action: RepairAction | null
  /** 一句话说明「这意味着什么」。 */
  readonly doc: string
  /** 修不了时，该归谁。`advise` 档必填。 */
  readonly owner?: string
}

/** 修复动作的种类（全部经别的插件的**公开方法**执行，绝不直连表）。 */
export type RepairAction =
  /** 调 O-017 `unpin(id)`。 */
  | 'unpin'
  /** 调 O-017 `forget(id, reason)`。**不可逆**。 */
  | 'forget'

/** 问题说明书表。 */
const FINDING_TABLE: Record<FindingCode, FindingSpec> = {
  'dangling-pin': {
    code: 'dangling-pin',
    zh: '钉子指向已不存在的记忆',
    tier: 'auto',
    action: 'unpin',
    doc: '这条记忆已经被删掉了，钉子还留在表里。清掉它不损失任何数据——它指向的东西本来就不在了。',
  },
  'tombstone-leak': {
    code: 'tombstone-leak',
    zh: '已忘内容还活着一条',
    tier: 'confirm',
    action: 'forget',
    doc: '这段正文在墓碑里（说明被明确忘记过），但库里还有一条活着的同内容记录。要再忘一次才能清净——这是删除动作，必须你点名确认。',
  },
  'resurface-ghost': {
    code: 'resurface-ghost',
    zh: '待补曝光的 id 已消失',
    tier: 'advise',
    action: null,
    doc: '扫描时它还在，取用时已经被删了。下一次扫描自己就会消失，不用动手。',
    owner: '无（下一轮 O-017 扫描自愈）',
  },
  'zero-strength': {
    code: 'zero-strength',
    zh: '强度归零却还活跃',
    tier: 'advise',
    action: null,
    doc: '它已经掉到地板，却没被沉底。沉底归 O-010 的批量归档口（archiveDue），本插件没有「按 id 沉底」的接口。',
    owner: 'O-010 ondra-memory-core（archiveDue 批量口）',
  },
  'empty-summary': {
    code: 'empty-summary',
    zh: '正文够长但没摘要',
    tier: 'advise',
    action: null,
    doc: '摘要由提炼链写（O-011）或由夜间重写（O-019）。本插件编的摘要会被人当成产品资产抄进包里，而且没人知道它是机器写的。',
    owner: 'O-019 ondra-memory-dream（≥5 条后重写）/ O-011 提炼链',
  },
  'duplicate-group': {
    code: 'duplicate-group',
    zh: '疑似重复',
    tier: 'advise',
    action: null,
    doc: '合并走 O-012 的五分类判重，它有明确的 0.4 包含度口径与决策日志。本插件自己合会多出第二套判重口径。',
    owner: 'O-012 ondra-memory-dedupe',
  },
  'pin-overflow': {
    code: 'pin-overflow',
    zh: '钉子偏多',
    tier: 'advise',
    action: null,
    doc: '钉住不参与衰减，钉太多等于把一个「会忘」的库改成「不会忘」，长期看会淹掉真正要紧的东西。删钉子由人决定。',
    owner: '人或 O-017 的钉子清单',
  },
}

/** 问题说明书的只读出口。 */
export const FINDING_SPECS: Readonly<Record<FindingCode, FindingSpec>> = Object.freeze(FINDING_TABLE)

/**
 * 摘要缺失的判定长度：正文去空白后 ≥ 此值且 `summary` 为空才算问题。
 *
 * 取 30 的理由：短于 30 字的记忆本来就不需要摘要（摘要会比正文还长），
 * 报了只会让清单塞满噪声，而噪声会把「强度归零」这类真问题挤下去。
 */
export const SUMMARY_MIN_CHARS = 30

/**
 * 钉子数量的告警线。默认 8，与 O-017 手册口径「钉住 ≤8」一致。
 *
 * **不在这里改别人的上限**，只报告「已超过」这个事实。
 */
export const PIN_WARN_LIMIT = 8

/** 单次巡检最多翻多少条记忆。 */
export const MAX_SCAN_ROWS = 2000

/** 单次巡检最多翻多少条钉子。 */
export const MAX_PINS = 200

/** 一条发现。 */
export interface Finding {
  /** 问题种类。 */
  readonly code: FindingCode
  /** 档位。 */
  readonly tier: RepairTier
  /** 相关记忆 id；与具体记录无关（如 `pin-overflow`）时为空串。 */
  readonly id: string
  /** 中文摘要一句（**可含数字，这是体检不是话术**）。 */
  readonly detail: string
  /** 修复动作；`advise` 档为 `null`。 */
  readonly action: RepairAction | null
}

/** 巡检报告。**只出清单，不改任何东西**。 */
export interface HealthReport {
  /** 巡检时刻。 */
  readonly at: number
  /** 扫了多少条记忆。 */
  readonly scanned: number
  /** 是否扫完（撞上限时为 `false`，清单不完整）。 */
  readonly complete: boolean
  /** 发现的问题（按档位 `auto → confirm → advise` 排序）。 */
  readonly findings: readonly Finding[]
  /** 各档位计数。 */
  readonly counts: Readonly<Record<RepairTier, number>>
  /** 缺席的上游（如 `ondra-memory-audit`），供体检面板解释「为什么这次只查出这几类」。 */
  readonly missing: readonly string[]
}

/** 修复计划里的一项。 */
export interface RepairItem {
  /** 计划项 id（`code:id` 形式，给 `apply()` 用）。 */
  readonly key: string
  /** 问题种类。 */
  readonly code: FindingCode
  /** 档位。 */
  readonly tier: RepairTier
  /** 目标记忆 id。 */
  readonly id: string
  /** 要做的动作；`advise` 档为 `null`。 */
  readonly action: RepairAction | null
  /** 这一项**会不会**被执行（`advise` 恒为 false）。 */
  readonly planned: boolean
  /** 一句话说明。 */
  readonly detail: string
}

/** 一份计划。 */
export interface RepairPlan {
  /** 计划生成时刻。 */
  readonly at: number
  /** 全部条目（含 `advise` 档，便于界面并排显示「这些修不了」）。 */
  readonly items: readonly RepairItem[]
  /** 会被执行的条数（`auto` + `confirm`）。 */
  readonly actionable: number
  /** 修不了的条数。 */
  readonly advisory: number
  /** 是否已做完巡检（`false` 表示记忆内核缺席，什么都没查）。 */
  readonly complete: boolean
}

/** 单项执行结果。 */
export interface RepairOutcome {
  /** 计划项 id。 */
  readonly key: string
  /** 是否真的修了。 */
  readonly ok: boolean
  /** 失败原因码。 */
  readonly refusal?: HealErrorCode
  /** 中文说明。 */
  readonly detail: string
}

/** 统计快照。 */
export interface HealStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 累计巡检次数。 */
  readonly diagnoses: number
  /** 累计发现条数。 */
  readonly findings: number
  /** 累计修复成功条数。 */
  readonly repaired: number
  /** 累计失败条数（不阻断，只记账）。 */
  readonly failed: number
}

/** 不可用原因。 */
export type HealUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 记忆内核缺席：没有库可巡检。 */
  | 'no-core'

/** 错误码。**只用闭集内的值**，不临时编新码。 */
export type HealErrorCode =
  | 'no-core'
  | 'no-audit'
  | 'not-found'
  | 'not-actionable'
  | 'confirmation-required'
  | 'failed'

/** 自愈错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class HealError extends Error {
  /** 错误码。 */
  readonly code: HealErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: HealErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'HealError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface MemoryHealService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HealUnavailableReason

  /** 七种问题的说明书（全量）。 */
  specs(): readonly FindingSpec[]

  /**
   * 巡检一遍。**只读**：不修、不写、不动任何状态。
   * @param limit 最多翻多少条记忆，省略用配置。
   */
  diagnose(limit?: number): HealthReport

  /**
   * 出一份计划。省略 `report` 就当场巡检一次。
   * @param report 已有报告（避免重复扫）。
   */
  plan(report?: HealthReport): RepairPlan

  /**
   * 执行修复。**必须传 `{ confirm: 'repair' }`**，且只接受 `auto` / `confirm` 档的 key。
   *
   * `advise` 档传进来一律抛 `not-actionable`——它们本来就该由别的插件或人做。
   * @param keys 计划项 key 列表。
   * @param options 二次确认；不传即拒绝。
   */
  apply(keys: readonly string[], options?: { readonly confirm: 'repair' }): readonly RepairOutcome[]

  /** 统计快照。 */
  stats(): HealStats
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

/** O-003 时钟服务的结构对位子集（只要「现在」）。 */
export interface ClockLike {
  now(): number
}

/**
 * O-010 `ondra-memory-core` 的结构对位子集。
 *
 * 只取读面：`listFacts` / `getFact` / `strengthOf` / `tombstoned` / `countFacts`。
 * **一个写方法都不镜像**——修记忆必须经 O-017 的审计口（它有钉子清理与孤儿边处理），
 * 本插件直接 `forget()` 会漏掉那两件 O-010 不管的事。
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
  tombstoned(text: string): boolean
}

/** 记忆记录的最小形状。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly text: string
  readonly summary: string | null
  readonly archived: boolean
  readonly sealed: boolean
  readonly createdAt: number
}

/** 强度视图的最小形状。 */
export interface StrengthLike {
  readonly strength: number
  readonly remainingHours: number
}

/**
 * O-017 `ondra-memory-audit` 的结构对位子集。
 *
 * 只取三样：`pinned()` 清单、`unpin()`、`forget()`、`scan()`。
 * **不取 `revise()`**：自愈不做内容订正（那是人写的，机器改了就没人认）。
 */
export interface AuditLike {
  readonly available: boolean
  pinned(): readonly { readonly id: string; readonly note: string }[]
  unpin(id: string): boolean
  forget(id: string, reason: string): { readonly forgotten: boolean; readonly pinRemoved: boolean }
  scan(at?: number): {
    readonly at: number
    readonly scanned: number
    readonly complete: boolean
    readonly resurfaceDue: readonly string[]
    readonly pins: number
  }
}

/**
 * O-012 `ondra-memory-dedupe` 的结构对位子集。
 *
 * 只取 `scan()`（只出清单）。**不取 `settle()`**：合并归 O-012 自己走，
 * 本插件替它合会绕过它的决策日志。
 */
export interface DedupeLike {
  readonly available: boolean
  scan(limit?: number): readonly { readonly anchorId: string; readonly members: readonly { readonly id: string }[] }[]
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
