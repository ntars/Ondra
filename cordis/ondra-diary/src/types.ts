/**
 * O-045 `ondra-diary` 的对外契约。
 *
 * 定位：**她每天给自己写一篇日记，一天一个文件，写进去就不会空着**。
 *
 * ```
 * 02:00–04:00 窗口
 *   ├─ 定时到点（clock.dailyAt）──┐
 *   ├─ 窗口内退避重试（clock.after）├─→ ensure(dayKey) ─→ 已存在？ → skipped-exists
 *   ├─ 看门狗（启动 60s 后 + 每次触发）│                    └→ 写：模型 / 模板兜底
 *   └─ 窗口外补写（backfillDays）  ─┘
 * ```
 *
 * ## 一、文件是真源，不是内存标志
 *
 * 「今天写没写」一律读文件系统（`exists`），不存「今天已写过」的内存标志。
 * 存标志的两种坏法都是静默的：断电重启后标志丢了 → 同一天写两篇（第二篇覆盖第一篇，
 * 内容还是新的，看不出问题）；或者标志被写成「已写」而文件其实没落盘 → 那一天永远是空的。
 *
 * ## 二、四层保底对应四个字段（手册 §11.8-4）
 *
 * | 层 | 手册原话 | 落点 |
 * |---|---|---|
 * | 定时 | 定时重试 | `clock.dailyAt(windowStart)` + 窗口内 `after()` 退避 |
 * | 容差 | 容差 | `windowEnd` 之前都算「还有机会」，过后才判错过 |
 * | 看门狗 | 看门狗 | 启动后延迟一次 `tick()`，每次触发都查缺失 |
 * | 程序兜底 | 系统直接写入 | `templateFallback`：模型不可用也写满一篇，标 `source=template` |
 *
 * ## 三、「不打扰」的准确含义
 *
 * 不往任何会话发消息、不调主动链路（O-042/O-043）、不把自己的产物塞进上下文。
 * 日记只落盘，读它的人自己来读（界面、`ondra-onthisday`、回忆类插件）。
 * 因此本插件**不注册工具**：一旦注册，模型就能自己触发「写日记」，
 * 于是「今天已经写过了」这句话会由模型说出来——那就不再是日记了。
 *
 * ## 四、日期只取一次
 *
 * 一次调用里 `dayKey` 只算一次再往下传（纪律 95）。两次取「今天」在跨零点那几毫秒
 * 会落在两个日子上，症状是「文件标题写昨天、正文写今天」，两边都不报错。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§18.5），相邻服务一律结构对位。
 */

/** 本插件注册的服务键（连字符，非 `ondra:diary`）。全仓唯一归属。 */
export const DIARY_SERVICE_KEY = 'ondra-diary'

/** 服务键 / 工具名 / 配置键的形状（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 日记目录（相对 `user` 区域）。手册 §11.8-4 的落点是 `user/diary/`。 */
export const DIARY_DIR = 'diary'

/** 日记文件扩展名。一天一个文件，文件名就是自然日键。 */
export const DIARY_EXT = '.md'

/** 自然日键的形状。只认 `YYYY-MM-DD`，别的一律当非法输入拒绝。 */
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 元信息注释的开头。放在文件末尾，方便人读时被折叠掉。 */
export const META_TAG = 'ondra-diary'

/** 元信息格式版本。读到不认识的版本仍能读正文，只是不解析字段。 */
export const META_VERSION = 1

/** 一天的毫秒数（只用于「大致范围」判断，精确跨日一律走 clock）。 */
export const DAY_MS = 86_400_000

/**
 * 默认写入窗口。台账写「每日 02:00–04:00」。
 *
 * 手册 §11.8-4 另有一套来源值（23:05 写日记，理由是「作者 24 点关电脑，
 * 建议按自己的关机时间定」）。两处不冲突于机制、只冲突于具体钟点：
 * 台账值是**产品默认**，23:05 那种是**用户自定**，故两者都做成配置项，
 * 并在 README「已知限制」里登记这条口径差。
 */
export const DEFAULT_WINDOW_START = '02:00'

/** 默认窗口结束。到此为止还没写成，就当今天错过了（第二天由看门狗补）。 */
export const DEFAULT_WINDOW_END = '04:00'

/* ------------------------------------------------------------------ *
 * 产物形状
 * ------------------------------------------------------------------ */

/** 正文来源。`template` 是兜底，必须能被界面区分出来（不是「模型偷懒」）。 */
export type DiarySource = 'model' | 'template'

/** 这一次是怎么被触发的。写进日志，排障时先看它。 */
export type TriggerMode = 'schedule' | 'retry' | 'catch-up' | 'manual'

/** 一次写日记的结论码。消费方可按码分支，不必匹配中文文案。 */
export type DiaryCode =
  /** 模型写的，已落盘。 */
  | 'written'
  /** 模板兜底写的，已落盘（模型缺席或失败）。 */
  | 'written-template'
  /** 当天已有文件，跳过（幂等）。 */
  | 'skipped-exists'
  /** 不在写入窗口内，且不是补写。 */
  | 'outside-window'
  /** 太旧了，超出 `backfillDays`，不补（补一个月等于一次性烧一个月模型费）。 */
  | 'too-old'
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有路径服务也没有可写目录，无法落盘。 */
  | 'no-path'
  /** 日期键非法。 */
  | 'invalid-day'
  /** 生成结果为空且兜底关闭。 */
  | 'empty'
  /** 内部错误（已捕获，不外抛）。 */
  | 'error'

/** 一篇日记的轻量引用（列表用，不带正文）。 */
export interface DiaryRef {
  /** 自然日键 `YYYY-MM-DD`。 */
  readonly dayKey: string
  /** 绝对路径。 */
  readonly path: string
  /** 正文字符数（不含元信息注释）。 */
  readonly chars: number
  /** 正文来源。 */
  readonly source: DiarySource
  /** 文件修改时间（毫秒）。 */
  readonly mtime: number
}

/** 一篇读完的日记。 */
export interface DiaryEntry extends DiaryRef {
  /** 标题行（`# ...` 去掉井号）。 */
  readonly title: string
  /** 正文（不含标题与元信息）。 */
  readonly body: string
  /** 元信息里记的生成时刻；老文件没有则等于 `mtime`。 */
  readonly generatedAt: number
}

/** 一次写入的结论。 */
export interface DiaryResult {
  /** 自然日键。 */
  readonly dayKey: string
  /** 结论码。 */
  readonly code: DiaryCode
  /** 落盘路径（不可写时为空串）。 */
  readonly path: string
  /** 正文字符数。 */
  readonly chars: number
  /** 正文来源。 */
  readonly source: DiarySource
  /** 结论时刻。 */
  readonly at: number
  /** 一句中文说明（可直接进日志与面板）。 */
  readonly detail: string
}

/** 写入选项。 */
export interface WriteOptions {
  /** 覆盖已有文件（**唯一正当用途是面板上的「重写这篇」**）。 */
  readonly force?: boolean
  /** 跳过模型，直接用模板（离线演示、评估集）。 */
  readonly templateOnly?: boolean
  /** 触发方式，只影响日志与统计。 */
  readonly mode?: TriggerMode
  /** 结论时刻，省略用系统时间。 */
  readonly at?: number
}

/** 统计快照。**只在内存**，不落盘（日记的真源是文件，不是计数）。 */
export interface DiaryStats {
  /** 判定次数（`ensure` 被调用几次）。 */
  readonly calls: number
  /** 真正写出文件的次数（含模板兜底）。 */
  readonly writes: number
  /** 模板兜底次数。 */
  readonly templateWrites: number
  /** 跳过次数（当天已有）。 */
  readonly skips: number
  /** 被窗口拒绝次数。 */
  readonly outsideWindow: number
  /** 补写次数（`catch-up` 成功写出）。 */
  readonly backfilled: number
  /** 太旧而放弃补写的天数。 */
  readonly tooOld: number
  /** 模型失败次数（随后多半走了模板兜底）。 */
  readonly modelFailures: number
  /** 落盘失败次数。 */
  readonly writeFailures: number
  /** 内部错误次数。 */
  readonly errors: number
  /** 从正文里剔除的「报数片段」个数（手册 §4.3 内感受铁律）。 */
  readonly metricsStripped: number
  /** 目录是否可写。 */
  readonly stored: boolean
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type DiaryUnavailableReason = 'disabled'

/** 日记服务。 */
export interface DiaryService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DiaryUnavailableReason
  /** 是否具备落盘条件（路径服务在位）。缺席时**不自己拼路径**，见 README 已知限制。 */
  readonly stored: boolean
  /**
   * 依赖是否齐（可写目录 + 时钟）。
   *
   * 与 `available` **分开给**（纪律 83）：只给 `available`，面板会显示「已启用」
   * 而每一轮都在降级，看不到真正缺的是时钟。缺时钟时只能手动 `write()`，不会自动写。
   */
  readonly ready: boolean

  /** 拼某天的文件路径（不创建、不检查）。 */
  pathOf(dayKey: string): string

  /** 某天是否已有日记文件。 */
  exists(dayKey: string): boolean

  /** 读某天的日记；没有或读不动时 `undefined`（不抛）。 */
  entry(dayKey: string): DiaryEntry | undefined

  /** 最近的几篇（按日期倒序，最多 `limit` 篇）。 */
  list(limit?: number): readonly DiaryRef[]

  /**
   * 写某天的日记（不判断窗口，供面板与补写用）。
   * @param dayKey 自然日键。
   * @param options 选项。
   */
  write(dayKey: string, options?: WriteOptions): Promise<DiaryResult>

  /**
   * 幂等写：已有就跳过。**这是定时与看门狗走的唯一入口。**
   * @param dayKey 自然日键，省略取今天。
   * @param options 选项。
   */
  ensure(dayKey?: string, options?: WriteOptions): Promise<DiaryResult>

  /**
   * 看门狗：窗口内补今天，窗口外补昨天及更早（上限 `backfillDays`）。
   *
   * 定时器与启动钩子都只调它一个，不各自判一遍窗口。
   * @param at 时刻，省略用系统时间。
   */
  tick(at?: number): Promise<readonly DiaryResult[]>

  /**
   * 补写：从昨天往前逐日查，缺的补上，最多 `days` 天。
   * @param days 最多补几天，省略用配置值。
   * @param at 时刻，省略用系统时间。
   */
  catchUp(days?: number, at?: number): Promise<readonly DiaryResult[]>

  /** 统计快照。 */
  stats(): DiaryStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码）
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

/** O-003 时钟的结构对位子集（只用到本插件真正用的那几个方法）。 */
export interface ClockLike {
  /** 自然日键 `YYYY-MM-DD`（生效时区）。 */
  dayKey(epoch?: number): string
  /** 某个时刻所在自然日的 00:00 时间戳。 */
  startOfDay(epoch?: number): number
  /** 判断是否落在时间窗内（左闭右开，`start===end` 为空窗口）。 */
  withinWindow(start: string, end: string, epoch?: number): boolean
  /** 每天到点一次。 */
  dailyAt(hhmm: string, fn: (dayKey: string) => void): () => void
  /** 延时一次。 */
  after(ms: number, fn: () => void): () => void
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user', ...segments: string[]): string
  /** 确保某区域下的子目录存在并收紧权限，返回绝对路径。 */
  ensure(area: 'user', ...segments: string[]): string
  /** 确保私有文件可用：父目录 0700、文件 0600。 */
  prepareFile(filePath: string): string
}

/** O-010 记忆条目的结构对位子集（只取本插件要读的字段）。 */
export interface FactLike {
  /** 正文。 */
  readonly text: string
  /** 五类标签。 */
  readonly kind: string
  /** 主体（`user` / `self` / 人名）。 */
  readonly subject: string | null
  /** 写入时间。 */
  readonly createdAt: number
}

/** O-010 记忆服务的结构对位子集。只读，且只取最近若干条。 */
export interface MemoryLike {
  /** 列事实。 */
  listFacts(query?: {
    readonly limit?: number
    readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
  }): readonly FactLike[]
}

/** O-035 模型网关的结构对位子集（只用到非流式一次调用）。 */
export interface GatewayLike {
  /** 是否有可用来源。 */
  readonly available: boolean
  /** 非流式调用：把正文拼起来一次给。 */
  complete(request: {
    readonly messages: readonly object[]
    readonly system?: string
    readonly temperature?: number
    readonly maxTokens?: number
    readonly purpose?: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly text: string }>
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}
