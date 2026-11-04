/**
 * O-135 `ondra-narrative-log` 的对外契约。
 *
 * 定位：**记下「她为什么这么回」**，只追加、只读，供界面与审计查。
 *
 * ## 四条边界，决定了整个形状
 *
 * 1. **不进提示词。** 这份记录是给**人**看的（面板、审计、事后追查），
 *    不是给她看的。塞进上下文会让「解释自己」变成一种表演，而且它天然带计数
 *    （「拦了 2 处」），正好撞上手册的禁止报数铁律。所以本包**没有**
 *    `prompt()` / `inject()` 之类的出口，一个都没有。
 *
 * 2. **只追加，不改不删。** 对外只有 `record()` 一个写入口，没有 update、
 *    没有 delete。文件以 `a` 打开，永不重写。审计日志一旦可改，就不再是审计。
 *
 * 3. **不自己判断「为什么」。** 判定因子由上游交进来（择档、情绪、九步过滤、
 *    证据门控…）。本包不知道 `emotion.tension` 是什么意思，也不解释它的语义，
 *    只负责**收下、脱敏、截断、按权重排序、说成人话**。自己推断理由，
 *    就会写出「她因为紧张所以冷淡」这种没人说过的话。
 *
 * 4. **不落正文全文。** 只存她**说出口那一小段**（默认 60 字，可关）与
 *    结构化因子。用户原话、记忆正文、提示词一律不存——那不是审计需要的东西。
 *
 * ## 为什么 id 是「时刻 + 序号」而不是随机数
 *
 * 审计要能按时间对齐别的日志（通道、模型网关）。随机 id 好看但对不上账。
 * 同一毫秒内多次写入用序号区分，序号在进程内单调，重启后从 0 开始——
 * 但同一毫秒 + 同序号 + 不同内容在同一台机器上要重启两次才可能撞，
 * 而那时 `at` 已经不同了。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const NARRATIVE_LOG_SERVICE_KEY = 'ondra-narrative-log'

/** 名字合规正则：服务键、工具名、配置键共用。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 条目版本。读到不认识的版本**跳过那一条**，不猜迁移。 */
export const TRACE_VERSION = 1

/** 闸门判定，四值闭集。 */
export const GATE_VERDICTS = ['pass', 'block', 'rewrite', 'skip'] as const

/** 一种闸门判定。 */
export type GateVerdict = (typeof GATE_VERDICTS)[number]

/** 判定的中文说法。**只给面板与审计**。 */
export const VERDICT_ZH: Readonly<Record<GateVerdict, string>> = Object.freeze({
  pass: '放行',
  block: '拦下',
  rewrite: '改写',
  skip: '跳过',
})

/** 写入结果的原因，五值闭集。 */
export const TRACE_REASONS = ['ok', 'disabled', 'invalid', 'no-store', 'write-failed'] as const

/** 一种写入原因。 */
export type TraceReason = (typeof TRACE_REASONS)[number]

/** 原因的中文说法。**只给日志与面板**。 */
export const TRACE_REASON_ZH: Readonly<Record<TraceReason, string>> = Object.freeze({
  ok: '已记录',
  disabled: '决策日志已关闭',
  invalid: '这一条没有可用字段，已拒收',
  'no-store': '没有路径服务：只进了内存环，重启即丢',
  'write-failed': '写盘失败：这一条只在内存里',
})

/** 一个判定因子。**上游交什么，这里就记什么**，语义由上游负责。 */
export interface TraceFactor {
  /** 因子键。小写、可用点与连字符，例 `emotion.tension` / `filter.narration`。 */
  readonly key: string
  /** 取值。省略表示「只有名字，没有值」。 */
  readonly value?: string | number | boolean
  /** 影响权重，−1…1。用于排序与「主要因为」的挑选。 */
  readonly weight?: number
  /** 一句中文说明。**会脱敏、会截断**。 */
  readonly note?: string
}

/** 一道闸门的判定。 */
export interface TraceGate {
  /** 闸门名（哪个插件、哪一道），例 `filter-chain` / `evidence-gate`。 */
  readonly name: string
  /** 判定。 */
  readonly verdict: GateVerdict
  /** 一句中文原因。**会脱敏、会截断**。 */
  readonly reason?: string
}

/** 她最终选了哪一档（字段全是可选的：上游有什么就交什么）。 */
export interface TraceChosen {
  /** 语域档（A 冷 / B 常 / C 软 / D 烫 / E 炸 / F 崩）。 */
  readonly register?: string
  /** 关系阶段。 */
  readonly stage?: string
  /** 表达风格或口语化档位。 */
  readonly style?: string
  /** 这一轮回了多少字。 */
  readonly chars?: number
}

/** `record()` 的入参。**全部字段都可缺**：能补的补，补不了的拒收。 */
export interface TraceInput {
  /** 回合 id。缺了就按「时刻+序号」生成，之后无法按 turn 反查。 */
  readonly turnId?: string
  /** 发生时刻（毫秒）。缺省用 `now()`。 */
  readonly at?: number
  /** 会话 id。 */
  readonly conversationId?: string
  /** 这一条是谁交的（插件名），便于追「哪一环没交」。 */
  readonly producer?: string
  /** 她最终选的档。 */
  readonly chosen?: TraceChosen
  /** 判定因子。 */
  readonly factors?: readonly TraceFactor[]
  /** 闸门判定。 */
  readonly gates?: readonly TraceGate[]
  /** 引用到的记忆/承诺 id。**只记 id，不记正文**。 */
  readonly refs?: readonly string[]
  /** 她说出口的那一段（**会脱敏、会截断，可关**）。 */
  readonly excerpt?: string
  /** 一句补充说明。**会脱敏、会截断**。 */
  readonly note?: string
}

/** 一条落定的记录。 */
export interface TraceEntry {
  /** 条目版本。 */
  readonly version: number
  /** 条目 id（`时刻36-序号36`）。 */
  readonly id: string
  /** 时刻（毫秒）。 */
  readonly at: number
  /** 回合 id。 */
  readonly turnId: string
  /** 会话 id。 */
  readonly conversationId: string
  /** 谁交的。 */
  readonly producer: string
  /** 她选的档。 */
  readonly chosen: TraceChosen
  /** 判定因子（已按 `|weight|` 降序排好）。 */
  readonly factors: readonly TraceFactor[]
  /** 闸门判定。 */
  readonly gates: readonly TraceGate[]
  /** 引用 id。 */
  readonly refs: readonly string[]
  /** 她说出口的那一段（已脱敏、已截断；关了就是空串）。 */
  readonly excerpt: string
  /** 补充说明（已脱敏、已截断）。 */
  readonly note: string
  /** 是否有字段在入库时被截断。 */
  readonly truncated: boolean
}

/** 一次写入的结果。 */
export interface RecordResult {
  /** 是否收下（收下即进内存环）。 */
  readonly ok: boolean
  /** 条目 id（拒收时没有）。 */
  readonly id?: string
  /** 是否真的落到磁盘。 */
  readonly stored: boolean
  /** 原因；`ok` 时省略。 */
  readonly reason?: TraceReason
  /** 一句中文说明。 */
  readonly message?: string
}

/** 查询入参。 */
export interface TraceQuery {
  /** 最多几条。省略用配置值。 */
  readonly limit?: number
  /** 只看这个会话。 */
  readonly conversationId?: string
  /** 只看这个生产者。 */
  readonly producer?: string
  /** 只要这个时刻之后的。 */
  readonly since?: number
}

/** 一次解释。 */
export interface ExplainView {
  /** 命中的条目。 */
  readonly entry: TraceEntry
  /** 一句中文解释，**给面板与审计读**。 */
  readonly sentence: string
}

/** 累计计数（只在内存）。 */
export interface TraceCounters {
  /** 收下的条数。 */
  readonly recorded: number
  /** 拒收的条数。 */
  readonly rejected: number
  /** 写盘失败次数。 */
  readonly writeFailed: number
  /** 清掉的旧文件数。 */
  readonly pruned: number
}

/** 现状快照。 */
export interface TraceStats {
  /** 服务是否可用（未卸载）。 */
  readonly available: boolean
  /** 是否真的在写盘。 */
  readonly stored: boolean
  /** 内存环里现有几条。 */
  readonly entries: number
  /** 内存环上限。 */
  readonly capacity: number
  /** 日志目录（没有路径服务时是空串）。 */
  readonly dir: string
  /** 累计计数。 */
  readonly counters: TraceCounters
}

/** 对外服务。 */
export interface NarrativeLogService {
  /** 是否可用（未卸载）。 */
  readonly available: boolean
  /** 是否真的在写盘（`false` 时只在内存环里）。 */
  readonly stored: boolean

  /**
   * 记一条。**永不抛错**。
   *
   * 收下即进内存环；写盘失败不回滚内存（面板还能看到这一条，只是重启后没了）。
   */
  record(input: unknown): RecordResult

  /** 按回合 id 解释。先查内存环，再查当天文件。找不到返回 `undefined`。 */
  explain(turnId: string): ExplainView | undefined

  /** 最近若干条，**新的在前**。只查内存环。 */
  recent(query?: TraceQuery): readonly TraceEntry[]

  /** 读某一天的文件（`YYYY-MM-DD`）。读不出来返回空数组。 */
  read(dayKey: string): readonly TraceEntry[]

  /** 把一条条目说成人话。纯函数，不查任何东西。 */
  why(entry: TraceEntry): string

  /**
   * 清掉早于保留期的日志文件。**只删本包自己命名的文件**。
   * 不会自动执行：由面板或维护动作显式调用。
   */
  prune(): number

  /** 现状快照。 */
  stats(): TraceStats

  /** 卸载（幂等）。 */
  dispose(): void
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
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

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  prepareFile(filePath: string): string
  exists(filePath: string): boolean
}

/** O-003 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
  dayKey(epoch?: number): string
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
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

/** O-005 的解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源的结构对位（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
