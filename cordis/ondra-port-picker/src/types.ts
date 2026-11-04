/**
 * O-083 `ondra-port-picker` 的对外契约。档位〔研〕（上游只提供了「端口 0 让系统挑」这一半）。
 *
 * ## 台账要求，逐字
 *
 * ```
 * | O-083 | `ondra-port-picker` | 〔研〕 | 9060–9079 回环挑端口 |
 * ```
 *
 * ## 手册给了什么、没给什么
 *
 * 给了（可引用）：
 *
 * - 手册 §6.4「一键部署四件套：检查 Node≥20 → 复用已装 `ondra` → **`--port 0` 挑空闲端口** →
 *   抓带 token 地址自动开浏览器」；
 * - 手册 §9.2「任何本地 WS 桥接必须校验 Origin + 一次性 token」——本包只挑**回环**端口，
 *   不为它开公网。
 *
 * **没给**：`9060–9079` 这个区间。它只出现在台账与 master-plan §5 的 L7 表格里
 * （另有一处间接旁证：台账 O-055 那条写「3001 … 避开 L7 的 9060–9079 端口池」）。
 * 所以本包把区间当**配置默认值**而不是常量：它是环境约定，不是设计定案。
 *
 * ## 两套口径是真冲突，按 §12 做两分支
 *
 * 手册说「`--port 0` 让系统挑」，台账说「9060–9079 回环挑」。这两句不是同一件事：
 *
 * | | 方案 A `system` | 方案 B `fixed` |
 * |---|---|---|
 * | 谁决定端口号 | 内核（`listen(0)`） | 本包顺序扫描 |
 * | 好处 | 几乎不可能撞号 | 防火墙/白名单只需放行 20 个号 |
 * | 坏处 | 每次启动号都变，写不进白名单 | 20 个号全占满就真的没有 |
 *
 * 按 §14.2「默认选最稳的那个分支」，默认 `system`；`fixed` 是为「必须固定端口」的
 * 部署形态准备的兜底，**不是**默认。
 *
 * ## 两处必须说清的「拿不到保证」
 *
 * 1. **探测 ≠ 占位。** 本包探完立刻释放。从释放到真正有人去 `listen` 之间有一个窗口，
 *    别人可能抢走。所以 `PickedPort.race` 如实写 `'window'`——把这件事说成「保证可用」
 *    会让排障从「端口被抢」变成「程序有 bug」。
 * 2. **回环探测只回答回环。** 探的是 `127.0.0.1` 能不能绑，不回答「这个号全系统没人用」。
 *    一个只监听 `0.0.0.0` 的进程会让回环绑定失败（这是好事，能探出来），但反过来
 *    本包不承诺 IPv6、不承诺别的网卡。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const PORT_PICKER_SERVICE_KEY = 'ondra-port-picker'

/** 名字合规正则：与 §8.4 同一条，用于 `purpose` 之类的短名。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 挑端口的两条分支。
 *
 * `system` = 让内核挑（`listen(0)`，等价于手册 §6.4 的 `--port 0`）；
 * `fixed` = 在配置区间里顺序扫。
 */
export type PortBranch = 'system' | 'fixed'

/**
 * 这个号是从哪儿来的。
 *
 * `web-server` 与其它三种的区别不是实现细节，而是**有没有竞态**：宿主 `webServer`
 * 已经把端口绑上了，读它的 `port` 是既成事实；另外三种都只是「探测到空闲」。
 */
export type PortSource = 'web-server' | 'os-assigned' | 'range-scan' | 'reserved'

/**
 * 原因码。每个码对应一句能照做的话（见 `policy.ts` 的 `describeReason`）。
 *
 * 刻意不设 `unknown`：一个说不清原因的错误码，在界面上等于「失败了」三个字，
 * 而排障需要的恰恰是「下一步该改哪里」。
 */
export type PortReason =
  | 'disabled'
  | 'bad-host'
  | 'bad-range'
  | 'bad-port'
  | 'no-free-port'
  | 'no-endpoint'
  | 'probe-failed'
  | 'not-reserved'
  | 'disposed'

/**
 * 「要一个号」到底是什么意思。
 *
 * 这两个意图看起来一样，实际相反——混用会产生最难查的一类故障：
 *
 * | | `listener` | `endpoint` |
 * |---|---|---|
 * | 要的人 | 一个准备 `listen` 的子进程 | 一个准备**打开**的地址 |
 * | 想要的号 | 现在**没人绑**的号 | 宿主 `webServer` **已经绑着**的号 |
 * | 把 webServer 的号给它 | 子进程立刻 `EADDRINUSE` | 正确，正是它 |
 *
 * 所以 `endpoint` 不是「挑端口」，而是「读出既成事实」；它不扫描、不让内核分配。
 */
export type PortIntent = 'listener' | 'endpoint'

/** 一段闭区间端口。 */
export interface PortRange {
  /** 下界（含）。 */
  readonly start: number
  /** 上界（含）。 */
  readonly end: number
}

/** 一次挑端口请求。全部可选，缺省走配置。 */
export interface PickRequest {
  /** 这是一次什么请求。省略按 `listener`。 */
  readonly intent?: PortIntent
  /** 谁要这个号（短名，只进日志与账本，不参与判定）。 */
  readonly purpose?: string
  /** 强制走某条分支；省略用配置的 `branch`。`endpoint` 请求忽略此项。 */
  readonly branch?: PortBranch
  /** 绑定地址；省略用配置的 `host`。**只接受回环**。 */
  readonly host?: string
  /** 固定区间；省略用配置的 `rangeStart` / `rangeEnd`。 */
  readonly range?: PortRange
}

/** 交出去的一个号。 */
export interface PickedPort {
  /** 端口号。 */
  readonly port: number
  /** 绑定地址（一定是回环字面量）。 */
  readonly host: string
  /** 这是一次什么请求。 */
  readonly intent: PortIntent
  /** 走的哪条分支。`endpoint` 请求如实记配置值，但它不参与决定。 */
  readonly branch: PortBranch
  /** 号从哪儿来。 */
  readonly source: PortSource
  /** 谁要的。 */
  readonly purpose: string
  /**
   * 交出去之后、真正绑定之前，别人抢走的可能性。
   *
   * `'none'` 只有一种情况：宿主 `webServer` 已经绑好了，本包只是把既成事实读出来。
   */
  readonly race: 'none' | 'window'
  /** 发出时刻（Unix 毫秒）。 */
  readonly pickedAt: number
  /** 账本过期时刻；过期后这个号会被允许再次发出。 */
  readonly expiresAt: number
}

/** 挑端口的结果。**永不抛**。 */
export interface PickOutcome {
  readonly ok: boolean
  /** 成功时的号。 */
  readonly picked?: PickedPort
  /** 失败原因。 */
  readonly reason?: PortReason
  /** 一句给人看的补充（含「试过哪些号」这类事实）。 */
  readonly detail?: string
  /** 固定分支实际试过的号，按尝试顺序。诊断用。 */
  readonly tried?: readonly number[]
}

/** 计数（只增，不清零）。 */
export interface PortStats {
  /** 成功发出几个号。 */
  readonly picks: number
  /** 固定分支扫描了几轮。 */
  readonly scans: number
  /** 总共做了几次绑定探测。 */
  readonly probes: number
  /** 失败几次。 */
  readonly failures: number
  /** 显式释放几次。 */
  readonly releases: number
}

/**
 * 绑定探测端口。
 *
 * 端口化不是为了测试：它让「本包会不会偷偷占着端口不放」这个问题有确定答案——
 * 这个接口里**没有**「保留」这个方法。
 */
export interface ProbePort {
  /**
   * 试绑一个具体端口，立刻释放。
   * @param port 端口号。
   * @param host 绑定地址。
   * @param timeoutMs 超时。
   * @returns 能绑上为 `true`；被占、超时、参数非法都为 `false`。
   */
  probe(port: number, host: string, timeoutMs: number): Promise<boolean>
  /**
   * 让内核分配一个空闲端口，读出来，立刻释放。
   * @param host 绑定地址。
   * @param timeoutMs 超时。
   * @returns 内核给的端口；失败为 `null`。
   */
  assign(host: string, timeoutMs: number): Promise<number | null>
}

/** 本插件对外提供的服务。 */
export interface PortPickerService {
  /** 是否可用（`enable` 为真且未卸载）。 */
  readonly available: boolean
  /** 不可用的原因。 */
  readonly reason?: PortReason
  /** 当前生效的分支（配置值）。 */
  readonly branch: PortBranch
  /** 挑一个号。**永不抛**。 */
  pick(request?: PickRequest): Promise<PickOutcome>
  /** 登记一个外部已知的号（只记账，不探测、不占用）。 */
  reserve(port: number, purpose?: string): boolean
  /** 从账本里划掉一个号。 */
  release(port: number): boolean
  /** 单次探测：这个号在 `host` 上现在能不能绑。**永不抛**。 */
  isFree(port: number, host?: string): Promise<boolean>
  /** 账本快照（已剔除过期项）。 */
  list(): readonly PickedPort[]
  stats(): PortStats
  /** 卸载：清空账本。**永不抛**。 */
  dispose(): void
}

/** 宿主 `webServer` 的结构子集（只读端口与地址，不调用它任何方法）。 */
export interface WebServerLike {
  /** 已绑定的端口；未绑定时为 `undefined`。 */
  readonly port?: number | undefined
  /** 绑定的地址字面量。 */
  readonly host?: string | undefined
}

/** O-001 身份子集。 */
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
