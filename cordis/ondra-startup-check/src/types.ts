/**
 * O-077 `ondra-startup-check` 的对外契约。
 *
 * ## 台账的要求，逐字
 *
 * ```
 * | O-077 | `ondra-startup-check` | 〔研〕 | 自检十项（§8.3），第十项：验证"宿主会不会真的加载我"；只判定不拦启动 |
 * ```
 *
 * 「自检十项」= master-plan §19.1 的**九项机械自检** + 手册 §8.3 的**第十项**。
 * 前九项是「我这份包本身合不合规」，第十项是元命题：「宿主到底会不会加载我」。
 *
 * ## 第十项为什么必须自己算一遍入口树
 *
 * 手册 §8.3 列了三条静默失败，全都不报错：
 *
 * 1. `package.json` 漏 `ondra.bundle.patch` → 宿主只往 stderr 打一行
 *    `declares no ondra.bundle`，**插件永远不加载**；
 * 2. 补丁语义（`insert` 无 id / 带 id 必须 group / 无 insert 必须给 id）；
 * 3. 入口字段只有六个，`name` 必须与包名完全一致。
 *
 * 这三条的坏形态是同一个：**日志干净、进程正常、功能不在**。所以本包不查「文件在不在」，
 * 而是把宿主那套 `applyEntryPatches` 的语义**移植**过来，算出「宿主会看到的那份入口树」，
 * 再看自己有没有落在里面。
 *
 * ## 为什么是移植而不是 import
 *
 * 真实现有两处：`desktop/vendor/include/src/index.ts` 的 `applyEntryPatches`、
 * `desktop/packages/boot/app-boot/src/profile.ts` 的 `composeEntries`。它们是宿主包，
 * 本仓 82 个插件的 `peerDependencies` 里**只有 `@ntars/cordis`**——多声明一个依赖，
 * 一旦宿主没带这个包，`import` 在模块加载期就抛，整个插件连注册都做不到（比不检查更糟）。
 * 所以按手册 §8.3 的原话「用**移植的** `parsePatchYaml / applyEntryPatches /
 * composeEntries`」做结构对位，并留一个 `BootOracle` 端口：宿主若愿意提供权威结果，
 * 直接接进来即可，本包一行不改。
 *
 * ## 判不了就说判不了
 *
 * 补丁文件里出现本包子集解析器不认识的语法（`!!js`、锚点、流式 `{}`、块标量）时，
 * 第十项标 `unverifiable` 而**不是** `pass`。假装能算的后果是「自检说能加载、
 * 宿主说不能」，而这句话会让人开始怀疑自己没读懂手册（纪律 153 的同族问题）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const STARTUP_CHECK_SERVICE_KEY = 'ondra-startup-check'

/** 名字合规正则（服务键 / 包名 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 十项的 id 与顺序（顺序即 master-plan §19.1 的 1~9 + 手册 §8.3 的第十项）。 */
export const CHECK_IDS = Object.freeze([
  'files',
  'manifest',
  'tsconfig',
  'entry',
  'service-key',
  'dep-resolvable',
  'no-cross-import',
  'degrade',
  'deliverables',
  'host-loads',
] as const)

/** 检查项 id。 */
export type CheckId = (typeof CHECK_IDS)[number]

/** 单项结论（四值）。 */
export type CheckVerdict = 'pass' | 'fail' | 'warn' | 'unverifiable'

/**
 * 报告结论（三值，对应 master-plan §19.4 的分级）。
 *
 * 刻意与单项的 `CheckVerdict` 分开：单项要能说「判不了」，而整份报告要回答
 * 「这份包能不能算 done」——那是三档，不是四档。
 */
export type ReportVerdict = 'pass' | 'partial' | 'fatal'

/** 单项结果。 */
export interface CheckResult {
  /** 项 id。 */
  readonly id: CheckId
  /** 中文标题。 */
  readonly title: string
  /** 结论。 */
  readonly verdict: CheckVerdict
  /** 一句结论。 */
  readonly detail: string
  /** 指路（`fail` / `warn` 时给）。 */
  readonly hint?: string
  /** 逐条明细（最多 12 条，超出的写明「另有 N 条」）。 */
  readonly findings: readonly string[]
}

/** 一份报告。 */
export interface CheckReport {
  /** 包名。 */
  readonly package: string
  /** 判定时刻。 */
  readonly at: number
  /** 整份结论。 */
  readonly verdict: ReportVerdict
  /** 逐项结果（顺序同 `CHECK_IDS`）。 */
  readonly results: readonly CheckResult[]
  /** 通过的项。 */
  readonly passed: readonly CheckId[]
  /** 不过的项。 */
  readonly failed: readonly CheckId[]
  /** 提醒的项。 */
  readonly warned: readonly CheckId[]
  /** 判不了的项。 */
  readonly unverifiable: readonly CheckId[]
  /** **第十项的结论**：宿主会不会真的加载我。判不了时为 `null`。 */
  readonly hostLoads: boolean | null
}

/** 文件探测结果。 */
export type ProbeResult = 'file' | 'dir' | 'missing' | 'too-big'

/**
 * 包目录读取端口。
 *
 * 路径一律是**相对包目录**、以 `/` 分隔的写法；端口实现负责把它关在根目录里
 * （`..` 与绝对路径一律返回 `missing`，不抛错——抛错会把一次扫描变成一次崩溃）。
 */
export interface PackageSource {
  /** 端口名。 */
  readonly id: string
  /** 列目录（不递归）；目录不存在返回空数组。 */
  list(dir: string): Promise<readonly string[]>
  /** 探测一个路径是什么。 */
  probe(path: string): Promise<ProbeResult>
  /** 读文本；不存在 / 太大 / 读不了返回 `null`。 */
  read(path: string): Promise<string | null>
}

/** 一个补丁文件的事实。 */
export interface PatchFileFacts {
  /** 相对包目录的路径（来自声明）。 */
  readonly path: string
  /** 全文；读不出来为 `null`。 */
  readonly text: string | null
  /** 读不出来的原因（不存在 / 太大）。 */
  readonly problem?: string
}

/** 一份源码。 */
export interface SourceFile {
  /** 相对包目录的路径。 */
  readonly path: string
  /** 全文。 */
  readonly text: string
}

/** 一个包的事实（检查函数只吃这个，不碰 IO）。 */
export interface PackageFacts {
  /** 包名（取自目录名）。 */
  readonly name: string
  /** 目录下全部文件的相对路径（含 `src/*.ts`，不递归进 node_modules）。 */
  readonly files: readonly string[]
  /** `package.json` 解析结果；解析失败为 `null`。 */
  readonly manifest: Record<string, unknown> | null
  /** `package.json` 解析失败的原因。 */
  readonly manifestError?: string
  /** `tsconfig.json` 解析结果。 */
  readonly tsconfig: Record<string, unknown> | null
  /** `tsconfig.json` 解析失败的原因。 */
  readonly tsconfigError?: string
  /**
   * 补丁文件（**按 `ondra.bundle.patch` 的声明顺序**，一个或多个）。
   *
   * 声明成数组是因为宿主就是这么读的：`bundlePatchFiles()` 允许一个路径或一组路径，
   * 按顺序拼接。只认单个文件名会让「声明了两个补丁」的包被误判成「没声明」。
   */
  readonly patches: readonly PatchFileFacts[]
  /** `README.md` 全文。 */
  readonly readme: string | null
  /** `locale/zh.json` 解析结果。 */
  readonly localeZh: Record<string, unknown> | null
  /** `locale/en.json` 解析结果。 */
  readonly localeEn: Record<string, unknown> | null
  /** `src/**` 下的 TypeScript 源码。 */
  readonly sources: readonly SourceFile[]
}

/** 服务键索引（一次扫描算一次，供「唯一」与「可解析」两项共用）。 */
export interface KeyIndex {
  /** 键 → 声明它的包（可能多个 = 冲突）。 */
  readonly provided: ReadonlyMap<string, readonly string[]>
  /** 上游宿主键（不是本仓插件提供的，如 `llm` / `webServer`）。 */
  readonly hostKeys: readonly string[]
}

/** 补丁行（解析后的形状）。 */
export type PatchRow = Record<string, unknown>

/** 一条组合告警。 */
export type ComposeCode =
  | 'insert-target-missing'
  | 'insert-target-not-group'
  | 'id-required'
  | 'target-missing'
  | 'name-mismatch'
  | 'bad-row'

/** 组合告警。 */
export interface ComposeWarning {
  /** 码。 */
  readonly code: ComposeCode
  /** 涉及的 id（没有则 `undefined`）。 */
  readonly id?: string
  /** 一句说明（含补丁行号更利于排查，故带 `row`）。 */
  readonly row: number
  /** 中文说明。 */
  readonly message: string
}

/** 组合结果。 */
export interface ComposeResult {
  /** 宿主会看到的入口树（根列表）。 */
  readonly entries: readonly PatchRow[]
  /** 被跳过的补丁行。 */
  readonly warnings: readonly ComposeWarning[]
}

/** YAML 子集解析结果。 */
export type YamlResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false
      readonly reason: string
      readonly line: number
      /** 是「本子集不支持」而不是「写错了」——前者标 `unverifiable`，后者标 `fail`。 */
      readonly unsupported: boolean
    }

/** 解析补丁文件的结论。 */
export interface PatchParse {
  /** 解析成功没有。 */
  readonly ok: boolean
  /** 补丁行（失败时为空）。 */
  readonly rows: readonly PatchRow[]
  /** 失败原因（成功时 `undefined`）。 */
  readonly reason?: string
  /** 失败行号（成功时 `undefined`）。 */
  readonly line?: number
  /** 用了本包子集不支持的语法（`!!js` / 锚点 / 流式 / 块标量）。 */
  readonly unsupported: boolean
}

/** 宿主若愿意提供权威组合结果，接这个端口。 */
export interface BootOracle {
  /** 端口名。 */
  readonly id: string
  /** 把补丁文本算成入口树；算不了返回 `null`（本包退回自己的移植版）。 */
  compose(patchText: string): ComposeResult | null
}

/** 不能用的原因（闭集）。 */
export type StartupCheckReason = 'disabled' | 'no-root'

/** 现状。 */
export interface StartupCheckStatus {
  /** 开关。 */
  readonly enabled: boolean
  /** 扫描根（空 = 没配，什么都不扫）。 */
  readonly root: string
  /** 读端口。 */
  readonly source: string
  /** 索引里几个包、几个服务键。 */
  readonly packages: number
  /** 服务键数。 */
  readonly keys: number
  /** 宿主键几个。 */
  readonly hostKeys: number
  /** 索引算于何时（`0` = 还没算过）。 */
  readonly indexedAt: number
  /** 不能用的原因。 */
  readonly reason?: StartupCheckReason
  /** 是否接入了权威组合端口。 */
  readonly oracle: boolean
}

/** 计数。 */
export interface StartupCheckStats {
  /** 单包检查次数。 */
  readonly checks: number
  /** 全仓扫描次数。 */
  readonly scans: number
  /** 索引重建次数。 */
  readonly reindexes: number
  /** 判 `fatal` 的包数（累计）。 */
  readonly fatal: number
  /** 判 `partial` 的包数（累计）。 */
  readonly partial: number
  /** 判 `pass` 的包数（累计）。 */
  readonly passed: number
}

/** O-001 的日志名前缀子集。 */
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

/** 本插件对外提供的服务。 */
export interface StartupCheckService {
  /** 开关开着没有。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: StartupCheckReason
  /** 检查一个包（`name` 为空 = 检查本插件自己）。**永不抛错**。 */
  check(name?: string): Promise<CheckReport>
  /** 扫全部包。 */
  checkAll(): Promise<readonly CheckReport[]>
  /** 当前服务键索引。 */
  index(): Promise<KeyIndex>
  /** 重建索引。 */
  refresh(): Promise<KeyIndex>
  /** 只跑第十项（宿主会不会加载我），给启动期用。 */
  hostLoads(name?: string): Promise<CheckResult>
  /** 现状。 */
  status(): StartupCheckStatus
  /** 计数。 */
  stats(): StartupCheckStats
  /** 换读端口（`null` = 没有可用端口）。 */
  useSource(source: PackageSource | null): void
  /** 换权威组合端口（`null` = 只用本包的移植版）。 */
  useOracle(oracle: BootOracle | null): void
  /** 撤（幂等）。 */
  dispose(): void
}
