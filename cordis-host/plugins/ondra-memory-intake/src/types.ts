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
   * 写进库的事实。
   *
   * 注意**没有 id**：id 由记忆内核在落库时生成，归池只能按正文回查。
   * `category` / `subject` 决定这条事实该进哪个池。
   */
  readonly facts?: readonly {
    readonly id?: string
    readonly text?: string
    readonly category?: string
    readonly subject?: string
  }[]
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
  readonly available: boolean
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
}

/** 采集服务。 */
export interface IntakeService {
  /** 是否可用（总开关 + 记忆内核在场）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: string
  /** 统计快照。 */
  stats(): IntakeStats
  /** 手动收一轮（测试与补录）。 */
  ingest(turn: TurnDraft): Promise<{ readonly rawId?: string; readonly facts: number; readonly reason?: string }>
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
