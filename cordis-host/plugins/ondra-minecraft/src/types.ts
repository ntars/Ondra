/**
 * O-073 `ondra-minecraft` 的对外契约。**档位〔复〕（复用 Mineflayer），本轮只做能力入口 + 明确未接入。**
 *
 * ## 手册与主纲给了什么（逐字）
 *
 * master-plan §5「L6 端侧」只列了名字：`ondra-minecraft`。
 * master-plan §9.11 端侧实证：
 *
 * ```
 * browser / minecraft / pet：各 27 行左右占位，enabled 为真时只 warn「本版未实现」。
 * ```
 *
 * 也就是说：**旧项目里它就是一个空壳**，唯一的行为是「开着就警告一句」。
 * 台账 O-073 的职责列写「Mineflayer 接入（占位）」，档位〔复〕——
 * 复用 `mineflayer` 这个成熟库，不自己写 Minecraft 协议。
 *
 * ## 开工前查证结果（三处都是零命中，必须写清）
 *
 * 1. `Ondra-dev-handbook.md` 全文：`minecraft` **0 命中**、`Mineflayer` **0 命中**。
 *    手册里没有任何一节讲这个插件的参数、能力或风控口径。
 * 2. `desktop/packages/**`（含 `package.json`）：`mineflayer|minecraft` **0 命中**，
 *    也没有可复用的服务键。
 * 3. 本仓禁装依赖（master-plan §16.3 / 手册 §8.x 的施工边界），`mineflayer` 不在任何依赖里。
 *
 * ## 因此本包的真实形态：**能力入口 + 端口 + 明确原因码**
 *
 * 不写「看起来能跑」的连接代码。原因不是谨慎，是那种代码的坏形态无法与「没接」区分：
 * Mineflayer 的连接分三段（TCP → 握手/加密协商 → 进服），任何一段失败都表现为
 * 「连上了但什么也收不到」。写一版猜参数的实现，用户看到的会是「她的号一直在线但一句话不说」，
 * 而那与「根本没连」在界面上完全同形（纪律 101：猜不准的第三方 API，宁可不接）。
 *
 * 所以本包做三件**不需要 Mineflayer 也能做对**的事：
 *
 * 1. **话术闸门**（`policy.ts`，纯函数）：长度、频率、指令白名单、危险指令前缀；
 * 2. **文本整形**（`sanitize.ts`，纯函数）：控制字符、全角空格、超长截断；
 * 3. **端口与状态机**（`driver.ts` + `service.ts`）：`MissingDriver` 如实报 `no-driver`，
 *    接上真驱动只需 `useDriver()`，不改本包。
 *
 * ## 为什么把「指令白名单」做成出厂**空表**
 *
 * 进服之后她能发 `/` 开头的指令——那是**服务器管理员接口**，一条 `/op`、`/givemoney`、
 * 甚至 `/kill` 都可能毁掉别人的存档。出厂允许的指令表为空，等于「一个字都不许发指令」，
 * 由用户显式加。空表不是「忘配」，是一个明确的默认（与 O-072 的 App 白名单同一手法）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const MINECRAFT_SERVICE_KEY = 'ondra-minecraft'

/** 名字合规正则。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 工具名（连字符）。
 *
 * 手册没给这一项的工具名（§9.11 只说它是 27 行占位），三个名字是本轮自定，已登记待裁决。
 */
export const TOOL_NAMES = Object.freeze({
  status: 'minecraft-status',
  chat: 'minecraft-chat',
  command: 'minecraft-command',
})

/** 能力键。 */
export type ToolKey = keyof typeof TOOL_NAMES

/** 全部能力键。 */
export const TOOL_KEYS: readonly ToolKey[] = Object.freeze(['status', 'chat', 'command'])

/**
 * 单条聊天长度上限：**256 字符**。
 *
 * 这是 Minecraft 协议自己的字段上限（chat 包的字符串长度），
 * 超过会被服务端直接断开连接——不是报错、是断连，用户只会看到「她突然掉线」。
 * 因此本地先截断，不留一次断连的机会。
 */
export const CHAT_MAX = 256

/** 聊天长度硬顶（配置不许超过它：超过就是协议违规）。 */
export const CHAT_CEIL = 256

/** 单条聊天最小长度：1（空消息在多数服务端会被当成刷屏尝试）。 */
export const CHAT_FLOOR = 1

/** 指令长度上限：64（`/` + 指令名的合理上限；再长的东西不该由她代劳）。 */
export const COMMAND_MAX = 64

/** 两次发送之间的最小间隔（毫秒）。多数服务端把 1 秒内的连续消息判为刷屏。 */
export const SEND_INTERVAL_MS = 1_200

/** 间隔上界（毫秒）。 */
export const INTERVAL_CEIL = 30_000

/** 每分钟消息预算（条）。 */
export const PER_MINUTE = 20

/** 每分钟预算上界（条）。 */
export const PER_MINUTE_CEIL = 120

/** 连接超时（毫秒）。进服三段握手，10 秒是宽松值。 */
export const CONNECT_TIMEOUT_MS = 10_000

/** 超时下界/上界（毫秒）。 */
export const TIMEOUT_FLOOR = 1_000

/** 超时上界（毫秒）。 */
export const TIMEOUT_CEIL = 60_000

/** 服务端地址长度上限（`host` 或 `host:port`）。 */
export const HOST_MAX = 128

/** 离线状态：连接状态机的闭集。 */
export type LinkState = 'idle' | 'connecting' | 'online' | 'closing' | 'offline'

/** 全部连接状态。 */
export const LINK_STATES: readonly LinkState[] = Object.freeze([
  'idle',
  'connecting',
  'online',
  'closing',
  'offline',
])

/**
 * 不能用的原因（闭集）。
 *
 * `no-driver` 与 `disabled` 必须分开：前者是「缺施工件」，后者是「用户关了」，
 * 两者的排查方向完全相反（纪律 143）。
 */
export type McReason = 'disabled' | 'no-driver' | 'not-connected'

/** 拒绝原因（闭集）。 */
export type RefuseCode =
  | 'disabled'
  | 'no-driver'
  | 'not-connected'
  | 'empty'
  | 'too-long'
  | 'command-not-allowed'
  | 'command-shape'
  | 'rate-limited'
  | 'budget-exhausted'
  | 'chat-disabled'
  | 'command-disabled'
  | 'failed'

/** 发送结果。 */
export interface SendOutcome {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码（成功恒为 `ok`）。 */
  readonly code: RefuseCode | 'ok'
  /** 实际发出去的正文（已整形；失败时为 `null`）。 */
  readonly text: string | null
  /** 一句说明。 */
  readonly detail: string
  /** **指路**。 */
  readonly hint?: string
}

/** 一处服务端配置。 */
export interface ServerTarget {
  /** 主机名或 IP。**只接受 `host` 或 `host:port`**，不接受 URL。 */
  readonly host: string
  /** 端口（默认 25565）。 */
  readonly port: number
  /** 用户名（离线模式用；正版账号的认证归驱动实现方）。 */
  readonly username: string
  /** 版本（`auto` = 由驱动自己探测）。 */
  readonly version: string
}

/** 在线快照（驱动给的原始事实，本包只整形不推断）。 */
export interface McSnapshot {
  /** 观察时刻。 */
  readonly at: number
  /** 服务器地址（`host:port`）。 */
  readonly server: string
  /** 自己的用户名。 */
  readonly username: string
  /** 生命值（0–20）；驱动给不了就是 `undefined`。 */
  readonly health?: number
  /** 饥饿值（0–20）。 */
  readonly food?: number
  /** 坐标。 */
  readonly position?: { readonly x: number; readonly y: number; readonly z: number }
  /** 在线人数；驱动给不了就是 `undefined`。 */
  readonly players?: number
  /** 所在维度名（如 `minecraft:overworld`）。 */
  readonly dimension?: string
  /** 最近若干条聊天（**只保留最多 N 条，且不含自己的发言**）。 */
  readonly recentChat: readonly ChatLine[]
}

/** 一条聊天。 */
export interface ChatLine {
  /** 说话的人（系统消息用 `system`）。 */
  readonly from: string
  /** 正文（已整形、已截断）。 */
  readonly text: string
  /** 时刻。 */
  readonly at: number
}

/** 驱动结果。 */
export type DriverResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: 'no-driver' | 'not-connected' | 'unsupported' | 'failed'; readonly detail: string }

/**
 * Minecraft 驱动端口。
 *
 * 实现方是 `mineflayer` 的接线层（见 README 限制 1）。契约只四条：
 * 连、断、发、读。**本包不定义任何协议细节**——那些归驱动。
 */
export interface MinecraftDriver {
  /** 驱动名（面板显示）。 */
  readonly id: string
  /** 连接。 */
  connect(target: ServerTarget, timeoutMs: number): Promise<DriverResult<McSnapshot>>
  /** 断开（幂等）。 */
  disconnect(): Promise<DriverResult<null>>
  /** 发一条聊天。**必须原样发，不许自己加前后缀或重试**。 */
  chat(text: string): Promise<DriverResult<null>>
  /** 发一条指令（已含 `/`）。 */
  command(text: string): Promise<DriverResult<null>>
  /** 读一眼当前状态。 */
  snapshot(): Promise<DriverResult<McSnapshot>>
}

/** 判定所需配置。 */
export interface PolicyConfig {
  /** 总开关。 */
  readonly enable: boolean
  /** 开着的工具。 */
  readonly enabledTools: readonly ToolKey[]
  /** 允许的指令名（不含 `/`，小写）。**空 = 一个都不许。** */
  readonly commandAllowList: readonly string[]
  /** 两次发送的最小间隔（毫秒）。 */
  readonly minSendIntervalMs: number
  /** 每分钟预算。 */
  readonly maxPerMinute: number
  /** 单条聊天上限。 */
  readonly chatMax: number
}

/** 发送前的判定（不消耗额度，纯看）。 */
export interface SendVerdict {
  /** 放行没有。 */
  readonly allowed: boolean
  /** 结果码。 */
  readonly code: RefuseCode | 'ok'
  /** 整形后的正文（放行时才有意义）。 */
  readonly text: string
  /** 说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
}

/** 工具参数声明。 */
export interface ParamSpec {
  /** 类型。 */
  readonly type: 'string' | 'number' | 'boolean' | 'object'
  /** 必填。 */
  readonly required: boolean
  /** 说明。 */
  readonly description: string
}

/** 工具描述。 */
export interface ToolDescriptor {
  /** 工具名。 */
  readonly name: string
  /** 中文短标题。 */
  readonly title: string
  /**
   * 能力说明。
   *
   * **必须写明「未接入时不会假装在线」**：这是本包唯一诚实的地方。
   */
  readonly description: string
  /** 是否改变游戏内状态（`minecraft-status` 为 `false`）。 */
  readonly mutates: boolean
  /** 超时（毫秒）。 */
  readonly timeoutMs: number
  /** 参数表。 */
  readonly parameters: Readonly<Record<string, ParamSpec>>
}

/** 工具返回。 */
export interface ToolResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 工具名。 */
  readonly tool: string
  /** 结果码。 */
  readonly code: RefuseCode | 'bad-arg' | 'ok'
  /** 模型可见正文。 */
  readonly text: string
  /** 一句说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
}

/** 注册器（宿主侧适配，本包不 import 工具包）。 */
export type ToolRegistrar = (
  descriptor: ToolDescriptor,
  handler: (args: unknown) => Promise<ToolResult>,
) => () => void

/** 插件现状。 */
export interface McStatus {
  /** 开关开着没有。 */
  readonly enabled: boolean
  /** 现在能不能用（`enabled && driverReady`）。 */
  readonly available: boolean
  /** 驱动在位且支持 `connect` 没有。 */
  readonly driverReady: boolean
  /** 不能用的原因。 */
  readonly reason?: McReason
  /** 驱动名（没有为 `none`）。 */
  readonly driver: string
  /** 连接状态。 */
  readonly link: LinkState
  /** 服务器（`host:port`；没配为 `''`）。 */
  readonly server: string
  /** 开着的工具。 */
  readonly tools: readonly ToolKey[]
  /** 允许的指令（原样返回，面板要能看见「空的」）。 */
  readonly commands: readonly string[]
  /** 最近一次快照的时刻（没读过为 0）。 */
  readonly snappedAt: number
  /** 是否**显式**标注为骨架（本版恒 `true`，见 README 限制 1）。 */
  readonly skeleton: true
}

/** 计数。 */
export interface McStats {
  /** 连接尝试。 */
  readonly connects: number
  /** 连接成功。 */
  readonly connected: number
  /** 断开。 */
  readonly disconnects: number
  /** 状态读取次数。 */
  readonly reads: number
  /** 发出聊天数。 */
  readonly chats: number
  /** 发出指令数。 */
  readonly commands: number
  /** 被拒次数。 */
  readonly refused: number
  /** 限频次数。 */
  readonly throttled: number
  /** 预算用尽次数。 */
  readonly budgetHit: number
  /** 驱动缺席次数。 */
  readonly noDriver: number
  /** 驱动失败次数。 */
  readonly failed: number
  /** 未取到正文的次数（驱动通了但没数据）。 */
  readonly emptyReads: number
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

/** O-003 时钟子集（`dayKey` 可选：预算按分钟算，不需要自然日）。 */
export interface ClockLike {
  now(): number
}

/** O-005 字段声明形状。 */
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

/** O-005 段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 服务形状。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}

/** 本插件对外提供的服务。 */
export interface MinecraftService {
  /** 开关开着没有。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: McReason
  /** 驱动就绪没有。 */
  readonly ready: boolean
  /** 开着的工具描述。 */
  readonly skeleton: true
  descriptors(): readonly ToolDescriptor[]
  /** 调一个工具。**永不抛错**。 */
  invoke(tool: string, args?: unknown): Promise<ToolResult>
  /** 连接（驱动缺席时如实回 `no-driver`）。 */
  connect(): Promise<DriverResult<McSnapshot>>
  /** 断开。 */
  disconnect(): Promise<DriverResult<null>>
  /** 发一条聊天（过闸门）。 */
  say(text: string): Promise<SendOutcome>
  /** 发一条指令（过闸门）。 */
  run(command: string): Promise<SendOutcome>
  /** 读一眼状态。 */
  snapshot(): Promise<DriverResult<McSnapshot>>
  /** 换驱动。 */
  useDriver(driver: MinecraftDriver | null): void
  /** 换注册器。 */
  useRegistrar(registrar: ToolRegistrar | null): void
  /** 现状。 */
  status(): McStatus
  /** 计数。 */
  stats(): McStats
  /** 撤掉已注册工具（幂等）。 */
  dispose(): void
}
