/**
 * O-068 `ondra-adb` 的对外契约。**档位〔复〕**（端侧复用：只做接线、配置与只读降级）。
 *
 * ## 手册给出的全部依据（逐字，别处没有第二份）
 *
 * master-plan §9.11「端侧实证」：
 *
 * ```
 * adb（包名实为 @ondra/adapter-adb）：只做只读短信轮询（content://sms/inbox，
 * 未读 20 条，15s 轮询，seen 集合超 1000 裁到 500）；没有截图、点击、中文输入；
 * 发短信不做，靠 replyWebhook + 用户自备 Intent 桥。
 * ```
 *
 * master-plan §9.12（字段错位必须在本插件修掉）：
 *
 * ```
 * adb | UI 填 serial | 源码实际读 adbPath / pollSeconds / replyWebhook | 全部错位
 * ```
 *
 * 手册 §1.7：`O-068 adb | scrcpy 能力更强（投屏+控制）`。
 * → 本包**只承接「读短信」这一片**；投屏与点击属 scrcpy，本包不碰（见 README 不负责表）。
 *
 * 手册正文检索 `adb` 只有 3 处（§1.7 修订行、§7.4 设置入口、第十一部分书签表），
 * **没有 adb 专章**，也没有 `content query` 的确切命令行。所以：
 * 命令组合只出现在 `sms.ts` 一处，且标为「按公开用法写、仓内无副本、未实跑」。
 *
 * ## 三个必须分开的概念
 *
 * 1. **读**（`readSms`）：纯查询，**不改任何「已答」状态**。
 *    查询带副作用是最容易埋的坑——用户在面板上「看一眼未读」，
 *    消息就被标成已答，之后她再也不会回应它。
 * 2. **轮询应答**（`poll` + `autoReply`）：读过之后**转交给人格**并回一条。
 * 3. **已答集合**（`seen`）：只在第 2 条里增长。它存的是「处理过」而不是「读过」。
 *
 * 三者混成一个，就会出现「点开面板 → 短信全被吞」这种查不出原因的行为。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const ADB_SERVICE_KEY = 'ondra-adb'

/** 名字合规正则（服务键 / 工具名 / 配置键共用，手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 短信收件箱的 content URI（master-plan §9.11 逐字）。 */
export const SMS_URI = 'content://sms/inbox'

/** 轮询周期默认值（秒）。master-plan §9.11：`15s 轮询`。 */
export const POLL_SECONDS = 15

/** 轮询周期下界（秒）：5。再低就是拿电池换实时性。 */
export const POLL_SECONDS_FLOOR = 5

/** 轮询周期上界（秒）：300。五分钟才看一眼，短信就不是短信了。 */
export const POLL_SECONDS_CEIL = 300

/** 每次轮询最多处理几条。master-plan §9.11：`未读 20 条`。 */
export const UNREAD_BATCH = 20

/** 单轮处理条数的下界：1。 */
export const BATCH_FLOOR = 1

/** 单轮处理条数的上界：20。**故意不让调高**——一次涌 100 条会把模型打成一串 429。 */
export const BATCH_CEIL = 20

/** 已答集合上限。master-plan §9.11：`seen 集合超 1000 裁到 500`。 */
export const SEEN_MAX = 1_000

/** 裁剪后保留条数。master-plan §9.11：`裁到 500`。 */
export const SEEN_KEEP = 500

/** 单条 adb 命令超时（毫秒）。8 秒：手机睡着了会拖，但不能拖住 15 秒的轮询周期。 */
export const EXEC_TIMEOUT_MS = 8_000

/** 命令超时的下界（毫秒）：2 秒。 */
export const EXEC_FLOOR = 2_000

/** 命令超时的上界（毫秒）：30 秒。超过它就会与轮询周期打架。 */
export const EXEC_CEIL = 30_000

/** 发送桥请求超时（毫秒）。8 秒：桥接端是本机或 adb forward，不该更慢。 */
export const REPLY_TIMEOUT_MS = 8_000

/** 同一条短信最多尝试转交几次，超过就放弃并记入已答集合（防止每 15 秒重试到天荒地老）。 */
export const MAX_ATTEMPTS = 3

/** 尝试计数的内存表上限（只记在飞，不落盘）。 */
export const ATTEMPT_MAX = 200

/** 首次轮询的延迟（毫秒）：3 秒。躲开宿主启动时的争抢，但别让用户等 15 秒才看见第一条。 */
export const FIRST_POLL_DELAY_MS = 3_000

/**
 * 轮询结论（闭集）。
 *
 * 每个码对应**一个不同的排查动作**（纪律 143）：把「用户关了」与「缺施工件」
 * 合成一个 `disabled`，面板上就会有人去翻开关，而真正的原因是从没注入执行器。
 */
export type PollReason =
  /** 读成功（有没有新消息看 `unseen`）。 */
  | 'ok'
  /** 用户把开关关了。 */
  | 'disabled'
  /** 没有可用的执行器（`useRunner(null)` 之后）。**与 `no-adb` 分开**：一个是没接管，一个是没装。 */
  | 'no-runner'
  /** `adb` 可执行文件找不到（ENOENT）。去装 platform-tools 或改 `adbPath`。 */
  | 'no-adb'
  /** 命令不在只读白名单里（本包自己拦下的，**没有真的执行**）。 */
  | 'denied'
  /** 没有设备 / 设备离线 / 未授权 USB 调试。三个的修法是同一件：插上、解锁、点允许。 */
  | 'device-offline'
  /** 命令超时。 */
  | 'timeout'
  /** 非零退出（其余退出失败）。 */
  | 'exit'
  /** 进程启动就抛错（与 ExecReason 的 'spawn' 对齐：运行期执行器确实会把它报上来）。 */
  | 'spawn'
  /** 上一次轮询还没结束。 */
  | 'busy'
  /** 输出解析不出任何一行（格式变了，或设备上没有短信应用）。 */
  | 'bad-output'
  /** 插件已停止。 */
  | 'stopped'
  /** 本包内部异常（正确性兜底；正常路径走不到这里）。 */
  | 'internal'

/** 一条短信（本包命名，不是平台命名）。 */
export interface SmsMessage {
  /** 短信表主键（`_id`）。**它是唯一的幂等键**——正文与号码都可能重复。 */
  readonly id: string
  /** 发信号码。 */
  readonly address: string
  /** 正文。 */
  readonly body: string
  /** 时间戳（毫秒；解析不出时 0）。 */
  readonly date: number
}

/** 一次读取的结论。 */
export interface ReadResult {
  /** 读成功没有。 */
  readonly ok: boolean
  /** 原因码。`ok:true` 时恒为 `ok`。 */
  readonly reason: PollReason
  /** 读到的短信（已按时间升序，**未被已答集合过滤**）。 */
  readonly rows: readonly SmsMessage[]
  /** 一行中文说明（含下一步动作，不含号码与正文）。 */
  readonly detail: string
  /** 解析时丢弃的坏行数。 */
  readonly badRows: number
}

/** 一次轮询的结论。 */
export interface PollOutcome {
  /** 是否读成功。 */
  readonly ok: boolean
  /** 原因码。 */
  readonly reason: PollReason
  /** 读到几行。 */
  readonly read: number
  /** 其中未处理过几条（自动应答关闭时也照实报，供面板显示）。 */
  readonly unseen: number
  /** 本轮实际转交几条。 */
  readonly handled: number
  /** 转交成功并已回出去几条。 */
  readonly answered: number
  /** 本轮放弃几条（尝试次数用尽）。 */
  readonly gaveUp: number
  /** 一句中文说明。 */
  readonly detail: string
}

/** 发送结论（闭集）。 */
export type ReplyReason =
  /** 发成功。 */
  | 'ok'
  /** 插件关着。 */
  | 'disabled'
  /** 没配桥接地址（`replyWebhook` 为空）。 */
  | 'no-bridge'
  /** 地址不是 http/https。 */
  | 'bad-url'
  /** 地址指向外网且 `allowRemoteBridge=false`。 */
  | 'loopback-only'
  /** 号码或正文为空。 */
  | 'empty'
  /** HTTP 非 2xx。 */
  | 'http'
  /** 请求超时。 */
  | 'timeout'
  /** 其余异常。 */
  | 'error'

/** 一次发送的结论。 */
export interface ReplyOutcome {
  /** 发成功没有。 */
  readonly ok: boolean
  /** 原因码。 */
  readonly reason: ReplyReason
  /** 一句中文说明（**不含号码与正文**）。 */
  readonly detail: string
}

/** adb 一次命令的结论。 */
export interface ExecResult {
  /** 命令跑完且退出码为 0。 */
  readonly ok: boolean
  /** 失败原因（`ok:true` 时无）。 */
  readonly reason?: ExecReason
  /** 标准输出。 */
  readonly stdout: string
  /** 标准错误。 */
  readonly stderr: string
  /** 退出码（拿不到时为 -1）。 */
  readonly code: number
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 命令失败原因（闭集）。 */
export type ExecReason =
  /** 可执行文件不存在。 */
  | 'no-adb'
  /** 没有设备 / 离线 / 未授权。 */
  | 'device-offline'
  /** 超时。 */
  | 'timeout'
  /** 非零退出。 */
  | 'exit'
  /** 进程启动就抛错（权限、路径不是可执行文件…）。 */
  | 'spawn'

/**
 * 命令执行端口（**本包唯一与设备打交道的地方**）。
 *
 * 为什么是端口而不是直接 `execFile`：
 * ① 测试与宿主侧桥接都要能换实现，而不改本包；
 * ② 只读白名单必须在**命令级别**拦截（`policy.ts`），端口收 `argv` 数组而不是命令串，
 *    就是为了让白名单能逐 token 检查——收字符串就只能靠正则猜，猜漏一次就是写操作。
 */
export interface AdbRunner {
  /** 实现标识（日志与面板用）。 */
  readonly id: string
  /**
   * 跑一条 **已通过白名单** 的命令。
   * 实现方**不得抛错**：所有失败折成 `ExecResult`（手册 §8.1-C3）。
   * @param argv 参数数组（不含 adb 本体，第一个是 `shell` / `devices` 之类）。
   * @param timeoutMs 超时（毫秒）。
   */
  exec(argv: readonly string[], timeoutMs: number): Promise<ExecResult>
}

/** 回复桥端口（把她说的话交给用户自备的 Intent 桥）。 */
export interface ReplyPush {
  /** 实现标识。 */
  readonly id: string
  /**
   * 投递一条回复。**永不抛错**。
   * @param input 号码与正文。
   */
  send(input: { readonly to: string; readonly body: string }): Promise<ReplyOutcome>
}

/** 插件现状（面板读它）。 */
export interface AdbStatus {
  /** 开关开着没有。 */
  readonly enabled: boolean
  /** 能不能读（开关 + 执行器 + 没停）。 */
  readonly available: boolean
  /** 不能读的原因。 */
  readonly reason?: PollReason
  /** 执行器标识（没有则空串）。 */
  readonly runner: string
  /** 桥接标识（没有则空串）。 */
  readonly bridge: string
  /** 已答集合条数。 */
  readonly seen: number
  /** 上次轮询时刻（毫秒；没跑过为 0）。 */
  readonly lastPollAt: number
  /** 上次轮询结论。 */
  readonly lastReason: PollReason | 'idle'
  /** `adb -s <serial>` 里的序列号（空 = 不指定）。 */
  readonly serial: string
}

/** 计数。 */
export interface AdbStats {
  /** 轮询了几次（含失败）。 */
  readonly polls: number;
  /** 读到几行（累计）。 */
  readonly rows: number;
  /** 处理过几条（累计）。 */
  readonly handled: number;
  /** 回出去几条（累计）。 */
  readonly answered: number;
  /** 放弃几条（累计）。 */
  readonly gaveUp: number;
  /** 按原因分桶的失败数。 */
  readonly failures: Readonly<Record<string, number>>;
  /** 最慢一次轮询耗时（毫秒）。 */
  readonly worstPollMs: number;
}

/** 本插件对外提供的服务。 */
export interface AdbService {
  /** 现在能不能读。 */
  readonly available: boolean
  /** 不能读的原因。 */
  readonly reason?: PollReason
  /** 换执行器（`null` = 卸掉；此时 `poll()` 返回 `no-runner`）。 */
  useRunner(runner: AdbRunner | null): void
  /** 换回复桥。 */
  usePush(push: ReplyPush | null): void
  /** 开始轮询（重复调用无副作用）。 */
  start(): void
  /** 停止轮询（清定时器；幂等）。 */
  stop(): void
  /** 立刻轮询一次（定时器也走它）。 */
  poll(): Promise<PollOutcome>
  /**
   * 只读读取短信。**不改已答集合**，故面板刷新不会吞消息。
   * @param input 条数上限与是否只看未读。
   */
  readSms(input?: { readonly limit?: number; readonly unreadOnly?: boolean }): Promise<ReadResult>
  /** 经桥接端发一条（号码为接收方）。 */
  reply(to: string, body: string): Promise<ReplyOutcome>
  /** 现状。 */
  status(): AdbStatus
  /** 计数。 */
  stats(): AdbStats
  /** 重读已答集合（用户手改过文件时用）。 */
  reloadSeen(): number
}

/* ------------------------------------------------------------------ *
 * 依赖服务的结构对位（不 import 任何 ondra-* 包，master-plan §18.5）
 * ------------------------------------------------------------------ */

/** 日志子集（宿主 `ctx.logger()` 的形状）。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** fetch 的最小形状（不引 `@types/node` 之外的东西）。 */
export interface FetchLike {
  (
    input: string,
    init: {
      readonly method: string
      readonly headers: Readonly<Record<string, string>>
      readonly body: string
      readonly signal?: AbortSignal
    },
  ): Promise<FetchResponseLike>
}

/** fetch 响应的最小形状。 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** O-001 的日志名前缀子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟子集。 */
export interface ClockLike {
  now(): number
}

/** O-002 路径服务子集。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
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

/**
 * O-056 的公共段子集。**只取 `callPersona`**：
 * 分条与落盘都不该由「读短信」这件事决定（短信桥自己管拼接）。
 */
export interface KitLike {
  callPersona(input: {
    readonly conversationId: string
    readonly text: string
    readonly maxChars?: number
    readonly timeoutMs?: number
  }): Promise<{
    readonly ok: boolean
    readonly text: string
    readonly pieces?: readonly string[]
    readonly partial?: boolean
    readonly failure?: string
  }>
}
