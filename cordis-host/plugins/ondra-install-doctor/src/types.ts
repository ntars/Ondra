/**
 * O-133 `ondra-install-doctor` 的对外契约。
 *
 * ## 它与 O-077 的分工（同一件事的两个粒度，不能互相替代）
 *
 * - **O-077 `ondra-startup-check`**：逐包体检，「**我这个包**会不会被加载」。
 *   输入是一个包目录，输出十项判定。
 * - **本包**：装配级体检，「**整份 profile 装配出来长什么样**」。
 *   输入是一个 profile 目录（`package.json` 里的 `ondra.profile.bundles`），
 *   输出「宿主会看到的那份入口树」+「哪些 bundle 被跳过、为什么」+「补丁告警几条」。
 *
 * 为什么要分两个：一个包自己的补丁写对了，不代表它**所在的 profile** 装得上——
 * profile 里没登记这个 bundle、bundle 解析不到、`ondra.bundle` 缺声明、
 * 补丁路径相对包目录写错，这几种失败都发生在包外面，而它们全都**不报错**，
 * 只让功能凭空消失。
 *
 * ## 只读是硬属性，不是配置项
 *
 * 台账写「O-133 只读，绝不执行器官」。所以本契约里**没有任何写方法**：
 * 没有 `install()`、没有 `enable()`、没有 `apply()` 的对偶。
 * `PatchEntry` 里的 `disabled` 只被**读**出来印在报告里，本包从不写它。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const DOCTOR_SERVICE_KEY = 'ondra-install-doctor'

/** 入口 id / 包名 / 组名的唯一合法形状（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 入口字段**只有六个**（手册 §8.3-3 的 `EntryOptions`）。
 * 出现第七个就是写错了——宿主会静默忽略它，而写的人以为生效了。
 */
export const ENTRY_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'config',
  'group',
  'disabled',
  'inject',
])

/** 补丁行**特有**的键（不属于入口字段）。 */
export const PATCH_ONLY_FIELDS: readonly string[] = Object.freeze(['insert'])

/** Profile 自己的补丁文件名（宿主常量 `PROFILE_PATCH_FILENAME`）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** 判空对象。 */
export type Row = Readonly<Record<string, unknown>>

/**
 * 补丁行（`PatchOptions` 的最小形状）。
 *
 * 与入口行的差别只有 `insert`：有它就是「插入」，没有它就是「改已有的某一行」。
 */
export interface PatchRow {
  readonly id?: string
  readonly insert?: readonly Row[]
  readonly name?: string
  readonly config?: unknown
  readonly group?: boolean | null
  readonly disabled?: boolean | null
  readonly inject?: unknown
}

/** 一个入口行（补丁应用后，宿主会真的挂载的那一行）。 */
export interface PatchEntry extends Row {
  readonly id?: string
  readonly name?: string
  readonly config?: unknown
  readonly group?: boolean | null
  readonly disabled?: boolean | null
  readonly inject?: unknown
}

/** 补丁被跳过 / 有风险的原因码。每条都对应宿主源码里的一个 `warn(...)`。 */
export type PatchProblemCode =
  /** `insert` 不是数组。 */
  | 'bad-row'
  /** `insert` 的目标 id 在入口表里找不到。 */
  | 'insert-target-missing'
  /** `insert` 的目标不是 `group: true`。 */
  | 'insert-target-not-group'
  /** 无 `insert` 的补丁行没给 `id`。 */
  | 'id-required'
  /** 补丁目标找不到。 */
  | 'target-missing'
  /** `name` 与目标条目的 `name` 不一致。 */
  | 'name-mismatch'
  /** 入口行出现第七个字段。 */
  | 'seventh-field'
  /** 入口 id 不合规（§8.4）。 */
  | 'bad-id'
  /** 同一个 id 在入口树里出现两次。 */
  | 'duplicate-id'
  /** `group: true` 但 `config` 不是数组。 */
  | 'group-without-list'
  /** 入口行既没有 `id` 也没有 `name`。 */
  | 'anonymous-row'

/** 一条补丁/入口问题。 */
export interface PatchProblem {
  readonly code: PatchProblemCode
  /** 补丁行号（1 起）；入口结构问题没有行号。 */
  readonly row?: number
  /** 涉及的 id。 */
  readonly id?: string
  /** 哪一层来的（bundle 包名或 `'user'`）。 */
  readonly layer?: string
  /** 一句人话，直接进报告。 */
  readonly message: string
  /** 是否**致命**（致命 = 这行入口不会挂载；不致命 = 挂上了但有风险）。 */
  readonly fatal: boolean
}

/** 一个入口行在树里的位置。 */
export interface EntryRowView {
  readonly id: string
  readonly name?: string
  readonly group: boolean
  readonly disabled: boolean
  /** 深度（根为 0）。 */
  readonly depth: number
  /** 从根到这里的 id 路径（含自身）。 */
  readonly path: readonly string[]
  /** 来自哪一层。 */
  readonly layer: string
}

/** 「宿主会看到的那份入口树」。 */
export interface EntryTree {
  /** 根入口列表（按宿主挂载顺序）。 */
  readonly roots: readonly PatchEntry[]
  /** 拉平后的全部行（深度优先，与 `roots` 同序）。 */
  readonly rows: readonly EntryRowView[]
  readonly total: number
  readonly groups: number
  readonly leaves: number
  /** `disabled: true` 的条数。 */
  readonly disabled: number
  /** 最大嵌套深度。 */
  readonly maxDepth: number
}

/** 补丁文件读 / 解析的结果。 */
export interface PatchFileView {
  /** 相对包目录的声明路径（原样）。 */
  readonly declared: string
  /** 绝对路径。 */
  readonly path: string
  /** 属于哪一层。 */
  readonly layer: string
  /** 读到了没有。 */
  readonly read: boolean
  /** 解析成功了没有。 */
  readonly parsed: boolean
  /** 读/解析失败的原因。 */
  readonly problem?: string
  /** 解析出来的补丁行数。 */
  readonly rows: number
  /** 本包 YAML 子集不支持（`unverifiable`，不是 `fail`）。 */
  readonly unsupported: boolean
  /** 不支持的行号。 */
  readonly unsupportedLine?: number
}

/** 一个 bundle 层的体检结果。 */
export interface BundleLayerView {
  /** profile 里登记的包名。 */
  readonly packageName: string
  /** 解析到的包目录；解析不到时省略。 */
  readonly dir?: string
  /** 这一层贡献的补丁文件。 */
  readonly patches: readonly PatchFileView[]
  /** 这一层贡献的入口行数（补丁应用后新增的）。 */
  readonly entries: number
  /** 被跳过了没有。 */
  readonly skipped: boolean
  /** 跳过原因（与宿主 `SkippedBundle.reason` 同义）。 */
  readonly skipReason?: string
  /** 跳过原因的分类码。 */
  readonly skipCode?: BundleSkipCode
}

/**
 * bundle 被跳过的原因码。
 *
 * 前四个与宿主 `loadProfileDirectory()` 的 `catch` 分支一一对应；
 * 后两个是本包补的「结构上不成立但宿主还没到那步就失败了」。
 */
export type BundleSkipCode =
  /** profile 里登记了这个包，但目录解析不到（没装 / 装歪了）。 */
  | 'not-found'
  /** 包目录里 `package.json` 读不出来。 */
  | 'manifest-unreadable'
  /** `package.json` 没有 `ondra.bundle`（手册 §8.3-1 最隐蔽的失败）。 */
  | 'no-ondra.bundle'
  /** `ondra.bundle.patch` 既不是字符串也不是字符串数组。 */
  | 'bad-patch-declaration'
  /** 声明的补丁文件读不出来。 */
  | 'patch-unreadable'
  /** 补丁文件解析失败（宿主会抛错 → 整层被跳过）。 */
  | 'patch-unparsable'
  /** 平台不符（`bundle.platforms` 不含当前平台）。 */
  | 'platform-unsupported'

/** 跳过清单（对应宿主 `reportSkippedBundles` 打印的那几行）。 */
export interface SkipReport {
  /** 被跳过的 bundle（顺序与 profile 登记一致）。 */
  readonly bundles: readonly BundleLayerView[]
  /** 全部补丁告警（跨层，含入口结构问题）。 */
  readonly warnings: readonly PatchProblem[]
  /** 致命告警条数（这些入口不会挂载）。 */
  readonly fatal: number
  /** 非致命告警条数（挂上了但有风险）。 */
  readonly soft: number
  /** 「宿主会不会打 stderr」——被跳过的 bundle 数 > 0 就是会。 */
  readonly willWarnOnStderr: boolean
}

/** 报告结论。 */
export type DoctorVerdict =
  /** 全部通过。 */
  | 'pass'
  /** 装得上，但有告警。 */
  | 'warn'
  /** 有致命问题（某个 bundle 不会加载 / 某个入口不会挂载）。 */
  | 'fail'
  /** 判不了（没配路径、YAML 超出子集、文件太大）。 */
  | 'unverifiable'

/** 一条结论。 */
export interface DoctorFinding {
  readonly level: 'info' | 'warn' | 'error'
  /** 一句结论。 */
  readonly detail: string
  /** 能拿去改的话。 */
  readonly hint?: string
}

/** 一次体检的完整报告。 */
export interface DoctorReport {
  readonly at: number
  /** 体检的 profile 目录（绝对路径）。 */
  readonly profileDir: string
  /** profile 名（目录 basename）。 */
  readonly profileName: string
  /** profile 里登记了几个 bundle。 */
  readonly bundles: number
  /** 逐层结果（按登记顺序）。 */
  readonly layers: readonly BundleLayerView[]
  /** 宿主会看到的入口树。 */
  readonly tree: EntryTree
  /** 跳过与告警。 */
  readonly skip: SkipReport
  readonly verdict: DoctorVerdict
  readonly findings: readonly DoctorFinding[]
  /** 给人看的纯文本报告（等宽排版，可直接贴进 issue）。 */
  readonly text: string
}

/** 本包体检不了的原因。 */
export type DoctorReason =
  /** 总开关关着。 */
  | 'disabled'
  /** 没配 `profile-path`：**不猜路径**。 */
  | 'no-profile'
  /** 配了路径但读不出 `package.json`。 */
  | 'no-manifest'

/** 计数。 */
export interface DoctorStats {
  readonly at: number
  readonly inspected: number
  readonly bundles: number
  readonly skipped: number
  readonly fatal: number
  readonly soft: number
  readonly entries: number
  readonly patchFiles: number
  /** 上一次报告的结论；从未跑过时省略。 */
  readonly lastVerdict?: DoctorVerdict
}

/** 体检服务。**全部方法只读**。 */
export interface DoctorService {
  /** 能不能工作。 */
  readonly available: boolean
  /** 不能工作的原因。 */
  readonly reason?: DoctorReason
  /** 配的 profile 目录（空 = 没配）。 */
  readonly profileDir: string

  /**
   * 体检一次。**永不抛错**：读不到就返回 `verdict:'unverifiable'` + 一条 finding。
   * @param options 覆盖项。
   */
  inspect(options?: InspectOptions): DoctorReport
  /** 只要入口树（不生成文本报告，省一次字符串拼接）。 */
  tree(options?: InspectOptions): EntryTree
  /** 只要跳过清单。 */
  skip(options?: InspectOptions): SkipReport
  /** 现状。 */
  stats(): DoctorStats
  /** 清缓存（下次 `inspect()` 重读磁盘）。 */
  invalidate(): void
}

/** 体检覆盖项。 */
export interface InspectOptions {
  /** 覆盖配置里的 profile 目录。 */
  readonly profileDir?: string
  /** 是否把 profile 自己的 `cordis.patch.yml` 当成最后一层。 */
  readonly userLayer?: boolean
  /** 是否生成文本报告（默认 true）。 */
  readonly text?: boolean
}

/** 缓存条目（同一 profile + 同一批补丁内容的指纹）。 */
export interface DoctorCache {
  readonly profileDir: string
  /** 输入指纹（文件路径 + 大小 + mtime + 内容长度）。 */
  readonly fingerprint: string
  readonly report: DoctorReport
}

/** O-001 身份服务的形状（只取日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 本插件配置（与 `src/settings.ts` 的 `FIELD_SPECS` 一一对应）。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** profile 目录绝对路径；空 = 不扫。 */
  readonly profilePath: string
  /** 是否把 profile 自己的 `cordis.patch.yml` 当最后一层。 */
  readonly userLayer: boolean
  /** 单文件最大字节数。 */
  readonly maxFileBytes: number
  /** 每条告警一行日志。 */
  readonly verbose: boolean
  /** 报告缓存有效期（毫秒），0 = 每次都重读。 */
  readonly ttlMs: number
}

/** 日志形状。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}
