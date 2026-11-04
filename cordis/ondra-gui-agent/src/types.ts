/**
 * O-072 `ondra-gui-agent` 的对外契约。**档位〔研〕**。
 *
 * ## 手册给了什么（逐字）
 *
 * master-plan §5「L6 端侧」边界铁律：
 *
 * ```
 * gui-agent 单步决策环、写操作逐条确认、检测到已填表单立即收手。
 * ```
 *
 * master-plan §9.11 端侧实证（讲的是**旧项目**的实现状态）：
 *
 * ```
 * gui-agent：已实现 observe（screencapture + 前台 App）、executeStep（仅 click/type/key，
 * 走 osascript）、classifyRisk（type/click/system）、审计 jsonl；
 * 「三层安全网」「表单红线」「dailyBudget 计量」只有注释与文档，无代码；
 * classifyRisk 永不返回 readonly。
 * ```
 *
 * master-plan §16.3：端侧同类各自独立插件、独立权限声明、独立开关、默认全关；
 * **只读能力不得因同组其他插件被授权而获得写权限**。
 *
 * 手册 §8.7（分级自动审批三档）说明「高风险要弹确认、`organ_*` 算自己人」，
 * 但它被点名归 `ondra-privacy` / `ondra-startup-check` 一级的**全局配置**，
 * 不是本插件的字段——本包只实现「一个动作要不要确认」这一层判定，
 * 三档口径若接入，由调用方把 `confirmThreshold` 换算成对应值传进来（见 README 限制 6）。
 *
 * ## 台账职责列里那句「手册补」的核对结果（必须写清）
 *
 * 台账 O-072 写「**手册补：三层安全网必须落地**（危险区黑名单 / App 白名单 / 动作确认阈值）」。
 * 本轮全文检索 `Ondra-dev-handbook.md`：`gui` 仅 12 处命中、无 gui-agent 专章；
 * `危险区` / `黑名单` / `三层安全网` **0 命中**。也就是说这句话**在手册里找不到出处**，
 * 它是从 master-plan §9.11「旧实现只写在注释里」反推出来的施工要求。
 *
 * 处理方式：**按台账要求把三层都实现**（它是对的方向，且与 §9.11 的缺口清单一致），
 * 但把「这句话没有手册出处」如实登记在台账与本文件头——
 * 免得下一个人去手册里找一段不存在的规范。
 *
 * ## 为什么风险分级必须真的能返回 `readonly`
 *
 * §9.11 明确指出旧实现 `classifyRisk` **永不返回 readonly**：观察本身就是读动作，
 * 却和点击同档，于是「只看不动」也要过一遍确认闸门——用户很快会永久关掉确认，
 * 三层安全网随之一起失效。本包的 `observe` 恒为 `readonly`，且 `readonly` 不进确认阈值。
 *
 * ## 为什么审计里没有「输入了什么」
 *
 * `AuditEntry` **没有** `text` 字段，只有 `textChars`（长度）。
 * 输入框里可能是密码、身份证、验证码——审计文件是长期留存物，
 * 记正文等于把凭据抄进一个 0600 也挡不住备份同步的角落。
 * 这是类型层约束：审计端口想写正文也写不进去（与 O-070「进程不取命令行」同一手法）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const GUI_SERVICE_KEY = 'ondra-gui-agent'

/** 名字合规正则（服务键 / 工具名 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 工具名（连字符）。
 *
 * 旧项目这一项**没有对外工具名**（它是壳内部调用），所以四个名字是本轮自定，
 * 已登记待裁决。命名遵守 §8.4：全小写、连字符、无点号。
 */
export const TOOL_NAMES = Object.freeze({
  observe: 'gui-observe',
  click: 'gui-click',
  type: 'gui-type',
  key: 'gui-key',
})

/** 能力键（配置里用，也是 `enabledTools` 的取值）。 */
export type ToolKey = keyof typeof TOOL_NAMES

/** 全部能力键（顺序即描述顺序）。 */
export const TOOL_KEYS: readonly ToolKey[] = Object.freeze(['observe', 'click', 'type', 'key'])

/** 观察动作的超时（毫秒）。截屏 + 取前台应用都是本地操作，5 秒足够。 */
export const OBSERVE_TIMEOUT_MS = 5_000

/**
 * 执行动作的超时（毫秒）。
 *
 * 给到 10 秒而不是 5 秒：macOS 首次触发「辅助功能」授权时会弹系统对话框，
 * 那一次一定超 5 秒。超时更短的症状是「第一次永远失败」，用户会以为是插件坏了。
 */
export const ACT_TIMEOUT_MS = 10_000

/** 超时下界（毫秒）。 */
export const TIMEOUT_FLOOR = 1_000

/** 超时上界（毫秒）。30 秒以上就该问「为什么一次点击要等半分钟」。 */
export const TIMEOUT_CEIL = 30_000

/**
 * 观察的有效期（毫秒）。
 *
 * 决策必须基于「当下画面」。30 秒前的截图里那个按钮还在原位，
 * 但用户可能已经切走了窗口——此时按坐标点击会点到完全不相干的地方。
 */
export const OBSERVATION_TTL_MS = 30_000

/** 观察有效期上界（毫秒）：5 分钟。再长就等于允许「拿早上的截图做晚上的决定」。 */
export const TTL_CEIL = 300_000

/** 两次真实动作之间的最小间隔（毫秒）。防连点风暴。 */
export const STEP_INTERVAL_MS = 1_500

/** 间隔上界（毫秒）。 */
export const INTERVAL_CEIL = 10_000

/**
 * 每日动作预算（次）。
 *
 * §9.11 说旧实现的 `dailyBudget`「只有注释与文档，无代码」——本包把它真的做成计数。
 * 200 次是工程判断（一个人一天手动点两百次已经很夸张），已登记待裁决。
 */
export const DAILY_BUDGET = 200

/** 每日预算上界（次）。 */
export const BUDGET_CEIL = 2_000

/** 确认票有效期（毫秒）。 */
export const CONFIRM_TTL_MS = 120_000

/** 确认票有效期上界（毫秒）。 */
export const CONFIRM_TTL_CEIL = 600_000

/** 单次输入的字符上限。 */
export const TEXT_MAX = 500

/** 输入字符硬顶。超过它就该走别的路径（粘贴、脚本），而不是一个字一个字敲。 */
export const TEXT_CEIL = 2_000

/** 坐标量化网格（像素）。审计里只记量化后的坐标。 */
export const COORD_GRID = 10

/** 审计在内存里保留的条数。 */
export const AUDIT_KEEP = 200

/** 审计保留条数上界。 */
export const AUDIT_KEEP_CEIL = 2_000

/** 审计文件名（落在 `user/` 下）。 */
export const AUDIT_FILE = 'gui-audit.jsonl'

/** 审计文件轮转阈值（字节）。 */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024

/**
 * 合法按键名。
 *
 * 只认小写字母开头、由小写字母/数字/连字符组成，最长 24——
 * 这个形状**同时**满足「人读得懂」（`enter` / `cmd-s` / `escape`）与
 * 「不可能被拼成脚本注入」（没有引号、分号、空格、反斜杠）。
 * 后端实现必须按白名单再收一遍，不能把字符串直接拼进 AppleScript。
 */
export const KEY_RE = /^[a-z][a-z0-9-]{0,23}$/

/** 风险四级（闭集）。 */
export type RiskLevel = 'readonly' | 'low' | 'high' | 'blocked'

/** 四级全体（顺序即严重度递增）。 */
export const RISK_LEVELS: readonly RiskLevel[] = Object.freeze(['readonly', 'low', 'high', 'blocked'])

/** 动作种类（闭集）。 */
export type ActionKind = 'observe' | 'click' | 'type' | 'key'

/** 动作全体。 */
export const ACTION_KINDS: readonly ActionKind[] = Object.freeze(['observe', 'click', 'type', 'key'])

/** 表单状态。**`unknown` 不是 `none`**（见 `policy.ts` 的裁决）。 */
export type FormState = 'none' | 'filled' | 'unknown'

/** 决策原因码（闭集）。 */
export type DecisionCode =
  | 'ok'
  | 'disabled'
  | 'no-runner'
  | 'no-observation'
  | 'stale-observation'
  | 'unknown-action'
  | 'bad-target'
  | 'text-too-long'
  | 'app-not-allowed'
  | 'danger-zone'
  | 'form-red-line'
  | 'risk-over-ceiling'
  | 'step-cooldown'
  | 'budget-exhausted'
  | 'need-confirm'

/** 执行结果码（闭集）。 */
export type ActCode =
  | 'ok'
  | 'no-ticket'
  | 'ticket-expired'
  | 'not-approved'
  | 'cooldown'
  | 'budget-exhausted'
  | 'no-runner'
  | 'failed'
  | 'timeout'

/** 审计里的结论码（决策码与执行码的并集）。 */
export type AuditCode = DecisionCode | ActCode

/** 不能用的原因（面板用）。 */
export type GuiReason = 'disabled' | 'no-runner'

/** 屏幕尺寸（像素）。 */
export interface ScreenBox {
  /** 宽（像素）。 */
  readonly width: number
  /** 高（像素）。 */
  readonly height: number
}

/** 前台应用。 */
export interface Foreground {
  /** 应用名（系统给什么就是什么，不猜）。 */
  readonly app: string
  /** 窗口标题（可选；标题里常有文档名，面板默认不展示）。 */
  readonly title?: string
}

/**
 * 一次观察。
 *
 * **没有截图路径**：路径里带用户名（`/Users/<名>/…`），
 * 而观察结果会被写进模型可见的正文——那是隐私泄漏的最短路径。
 * 需要看图的是视觉能力，走各自的通道，不经本结构。
 */
export interface Observation {
  /** 观察时刻（毫秒）。 */
  readonly at: number
  /** 屏幕尺寸。 */
  readonly screen: ScreenBox
  /** 前台应用。 */
  readonly foreground: Foreground
  /** 表单状态。 */
  readonly formState: FormState
  /** 截图体积（字节）；没截图时为 `undefined`。 */
  readonly screenshotBytes?: number
}

/** 屏幕坐标（像素，左上原点）。 */
export interface Point {
  /** 横坐标。 */
  readonly x: number
  /** 纵坐标。 */
  readonly y: number
}

/**
 * 危险区（归一化矩形，0–1）。
 *
 * 用比例而不是像素：换一台分辨率不同的机器，像素矩形会整体错位，
 * 而错位的后果是「黑名单拦不到该拦的地方」——这比拦错更危险。
 */
export interface ZoneSpec {
  /** 区名（审计与面板用）。 */
  readonly id: string
  /** 左边界（0–1）。 */
  readonly x: number
  /** 上边界（0–1）。 */
  readonly y: number
  /** 宽（0–1）。 */
  readonly w: number
  /** 高（0–1）。 */
  readonly h: number
}

/** 一次单步请求。 */
export interface StepRequest {
  /** 动作。 */
  readonly action: ActionKind
  /** 观察结果；省略则用最近一次 `observe()`（仍受有效期约束）。 */
  readonly observation?: Observation
  /** 点击坐标（`click` 必填）。 */
  readonly point?: Point
  /** 要输入的文本（`type` 必填）。 */
  readonly text?: string
  /** 按键名（`key` 必填，须匹配 `KEY_RE`）。 */
  readonly key?: string
}

/** 判定输入。 */
export interface DecideInput {
  /** 请求。 */
  readonly request: StepRequest
  /** 观察结果（已解析过来源）。 */
  readonly observation: Observation
  /** 时区无关的「现在」。 */
  readonly now: number
  /** 配置。 */
  readonly settings: DecideConfig
  /** 后端是否就绪（有 `observe` 能力）。 */
  readonly runnerReady: boolean
}

/**
 * 判定所需的配置子集。
 *
 * 单独抽出而不直接用 `settings.Config`：`policy.ts` 是纯函数，
 * 它只要这几个值，不该知道配置里还有审计、日志之类的事。
 */
export interface DecideConfig {
  /** 总开关。 */
  readonly enable: boolean
  /** App 白名单（空 = 一个都不许）。 */
  readonly appAllowList: readonly string[]
  /** 危险区。 */
  readonly dangerZones: readonly ZoneSpec[]
  /** 是否启用表单红线。 */
  readonly formRedLine: boolean
  /** 风险上限。 */
  readonly maxRisk: RiskLevel
  /** 确认阈值。 */
  readonly confirmThreshold: RiskLevel
  /** 观察有效期（毫秒）。 */
  readonly observationTtlMs: number
  /** 输入字符上限。 */
  readonly textMax: number
}

/** 一次判定。 */
export interface StepDecision {
  /** 是否没被否决（`need-confirm` 也算「没被否决」，但要票）。 */
  readonly allowed: boolean
  /** 风险等级。 */
  readonly risk: RiskLevel
  /** 是否需要人确认。 */
  readonly requiresConfirm: boolean
  /** 原因码。 */
  readonly code: DecisionCode
  /** 一句话说明（面板用，不含标题与正文）。 */
  readonly reason: string
  /** **指路**：告诉它该改用什么办法（手册「拒绝提示从禁止改成指路」）。 */
  readonly hint?: string
  /** 命中的危险区 id。 */
  readonly zone?: string
  /** 判定时的前台应用。 */
  readonly app: string
  /** 判定时刻。 */
  readonly at: number
}

/** 确认票状态。`pending` 必须由宿主/界面批准，模型没有批准通道。 */
export type TicketStatus = 'pending' | 'approved'

/** 一张确认票（对外只暴露这些；请求正文留在服务内部）。 */
export interface StepTicket {
  /** 票号。 */
  readonly id: string
  /** 动作。 */
  readonly action: ActionKind
  /** 风险等级。 */
  readonly risk: RiskLevel
  /** 状态。 */
  readonly status: TicketStatus
  /** 签发时刻。 */
  readonly issuedAt: number
  /** 过期时刻。 */
  readonly expiresAt: number
}

/** 一次规划的结果。 */
export interface StepPlan {
  /** 判定。 */
  readonly decision: StepDecision
  /** 票（`allowed` 且未过期时才有；被否决时为 `null`）。 */
  readonly ticket: StepTicket | null
}

/** 执行结果。 */
export interface ActResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 动作（票不存在时拿不到，故可选）。 */
  readonly action?: ActionKind
  /** 结果码。 */
  readonly code: ActCode
  /** 一句中文说明。 */
  readonly detail: string
  /** **指路**。 */
  readonly hint?: string
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 审计条目的 id（便于对账）。 */
  readonly auditId: string
}

/** 观察结果。 */
export interface ObserveResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 观察数据（失败时为 `null`）。 */
  readonly observation: Observation | null
  /** 说明。 */
  readonly detail: string
  /** **指路**。 */
  readonly hint?: string
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/**
 * 一条审计。
 *
 * **没有正文**：只有 `textChars`。理由见文件头。
 */
export interface AuditEntry {
  /** 条目 id。 */
  readonly id: string
  /** 时刻。 */
  readonly at: number
  /** 动作。 */
  readonly action: ActionKind
  /** 风险。 */
  readonly risk: RiskLevel
  /** 结论码。 */
  readonly code: AuditCode
  /** 前台应用（判定时）。 */
  readonly app: string
  /** 命中的危险区。 */
  readonly zone?: string
  /** 坐标（已量化到 `COORD_GRID`）。 */
  readonly point?: Point
  /** 输入字符数。 */
  readonly textChars?: number
  /** 按键名（键名不是隐私）。 */
  readonly key?: string
  /** 截图体积（字节；观察条目用）。 */
  readonly bytes?: number
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 审计外送端口（宿主可接文件、界面或日志）。 */
export interface AuditSink {
  /** 收一条（**实现方不得抛错**，抛了本包会吞掉并计数）。 */
  append(entry: AuditEntry): void
}

/** 后端执行结果。 */
export type RunnerResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: 'no-runner' | 'unsupported' | 'failed'; readonly detail: string }

/**
 * 图形界面后端端口。
 *
 * 本包**不自带实现**：见 README 限制 1。契约只两条——
 * 一条「看」，一条「做」，都由实现方负责真正的截屏与合成事件。
 */
export interface GuiRunner {
  /** 来源名（面板显示）。 */
  readonly id: string
  /** 支持的动作。`observe` 必须支持，否则本包判 `no-runner`。 */
  readonly supports: readonly ActionKind[]
  /** 看一眼。 */
  observe(timeoutMs: number): Promise<RunnerResult<Observation>>
  /** 做一个动作。**必须只做这一下**，不许内部重试、不许连点。 */
  act(input: RunnerActInput, timeoutMs: number): Promise<RunnerResult<RunnerOutcome>>
}

/** 交给后端的动作。 */
export interface RunnerActInput {
  /** 动作。 */
  readonly action: ActionKind
  /** 坐标（`click`）。 */
  readonly point?: Point
  /** 文本（`type`）。 */
  readonly text?: string
  /** 按键（`key`）。 */
  readonly key?: string
}

/** 后端回报。 */
export interface RunnerOutcome {
  /** 一句说明（不含正文）。 */
  readonly detail: string
}

/** 工具参数声明。 */
export interface ParamSpec {
  /** 类型。 */
  readonly type: 'string' | 'number' | 'object' | 'boolean'
  /** 必填。 */
  readonly required: boolean
  /** 说明。 */
  readonly description: string
}

/** 工具描述（模型侧可见）。 */
export interface ToolDescriptor {
  /** 工具名。 */
  readonly name: string
  /** 中文短标题。 */
  readonly title: string
  /** 能力说明。**必须写明「一次只做一步」**。 */
  readonly description: string
  /** 本工具会改变屏幕状态（`gui-observe` 为 `false`）。 */
  readonly mutates: boolean
  /** 单次超时（毫秒）。 */
  readonly timeoutMs: number
  /** 参数表。 */
  readonly parameters: Readonly<Record<string, ParamSpec>>
}

/** 工具返回（给模型）。 */
export interface ToolResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 工具名。 */
  readonly tool: string
  /** 原因码。 */
  readonly code: DecisionCode | ActCode | 'bad-arg'
  /** 模型可见正文。 */
  readonly text: string
  /** 一句说明（面板用）。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
  /** 待确认的票号（仅在需要人确认时给出）。 */
  readonly ticket?: string
  /** 审计条目 id。 */
  readonly auditId?: string
}

/** 把工具交给宿主的注册器（宿主侧适配，本包不 import 工具包）。 */
export type ToolRegistrar = (
  descriptor: ToolDescriptor,
  handler: (args: unknown) => Promise<ToolResult>,
) => () => void

/** 插件现状。 */
export interface GuiStatus {
  /** 开关开着没有。 */
  readonly enabled: boolean
  /** 现在能不能用（= `enabled && runnerReady`）。 */
  readonly available: boolean
  /** 后端就绪没有（有 `observe` 能力）。 */
  readonly ready: boolean
  /** 不能用的原因。 */
  readonly reason?: GuiReason
  /** 后端名（没有为 `none`）。 */
  readonly runner: string
  /** 白名单（原样返回，面板要能看见「空的」）。 */
  readonly apps: readonly string[]
  /** 危险区 id 列表。 */
  readonly zones: readonly string[]
  /** 开着的工具。 */
  readonly tools: readonly ToolKey[]
  /** 待确认票数。 */
  readonly pending: number
  /** 今日预算剩余。 */
  readonly budgetLeft: number
  /** 预算口径：`day` 表示按自然日重置，`session` 表示时钟不给 `dayKey`、只在进程内累计。 */
  readonly budgetScope: 'day' | 'session'
  /** 审计落在哪。 */
  readonly audit: 'memory' | 'file'
}

/** 计数（对外只读）。 */
export interface GuiStats {
  /** 规划次数。 */
  readonly plans: number
  /** 被否决次数。 */
  readonly blocked: number
  /** 需要确认次数。 */
  readonly confirmations: number
  /** 已批准次数。 */
  readonly approved: number
  /** 已否决票数。 */
  readonly rejected: number
  /** 执行次数（含失败）。 */
  readonly acts: number
  /** 执行成功次数。 */
  readonly ok: number
  /** 执行失败次数。 */
  readonly failed: number
  /** 超时次数。 */
  readonly timeouts: number
  /** 后端缺席次数。 */
  readonly noRunner: number
  /** 观察次数。 */
  readonly observed: number
  /** 观察失败次数。 */
  readonly observeFailed: number
  /** 因限频被挡次数。 */
  readonly throttled: number
  /** 因预算被挡次数。 */
  readonly budgetHit: number
  /** 审计写入失败次数。 */
  readonly auditFailed: number
}

/** 审计内部计数（可变，见 `service.ts`）。 */
export interface AuditCounters {
  /** 已收条数。 */
  readonly kept: number
  /** 已落盘条数。 */
  readonly written: number
  /** 落盘失败条数。 */
  readonly failed: number
  /** 当前模式。 */
  readonly mode: 'memory' | 'file'
}

/** O-001 的日志名前缀子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/**
 * O-003 时钟子集。
 *
 * `dayKey` 是**可选**的：调用类服务时若上游给的是精简实现，
 * 调用不存在的函数会抛错并让整个 `plan()` 失败。缺席时预算退化成「按进程」，
 * 由 `status().budgetScope` 如实报出去，而不是假装按天重置。
 */
export interface ClockLike {
  now(): number
  dayKey?(epoch?: number): string
}

/** O-002 路径子集。 */
export interface PathLike {
  fileIn(area: 'user', ...segments: string[]): string
  ensure(area: 'user', ...segments: string[]): string
  prepareFile(filePath: string): string
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
  readonly sensitive?: boolean
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

/** O-005 的服务形状。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}

/** 本插件对外提供的服务。 */
export interface GuiService {
  /** 开关开着没有。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: GuiReason
  /** 后端就绪没有。 */
  readonly ready: boolean
  /** 开着的工具描述（模型侧可见的那一份）。 */
  descriptors(): readonly ToolDescriptor[]
  /** 调一个工具。**永不抛错**。 */
  invoke(tool: string, args?: unknown): Promise<ToolResult>
  /** 看一眼（会更新「最近一次观察」）。 */
  observe(timeoutMs?: number): Promise<ObserveResult>
  /** 规划一步（只判定，不动手）。 */
  plan(request: StepRequest): StepPlan
  /** 批准一张待确认票。**只给宿主/界面调用，模型没有这个工具**。 */
  approve(ticketId: string): boolean
  /** 否决一张待确认票。 */
  deny(ticketId: string): boolean
  /** 执行一张票。票**一次即焚**，无论成败。 */
  act(ticketId: string): Promise<ActResult>
  /** 最近一次观察（没有为 `null`）。 */
  lastObservation(): Observation | null
  /** 审计（最近 N 条，倒序）。 */
  audit(limit?: number): readonly AuditEntry[]
  /** 换后端。 */
  useRunner(runner: GuiRunner | null): void
  /** 换注册器（`null` 会撤掉已注册的全部工具）。 */
  useRegistrar(registrar: ToolRegistrar | null): void
  /** 换审计出口（`null` 只留内存）。 */
  useAuditSink(sink: AuditSink | null): void
  /** 现状。 */
  status(): GuiStatus
  /** 计数。 */
  stats(): GuiStats
}
