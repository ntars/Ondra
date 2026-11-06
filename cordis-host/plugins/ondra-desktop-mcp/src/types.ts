/**
 * O-070 `ondra-desktop-mcp` 的对外契约。**档位〔研〕**（电脑只读能力面，生态无同形插件件）。
 *
 * ## 手册给的依据（逐字）
 *
 * master-plan §9.11「端侧实证」：
 *
 * ```
 * desktop-mcp：desktop.processes（不取命令行，防 token 泄露）/ foreground /
 * clipboardMeta（只返回长度）/ findFiles（关键词必填，深度 ≤2、≤30 条）/ sysinfo，timeout 5s。
 * ```
 *
 * 手册 §6.6 / §14（宿主感观通道）：
 *
 * ```
 * 暴露系统指标（内存/CPU/电量/前台应用），刻意不暴露某些项（进程不取命令行、剪贴板只返回长度）。
 * 设计取舍三条：只读、限频、不做推断；拒绝提示从"禁止"改成"指路"（告诉它该用什么替代）。
 * 缺一条链：低电量时她该有什么反应 —— desktop-mcp 输出 battery 事件 → life-rhythm 消费。
 * ```
 *
 * 手册 §10.1 / 第九部分 §3-1：**「工具输出沙箱」是架构级前置**，
 * 而 `desktop-mcp` 被点名「全部走沙箱」（Playwright 快照 315KB → 5.4KB 是同类证据）。
 *
 * master-plan §9.12：旧界面给 desktop-mcp 填的 `endpoint` 是**假字段**（源码走本地命令）。
 * → 本包**没有 `endpoint`**。数据从哪来由 `DesktopBridge` 端口决定。
 *
 * ## 一处必须先讲清的口径冲突：工具名不能带点
 *
 * §9.11 写成 `desktop.processes` 这种**点号**形式，而手册 §8.4 是硬约束：
 *
 * > 服务键、**工具名**、配置键都必须匹配 `^[a-z][a-z0-9_-]{1,63}$`。事故教训：
 * > 工具名/参数名不合规，模型侧直接拒绝。
 *
 * 点号不匹配。两条同时成立的唯一读法是：§9.11 那一列是**能力清单**，不是最终工具名。
 * 故发布名统一改成连字符（与 O-069 同一处理，台账已记这条「手册内部冲突」）。
 *
 * ## 「不取命令行」怎么保证不是一句承诺
 *
 * `ProcessItem` **类型里根本没有存放命令行的字段**，端口实现想给也给不出来。
 * 这是三重防线里最硬的一层（能力层没有、参数层没有、类型层没有），
 * 比「读取后再过滤」可靠：过滤会漏，类型不会。
 *
 * 同理 `ClipboardMeta` 没有 `text` 字段——剪贴板内容在任何一条路径上都进不了模型上下文。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const DESKTOP_SERVICE_KEY = 'ondra-desktop-mcp'

/** 名字合规正则（服务键 / 工具名 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 工具名（连字符；与手册 §9.11 点号写法的对应关系见文件头）。 */
export const TOOL_NAMES = Object.freeze({
  processes: 'desktop-processes',
  foreground: 'desktop-foreground',
  clipboard: 'desktop-clipboard-meta',
  findFiles: 'desktop-find-files',
  sysinfo: 'desktop-sysinfo',
})

/** 能力键（配置里用，也是 `enabledTools` 的取值）。 */
export type ToolKey = keyof typeof TOOL_NAMES

/** 全部能力键（顺序即描述顺序）。 */
export const TOOL_KEYS: readonly ToolKey[] = Object.freeze([
  'processes',
  'foreground',
  'clipboard',
  'findFiles',
  'sysinfo',
])

/**
 * 单次调用超时（毫秒）。master-plan §9.11：`timeout 5s`。
 *
 * **与 O-069 的 8 秒刻意不同**：手机侧要跨 USB/adb 一跳，电脑侧是本地内存读数。
 * 抄成 8 秒的后果不是错，而是「本该立刻返回的读数被允许慢到 8 秒」，
 * 面板上一切正常，只是每次调用都让人多等一截。
 */
export const CALL_TIMEOUT_MS = 5_000

/** 超时下界（毫秒）：1 秒。 */
export const TIMEOUT_FLOOR = 1_000

/** 超时上界（毫秒）：20 秒。超过它就该问「为什么一次本地读数要等这么久」。 */
export const TIMEOUT_CEIL = 20_000

/** 默认条数（进程 / 文件）。 */
export const DEFAULT_LIMIT = 10

/** 进程条数硬顶：50。 */
export const LIMIT_CEIL = 50

/** 文件检索条数硬顶：**30**（§9.11 逐字「≤30 条」）。 */
export const FILE_LIMIT_CEIL = 30

/** 文件检索深度硬顶：**2**（§9.11 逐字「深度 ≤2」）。 */
export const FILE_DEPTH_CEIL = 2

/**
 * 一次检索最多看多少个目录条目：2000。
 *
 * 这不是性能参数，是**「一次只读不许把磁盘扫一遍」**的预算。
 * 超预算就带着已找到的结果提前收手并标 `partial`，而不是让调用等下去。
 */
export const FILE_SCAN_ENTRY_CEIL = 2_000

/** 检索关键词最小长度：2。一个字的关键词会把「几乎所有文件」都算命中。 */
export const KEYWORD_MIN = 2

/** 检索关键词最大长度：64。 */
export const KEYWORD_MAX = 64

/** 进程名截断长度。 */
export const NAME_MAX = 60

/** 窗口标题截断长度。 */
export const TITLE_MAX = 80

/** 单次结果进上下文的最大字符数（工具输出沙箱的硬闸）。 */
export const RENDER_CHARS_MAX = 1_200

/** 单次结果最多几行。 */
export const RENDER_LINES_MAX = 30

/** 低电量阈值（百分比）。 */
export const BATTERY_LOW = 20

/** 严重低电量阈值（百分比）。 */
export const BATTERY_CRITICAL = 10

/** 进程排序键。 */
export type SortKey = 'cpu' | 'mem' | 'name'

/** 剪贴板类型（只看形态，不看内容）。 */
export type ClipboardKind = 'text' | 'image' | 'files' | 'empty' | 'unknown'

/** 电量档位。 */
export type BatteryBand = 'critical' | 'low' | 'normal' | 'charging' | 'unknown'

/**
 * 调用结论（闭集）。每个码一个排查方向（纪律 143：同一个码别表示两种相反处境）。
 */
export type InvokeReason =
  /** 成功。 */
  | 'ok'
  /** 插件关着。 */
  | 'disabled'
  /** 这个工具没在 `enabledTools` 里。 */
  | 'tool-disabled'
  /** 没有这个工具。 */
  | 'unknown-tool'
  /** 参数不合规（缺必填、超范围、空关键词）。 */
  | 'bad-arg'
  /** 没有数据来源（`DesktopBridge` 未注入）。 */
  | 'no-bridge'
  /** 来源说不支持这个能力。 */
  | 'unsupported'
  /** 文件检索没配任何根目录。 */
  | 'no-roots'
  /** 被限频挡住（手册「限频」）。 */
  | 'rate-limited'
  /** 超时（5 秒没回来）。 */
  | 'timeout'
  /** 来源明确拒绝（系统权限没给）。 */
  | 'denied'
  /** 来源报错。 */
  | 'error'
  /** 超时之后才回来的结果，已丢弃。 */
  | 'late'

/** 数据来源失败原因（闭集）。 */
export type BridgeFailure = 'unsupported' | 'denied' | 'error' | 'timeout'

/** 数据来源的统一返回。 */
export type BridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: BridgeFailure; readonly detail: string }

/** 参数规格（模型侧可见的最小形状）。 */
export interface ParamSpec {
  /** 类型。 */
  readonly type: 'string' | 'number' | 'boolean'
  /** 是否必填。 */
  readonly required?: boolean
  /** 给模型看的一句话说明。 */
  readonly description: string
  /** 字符串/数字的枚举候选。 */
  readonly values?: readonly string[]
  /** 数字下界。 */
  readonly min?: number
  /** 数字上界。 */
  readonly max?: number
}

/** 工具描述（模型侧可见，也是 `useRegistrar()` 的入参）。 */
export interface ToolDescriptor {
  /** 工具名（连字符，符合 §8.4）。 */
  readonly name: string
  /** 中文短标题（面板用）。 */
  readonly title: string
  /** 给模型看的能力说明。**必须写明只读**。 */
  readonly description: string
  /** 恒为 `true`：本包没有任何写能力。 */
  readonly readOnly: true
  /** 单次超时（毫秒）。 */
  readonly timeoutMs: number
  /** 参数表。 */
  readonly parameters: Readonly<Record<string, ParamSpec>>
}

/**
 * 一条进程。**没有命令行列**（见文件头）。
 *
 * 端口实现若多给了字段，`privacy.poseProcess()` 会把它丢掉——
 * 类型层挡住「想写」，整型层挡住「偷偷写进来」。
 */
export interface ProcessItem {
  /** 进程名（截断）。 */
  readonly name: string
  /** 进程号。 */
  readonly pid: number
  /** CPU 占用（百分比；来源没给为 -1）。 */
  readonly cpu: number
  /** 内存占用（MB；来源没给为 -1）。 */
  readonly memMb: number
}

/** 前台应用。 */
export interface ForegroundInfo {
  /** 应用名（截断）。 */
  readonly app: string
  /** 窗口标题（截断；`includeWindowTitle=false` 时为空串）。 */
  readonly title: string
  /** 进程号（来源没给为 -1）。 */
  readonly pid: number
  /** 取到的时刻（毫秒）。 */
  readonly at: number
}

/**
 * 剪贴板元信息。**没有内容字段**（见文件头）。
 */
export interface ClipboardMeta {
  /** 形态。 */
  readonly kind: ClipboardKind
  /** 字符数（非文本为 0）。 */
  readonly chars: number
  /** 行数（非文本为 0）。 */
  readonly lines: number
  /** 文件数（仅 `files` 形态有意义）。 */
  readonly pieces: number
  /** 取到的时刻（毫秒）。 */
  readonly at: number
}

/** 一条文件命中。 */
export interface FileHit {
  /** 文件名（截断）。 */
  readonly name: string
  /** 相对根目录的路径（分段用 `/`）。 */
  readonly path: string
  /** 类型。 */
  readonly kind: 'file' | 'dir'
  /** 字节数（目录为 0）。 */
  readonly size: number
  /** 修改时刻（毫秒）。 */
  readonly mtime: number
}

/** 一次根目录扫描的结果。 */
export interface FindOutcome {
  /** 命中。 */
  readonly hits: readonly FileHit[]
  /** 看过多少条目。 */
  readonly scanned: number
  /** 是否因为条目预算提前收手。 */
  readonly partial: boolean
}

/** 电池信息。 */
export interface BatteryInfo {
  /** 电量（0–100；来源没给为 -1）。 */
  readonly level: number
  /** 是否在充电。 */
  readonly charging: boolean
  /** 取到的时刻（毫秒）。 */
  readonly at: number
}

/** 系统状态。 */
export interface SysInfo {
  /** 平台标识（如 `darwin`）。 */
  readonly platform: string
  /** CPU 架构（如 `arm64`）。 */
  readonly arch: string
  /** 逻辑核数。 */
  readonly cores: number
  /** 总内存（MB）。 */
  readonly totalMb: number
  /** 空闲内存（MB）。 */
  readonly freeMb: number
  /** 1/5/15 分钟负载（取不到为空数组）。 */
  readonly loadAvg: readonly number[]
  /** 开机时长（秒）。 */
  readonly uptimeSec: number
  /** 电池（拿不到为 `null`，**不填 0 假装没电**）。 */
  readonly battery: BatteryInfo | null
}

/**
 * 数据来源端口：**本包唯一与操作系统打交道的地方**。
 *
 * `supports` 先声明，调用方在等 5 秒之前就能拿到 `unsupported`——
 * 这是「指路」而不是「等超时」的关键。
 */
export interface DesktopBridge {
  /** 实现标识（日志与面板用）。 */
  readonly id: string
  /** 负责哪些能力。 */
  readonly supports: readonly ToolKey[]
  /** 进程（只读）。 */
  processes(input: { readonly limit: number; readonly sort: SortKey }, timeoutMs: number): Promise<BridgeResult<readonly ProcessItem[]>>
  /** 前台应用（只读）。 */
  foreground(timeoutMs: number): Promise<BridgeResult<ForegroundInfo>>
  /** 剪贴板元信息（只读，无内容）。 */
  clipboardMeta(timeoutMs: number): Promise<BridgeResult<ClipboardMeta>>
  /** 单个根目录下的关键词检索（只读）。 */
  findFiles(
    input: { readonly root: string; readonly keyword: string; readonly depth: number; readonly limit: number },
    timeoutMs: number,
  ): Promise<BridgeResult<FindOutcome>>
  /** 系统状态（只读）。 */
  sysinfo(timeoutMs: number): Promise<BridgeResult<SysInfo>>
}

/** 一次调用的结论。 */
export interface ToolResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 工具名。 */
  readonly tool: string
  /** 原因码。 */
  readonly reason: InvokeReason
  /** 规范返回值（成功时是裁剪后的结构；失败时为 `null`）。 */
  readonly data: unknown
  /** 模型可见正文（已经过沙箱裁剪）。 */
  readonly text: string
  /** 一句中文说明（面板用；**不含窗口标题与路径原文**）。 */
  readonly detail: string
  /** **指路**：失败时告诉它该用什么替代（手册「拒绝提示从禁止改成指路」）。 */
  readonly hint?: string
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 结果是否被裁剪过（截断/超条数/超字符）。 */
  readonly degraded: boolean
  /** 被裁掉的条数（0 = 一条没裁）。 */
  readonly omitted: number
}

/** 插件现状。 */
export interface DesktopStatus {
  /** 开关。 */
  readonly enabled: boolean
  /** 能不能用（开关 + 至少一个工具开着）。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: InvokeReason
  /** 数据来源标识（空 = 没有）。 */
  readonly bridge: string
  /** 数据来源声明负责的能力。 */
  readonly supports: readonly ToolKey[]
  /** 开着的工具。 */
  readonly tools: readonly string[]
  /** 是否有注册器（能把这些工具交给模型）。 */
  readonly registrar: boolean
  /** 配了几个检索根。 */
  readonly roots: number
}

/** 计数。 */
export interface DesktopStats {
  /** 调用总数（含失败）。 */
  readonly calls: number
  /** 成功数。 */
  readonly ok: number
  /** 被限频挡住的次数。 */
  readonly throttled: number
  /** 超时数。 */
  readonly timeouts: number
  /** 迟到被丢弃的结果数。 */
  readonly late: number
  /** 按原因分桶。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 最慢一次耗时（毫秒）。 */
  readonly worstMs: number
  /** 发出过的电量事件数。 */
  readonly batteryEvents: number
}

/** 电量事件（手册 §14 那条缺口链的产出端）。 */
export interface DesktopEvent {
  /** 事件种类。目前只有电量一种。 */
  readonly kind: 'battery'
  /** 档位。 */
  readonly band: BatteryBand
  /** 电量。 */
  readonly level: number
  /** 是否在充电。 */
  readonly charging: boolean
  /** 时刻（毫秒）。 */
  readonly at: number
}

/** 把工具交给宿主的注册器（由宿主侧适配，本包不 import 工具包）。 */
export type ToolRegistrar = (descriptor: ToolDescriptor, handler: (args: unknown) => Promise<ToolResult>) => () => void

/** 本插件对外提供的服务。 */
export interface DesktopService {
  /** 现在能不能用。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: InvokeReason
  /** 开着的工具描述（模型侧可见的那一份）。 */
  descriptors(): readonly ToolDescriptor[]
  /** 调一个工具。**永不抛错**。 */
  invoke(tool: string, args?: unknown): Promise<ToolResult>
  /** 换数据来源。 */
  useBridge(bridge: DesktopBridge | null): void
  /** 换注册器（`null` 会撤掉已注册的全部工具）。 */
  useRegistrar(registrar: ToolRegistrar | null): void
  /** 订阅电量事件。返回退订函数。 */
  subscribe(listener: (event: DesktopEvent) => void): () => void
  /** 最近一次电量读数（没读过为 `null`）。 */
  lastBattery(): BatteryInfo | null
  /** 现状。 */
  status(): DesktopStatus
  /** 计数。 */
  stats(): DesktopStats
}

/* ------------------------------------------------------------------ *
 * 依赖服务的结构对位（不 import 任何 ondra-* 包，master-plan §18.5）
 * ------------------------------------------------------------------ */

/** 日志子集。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-001 的日志名前缀子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟子集。 */
export interface ClockLike {
  now(): number
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
