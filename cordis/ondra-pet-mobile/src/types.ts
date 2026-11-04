/**
 * O-075 `ondra-pet-mobile` 的对外契约。**档位〔复〕，本轮落成 `skeleton`（能力入口空壳）。**
 *
 * ## 台账只给了九个字
 *
 * ```
 * | O-075 | `ondra-pet-mobile` | 〔复〕 | 占位，钉住三端技术前提 |
 * ```
 *
 * 「三端技术前提」这五个字是唯一线索。手册里与之对应的原始事实只有三处：
 *
 * 1. §6.2 / 语料庚-7：「**桌宠/QQ/微信本是三种插件、记忆不共享**——『桌宠版、QQ 版、
 *    微信版本质是 3 种不同插件，并不是同一只鱼』」，方案是「读取本地日志实现记忆共享 +
 *    记忆卡插件（surfcore 模式）」；
 * 2. 同一处的链路：**HTTP API 监听 3000 端口 → WS 服务端监听 3001 端口 → 粘贴 token**，
 *    并列了三个坑（先点「检查已安装的 snoluma」、launcher 黑框不能关、
 *    **token 误点「重新生成」导致两端不一致**）；
 * 3. §1.11-07：三端体验承诺里「手机标『即将适配』」。
 *
 * ## 所以本包**不做移动端**，做的是把上面三处钉成可检查的清单
 *
 * 「钉住前提」不是写一段 README 提醒，而是：**每条前提一个判定，判不了的就标判不了**。
 * 判不了的硬写成「已满足」，比不判更危险——用户会以为自己配好了。
 *
 * 因此 `PrereqVerdict` 是四值而不是布尔：
 *
 * - `pass` —— 本包能确认它成立；
 * - `fail` —— 本包能确认它不成立（带指路）；
 * - `unverifiable` —— **结构上判不了**（例：两端 token 是否一致，只有两侧都开口才能比，
 *   本包只在一侧）。这类不阻塞 `ready`，但必须显示出来；
 * - `unshipped` —— 东西还没发布（手机客户端，手册说「即将适配」）。
 *
 * ## 为什么 `ready` 不包含手机端
 *
 * 若把「手机客户端已发布」也算进 `ready`，这个值会**永远为 false**，面板上就是一句
 * 没人能执行的「不可用」——那是 §17-6 说的假开关。所以 `ready` 只回答
 * 「**除手机客户端以外**，三端互通的服务端侧前提齐了吗」，手机端单独用
 * `mobileShipped`（恒 `false`）表示。两个值分开，用户才知道自己该干什么。
 *
 * ## 与 O-074 的关系
 *
 * 台账两项都只依赖已完成的插件，但语义上桌宠端是三端之一。本包对 `ondra-pet`
 * 是**软依赖**：只读它的 `status().state` 用来显示「桌宠端现在什么状态」，
 * 缺席时显示 `unknown`。**不 import**（§18.5 同轮禁止互相 import），
 * 按 §18.3 由 O-074 先定契约、本包按结构对位消费。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const PET_MOBILE_SERVICE_KEY = 'ondra-pet-mobile'

/** 名字合规正则（服务键 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 三端：桌宠 / QQ / 微信。
 *
 * 顺序即手册语料的列举顺序。**注意 `mobile` 不在里面**——手机不是第四个平台，
 * 它是「同一只」在移动端的呈现，而手册说它「即将适配」（§1.11-07）。
 * 把 `mobile` 也塞进这个联合类型，会让「三端」变成「四端」，与手册口径打架。
 */
export type MobilePlatform = 'pet' | 'qq' | 'wechat'

/** 全部平台。 */
export const PLATFORMS: readonly MobilePlatform[] = Object.freeze(['pet', 'qq', 'wechat'])

/** 端口下界。 */
export const PORT_FLOOR = 1

/** 端口上界。 */
export const PORT_CEIL = 65_535

/** 前提条目 id 闭集。 */
export type PrereqId =
  | 'memory-single-source'
  | 'pet-entry'
  | 'local-api'
  | 'ws-bridge'
  | 'origin-check'
  | 'token-consistency'
  | 'mobile-client'

/** 判定结论（四值，见文件头）。 */
export type PrereqVerdict = 'pass' | 'fail' | 'unverifiable' | 'unshipped'

/**
 * 一条技术前提（**静态定义**，不含判定结果）。
 *
 * `source` 必须写出处：一条没有出处的前提，下一个人无法判断它还算不算数。
 */
export interface Prereq {
  /** id。 */
  readonly id: PrereqId
  /** 中文标题。 */
  readonly title: string
  /** 不满足能不能继续（`token-consistency` / `mobile-client` 为 `false`）。 */
  readonly required: boolean
  /** 出处（手册章节或语料编号）。 */
  readonly source: string
  /** 不满足时该做什么（**必须是能执行的动作**）。 */
  readonly hint: string
}

/** 一条前提的判定结果。 */
export interface PrereqResult {
  /** id。 */
  readonly id: PrereqId
  /** 标题。 */
  readonly title: string
  /** 是否必需。 */
  readonly required: boolean
  /** 结论。 */
  readonly verdict: PrereqVerdict
  /** 一句说明。 */
  readonly detail: string
  /** 指路（`fail` 时必有）。 */
  readonly hint?: string
}

/** 判定所需的**事实**（由服务从各上游取，纯函数只吃这个）。 */
export interface PrereqFacts {
  /** 判定时刻。 */
  readonly at: number
  /** O-010 记忆核心在不在（三端共享记忆的**唯一**载体）。 */
  readonly memoryCore: boolean
  /** O-074 桌宠入口在不在。 */
  readonly petEntry: boolean
  /** 上游 `webServer` 在不在（三端读同一份数据的本机出口）。 */
  readonly webServer: boolean
  /**
   * 本机 API 端口与中继端口是不是同一个。
   *
   * 手册链路是「HTTP 3000 / WS 3001」两个端口。若被填成同一个，
   * 两个服务会抢同一个监听口，而现象是「一个起来了、另一个静默失败」——
   * 这条只能在这里判，因为只有本包同时知道两个端口。
   */
  readonly portConflict: boolean
  /** 中继端口是否合法。 */
  readonly relayPortValid: boolean
  /** `ws-bridge` 是否已注入实现。 */
  readonly bridge: boolean
  /** 中继地址填了没有。 */
  readonly relayConfigured: boolean
  /** 允许来源填了几条。 */
  readonly originCount: number
  /** 手机客户端发布了没有（本版恒 `false`，手册 §1.11-07）。 */
  readonly mobileShipped: boolean
}

/** 前提报告。 */
export interface PrereqReport {
  /** 除手机端外的必需前提是否齐备。 */
  readonly ready: boolean
  /** 手机端发布了没有（本版恒 `false`）。 */
  readonly mobileShipped: boolean
  /** 判定时刻。 */
  readonly at: number
  /** 全部通过项。 */
  readonly passed: readonly PrereqId[]
  /** 阻塞项（`required && fail`）。 */
  readonly blockers: readonly PrereqResult[]
  /** 提醒项（`unverifiable` / `unshipped` / 非必需的 `fail`）。 */
  readonly warnings: readonly PrereqResult[]
  /** 逐条结果（顺序同 `PREREQUISITES`）。 */
  readonly all: readonly PrereqResult[]
}

/** 一条端绑定。 */
export interface Binding {
  /** 平台。 */
  readonly platform: MobilePlatform
  /** 该平台的用户/会话标识（QQ 号、微信 openid、桌宠端会话 id）。 */
  readonly peerId: string
  /** 绑定时刻。 */
  readonly boundAt: number
}

/** 绑定结果码。 */
export type BindingCode =
  | 'ok'
  | 'disabled'
  | 'platform-not-enabled'
  | 'invalid-peer'
  | 'conflict'
  | 'not-bound'

/** 绑定结果。 */
export interface BindingResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly code: BindingCode
  /** 说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
  /** 成功时的绑定。 */
  readonly binding?: Binding
}

/** 不能用的原因（闭集）。 */
export type MobileReason =
  | 'disabled'
  | 'memory-missing'
  | 'bridge-unset'
  | 'bridge-url'
  | 'origin-unset'
  | 'no-bridge'

/** 中继桥端口（**不定义帧形状**，见 `bridge.ts`）。 */
export interface PetMobileBridge {
  /** 桥名。 */
  readonly id: string
  /** 连接。 */
  connect(options: RelayOptions): Promise<BridgeResult<null>>
  /** 断开（幂等）。 */
  disconnect(): Promise<BridgeResult<null>>
}

/** 连中继时的参数。 */
export interface RelayOptions {
  /** 中继地址。 */
  readonly relayUrl: string
  /** 允许来源（交给桥做 Origin 校验）。 */
  readonly allowedOrigins: readonly string[]
  /** 本机 API 端口（三端读同一份数据的出口）。 */
  readonly apiPort: number
}

/** 桥错误分类。 */
export type BridgeFailReason = 'no-bridge' | 'refused' | 'failed'

/** 桥调用结果。 */
export type BridgeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: BridgeFailReason; readonly detail: string }

/** 互通的开关结果。 */
export interface RelayOutcome {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码（成功恒 `ok`）。 */
  readonly code: MobileReason | 'ok' | 'failed'
  /** 说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
}

/** O-074 桌宠入口的最小形状：**只读一个状态串**，不 import，结构对位（§18.5）。 */
export interface PetLike {
  status(): { readonly state: string }
}

/** 上游 `webServer` 的最小形状：**只判存在**，不注册路由、不调用成员。 */
export type WebServerLike = object

/** 插件现状。 */
export interface PetMobileStatus {
  /** 开关开着没有。 */
  readonly enabled: boolean
  /** 服务端侧前提齐了没有（不含手机端）。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: MobileReason
  /** 启用的平台。 */
  readonly platforms: readonly MobilePlatform[]
  /** 已绑定几个端。 */
  readonly bindings: number
  /** 中继桥在位没有。 */
  readonly bridge: 'ready' | 'missing'
  /** 中继地址填了没有（不回显地址）。 */
  readonly relayConfigured: boolean
  /** 允许来源条数。 */
  readonly originCount: number
  /** 记忆真源在不在。 */
  readonly memoryReady: boolean
  /** 桌宠端状态（`unknown` = O-074 缺席或读不出）。 */
  readonly petState: string
  /** 手机端发布了没有（本版恒 `false`）。 */
  readonly mobileShipped: false
  /** 是否**显式**标注为骨架（本版恒 `true`）。 */
  readonly skeleton: true
}

/** 计数。 */
export interface PetMobileStats {
  /** 绑定尝试。 */
  readonly binds: number
  /** 绑定成功。 */
  readonly bindsOk: number
  /** 解绑尝试。 */
  readonly unbinds: number
  /** 被拒（含冲突）。 */
  readonly refused: number
  /** 冲突次数。 */
  readonly conflicts: number
  /** 前提检查次数。 */
  readonly checks: number
  /** 中继开关尝试。 */
  readonly relays: number
  /** 中继失败。 */
  readonly relayFailed: number
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

/** O-003 时钟子集。 */
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
export interface PetMobileService {
  /** 服务端侧前提齐了没有。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: MobileReason
  /** 显式标骨架。 */
  readonly skeleton: true
  /** 七条技术前提（静态定义，含出处）。 */
  prerequisites(): readonly Prereq[]
  /** 逐条判定（**永不抛错**）。 */
  check(): PrereqReport
  /** 绑定一个端。 */
  bind(platform: MobilePlatform, peerId: string): BindingResult
  /** 解绑一个端。 */
  unbind(platform: MobilePlatform): BindingResult
  /** 全部绑定。 */
  bindings(): readonly Binding[]
  /** 某个端的绑定。 */
  bindingOf(platform: MobilePlatform): Binding | undefined
  /** 已绑定的 peer 集合（去重）。 */
  peers(): readonly string[]
  /** 连上中继。前提不齐时回**具体的**闸门原因码（`disabled` / `no-bridge` / …），不笼统回一个「未就绪」。 */
  connect(): Promise<RelayOutcome>
  /** 断开中继（幂等）。 */
  disconnect(): Promise<RelayOutcome>
  /** 现状。 */
  status(): PetMobileStatus
  /** 计数。 */
  stats(): PetMobileStats
  /** 换中继桥（`null` 装回缺失实现）。 */
  useBridge(bridge: PetMobileBridge | null): void
  /** 撤（幂等）。 */
  dispose(): void
}
