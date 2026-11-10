/**
 * `ondra-memory-intake` 的类型与常量。
 *
 * 上游服务（记忆内核、提炼服务）都用**结构化对位**声明，不 import 它们的包：
 * 插件之间只靠服务键耦合，import 会把编译期依赖带进运行期（装上但没启用的
 * 上游会让本插件一起挂）。
 */

/** 本插件的服务键。 */
export const INTAKE_SERVICE_KEY = 'ondra-memory-intake'

/** 提炼服务的服务键（O-011）。 */
export const EXTRACT_SERVICE_KEY = 'ondra-memory-extract'

/**
 * 判重服务的服务键（O-012）。
 *
 * 它决定本插件走哪条写入路径：**在册时 `propose()` + `settle()`，缺席时 `extract()`**。
 * 两者的差别不是「多一道检查」，而是「同一条事实会不会在库里躺两份」：
 * `extract()` 是纯追加语义，说三遍「搭档叫阿岚」就写三条。
 */
export const DEDUPE_SERVICE_KEY = 'ondra-memory-dedupe'

/** 配置段键（设置页一屏）。 */
export const CONFIG_SECTION_ID = 'memory-intake'

/** 一条粗粒度日志器。 */
export interface LogLike {
  info?(message: string, ...args: readonly unknown[]): void
  warn?(message: string, ...args: readonly unknown[]): void
}

/** 消息内容块（只关心文本）。 */
export interface BlockLike {
  readonly type: string
  readonly text?: string
}

/** 一条会话消息。 */
export interface MessageLike {
  readonly role: string
  readonly content?: readonly BlockLike[]
  /**
   * 消息来源标记。宿主给真实对话标 `kind:'user'`（用户）与 `kind:'model'`（她），
   * 给每轮重新注入的上下文快照标 `runtime-context` / `time-context` 等。
   * 老发射点可能不带这个字段，故可选、且 `kind` 也可选。
   */
  readonly source?: { readonly kind?: string }
}

/** 会话事件（只取本插件认得的形状）。 */
export interface SessionEventLike {
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/** 记忆内核的写入口（结构化镜像 O-010）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  appendTurn(input: {
    readonly turnId: string
    readonly role: string
    readonly text: string
    readonly at?: number
  }): { readonly id?: string } | undefined
  /** 按条件列出事实（归池要按正文回查 id）。 */
  listFacts?(query?: {
    readonly limit?: number
    readonly subject?: string
    readonly kind?: string
  }): readonly { readonly id?: string; readonly text?: string }[]
}

/** 一条提炼出来的事实。 */
export interface ExtractResultLike {
  readonly ok?: boolean
  readonly written?: number
  readonly reason?: string
  /**
   * 提炼出的（在 `propose()` 路径下是「**待写**」的）事实。
   *
   * 注意写库前**没有 id**：id 由记忆内核在落库时生成，判重与归池都按正文对齐。
   * `category` / `subject` 决定这条事实该进哪个池，`kind` / `summary` /
   * `evidence` 是判重写库时要一并带过去的字段——少带一个，写进去的那条就
   * 与 `extract()` 直写出来的不是同一种东西。
   */
  readonly facts?: readonly {
    readonly id?: string
    readonly text?: string
    readonly kind?: string
    readonly category?: string
    readonly subject?: string
    readonly summary?: string
    readonly evidence?: readonly EvidenceRefLike[]
  }[]
}

/**
 * 判重服务（结构化镜像 O-012），只镜像本插件真正调用的两个成员。
 *
 * 为什么是 `judge()` 而不是 `settle()`：`settle()` 会自己再判一次并写库，
 * 但本插件要在这中间补一步——**墓碑已在提炼侧判过，冲突要不要落库由判重定**。
 * 用 `judge()` + `settle()` 会判两遍（两遍读的候选池不同，第二次可能换结论），
 * 所以这里只用 `settle()` 一次到底，`judge()` 留作判别「为什么没写成」。
 */
export interface DedupeServiceLike {
  readonly available: boolean
  readonly reason?: string
  settle(request: {
    readonly text: string
    readonly category?: string
    readonly kind?: string
    readonly subject?: string
    readonly channel?: string
    readonly summary?: string
    readonly salience?: number
    readonly arousal?: number
    readonly rawId?: string
    readonly evidence?: readonly EvidenceRefLike[]
    readonly at?: number
  }): {
    readonly verdict?: { readonly action?: string; readonly needsModel?: boolean; readonly reasons?: readonly string[] }
    readonly written?: boolean
    readonly record?: { readonly id?: string }
    readonly logged?: boolean
  }
}

/** 一条引文（与 O-010 的 `EvidenceRef` 同形，只镜像判重写库要带的三项）。 */
export interface EvidenceRefLike {
  readonly source: string
  readonly quote: string
  readonly messageIndex?: number
}

/** 提炼服务（结构化镜像 O-011）。 */
export interface ExtractServiceLike {
  readonly available: boolean
  extract(request: {
    readonly turnId: string
    readonly rawId?: string
    readonly messages: readonly { readonly role: 'user' | 'assistant' | 'tool'; readonly text: string }[]
    readonly at?: number
    readonly maxFacts?: number
  }): Promise<ExtractResultLike>
  /**
   * 只提炼、**不写库**（O-011 刻意留的第二个入口，专给判重用）。
   *
   * 与 `extract()` 的差别只有一个：不走 `addFact()`。其余（调模型、解析、
   * 证据闸门、墓碑闸、本轮内去重）完全同一条路径——所以「有判重时少了一条
   * 事实」不可能是本函数丢的，只可能是裁决判成了 `drop` / `append`。
   *
   * 声明成可选：老版本 O-011 只有 `extract()`，那时本插件自动退回旧路径，
   * 不会因为接口少一个成员而整轮不写。
   */
  propose?(request: {
    readonly turnId: string
    readonly rawId?: string
    readonly messages: readonly { readonly role: 'user' | 'assistant' | 'tool'; readonly text: string }[]
    readonly at?: number
    readonly maxFacts?: number
  }): Promise<ExtractResultLike>
}

/** 记忆池（结构化镜像 O-131）。 */
export interface PoolServiceLike {
  readonly available: boolean
  assign(input: {
    readonly factId: string
    readonly text?: string
    readonly labels?: readonly string[]
    readonly pool?: string
    readonly note?: string
    readonly at?: number
  }): { readonly pool?: string; readonly unclassified?: boolean } | undefined
}

/**
 * 记忆图谱（结构化镜像 O-015 的建边面）。
 *
 * 只镜像一个成员：本插件只建 `cooccur` 边，不查邻居、不读关联度。
 * 抄一份完整契约等于在这里维护第二份形状（§18.5：不 import 邻居源码，
 * 一致性靠结构对位与检查脚本）。
 */
export interface GraphServiceLike {
  readonly available: boolean
  link(input: {
    readonly from: string
    readonly to: string
    readonly relation?: string
    readonly at?: number
  }): { readonly created?: boolean; readonly refusal?: string } | undefined
}

/** 一条被认出的话（结构化镜像 O-016 的 `DetectedItem`）。 */
export interface DetectedLike {
  /** 判为承诺还是待办。 */
  readonly kind: 'promise' | 'todo'
  /** 锁住的正文。 */
  readonly text: string
  /** 解析出的到期时刻；`null` = 无期限。 */
  readonly dueAt: number | null
}

/** 一条待办（只镜像用到的两项）。 */
export interface TodoLike {
  readonly id: string
  readonly text: string
}

/** 一条到期提醒候选（只镜像用到的两项）。 */
export interface ReminderLike {
  readonly promise: { readonly id: string; readonly text: string }
}

/* ------------------------------------------------------------------ *
 * 缺口池（结构化镜像 O-129 `ondra-drive-gap`）
 * ------------------------------------------------------------------ */

/** 一次「她自己没答上来」的判定结果。 */
export interface GapDetectionLike {
  /** 取到的整句（上游已截断到 120 字）。 */
  readonly text: string
  /** 命中的标记词，只进日志。 */
  readonly marker: string
}

/** 开一条缺口的结果（只镜像用到的四项）。 */
export interface GapOpenResultLike {
  /** 是否被接收。 */
  readonly accepted: boolean
  /** 是否新建了一条（`false` 且 `accepted` 表示并入了已有的）。 */
  readonly created: boolean
  /** 拒收原因。 */
  readonly refusal?: string
}

/**
 * 缺口池服务（结构化镜像 O-129 `ondra-drive-gap`）。
 *
 * ## 为什么只镜像三个方法
 *
 * 本插件只做**写入**：`available` 判能不能写、`detect()` 判哪句该写、
 * `open()` 真写。唤醒判定（`dueForWake`）、片段产出（`fragment`）、
 * 投递记账（`markDelivered`）全是**读取侧**的事，归 O-042 与器官宿主，
 * 镜像进来只会多两处会漂的契约。
 */
export interface DriveGapLike {
  /** 是否可用（总开关 + 存储端口就位）。 */
  readonly available: boolean
  /** 不可用原因，用于日志里说清「为什么一条都没记」。 */
  readonly reason?: string
  /** 判一句话里有没有「她自己没答上来」（**判据全在上游**）。 */
  detect(text: string): GapDetectionLike | undefined
  /** 开一条缺口（三源共用入口）。 */
  open(input: {
    readonly text: string
    readonly source: string
    readonly query?: string
    readonly note?: string
  }, at?: number): GapOpenResultLike
}

/**
 * 承诺与待办服务（结构化镜像 O-021 `ondra-memory-prospective`）。
 *
 * ## 为什么这里只镜像五个方法
 *
 * 本插件只做「把话捡进去」，不读提醒算术、不结算、不清库。多镜像一个方法
 * 就多一处会漂的契约——上游改签名时，本插件会因为一个自己从不调用的方法
 * 而编译失败。
 */
export interface ProspectiveLike {
  /** 是否可用（总开关 + 存储端口就位）。 */
  readonly available: boolean
  /** 不可用原因，用于日志里说清「为什么一条都没记」。 */
  readonly reason?: string
  /** 从一句话里认承诺 / 待办（**判据全在上游**）。 */
  detect(text: string, at?: number): readonly DetectedLike[]
  /** 记一条承诺（会写记忆，缺内核时抛 `no-core`）。 */
  remember(text: string, options?: { readonly dueAt?: number; readonly at?: number }): unknown
  /** 记一条待办（不写记忆）。 */
  addTodo(text: string, at?: number): unknown
  /** 未完成的待办。 */
  listTodos(): readonly TodoLike[]
  /** 到期提醒候选（查重用）。 */
  dueForReminder(at?: number): readonly ReminderLike[]
}

/** 一轮对话。 */
export interface TurnDraft {
  /** 轮次 id（调用方生成，仅用于溯源）。 */
  readonly turnId: string
  /** 用户与助手的原话，按发生顺序。 */
  readonly lines: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  /** 时刻；省略取落盘时刻。 */
  readonly at?: number
}

/** 采集统计（只在内存）。 */
export interface IntakeStats {
  /** 是否可用（总开关 + 记忆内核在场）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: string
  /** 收下的轮次数。 */
  readonly turns: number
  /** 成功写入原文的次数。 */
  readonly raw: number
  /** 累计写入的事实数。 */
  readonly facts: number
  /** 跳过的次数（无内核、空轮次）。 */
  readonly skipped: number
  /** 失败次数（写原文或提炼抛错）。 */
  readonly failed: number
  /** 累计记下的承诺条数。 */
  readonly promises: number
  /** 累计记下的待办条数。 */
  readonly todos: number
  /** 累计新建的缺口（执念）条数。 */
  readonly gaps: number
  /** 累计投出去的情绪事件次数。 */
  readonly felt: number
}

/** 采集服务。 */
export interface IntakeService {
  /** 是否可用（总开关 + 记忆内核在场）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: string
  /** 统计快照。 */
  stats(): IntakeStats
  /**
   * 手动收一轮（测试与补录）。
   * @param turn 轮次内容。
   * @param sinceLastTurn 距上一轮的毫秒数；省略表示判不出「久别」。
   */
  ingest(turn: TurnDraft, sinceLastTurn?: number): Promise<{ readonly rawId?: string; readonly facts: number; readonly reason?: string }>
}

/** 插件实例配置。 */
export interface IntakeConfig {
  /** 总开关，默认开。 */
  readonly enable?: boolean
  /** 是否调用提炼服务抽事实，默认开；关掉就只写原文。 */
  readonly extract?: boolean
  /** 同时进行的提炼次数上限，默认 1。 */
  readonly maxConcurrent?: number
  /** 每轮最多提炼几条，默认交给提炼服务。 */
  readonly maxFacts?: number
  /** 是否打日志，默认开。 */
  readonly verbose?: boolean
}

/** 出厂默认值（单一真源）。 */
export const DEFAULT_CONFIG: Required<IntakeConfig> = {
  enable: true,
  extract: true,
  maxConcurrent: 1,
  maxFacts: undefined as unknown as number,
  verbose: true,
}
