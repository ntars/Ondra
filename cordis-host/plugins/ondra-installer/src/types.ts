/**
 * O-079 `ondra-installer` 的对外契约。档位〔研〕。
 *
 * ## 台账的要求，逐字
 *
 * ```
 * | O-079 | `ondra-installer` | 〔研〕 | 九步流水线；**清单制 Bootstrap：每组件独立 sha256
 *            + 记账文件 + `bootstrap-ok` 自检**（§8.3） |
 * ```
 *
 * ## 手册到底给了什么、没给什么
 *
 * 给了（可引用）：
 *
 * - 手册 §4.6「Bootstrap 清单制安装：`components` 嵌套 + **每组件独立 sha256** +
 *   `.ondra-bootstrap.json` 记账 + `bootstrap-ok` 自检。旧项目的 `manifest.ts` 是平铺
 *   `NODE_ARTIFACTS`，**只有哈希、无记账本、无自检命令**」；
 * - 手册 §6.4「一键部署四件套：检查 Node≥20 → 复用已装 `ondra` → `--port 0` 挑空闲端口 →
 *   抓带 token 地址自动开浏览器」；
 * - 手册 §6.4 验收：「安装器：标题 + 实时进度百分比 + 状态行（『正在准备运行环境』→
 *   『安装完成，已就绪』）」。
 *
 * **没给**：九步的**名称与顺序**。全文检索「九步流水线」只有两处——master-plan §5 的一句话
 * 与台账那一行，都没有展开。所以本包的九步是从上面三条**反推**的，每一步在 `STEP_SOURCES`
 * 里带出处；推不出的不做（见 README「已知限制」第 1 条）。
 *
 * ## 为什么「先验后写」是硬顺序
 *
 * `verify`（算实际哈希）必须排在 `install`（落盘）**之前**。反过来的坏形态：
 * 先把 256MB 写进目标目录，再发现哈希不对——此时目标目录已经是脏的，而「回滚」
 * 要么删掉用户原有文件（不可逆），要么留着坏文件（下次启动炸在更远的地方）。
 * 所以：**哈希不通过，一个字节都不落盘**。
 *
 * ## 为什么记账是两阶段
 *
 * 记账只有 `installed` 一种状态时，进程在「写文件」与「写账」之间被杀，账本就永远
 * 不知道这个组件装到一半。所以同一组件先记 `pending`、再记 `installed`。
 * `pending` 在下次启动时是明确的「需要重装」信号，而不是「没装过」。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const INSTALLER_SERVICE_KEY = 'ondra-installer'

/** 名字合规正则（服务键 / 配置键 / 组件名共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 九步的 id 与顺序。
 *
 * 顺序即依赖：结构 → 哈希声明 → 来源 → 实际哈希 → 复用 → 落盘 → 记账 → 自检。
 * 前一步不过，后一步不跑。
 */
export const STEP_IDS = Object.freeze([
  'preflight',
  'manifest',
  'source',
  'verify',
  'reuse',
  'conflict',
  'install',
  'ledger',
  'self-check',
] as const)

/** 步骤 id。 */
export type StepId = (typeof STEP_IDS)[number]

/** 单步结论。 */
export type StepStatus = 'ok' | 'skipped' | 'failed' | 'blocked' | 'unsupported'

/** 整轮结论。 */
export type RunVerdict = 'ok' | 'partial' | 'failed' | 'blocked'

/** 自检结论（四值，与全仓其余自检同形）。 */
export type BootstrapVerdict = 'ok' | 'partial' | 'fail' | 'unverifiable'

/** 组件类型。`archive` 本版**不支持**（不引依赖就没有解压器，见 README）。 */
export const COMPONENT_KINDS = Object.freeze(['file', 'archive'] as const)

/** 组件类型。 */
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

/** 一个展平后的组件声明。 */
export interface ComponentSpec {
  /** 展平后的路径（嵌套用 `/` 连接），账本与报错都用它。 */
  readonly path: string
  /** 叶名。 */
  readonly name: string
  readonly version?: string
  /** 64 位小写十六进制。**每组件独立**，不是整包一个。 */
  readonly sha256: string
  /** 相对 `sourceDir` 的文件名。 */
  readonly file: string
  readonly kind: ComponentKind
  /** 可选组件：缺了不判失败，只跳。 */
  readonly optional: boolean
  /** 装完是否给执行位（0755）。运行时二进制必须为真。 */
  readonly exec: boolean
  /** 相对 `destDir` 的子目录；省略 = 直接放 `destDir`。 */
  readonly dest?: string
}

/** 清单问题的原因码。 */
export type ManifestIssueReason =
  | 'not-object'
  | 'no-components'
  | 'too-many'
  | 'too-deep'
  | 'bad-name'
  | 'duplicate-name'
  | 'no-sha256'
  | 'bad-sha256'
  | 'no-file'
  | 'unsafe-path'
  | 'bad-kind'
  | 'bad-type'
  | 'bad-version'

/** 一条清单问题。 */
export interface ManifestIssue {
  /** 出问题的位置（展平路径，或 `components[2].components[0]`）。 */
  readonly path: string
  readonly reason: ManifestIssueReason
  readonly message: string
}

/** 清单解析结果。 */
export type ManifestParse =
  | { readonly ok: true; readonly components: readonly ComponentSpec[]; readonly digest: string }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] }

/** 一个组件的记账状态。 */
export type LedgerStatus = 'pending' | 'installed' | 'failed'

/** 账本里的一条。 */
export interface LedgerComponent {
  readonly path: string
  readonly version?: string
  /** 装机时校验通过的哈希。 */
  readonly sha256: string
  readonly file: string
  readonly status: LedgerStatus
  /** Unix 毫秒。 */
  readonly at: number
  readonly bytes?: number
  /** 失败原因（`status: failed` 时给）。 */
  readonly error?: string
}

/** 账本（`.ondra-bootstrap.json`）。 */
export interface BootstrapLedger {
  readonly version: number
  /** 清单文件的哈希：清单换了，账本就不再算数。 */
  readonly manifestSha256?: string
  /** 整轮成功完成时刻（Unix 毫秒）。 */
  readonly bootstrapAt?: number
  readonly components: readonly LedgerComponent[]
}

/** 单步结果。 */
export interface StepResult {
  readonly id: StepId
  readonly title: string
  readonly status: StepStatus
  /** 一句话结论（给人看）。 */
  readonly detail: string
  /** 逐条发现（缺哪个文件、哪个哈希不对）。 */
  readonly findings: readonly string[]
  /** 这一步的依据出处（手册章节或「反推」）。 */
  readonly source: string
}

/** 一轮安装结果。 */
export interface InstallRun {
  readonly dryRun: boolean
  readonly startedAt: number
  readonly finishedAt: number
  readonly steps: readonly StepResult[]
  readonly verdict: RunVerdict
  /** 本轮真正落盘的组件路径。 */
  readonly installed: readonly string[]
  /** 因「已装且哈希一致」跳过的组件路径。 */
  readonly reused: readonly string[]
  /** 失败或被挡的组件路径。 */
  readonly failed: readonly string[]
}

/** `bootstrap-ok` 的一项。 */
export interface BootstrapCheck {
  readonly id: 'ledger' | 'coverage' | 'files' | 'manifest-drift' | 'stamp'
  readonly title: string
  readonly verdict: 'pass' | 'fail' | 'unverifiable'
  readonly detail: string
  readonly findings: readonly string[]
  /** 怎么修（只在不过时给）。 */
  readonly hint?: string
}

/** `bootstrap-ok` 报告。 */
export interface BootstrapReport {
  /** 四值总判。`unverifiable` = 关键前提缺失（没清单 / 没账本）。 */
  readonly verdict: BootstrapVerdict
  /** `true` 全过；`false` 有不过；`null` 判不了。**界面拿它做红点**。 */
  readonly bootstrapOk: boolean | null
  readonly checks: readonly BootstrapCheck[]
  readonly checkedAt: number
}

/** 不能用 / 装不了的原因。 */
export type InstallerReason = 'disabled' | 'no-manifest' | 'no-source' | 'no-dest' | 'no-ledger'

/** 现状。 */
export interface InstallerStatus {
  readonly available: boolean
  readonly reason?: InstallerReason
  /** 清单里的组件数（解析成功才有）。 */
  readonly components: number
  /** 本轮会不会真的落盘。 */
  readonly dryRun: boolean
  readonly manifestPath: string
  readonly sourceDir: string
  readonly destDir: string
  readonly ledgerPath?: string
}

/** 计数。 */
export interface InstallerStats {
  readonly runs: number
  readonly installed: number
  readonly reused: number
  readonly failed: number
  readonly verifies: number
}

/** 计划视图（只读，不落盘）。 */
export interface InstallPlanView {
  readonly steps: readonly { readonly id: StepId; readonly title: string; readonly source: string }[]
  readonly components: readonly ComponentSpec[]
  readonly dryRun: boolean
  readonly reason?: InstallerReason
}

/** 一次读源端口：把组件文件名换成可读的绝对路径。 */
export interface ComponentSource {
  /**
   * 定位一个组件文件。
   * @param file 相对 `sourceDir` 的文件名。
   * @returns 绝对路径；读不到返回 `null`（不抛）。
   */
  locate(file: string): string | null
}

/** 一个写目标端口。 */
export interface FileSink {
  /**
   * 确保目录存在。
   * @param dir 绝对路径。
   */
  ensureDir(dir: string): void
  /**
   * 从来源文件复制出一个临时文件（同目录、0600）。
   *
   * **刻意收路径而不是字节**：256 MB 的组件读进内存再写出去，峰值是文件的两倍，
   * 在低配机器上等于一次可避免的 OOM；`copyFile` 走内核，峰值只有缓冲区。
   * @param dest 目标绝对路径。
   * @param sourcePath 来源文件绝对路径。
   * @param exec 是否给执行位（0755）；否则 0600。
   * @returns 临时文件绝对路径。
   */
  writeTemp(dest: string, sourcePath: string, exec: boolean): string
  /**
   * 临时文件 → 目标（原子 `rename`）。
   * @param temp 临时路径。
   * @param dest 目标路径。
   */
  commit(temp: string, dest: string): void
  exists(dest: string): boolean
  remove(path: string): void
}

/** 运行环境端口。 */
export interface RuntimeProbe {
  /** Node 版本（`process.versions.node`）。 */
  nodeVersion(): string
  /**
   * 目录所在卷的剩余字节；取不到返回 `null`（判不了，不猜）。
   * @param dir 绝对路径。
   */
  freeBytes(dir: string): number | null
}

/** 本插件对外提供的服务。 */
export interface InstallerService {
  readonly available: boolean
  readonly reason?: InstallerReason
  /** 九步计划（只读，不跑）。 */
  plan(): Promise<InstallPlanView>
  /** 跑一轮。默认按配置的 `dryRun`。**永不抛错**。 */
  run(options?: { readonly dryRun?: boolean }): Promise<InstallRun>
  /** `bootstrap-ok` 自检（只读）。 */
  verify(): Promise<BootstrapReport>
  /** 当前账本（只读快照）。 */
  ledger(): BootstrapLedger | undefined
  /** 九步声明。 */
  steps(): readonly { readonly id: StepId; readonly title: string; readonly source: string }[]
  status(): InstallerStatus
  stats(): InstallerStats
  useSource(source: ComponentSource | null): void
  useSink(sink: FileSink | null): void
  useRuntime(probe: RuntimeProbe | null): void
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
