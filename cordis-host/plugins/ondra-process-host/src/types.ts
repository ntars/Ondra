/**
 * O-080 `ondra-process-host` 的对外契约。档位〔复〕（机制复用上游 `ctx.subprocess`）。
 *
 * ## 台账要求，逐字
 *
 * ```
 * | O-080 | `ondra-process-host` | 〔研〕 | 子进程托管：detached + pidfile + 组杀 + 重启 1 次 |
 * ```
 *
 * ## 手册给了什么、没给什么
 *
 * 手册全文检索「子进程 / pidfile / 组杀 / detached / 进程托管」**全部 0 命中**。
 * 这一行的规格只存在于 master-plan §5 的 L7 表格与台账本身。所以本包不去「解释」
 * 那四个词，而是逐词对照上游源码，把**能做的做实、不能做的说清**：
 *
 * | 台账的词 | 上游有什么 | 本包怎么做 |
 * |---|---|---|
 * | 组杀 | `SubprocessHandle.terminate()` 作用于 **provider 托管的整个进程范围**（POSIX 是 scope / win32 是 job object），`waitForExit()` 观察同一范围 | **直接接线**，一行 `kill(-pid)` 都不写 |
 * | 重启 1 次 | 无 | 自有策略：`maxRestarts` 默认 1，超过即 `crash-limit`，不再试 |
 * | pidfile | **无 pid**：`SubprocessHandle` 只有 `stdin/stdout/stderr/control/collected/done/terminate/waitForExit`，`subprocess-local` 里也没有 `pid` | 探测式写入：拿得到就写 `<name>.pid`，拿不到就**不建文件**、`pid: null`、日志一句 `pidfile-skipped`。**绝不写一个假 pid** |
 * | detached | `SubprocessSpawnSpec` 只有 `argv/cwd/stdio/graceMs/signal/env`，**没有 `detached`** | 拆成两半：①「不占父终端、输出不混进父 stdout」由 `stdio` 显式声明 + 收集器满足（真做到了）；②「父进程退出后子进程继续活」**刻意不做**（见下） |
 *
 * ## 为什么「父死子活」这一半刻意不做
 *
 * master-plan §12.4 明令成品形态只能是 app 插件包，**禁止常驻后台服务**；
 * 而「父进程死了子进程还在」正是常驻后台服务的技术定义。更实际的一条：
 * 一个脱离父生命周期的子进程，在插件卸载 / 宿主重启之后**没有任何人负责收尸**，
 * 端口被占、pid 文件过期、下一次启动直接 `EADDRINUSE`——这是运维事故的标准剧本。
 *
 * 上游的语义反而更安全：`SubprocessRuntime` 的 disposal「terminates all
 * still-running managed processes and awaits their exit」。本包顺着它做，
 * 卸载即收尾，与手册 §3.3-4「可逆注册」一致。
 *
 * ## 错误不传播（C3 同源）
 *
 * 所有方法**永不抛**。启动失败、端口缺席、超时都折成带 `reason` 的 `HostedView`。
 * 理由：托管失败是常态（二进制不在、权限不足、端口占用），把它变成异常会让调用方
 * 在「要不要 try/catch」上做选择，而选择的结果一定是有人忘了。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const PROCESS_HOST_SERVICE_KEY = 'ondra-process-host'

/** 名字合规正则：与 §8.4 同一条，用于托管项名。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 托管项的生命阶段。
 *
 * `stopped` 与 `failed` 分开：前者是「我让它停的」，后者是「它自己没了且不再重启」。
 * 合成一个，界面就无法回答「是不是我按了停止」。
 */
export type HostPhase = 'idle' | 'running' | 'restarting' | 'stopped' | 'failed'

/**
 * 原因码。
 *
 * 每个码对应一句能照做的话（见 `describeReason`），不用「失败」两个字糊过去。
 */
export type HostReason =
  | 'disabled'
  | 'no-subprocess'
  | 'duplicate'
  | 'bad-name'
  | 'no-argv'
  | 'spawn-failed'
  | 'crash-limit'
  | 'timeout'
  | 'not-found'
  | 'disposed'

/** 一次托管请求。 */
export interface HostRequest {
  /** 托管项名；同一名字同时只允许一个实例。 */
  readonly name: string
  /** 可执行文件与参数；`argv[0]` 是程序本身，不经 shell 解释。 */
  readonly argv: readonly string[]
  /** 工作目录；省略用配置里的 `cwd`（默认宿主工作目录）。 */
  readonly cwd?: string
  /** 追加到父环境清洗结果之上的环境项。 */
  readonly env?: Readonly<Record<string, string>>
  /** 终止宽限期（毫秒）；省略用配置值。 */
  readonly graceMs?: number
}

/** 托管项的只读视图（对外只给快照，不给句柄）。 */
export interface HostedView {
  readonly name: string
  readonly phase: HostPhase
  /** 已重启次数（首次启动不计）。 */
  readonly restarts: number
  /** Unix 毫秒。 */
  readonly startedAt?: number
  readonly exitedAt?: number
  /** 退出码；被信号杀死时为 `null`。 */
  readonly exitCode?: number | null
  readonly signal?: string | null
  /**
   * 子进程 pid。
   *
   * **上游契约没有这个字段**，本包只在实现真的挂了 `pid` 时读出来（防御式探测），
   * 读不到就是 `null`。`null` 不等于「没有进程」，只等于「拿不到 pid」。
   */
  readonly pid?: number | null
  /** 走到这一步的原因。 */
  readonly reason?: HostReason
  /** 一句给人看的补充。 */
  readonly detail?: string
  /**
   * `stop()` 时「托管范围确实静默了」是否被确认。
   *
   * `false` 的语义很具体：组杀已经发出，但 `waitForExit` 在超时内没有回 true。
   * 这时**不能**报「已停止」——那会让下一次启动撞上还在占端口的进程。
   */
  readonly confirmed?: boolean
}

/** 计数（只增，不清零）。 */
export interface HostStats {
  readonly starts: number
  readonly restarts: number
  readonly exits: number
  readonly terminations: number
  readonly refusals: number
}

/** 落盘的一条状态（`.pid` 之外的 `.json`，两者分工见 README）。 */
export interface HostStateRecord {
  readonly name: string
  readonly phase: HostPhase
  readonly argv: readonly string[]
  readonly cwd: string
  readonly startedAt: number
  readonly exitedAt?: number
  readonly restarts: number
  readonly pid: number | null
}

/**
 * 上游 `SubprocessHandle` 的结构子集。
 *
 * **刻意只写用到的那几项**：写全了就等于把上游契约抄一份进来，上游加字段本包不会跟，
 * 抄来的那份就成了第二个真源。
 */
export interface ChildHandleLike {
  /** 退出事实；被信号杀死时 `exitCode` 为 `null`。 */
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  /** 上游唯一终止动词：作用于 provider 托管的整个进程范围。 */
  terminate(): void
  /** 等托管范围清空；`false` = 信号先到期。 */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** 上游 `SubprocessSpawnSpec` 的结构子集（只写本包会填的字段）。 */
export interface SpawnSpecLike {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore'
    readonly stdout: { readonly maxBytes: number }
    readonly stderr: { readonly maxBytes: number }
  }
  readonly graceMs: number
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** 上游 `ctx.subprocess` 的结构子集。 */
export interface SubprocessPortLike {
  spawn(spec: SpawnSpecLike): ChildHandleLike
}

/** 状态落盘端口（默认本地文件，测试可换内存实现）。 */
export interface StatePort {
  /** 这条托管项的状态文件绝对路径；只在内存时为空串。 */
  pathOf(name: string): string
  read(name: string): HostStateRecord | null
  write(record: HostStateRecord): void
  remove(name: string): void
}

/** 本插件对外提供的服务。 */
export interface ProcessHostService {
  readonly available: boolean
  readonly reason?: HostReason
  /** 启动并托管。**永不抛**。 */
  start(request: HostRequest): Promise<HostedView>
  /** 组杀并等静默。**永不抛**。 */
  stop(name: string, options?: { readonly timeoutMs?: number }): Promise<HostedView>
  /** 停再起（同一 `argv`）。**永不抛**。 */
  restart(name: string): Promise<HostedView>
  get(name: string): HostedView | undefined
  list(): readonly HostedView[]
  /** 状态文件路径；只在内存时为空串。 */
  stateFileOf(name: string): string
  stats(): HostStats
  /** 卸载：逐个组杀，清空引用。**永不抛**。 */
  dispose(): Promise<void>
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

/** O-002 路径子集。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  ensure(area: 'user', ...segments: string[]): string
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
