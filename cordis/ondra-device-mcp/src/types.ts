/**
 * O-069 `ondra-device-mcp` 的对外契约。**档位〔研〕**（手机只读 MCP 面，生态无同形件）。
 *
 * ## 手册给出的全部依据
 *
 * master-plan §9.11「端侧实证」逐字：
 *
 * ```
 * device-mcp：device.notifications / sms / contacts / battery / foreground，全只读，timeout 8s。
 * ```
 *
 * master-plan §9.12（字段错位）：
 *
 * ```
 * device-mcp / desktop-mcp | UI 填 endpoint | 无（走本地命令） | 假字段
 * ```
 *
 * → 本包**没有 `endpoint`**。数据从哪来由 `DeviceBridge` 端口决定，
 * 而不是「填一个地址就以为连上了」。
 *
 * ## 一处必须先讲清的口径冲突：工具名不能带点
 *
 * §9.11 把它们写成 `device.notifications` 这种**点号**形式。
 * 但手册 §8.4 是硬约束：
 *
 * > 服务键、**工具名**、配置键都必须匹配 `^[a-z][a-z0-9_-]{1,63}$`。事故教训：
 * > 工具名/参数名不合规，模型侧直接拒绝。
 *
 * 点号不匹配这个正则。两条同时成立的唯一读法是：§9.11 那一列是**能力清单**，
 * 不是最终工具名。所以本包发布的名字统一改成连字符：
 *
 * | 手册写法（能力） | 本包工具名 |
 * |---|---|
 * | `device.notifications` | `device-notifications` |
 * | `device.sms` | `device-sms` |
 * | `device.contacts` | `device-contacts` |
 * | `device.battery` | `device-battery` |
 * | `device.foreground` | `device-foreground` |
 *
 * 这是**手册内部两条规则的冲突**，按「§8.4 是硬约束、且它给了事故教训」优先。
 * 台账备注已记，简报里也报了。
 *
 * ## 只读的三层含义（缺一层就是假只读）
 *
 * 1. **能力层**：五个工具全部只读，描述里写明「不会修改设备」；
 * 2. **参数层**：没有写参数可传（没有 `package` 可指定、没有 `action` 可执行）；
 * 3. **数据层**：剪贴板式的克制——通知默认**不带正文**，联系人默认**打码**，
 *    短信正文**截断**并标 `truncated`。这一层最容易漏：能力只读不等于数据无害。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const DEVICE_SERVICE_KEY = 'ondra-device-mcp'

/** 名字合规正则（服务键 / 工具名 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 工具名（连字符；与手册 §9.11 的点号写法对应关系见文件头）。 */
export const TOOL_NAMES = Object.freeze({
  notifications: 'device-notifications',
  sms: 'device-sms',
  contacts: 'device-contacts',
  battery: 'device-battery',
  foreground: 'device-foreground',
})

/** 能力键（配置里用，也是 `enabledTools` 的取值）。 */
export type ToolKey = keyof typeof TOOL_NAMES

/** 全部能力键（顺序即描述顺序）。 */
export const TOOL_KEYS: readonly ToolKey[] = Object.freeze([
  'notifications',
  'sms',
  'contacts',
  'battery',
  'foreground',
])

/** 单次调用超时（毫秒）。master-plan §9.11：`timeout 8s`。 */
export const CALL_TIMEOUT_MS = 8_000

/** 超时下界（毫秒）：1 秒。 */
export const TIMEOUT_FLOOR = 1_000

/** 超时上界（毫秒）：30 秒。超过它就该问「为什么一次只读要等半分钟」。 */
export const TIMEOUT_CEIL = 30_000

/** 默认条数上限（通知 / 短信）。 */
export const DEFAULT_LIMIT = 10

/** 条数上限的硬顶：50。 */
export const LIMIT_CEIL = 50

/**
 * 联系人条数上限：20。
 *
 * **比其它能力更低**，理由不是性能：通讯录的每条记录都带一个真实的人。
 * 一次 20 条已经够回答「帮我找一下张阿姨」，50 条就开始接近「导出」了。
 */
export const CONTACT_LIMIT_CEIL = 20

/** 短信正文默认截断长度（字符）。 */
export const SMS_BODY_MAX = 120

/** 标题 / 应用名截断统一常量（通知与前台 App 共用）。 */
export const TITLE_MAX = 60

/** 联系人搜索关键词的最小长度：1（一个字的姓也要能搜）。 */
export const QUERY_MIN = 1

/** 联系人搜索关键词的最大长度：64。 */
export const QUERY_MAX = 64

/**
 * 调用结论（闭集）。每个码一个排查动作（纪律 143）。
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
  /** 没有数据来源（`DeviceBridge` 未注入）。 */
  | 'no-bridge'
  /** 数据来源说不支持这个能力（例如只有 adb 时问通知）。 */
  | 'unsupported'
  /** 设备不在线 / 未授权。 */
  | 'device-offline'
  /** 超时（8 秒没回来）。 */
  | 'timeout'
  /** 数据来源明确拒绝（权限没给）。 */
  | 'denied'
  /** 数据来源报错。 */
  | 'error'
  /** 超时之后才回来的结果，已丢弃。 */
  | 'late'

/** 数据来源失败原因（闭集）。 */
export type BridgeFailure = 'unsupported' | 'device-offline' | 'denied' | 'error' | 'timeout'

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

/** 一条通知（已按隐私规则处理）。 */
export interface NotificationItem {
  /** 应用名（截断）。 */
  readonly app: string
  /** 标题（截断）。 */
  readonly title: string
  /** 正文（默认不返回；`includeNotificationBody` 打开才有，且截断）。 */
  readonly body?: string
  /** 时刻（毫秒；0 = 来源没给）。 */
  readonly at: number
}

/** 一条短信（已按隐私规则处理）。 */
export interface SmsItem {
  /** 主键。 */
  readonly id: string
  /** 号码（`maskPhones` 打开时为打码形式）。 */
  readonly address: string
  /** 正文（截断）。 */
  readonly body: string
  /** 时刻（毫秒）。 */
  readonly date: number
  /** 正文是否被截断。 */
  readonly truncated: boolean
}

/** 一条联系人（已按隐私规则处理）。 */
export interface ContactItem {
  /** 姓名（截断）。 */
  readonly name: string
  /** 号码（`maskPhones` 打开时为打码形式）。 */
  readonly phone: string
}

/** 电池信息。 */
export interface BatteryInfo {
  /** 电量百分比（0–100；来源没给为 -1）。 */
  readonly level: number
  /** 是否在充电。 */
  readonly charging: boolean
  /** 温度（摄氏度；没有为 null）。 */
  readonly temperatureC: number | null
  /** 健康度原文（可为空串）。 */
  readonly health: string
}

/** 前台 App。 */
export interface ForegroundInfo {
  /** 包名。 */
  readonly app: string
  /** 界面名（可为空串）。 */
  readonly activity: string
  /** 取到的时刻（毫秒）。 */
  readonly at: number
}

/** 数据来源端口：**本包唯一与设备/外部程序打交道的地方**。 */
export interface DeviceBridge {
  /** 实现标识（日志与面板用）。 */
  readonly id: string
  /** 支持哪些能力（用来提前说「不支持」，而不是让调用方等超时）。 */
  readonly supports: readonly ToolKey[]
  /** 通知（只读）。 */
  notifications(input: { readonly limit: number }, timeoutMs: number): Promise<BridgeResult<readonly NotificationItem[]>>
  /** 短信（只读）。 */
  sms(
    input: { readonly limit: number; readonly unreadOnly: boolean },
    timeoutMs: number,
  ): Promise<BridgeResult<readonly SmsItem[]>>
  /** 联系人（只读，**关键词必填**）。 */
  contacts(
    input: { readonly query: string; readonly limit: number },
    timeoutMs: number,
  ): Promise<BridgeResult<readonly ContactItem[]>>
  /** 电池（只读）。 */
  battery(timeoutMs: number): Promise<BridgeResult<BatteryInfo>>
  /** 前台 App（只读）。 */
  foreground(timeoutMs: number): Promise<BridgeResult<ForegroundInfo>>
}

/** 一次调用的结论。 */
export interface ToolResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 工具名。 */
  readonly tool: string
  /** 原因码。 */
  readonly reason: InvokeReason
  /** 规范返回值（成功时是 `{items}` / `{battery}` 之类；失败时为 `null`）。 */
  readonly data: unknown
  /** 一句中文说明（含下一步动作；**不含联系人号码与短信正文**）。 */
  readonly detail: string
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 结果是否被降级处理过（截断/打码/丢字段）。 */
  readonly degraded: boolean
}

/** 插件现状。 */
export interface DeviceStatus {
  /** 开关。 */
  readonly enabled: boolean
  /** 能不能用（开关 + 有来源 + 至少一个工具开着）。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: InvokeReason
  /** 数据来源标识（空 = 没有）。 */
  readonly bridge: string
  /** 数据来源声明支持的能力。 */
  readonly supports: readonly ToolKey[]
  /** 开着的工具。 */
  readonly tools: readonly string[]
  /** 是否有注册器（能把这些工具交给模型）。 */
  readonly registrar: boolean
}

/** 计数。 */
export interface DeviceStats {
  /** 调用总数（含失败）。 */
  readonly calls: number
  /** 成功数。 */
  readonly ok: number
  /** 超时数。 */
  readonly timeouts: number
  /** 迟到被丢弃的结果数。 */
  readonly late: number
  /** 按原因分桶。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 最慢一次耗时（毫秒）。 */
  readonly worstMs: number
}

/** 把工具交给宿主的注册器（由宿主侧适配，本包不 import `dsh-tools`）。 */
export type ToolRegistrar = (descriptor: ToolDescriptor, handler: (args: unknown) => Promise<ToolResult>) => () => void

/** 本插件对外提供的服务。 */
export interface DeviceService {
  /** 现在能不能用。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: InvokeReason
  /** 开着的工具描述（模型侧可见的那一份）。 */
  descriptors(): readonly ToolDescriptor[]
  /** 调一个工具。**永不抛错**。 */
  invoke(tool: string, args?: unknown): Promise<ToolResult>
  /** 换数据来源。 */
  useBridge(bridge: DeviceBridge | null): void
  /** 换注册器（宿主侧把 `ctx.tools.register` 包一层交进来）。 */
  useRegistrar(registrar: ToolRegistrar | null): void
  /** 现状。 */
  status(): DeviceStatus
  /** 计数。 */
  stats(): DeviceStats
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

/**
 * O-068 `ondra-adb` 的服务子集（结构对位，不 import 它的源码）。
 *
 * **只取 `readSms`**：本包不需要它去轮询、不需要它的已答集合、也不需要它去回复。
 * 拿一个「能读短信」的来源，正好对上 `device-sms` 这一件只读能力。
 * 这也是本包唯一允许的跨插件数据通路（同层软依赖，§18.5 只经服务键）。
 */
export interface AdbLike {
  /** 能不能读。 */
  readonly available: boolean
  /** 只读读取。 */
  readSms(input?: { readonly limit?: number; readonly unreadOnly?: boolean }): Promise<{
    readonly ok: boolean
    readonly reason: string
    readonly rows: readonly {
      readonly id: string
      readonly address: string
      readonly body: string
      readonly date: number
    }[]
    readonly detail: string
  }>
}
