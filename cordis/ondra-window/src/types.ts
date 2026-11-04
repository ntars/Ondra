/**
 * O-081 `ondra-window` 的对外契约。档位〔研〕（壳侧规格，生态无对应服务键）。
 *
 * ## 台账要求，逐字
 *
 * ```
 * | O-081 | `ondra-window` | 〔研〕 | hiddenInset、44px 拖动区、红绿灯避让 |
 * ```
 *
 * ## 手册给了什么、没给什么
 *
 * 手册对窗口只有**一句半**：
 *
 * - §7.1：「**macOS 标题栏红绿灯方案 A/B**」——只给「有 A/B 两案」，没给两案各是什么；
 * - §4.3：「master-plan 的 `ondra-dev-rebrand` / **`ondra-window`** 都是**壳侧打补丁**类，
 *   同样需要这条（**版本边界守卫**：monkey-patch 前做版本白名单，上游升级则补丁
 *   **不生效**而非**错生效**）」。
 *
 * master-plan §9.9 补了三个数：`48px` 标题区横跨整窗、三列共用**圆心 y=25**、
 * `trafficLightPosition{x:20,y:19}`。手册全文检索 `hiddenInset / trafficLight / 44px /
 * 拖动区 / BrowserWindow` **全部 0 命中**——也就是说 `hiddenInset` 与 44px 拖动区
 * **只有台账那一行**。
 *
 * ## 所以本包是什么
 *
 * 上游 `desktop/packages` 里**没有任何窗口服务键**（全仓 `BrowserWindow` 0 命中，
 * `titleBarStyle` 0 命中），Electron 壳不在这个仓库里。既然不能凭空 `ctx.get('browserWindow')`
 * 造一个悬空键，本包就只做**它确实能做的事**：
 *
 * 1. **规格单一真源**：48 / 44 / 20 / 19 / 12 与三栏宽度，一处定义、处处引用；
 * 2. **两方案分支**：A（系统红绿灯 + `hiddenInset`，默认）与 B（自绘红绿灯 + `hidden`），
 *    同一接口、各一个文件；
 * 3. **版本边界守卫**：读壳侧补丁文件，判定「上游版本对不对得上」，对不上就报
 *    **不生效**——正是 §4.3 点名的旧病（`patch-host.sh` 存在但没有任何 `PATCH_EXPECT_*`）；
 * 4. **规格自洽检查**：48 与 44 的关系、25 与 24 的差、1092 与 1080 的冲突，逐条判定。
 *
 * 它**不创建窗口**：那要 Electron 主进程，属壳侧。这是阻塞点，写进 README 而不是假做。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const WINDOW_SERVICE_KEY = 'ondra-window'

/**
 * 平台判定结果。
 *
 * `unknown` 是**真实可能**的（比如宿主跑在 WSL 里、或者 `process.platform` 被 polyfill），
 * 不是兜底占位——所以不压成 `'macos' | 'windows'` 两值。
 */
export type WindowPlatform = 'macos' | 'windows' | 'linux' | 'unknown'

/** 分支 id。 */
export type WindowBranchId = 'a' | 'b'

/**
 * 原因码。
 *
 * 每个码对应一句能照做的话（见 `README`「原因码」表）。
 */
export type WindowReason =
  | 'ok'
  | 'disabled'
  | 'disposed'
  | 'unsupported-platform'
  | 'no-patch-target'
  | 'patch-unreadable'
  | 'patch-marker-missing'
  | 'no-expected-version'
  | 'version-unexpected'

/** 红绿灯的绘制方式。 */
export type TrafficLightMode = 'system' | 'drawn'

/** 红绿灯几何（单位 px，坐标系原点 = 窗口左上角）。 */
export interface TrafficLightSpec {
  /** 系统绘制还是自绘。 */
  readonly mode: TrafficLightMode
  /** 容器左边。 */
  readonly x: number
  /** 容器上边。 */
  readonly y: number
  /** 直径。 */
  readonly size: number
  /** 圆心 y（`y + size / 2`）。 */
  readonly centerY: number
}

/** 标题区规格。 */
export interface TitleBarSpec {
  /** 标题区总高（手册/§9.9：48）。 */
  readonly height: number
  /** 可拖热区高（台账：44）。 */
  readonly dragHeight: number
  /** 标题栏样式（交给壳侧的 `titleBarStyle`）。 */
  readonly style: 'hiddenInset' | 'hidden' | 'default'
  readonly trafficLight: TrafficLightSpec
}

/** 三栏宽度（px）。 */
export interface ColumnSpec {
  readonly left: number
  readonly centerMin: number
  readonly right: number
}

/** 窗口规格。 */
export interface WindowSpec {
  readonly platform: WindowPlatform
  readonly branch: WindowBranchId
  readonly titleBar: TitleBarSpec
  readonly columns: ColumnSpec
  /** 断点（大 → 小）。 */
  readonly breakpoints: readonly number[]
  /**
   * 三栏全展开所需的最小宽度 = `left + centerMin + right`。
   *
   * **刻意不给 `minHeight`**：手册与 master-plan 都没有窗口高度的任何数字，
   * 编一个出来就会有人当真值去用。高度由壳侧按屏幕可用区决定。
   */
  readonly minWidth: number
}

/** 规格自洽问题。`error` 会挡住 `spec()`，`warn` 只记录（多为文档级口径冲突）。 */
export interface SpecIssue {
  readonly code:
    | 'drag-over-title'
    | 'center-mismatch'
    | 'center-off-geometric'
    | 'min-width-sum'
    | 'min-width-over-breakpoint'
    | 'breakpoint-order'
  readonly severity: 'error' | 'warn'
  readonly message: string
  /** 出处：手册 / master-plan / 反推。 */
  readonly source: string
}

/** 一支分支的声明。 */
export interface WindowBranch {
  readonly id: WindowBranchId
  readonly title: string
  /** 坐标是否有出处。`false` = 沿用别的分支的数值，**不假装是设计值**。 */
  readonly grounded: boolean
  /** 出处（章节号或「反推」）。 */
  readonly source: string
  /** 一句话差异。 */
  readonly note: string
  /**
   * 在基线上施加本分支的差异。
   * @param base 基线规格。
   */
  specOf(base: WindowSpec): WindowSpec
}

/** 补丁计划：壳侧照着做的那一份。 */
export interface PatchPlan {
  /** 壳侧补丁文件路径（配置项）。 */
  readonly target: string
  /** 版本白名单的环境变量名。 */
  readonly marker: string
  /** 白名单里的版本（配置项，可为空 = 没声明期望）。 */
  readonly expected: readonly string[]
  /** **恒为 false**：本包永不真打补丁（那要壳侧主进程）。 */
  readonly applied: false
  readonly reason: WindowReason
  readonly detail: string
}

/** 补丁判定结论。 */
export interface PatchVerdict {
  /** 四值：判不了就说判不了。 */
  readonly verdict: 'pass' | 'fail' | 'unverifiable'
  readonly reason: WindowReason
  readonly findings: readonly string[]
}

/** 计数。 */
export interface WindowStats {
  readonly specs: number
  readonly plans: number
  readonly verifies: number
}

/** 读文本端口（默认本地文件；判定器本身是纯函数）。 */
export interface TextReader {
  /**
   * 读一个文本文件。
   * @param path 绝对路径。
   * @returns 内容；读不到返回 `null`（不抛）。
   */
  read(path: string): string | null
}

/** 本插件对外提供的服务。 */
export interface WindowService {
  readonly available: boolean
  readonly reason?: WindowReason
  /** 当前生效的窗口规格。**永不抛**。 */
  spec(): WindowSpec
  /** 规格自洽检查（只读）。 */
  issues(): readonly SpecIssue[]
  /** 全部分支声明（只读）。 */
  branches(): readonly WindowBranchId[]
  /** 补丁计划（只读，不落盘、不打补丁）。 */
  plan(): PatchPlan
  /** 版本边界判定（只读）。 */
  verify(): PatchVerdict
  stats(): WindowStats
  dispose(): void
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
