/**
 * O-082 `ondra-onboarding` 的对外契约。档位〔研〕。
 *
 * ## 台账要求，逐字
 *
 * ```
 * | O-082 | `ondra-onboarding` | 〔研〕 | 四段首启引导；**宣传片 01 章验收基线**（§1.11） |
 * ```
 *
 * ## 手册给了什么、没给什么
 *
 * 给了（可引用）：
 *
 * - 手册 §6.4「**一键部署四件套**：检查 Node≥20 → 复用已装 `ondra` → `--port 0` 挑空闲端口 →
 *   抓带 token 地址自动开浏览器」；
 * - 手册 §6.4 验收「安装器：标题『安装 空谷 Ondra 1.0』+ 实时进度百分比 + 状态行
 *   （『正在准备运行环境』→『安装完成，已就绪』）」；
 * - 手册 §6.4「安装完成后**首条消息由当前人设主动发出**」；
 * - 手册 §1.11 章 01「下载就能用，不调模型，不写代码」；
 * - 手册 §6.4 五条新手坑（Node 太旧 / 市场拉不到 / 密钥配错只报「模型无响应」/
 *   权限不足 / 装了要启用）。
 *
 * **没给**：「四段」到底是哪四段。全文检索「四段」，只有人格拼装（§O-023）与
 * `persona-assemble` 用这个词，与首启无关。所以本包把 §6.4 的**四件套**对位成四段，
 * 每一段的 `source` 都标出处，并在 `SEGMENTS_REVERSE_ENGINEERED` 里明写「这是对位，不是手册原文」。
 *
 * ## 为什么它不渲染界面、不发消息
 *
 * 界面是 O-085 ~ O-096 的事，发消息是对话层的事。本包只做三件插件能负责的事：
 * **状态机**（走到第几段、哪些段算完）、**判定**（验收五条各自过没过）、
 * **话术**（状态行文案、首条消息模板、新手坑的处置建议）。渲染与发送都交给别人。
 *
 * 硬做一个窗口会与 master-plan §12.4「成品只能是插件包」冲突，也会和 O-081
 * 「不创建窗口」的口径分叉。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const ONBOARDING_SERVICE_KEY = 'ondra-onboarding'

/**
 * 「四段」的出处标记。
 *
 * 台账写「四段」，手册没展开。本包按 §6.4 四件套对位，并把这件事写进类型常量，
 * 让任何读到 `SegmentDecl.source` 的人都能立刻分辨「这是引用的」还是「这是推的」。
 */
export const SEGMENTS_REVERSE_ENGINEERED = '反推：台账「四段」手册未展开，按 §6.4 一键部署四件套对位'

/** 四段的 id。顺序即依赖：环境不过，后面的段没有意义。 */
export type SegmentId = 'env' | 'reuse' | 'port' | 'open'

/** 一段的状态。 */
export type SegmentState = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

/** 原因码。每个码对应一句能照做的话（见 `segments.ts` 的 `describeReason`）。 */
export type OnboardingReason =
  | 'disabled'
  | 'not-started'
  | 'bad-segment'
  | 'out-of-order'
  | 'no-evidence'
  | 'bad-evidence'
  | 'not-skippable'
  | 'already-done'
  | 'disposed'

/** 整体阶段。`failed` 与 `preparing` 分开：停下与还在跑，界面该显示的东西完全不同。 */
export type Phase = 'idle' | 'preparing' | 'ready' | 'failed'

/** 一段的声明。 */
export interface SegmentDecl {
  readonly id: SegmentId
  readonly title: string
  /** 百分比权重。四段等权 25（手册没给权重，等权是最少编造的选择）。 */
  readonly weight: number
  /** 能不能跳过。只有 `open` 可以——有些环境压根没有图形界面。 */
  readonly required: boolean
  /** 出处；反推的明写「反推」。 */
  readonly source: string
  /** 这一段要什么证据才算完（给界面显示，也用于 `advance()` 的闸门）。 */
  readonly needs: string
}

/** 一段的证据。四段各用一个字段，互不重叠。 */
export interface SegmentEvidence {
  /** `env`：Node 版本号，例如 `v20.11.1`。 */
  readonly nodeVersion?: string
  /** `reuse`：复用的 `ondra` 可执行文件路径，或 `npm-exec`（免安装跑）。 */
  readonly ondraPath?: string
  /** `port`：挑到的端口号。 */
  readonly port?: number
  /** `open`：要打开的地址（**原样**，本包不重拼）。 */
  readonly url?: string
}

/** 一段的落盘记录。 */
export interface SegmentRecord {
  readonly state: SegmentState
  /** 段内进度 0–1，供「实时百分比」用。 */
  readonly fraction: number
  /** 最后一次变化时刻（Unix 毫秒）。 */
  readonly at: number
  readonly evidence?: SegmentEvidence
  readonly detail?: string
}

/** 一段的只读视图（声明 + 记录）。 */
export interface SegmentView extends SegmentRecord {
  readonly id: SegmentId
  readonly title: string
  readonly weight: number
  readonly required: boolean
  readonly source: string
  readonly needs: string
}

/** 进度视图。 */
export interface ProgressView {
  /** 0–100 的整数。**不写死 56%**（那是宣传片的一帧，不是常量）。 */
  readonly percent: number
  readonly phase: Phase
  /** 状态行文案。见 `segments.ts` 的 `statusLineOf`。 */
  readonly statusLine: string
  /** 当前该做的那一段。 */
  readonly current?: SegmentId
  /** 已完（含跳过）几段。 */
  readonly done: number
  readonly total: number
}

/** 一次状态推进的结果。 */
export interface StepResult {
  readonly ok: boolean
  readonly segment?: SegmentView
  readonly progress: ProgressView
  readonly reason?: OnboardingReason
  readonly detail?: string
}

/** 验收时可从外部拿到的补充事实（本包判不了的那些）。 */
export interface AcceptanceFacts {
  /** 安装器**实际**渲染出来的标题。 */
  readonly installerTitle?: string
  /** 当前人设名（出厂是鲸鲸，示例包是夏柠柒——本包不猜，由调用方给）。 */
  readonly personaName?: string
  /** 首轮实际走的模型通路。 */
  readonly modelRoute?: 'builtin' | 'cloud' | 'local' | 'unknown'
  /** 用户在首轮之前有没有被要求改配置。 */
  readonly userEditedConfig?: boolean
}

/** 一条验收的结论。三值：**判不了**要说判不了，不许当成过。 */
export type CheckVerdict = 'pass' | 'fail' | 'unverifiable'

/** 验收五条之一。 */
export interface AcceptanceCheck {
  readonly id: 'installer-title' | 'live-progress' | 'status-line' | 'first-message' | 'zero-config'
  readonly title: string
  readonly verdict: CheckVerdict
  readonly detail: string
  /** 出处（§1.11 章 01 / §6.4）。 */
  readonly source: string
}

/** 验收报告。 */
export interface AcceptanceReport {
  readonly checks: readonly AcceptanceCheck[]
  readonly verdict: CheckVerdict
  readonly passed: number
  readonly failed: number
  readonly unverifiable: number
}

/** 新手坑的五个码（手册 §6.4 逐条）。 */
export type DiagnosisCode =
  | 'node-too-old'
  | 'market-unreachable'
  | 'api-key-invalid'
  | 'permission-too-low'
  | 'plugin-not-enabled'

/** 诊断要用的事实。**缺的就不判**，不拿默认值替人签字。 */
export interface DiagnoseFacts {
  readonly nodeVersion?: string
  /** 要求的 Node 主版本；省略用配置值（默认 20）。 */
  readonly requiredNodeMajor?: number
  readonly marketReachable?: boolean
  readonly proxyConfigured?: boolean
  readonly apiKeyChecked?: boolean
  readonly apiKeyValid?: boolean
  /** 会话权限级别；手册说装插件前要三级。 */
  readonly sessionPermission?: number
  /** 已安装但未启用的插件名。 */
  readonly installedNotEnabled?: readonly string[]
}

/** 一条诊断。 */
export interface Diagnosis {
  readonly code: DiagnosisCode
  /** `block` = 不解决就走不下去；`warn` = 能走但会出问题。 */
  readonly severity: 'block' | 'warn'
  readonly cause: string
  readonly action: string
  readonly source: string
}

/** 首条消息的观察记录。 */
export interface FirstMessageObservation {
  readonly text: string
  /** 是谁先说的。`unknown` 不算数（判不了就是判不了）。 */
  readonly initiative: 'persona' | 'user' | 'unknown'
  readonly at: number
}

/** 首条消息规格。 */
export interface FirstMessageSpec {
  /** 人设名拿到了没有。没拿到就不给文案，**不替人设签字**。 */
  readonly resolved: boolean
  readonly personaName: string
  readonly text: string
  /** 这条消息必须由**人设**发出，不是系统通知。 */
  readonly by: 'persona'
  readonly reason?: 'no-persona'
}

/** 安装器标题。 */
export interface InstallerTitle {
  /** 产品名与版本是不是从 O-001 真源拿到的。 */
  readonly resolved: boolean
  readonly text: string
  readonly source: 'identity' | 'fallback'
}

/** 落盘的首启状态。 */
export interface OnboardingState {
  /** 结构版本。读不懂就重来，不猜。 */
  readonly version: number
  readonly runId: string
  readonly startedAt: number
  readonly segments: Readonly<Record<string, SegmentRecord>>
  readonly firstMessage?: FirstMessageObservation
  /** 每次进度变化记一个读数，供「实时百分比」验收。 */
  readonly samples: readonly number[]
  /** 出现过的状态行（去重，保序）。 */
  readonly statusLines: readonly string[]
  readonly completedAt?: number
}

/** 计数（只增）。 */
export interface OnboardingStats {
  readonly begins: number
  readonly advances: number
  readonly skips: number
  readonly failures: number
  readonly resets: number
}

/**
 * O-083 `ondra-port-picker` 的结构子集。
 *
 * **只写本包用到的那一个方法**。按 §18.5，同轮两个插件不许 import 对方源码，
 * 所以这里是结构对位而不是类型复用；O-083 侧加字段不会让本包编译失败。
 */
export interface PortPickerLike {
  pick(request?: {
    readonly intent?: 'listener' | 'endpoint'
    readonly purpose?: string
  }): Promise<{
    readonly ok: boolean
    readonly picked?: {
      readonly port: number
      readonly host: string
      readonly race?: 'none' | 'window'
      readonly source?: string
    }
    readonly reason?: string
    readonly detail?: string
  }>
}

/** 一次端口建议。**判不了就说判不了**，不编一个号。 */
export interface PortSuggestion {
  readonly ok: boolean
  readonly port?: number
  readonly host?: string
  readonly race?: 'none' | 'window'
  readonly source?: string
  readonly reason?: string
  readonly detail?: string
}

/** 本插件对外提供的服务。 */
export interface OnboardingService {
  readonly available: boolean
  readonly reason?: OnboardingReason
  /** 开一次首启。已有未完成的会**接着走**；已完成且 `restart` 不为真则报 `already-done`。 */
  begin(options?: { readonly restart?: boolean }): StepResult
  /** 推进当前段。**必须带证据**（闸门）。 */
  advance(id: SegmentId, evidence?: SegmentEvidence): StepResult
  /** 跳过一段（只有可选段可跳）。 */
  skip(id: SegmentId, detail?: string): StepResult
  /** 把当前段标成失败（停下来，不自动重试）。 */
  fail(id: SegmentId, detail: string): StepResult
  progress(): ProgressView
  segments(): readonly SegmentView[]
  /** 验收五条。`facts` 只补本包观察不到的部分。 */
  acceptance(facts?: AcceptanceFacts): AcceptanceReport
  /** 新手坑诊断（只出建议，不改任何设置）。 */
  diagnose(facts: DiagnoseFacts): readonly Diagnosis[]
  /** 安装器标题（走 O-001 真源）。 */
  title(): InstallerTitle
  /** 首条消息规格（模板取 §1.11 原文，名字由调用方给）。 */
  firstMessage(personaName?: string): FirstMessageSpec
  /** 记录「首条消息真的发出去了」。**不发送**，只记录。 */
  observeFirstMessage(input: {
    readonly text: string
    readonly initiative?: 'persona' | 'user' | 'unknown'
  }): boolean
  /** 给「要启动的服务」要一个空闲号（消费 O-083 的 `listener` 意图）。 */
  suggestPort(): Promise<PortSuggestion>
  /** 取「界面在哪个号上」（消费 O-083 的 `endpoint` 意图）。 */
  suggestEndpoint(): Promise<PortSuggestion>
  state(): OnboardingState | undefined
  stats(): OnboardingStats
  reset(): void
  dispose(): void
}

/** O-001 身份子集（只要产品事实）。 */
export interface IdentityLike {
  readonly product: {
    readonly fullName: string
    readonly version: string
  }
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

/** O-002 路径子集。 */
export interface PathLayoutLike {
  ensure(area: 'user', ...segments: string[]): string
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
