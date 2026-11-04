/**
 * O-074 `ondra-pet` 的对外契约。**档位〔复〕**（复用生态桌宠，不自研窗口与立绘）。
 *
 * ## 手册给了什么（逐字）
 *
 * 手册 §6.3「桌宠」全文只有六条：
 *
 * ```
 * - **不自研**：airi（50.9k★，"soul container of AI waifu"）、dsh-whale-girl-live2d、
 *   dsh-pet、agentpet（后两者 MIT）。Coopanion 为 AGPL-3.0，只能读思路（9.1）。
 * - 桌宠价值已被生态验证：省 token + 语音对话 + 屏幕检测；"桌宠"词频 38 > "记忆" 32。
 * - Live2D 注意：Cubism Core 专有**不可再分发**——1.0 阶段不做（P2 + 静态降级）。
 * - 商业化参考：桌宠框架的付费点在高级扩展/服务；…onboarding 是真实流失点。
 * - **人物可视化面板**：Electron 只读面板 9 view（见 7.5）。
 * ```
 *
 * 手册 §1.8 把「桌宠」列在**复用档**第一梯队（与 QQ 通道、语音合成、视觉/OCR 并列）。
 * 手册 §17（master-plan 转述）第 2 条原本写「桌宠砍掉」，而手册正文的修订表把它改成
 * **「保留为能力入口，按需启用 / 复用生态桌宠（ondra-pet、agentpet，MIT）」**，
 * 理由写在 §5-11：B 站「桌宠」词频 38 > 「记忆」32，且本地桌宠已能省 token。
 * 所以本包**不做窗口、不做立绘、不做 Live2D**，只做「能力入口」该做的那几件事。
 *
 * ## 开工前查证（三处，都写清结论）
 *
 * 1. `desktop/packages/**`：按**能力**查（`package.json` 的 name + description 里搜
 *    `pet|live2d|sprite`）→ **0 命中**。宿主没有桌宠能力，也没有可复用服务键。
 *    上游有的只是 `webServer` / `shell` / `shortcuts` 这类通用件，不是桌宠。
 * 2. 本仓禁装依赖（master-plan §19.3），`dsh-pet` / `agentpet` 都不在任何 `dependencies` 里。
 * 3. 手册没有任何「桌宠参数」（尺寸、透明、置顶、位置）。所以本包**不编参数表**，
 *    只留三个真需要用户决定的：渲染档、桥地址、允许来源。
 *
 * ## 因此本包的真实形态：**能力入口 + 端口 + 许可证闸门 + 状态机**
 *
 * 它不是空壳。它做四件**不需要上游在仓内也能做对**的事：
 *
 * 1. **许可证闸门**（`adapters.ts`）：把手册 §9.1「AGPL 只能读思路」变成可执行判定。
 *    `Coopanion` 是 AGPL-3.0，接它就是违规——这件事**不该靠人记得**。
 * 2. **桥接安全**（`bridge.ts`）：手册 §9.2「任何本地 WS 桥接必须校验 Origin + 一次性 token」
 *    写成纯函数：非回环地址、URL 里带 token、来源清单为空，一律拒。
 * 3. **单实例状态机**（`state.ts`）：桌宠只能有一只。两只的结果不是「更热闹」，
 *    是用户分不清「哪只是她」——正是手册 §6.2 那个痛点（「不是同一只鱼」）。
 * 4. **渲染档降级**：`live2d` 请求如实回 `render-unsupported` 而不是黑屏。
 *    §6.3 说了 Cubism Core 不可再分发，1.0 阶段只做静态。
 *
 * ## 为什么**不注册任何工具**
 *
 * 桌宠是「用户看到她」的入口，不是模型动作。给模型一个 `pet-summon` 工具，等于给模型
 * 「在你屏幕上开一个窗口」的能力——它会在觉得合适的时候把窗口弹出来。这与 §8.1 的
 * 器官责任相反（器官只能提议状态，不能自己改世界）。所以本包**一个工具都不注册**，
 * 召唤与收起只暴露在服务对象上，由界面 / 宿主在用户点头后调用。
 * 这条也顺手避开了「工具名手册没给」的编造问题。
 *
 * ## 为什么没有定时器
 *
 * 状态不靠轮询：上游窗口关闭时由桥或宿主调 `markExited()`（**推**模型）。
 * 有定时器就要考虑卸载、重入、宿主休眠，而这三样在桌宠上都只会带来「她明明关了却还在」。 
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const PET_SERVICE_KEY = 'ondra-pet'

/** 名字合规正则（服务键 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 桌宠状态闭集。 */
export type PetState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

/**
 * 允许的状态迁移。
 *
 * 这张表是**唯一**的迁移真源：`state.ts` 与 `service.ts` 都从它派生，
 * 不许在业务代码里另写 `if (state === 'running')` 式的隐式判定。
 *
 * `failed → stopping` 这条**必须留着**：`failed` 有两种来源，一是「还没开窗口就失败了」，
 * 二是「窗口已经开了、但 `spawn()` 的返回/回调失败」。后者如果不允许 `failed → stopping`，
 * `dismiss()` 就会回 `not-running`，而桌面上那个窗口还开着——成了收不掉的孤儿。
 */
export const PET_TRANSITIONS: Readonly<Record<PetState, readonly PetState[]>> = Object.freeze({
  idle: Object.freeze(['starting'] as readonly PetState[]),
  starting: Object.freeze(['running', 'failed'] as readonly PetState[]),
  running: Object.freeze(['stopping', 'failed'] as readonly PetState[]),
  stopping: Object.freeze(['stopped', 'failed'] as readonly PetState[]),
  stopped: Object.freeze(['starting'] as readonly PetState[]),
  failed: Object.freeze(['starting', 'stopping', 'stopped'] as readonly PetState[]),
})

/** 许可证种类（只列手册里出现过的）。 */
export type PetLicense = 'MIT' | 'Apache-2.0' | 'AGPL-3.0' | 'unknown'

/** 渲染档。`live2d` 在第一阶段被明确不做（§6.3 Cubism Core 不可再分发）。 */
export type RenderMode = 'static' | 'live2d'

/** 全部渲染档。 */
export const RENDER_MODES: readonly RenderMode[] = Object.freeze(['static', 'live2d'])

/**
 * 一个生态桌宠的登记项。
 *
 * `verified` 的意思是「LICENSE 文件逐字核对过」，**不是**「许可证友好」。
 * 手册 §9.1 明确写「新仓库 LICENSE 许可需正式确认」，本轮禁联网核对，
 * 所以 MIT 的两项也如实标 `false`——**不要让面板看起来比事实更确定**。
 */
export interface PetAdapter {
  /** 适配器 id（也是配置值）。 */
  readonly id: string
  /** 中文名。 */
  readonly title: string
  /** 许可证。 */
  readonly license: PetLicense
  /** LICENSE 是否逐字核对过。 */
  readonly verified: boolean
  /** 能不能接。 */
  readonly reusable: boolean
  /** 一句话说明（含为何不能接）。 */
  readonly note: string
}

/**
 * 不可用的原因（闭集）。
 *
 * `disabled` 与 `no-bridge` 必须分开：前者是用户关了，后者是缺施工件，
 * 排查方向完全相反。`adapter-unusable` 又是第三件事：**许可证不让接**。
 */
export type PetReason =
  | 'disabled'
  | 'adapter-unusable'
  | 'render-unsupported'
  | 'bridge-unset'
  | 'bridge-url'
  | 'origin-unset'
  | 'no-bridge'

/** 结果码（含 `PetReason` 与三个运行期码）。 */
export type PetCode =
  | PetReason
  | 'ok'
  | 'already-running'
  | 'not-running'
  | 'busy'
  | 'token-missing'
  | 'token-weak'
  | 'failed'

/** 桥的错误分类。 */
export type BridgeFailReason = 'no-bridge' | 'refused' | 'failed'

/** 桥调用结果。 */
export type BridgeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: BridgeFailReason; readonly detail: string }

/** 桥地址校验码。 */
export type BridgeCode =
  | 'ok'
  | 'empty'
  | 'malformed'
  | 'not-ws'
  | 'not-loopback'
  | 'userinfo'
  | 'bad-port'
  | 'token-in-url'

/** 桥地址校验结论。 */
export interface BridgeCheck {
  /** 过没过。 */
  readonly ok: boolean
  /** 结论码。 */
  readonly code: BridgeCode
  /** 一句说明。 */
  readonly detail: string
  /** **指路**（不过时必有）。 */
  readonly hint?: string
}

/** 来源清单校验结论。 */
export interface OriginCheck {
  /** 过没过。 */
  readonly ok: boolean
  /** 结论码。 */
  readonly code: 'ok' | 'empty' | 'bad'
  /** 说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
}

/** 一次性 token 的形状结论。 */
export type TokenVerdict = 'ok' | 'missing' | 'weak'

/**
 * 叫出桌宠时交给桥的参数。
 *
 * **token 只在这里过一手**：它不进配置、不进状态、不进日志（master-plan §6 禁令 6）。
 * 桌宠启动后会打印一次性 token，用户粘进来——这正是手册语料里 surfcore 那条
 * 「误点重新生成导致两端 token 不一致」的坑所在，所以本包把它做成**每次显式给**，
 * 而不是让它在配置里长期躺成第二份真源。
 */
export interface PetSpawnOptions {
  /** 渲染档（本版恒 `static`）。 */
  readonly render: RenderMode
  /** 桥地址。 */
  readonly bridgeUrl: string
  /** 一次性 token。 */
  readonly token: string
  /** 允许的来源清单（交给桥做 Origin 校验）。 */
  readonly allowedOrigins: readonly string[]
  /** 一次性 token 的有效期（毫秒）。 */
  readonly tokenTtlMs: number
  /** 是否置顶。 */
  readonly alwaysOnTop: boolean
  /** 缩放（0.5–2）。 */
  readonly scale: number
}

/** 桌宠桥端口（实现方 = 某个 MIT 桌宠的接线层）。 */
export interface PetBridge {
  /** 桥名（面板显示）。 */
  readonly id: string
  /** 桥支持的渲染档（本版只应含 `static`）。 */
  readonly renders: readonly RenderMode[]
  /** 叫出。**成功即代表窗口已起**。 */
  spawn(options: PetSpawnOptions): Promise<BridgeResult<null>>
  /** 收起（幂等）。 */
  stop(): Promise<BridgeResult<null>>
}

/** 召唤参数。 */
export interface SummonOptions {
  /** 一次性 token（必填，不从配置读）。 */
  readonly token?: string
}

/** 一次操作的结果。 */
export interface PetOutcome {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly code: PetCode
  /** 操作后的状态。 */
  readonly state: PetState
  /** 一句说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
}

/** 插件现状。 */
export interface PetStatus {
  /** 开关开着没有。 */
  readonly enabled: boolean
  /** 现在能不能叫出来。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: PetReason
  /** 状态。 */
  readonly state: PetState
  /** 适配器 id。 */
  readonly adapter: string
  /** 适配器许可证。 */
  readonly license: PetLicense
  /** 许可证核对过没有。 */
  readonly verified: boolean
  /** 渲染档。 */
  readonly render: RenderMode
  /** 桥在位没有。 */
  readonly bridge: 'ready' | 'missing'
  /** 桥地址填了没有（**不回显地址本身**：它可能带 query）。 */
  readonly bridgeConfigured: boolean
  /** 允许来源条数（面板要能看见「0 条 = 全拒」）。 */
  readonly originCount: number
  /** 是否**显式**标注为骨架（本版恒 `true`）。 */
  readonly skeleton: true
}

/** 计数。 */
export interface PetStats {
  /** 叫出尝试。 */
  readonly summons: number
  /** 叫出成功。 */
  readonly summonsOk: number
  /** 收起尝试。 */
  readonly dismissals: number
  /** 被闸门拒掉。 */
  readonly refused: number
  /** 桥缺席。 */
  readonly noBridge: number
  /** 已经有一只在跑。 */
  readonly alreadyRunning: number
  /** 桥报错。 */
  readonly failed: number
  /** 外部退出通知次数。 */
  readonly exits: number
  /** 桥调用总次数。 */
  readonly bridgeCalls: number
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
export interface PetService {
  /** 现在能不能叫出来。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: PetReason
  /** 显式标骨架。 */
  readonly skeleton: true
  /** 叫出桌宠（过全部闸门）。 */
  summon(options?: SummonOptions): Promise<PetOutcome>
  /** 收起（幂等：没在跑就回 `not-running`，不报错升级）。 */
  dismiss(): Promise<PetOutcome>
  /**
   * 外部告知「窗口已经关了」（崩溃或被用户直接关掉）。
   * 返回状态有没有因此改变。
   */
  markExited(detail?: string): boolean
  /** 现状。 */
  status(): PetStatus
  /** 计数。 */
  stats(): PetStats
  /** 可接的生态桌宠清单（含不能接的，面板要能看见原因）。 */
  adapters(): readonly PetAdapter[]
  /** 换桥（`null` 装回缺失实现）。 */
  useBridge(bridge: PetBridge | null): void
  /** 撤（幂等）。 */
  dispose(): void
}
