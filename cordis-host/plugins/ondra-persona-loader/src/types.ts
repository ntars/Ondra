/**
 * O-020 `ondra-persona-loader` 的对外契约。
 *
 * 定位：**「有哪些人设可用」的唯一真源**。它只做三件事——找包、解包、报账。
 *
 * 六件必须先说清的事：
 *
 * 1. **人设包只读。** `cordis/ondra-persona-skills/` 下是产品资产（master-plan §17-7 禁动），
 *    本插件**只解压读进内存**，从不回写、从不改包内文件、从不把包解到磁盘上再读。
 *    所以 ZIP 解码只有这一处（`zip.ts`），`ondra-persona-core` 一律经
 *    `readText()` 拿文本——**第二份 ZIP 解析就是第二真源**。
 *
 * 2. **ZIP 解码用 `node:zlib` 自实现，不引依赖。**
 *    上游 `dsh-skill-filesystem` 只发现「目录包 + 扁平 md」，**不认 `.skill.zip`**
 *    （已读源码确认：它走 `readdir` + `parse` frontmatter，没有解压路径）。
 *    而本仓禁止 `pnpm install`，故只能读中央目录 + `inflateRaw`。
 *    这是**格式解码**不是**机制重造**（§1.8 复用档列的是记忆/通道/语音那类机制），
 *    已知边界写在 README「已知限制 1」。
 *
 * 3. **`id` 是别处要用的键，所以必须合规。**
 *    `meta.slug` 是首选来源；不合 `^[a-z][a-z0-9_-]{1,63}$` 就整包**拒收并报 `bad-id`**，
 *    不悄悄改成合法值——改了之后「用户以为装的是 A、实际装成了 B」，
 *    而 A 在列表里永远找不到。中文名包（无 slug）同样拒收，并在问题里写明
 *    「请在 meta.json 里补 slug」。
 *
 * 4. **出厂 / 示例的判定来自包内 `meta.slug` 的实际值，不是猜。**
 *    `oh-jingjing` 与 `xia-ningqi` 是两个人设包 `meta.json` 里逐字写着的 slug
 *    （已解包核对）。手册 §1.1 定「出厂鲸鲸、夏柠柒为示例包」，本插件据此打
 *    `role` 标记；两者都缺席时 `role` 全是 `user`，**不编一个人设顶上去**。
 *
 * 5. **两个根、用户优先。** 用户根（数据根 `user/personas`）排在前、随包根排在后；
 *    同 id 时**用户根胜出**并记 `duplicate-id`。反过来做的话，用户导入一版
 *    改过的人设永远被随包版本盖住，而界面上看不出为什么没生效。
 *
 * 6. **不持久化「当前人设」。** 切换只改内存态，落盘归 O-005 的用户层或界面
 *    （§3.3-5 单一真源）。本插件写一次文件，就等于多一个能跟配置打架的状态。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:persona-loader`）。全仓唯一归属。 */
export const PERSONA_LOADER_SERVICE_KEY = 'ondra-persona-loader'

/** 人设包文件名后缀（手册 §1.1 / master-plan §5 L2 人格域）。 */
export const PERSONA_ARCHIVE_SUFFIX = '.skill.zip'

/**
 * 出厂人设 id。来源：`哦鲸鲸.skill.zip` 内 `meta.json` 的 `slug` 字段，逐字为 `oh-jingjing`。
 * 手册 §1.1「出厂人格（定案）：初始人设为**鲸鲸**」。
 */
export const FACTORY_PERSONA_ID = 'oh-jingjing'

/**
 * 示例人设 id。来源：`夏柠柒.skill.zip` 内 `meta.json` 的 `slug` 字段，逐字为 `xia-ningqi`。
 * 手册 §1.1「『夏柠柒』为示例人格包（示例人格·可随时替换）」。
 */
export const SAMPLE_PERSONA_ID = 'xia-ningqi'

/**
 * 人设 id 的硬约束（手册 §8.4 的同一条正则）。
 *
 * 这里比 §8.4 多一层理由：`id` 会被别的插件当键用（`activePersona` 配置项、
 * 日志命名空间 `persona.<id>`），不合规的键在下游会以「查不到」的形态出现，
 * 而不是在装载期报错。所以在入口处就拦住。
 */
export const PERSONA_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/

/** 人设的角色标记。 */
export type PersonaRole =
  /** 出厂人设（手册 §1.1 定案：鲸鲸）。 */
  | 'factory'
  /** 示例人设（手册 §1.1：夏柠柒，示例人格·可随时替换）。 */
  | 'sample'
  /** 用户自己导入的。 */
  | 'user'

/** 扫描根的类别。 */
export type PersonaRootKind =
  /** 随包根：`cordis/ondra-persona-skills`（产品资产，只读）。 */
  | 'bundled'
  /** 用户根：数据根下 `user/personas`（用户导入，只读扫描、由用户自己放文件）。 */
  | 'user'

/** 一个扫描根。 */
export interface PersonaRoot {
  /** 类别。 */
  readonly kind: PersonaRootKind
  /** 绝对路径。 */
  readonly path: string
  /**
   * 用户可见写法：随包根给相对仓库根的写法，用户根给 `~/.ondra/user/personas`。
   * **绝不把机器绝对路径塞进界面**（与 O-002 的 `display` 同口径）。
   */
  readonly display: string
  /** 目录是否存在。 */
  readonly exists: boolean
  /** 本轮扫到的包数。 */
  readonly found: number
}

/**
 * 人设包 `meta.json` 的 `profile` 段（只取本仓两个人设包实际存在的字段）。
 *
 * 全部可选：这两个包一个带 `alias`、一个不带，缺字段是常态。
 * **缺就留空，不补一个像样的默认值**——补出来的「性格」比没有更坏。
 */
export interface PersonaProfile {
  /** 全名。 */
  readonly fullName?: string
  /** 别名。 */
  readonly alias: readonly string[]
  /** 年龄段 / 年龄设定（原文可能是「大学生」这类描述）。 */
  readonly ageRange?: string
  /** 身份。 */
  readonly occupation?: string
  /** 性格标签（原文是短句数组）。 */
  readonly personality: readonly string[]
  /** 依恋类型。 */
  readonly attachmentStyle?: string
  /** 表达爱意的方式。 */
  readonly loveLanguage?: string
  /** 语言指纹（原包是「中位字数 / 问号率 / 句号率」这类数值的混合体）。 */
  readonly speechFingerprint?: Readonly<Record<string, string | number>>
}

/**
 * `meta.json` 的 `source` 段（只取六个已知字段）。
 *
 * 两个包的 `source` 形状不一致（`chapters` 一个是数字一个是字符串、`characters`
 * 一个是数组一个是数字），所以**只取两边都稳的六项**，其余原样丢弃。
 * 丢弃是安全的：这些是展示用的考证信息，不是任何判定的输入。
 */
export interface PersonaSource {
  /** 作品 / 语料来源。 */
  readonly work?: string
  /** 作者 / 合成者。 */
  readonly author?: string
  /** 平台。 */
  readonly platform?: string
  /** 阅读方式（原文如「全文分段精读（16 段）」）。 */
  readonly readingMethod?: string
  /** 核验引文数。 */
  readonly quotesChecked?: number
  /** 命中引文数。 */
  readonly quotesMatched?: number
}

/** 标签的来源。**必须区分「包自己写的」与「从性格标签派生的」**。 */
export type PersonaTagsSource =
  /** `meta.tags` 里明确写了。 */
  | 'meta'
  /** `meta.tags` 缺失，取 `profile.personality` 前三条（人设卡 chips 用）。 */
  | 'personality'
  /** 两者都没有，界面不显示 chips。 */
  | 'none'

/** 包内一个文件。 */
export interface PersonaFileEntry {
  /** 相对包根的路径（已剥掉 `xxx.skill/` 这层外壳目录）。 */
  readonly path: string
  /** 字节数。 */
  readonly bytes: number
  /** 是否在 `meta.files` 里被声明过（未声明不算错，只是渐进披露索引里没有它）。 */
  readonly declared: boolean
}

/** 人设摘要（列表用，不含正文）。 */
export interface PersonaSummary {
  /** 人设 id（= `meta.slug`，已校验合规）。 */
  readonly id: string
  /** 包名（`meta.name`，可能是中文）。 */
  readonly name: string
  /** 展示名（`meta.display_name` ?? `meta.name`）。 */
  readonly displayName: string
  /** 版本（`meta.version`，缺失为空串）。 */
  readonly version: string
  /** 角色标记。 */
  readonly role: PersonaRole
  /** 来自哪个根。 */
  readonly rootKind: PersonaRootKind
  /** 包文件绝对路径。 */
  readonly archivePath: string
  /** 用户可见的包文件名。 */
  readonly archiveName: string
  /** 触发词（`meta.trigger_words`，已去空去重、最多 32 条）。 */
  readonly triggerWords: readonly string[]
  /** 人设卡 chips。 */
  readonly tags: readonly string[]
  /** chips 来源。 */
  readonly tagsSource: PersonaTagsSource
  /** 语言。 */
  readonly language: string
  /** `SKILL.md` 的字符数（没读到为 0）。 */
  readonly skillChars: number
  /** 包内文件数。 */
  readonly fileCount: number
  /** 包的总字节数。 */
  readonly archiveBytes: number
}

/** 人设详情（含 `profile` / `source` / 文件清单）。 */
export interface PersonaDetail extends PersonaSummary {
  /** `profile` 段。 */
  readonly profile: PersonaProfile
  /** `source` 段。 */
  readonly source: PersonaSource
  /** `structure` 段（原包是一堆计数字段，原样保留给界面展示）。 */
  readonly structure: Readonly<Record<string, string | number>>
  /** 安全声明（`meta.safety`，原包有 `red_lines` / `self_harm` 等键）。 */
  readonly safety: Readonly<Record<string, unknown>>
  /** 版权声明（`meta.license`）。 */
  readonly license: string
  /** `meta.files` 的「路径 → 说明」表，供渐进披露索引用。 */
  readonly declaredFiles: Readonly<Record<string, string>>
  /** 包内文件清单（按路径排序）。 */
  readonly files: readonly PersonaFileEntry[]
}

/** 问题码。**每一个都要能被用户看懂并照做**，不是给人看的编号。 */
export type PersonaIssueCode =
  /** 包打不开（ZIP 结构坏、被截断、加密）。 */
  | 'zip-error'
  /** ZIP64 / 不支持的压缩算法。 */
  | 'unsupported-zip'
  /** 包超过 `maxArchiveBytes`。 */
  | 'too-large'
  /** 包里没有 `meta.json`。 */
  | 'no-meta'
  /** `meta.json` 不是合法 JSON 或不是对象。 */
  | 'bad-meta'
  /** 算不出合规的 `id`（缺 slug 且包名不能用）。 */
  | 'bad-id'
  /** 同 id 已被前面的根占用（后者被跳过）。 */
  | 'duplicate-id'
  /** 包里没有 `SKILL.md`（能列出来，但 `ondra-persona-core` 组装不出内核）。 */
  | 'no-skill'
  /** `meta.trigger_words` 为空或全被过滤掉。 */
  | 'no-trigger'
  /** 单文件超过 `maxEntryBytes`，读文本时会被拒。 */
  | 'entry-too-large'
  /** 超过 `maxPersonas` 上限，后面的包没扫。 */
  | 'over-cap'
  /** 问题条数超过 `keepIssues`，后面的被丢弃。 */
  | 'issue-truncated'

/** 一条问题。 */
export interface PersonaIssue {
  /** 问题码。 */
  readonly code: PersonaIssueCode
  /** 相关人设 id（能算出来才有）。 */
  readonly id?: string
  /** 相关文件（包文件名或包内路径）。 */
  readonly file: string
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 一次扫描的报告。 */
export interface ScanReport {
  /** 扫描时刻（毫秒）。 */
  readonly at: number
  /** 扫描耗时（毫秒）。 */
  readonly durationMs: number
  /** 扫过的根。 */
  readonly roots: readonly PersonaRoot[]
  /** 找到的包文件数（含被拒的）。 */
  readonly found: number
  /** 成功注册的人设数。 */
  readonly loaded: number
  /** 被拒 / 被跳过的包数。 */
  readonly skipped: number
  /** 问题清单。 */
  readonly issues: readonly PersonaIssue[]
}

/** 不可用原因。 */
export type PersonaUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 一个根都不存在。 */
  | 'no-root'
  /** 扫描本身抛错（权限、路径是文件而不是目录）。 */
  | 'scan-failed'

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface PersonaStats {
  /** 是否可用（未关且至少扫过一次）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: PersonaUnavailableReason
  /** 已注册人设数。 */
  readonly total: number
  /** 各角色的条数。 */
  readonly byRole: Readonly<Record<PersonaRole, number>>
  /** 当前人设 id（没设或设了但不存在时为 `null`）。 */
  readonly activeId: string | null
  /** 配置里指定的出厂 id 是否真的存在。 */
  readonly factoryPresent: boolean
  /** 配置里指定的示例 id 是否真的存在。 */
  readonly samplePresent: boolean
  /** 扫描根。 */
  readonly roots: readonly PersonaRoot[]
  /** 上次扫描时刻（0 表示还没扫过）。 */
  readonly lastScanAt: number
  /** 上次扫描耗时。 */
  readonly lastScanMs: number
  /** 缓存里的文本总字节数。 */
  readonly cachedTextBytes: number
  /** 最近的问题（最多 `keepIssues` 条）。 */
  readonly issues: readonly PersonaIssue[]
}

/** 人设加载服务。 */
export interface PersonaLoaderService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: PersonaUnavailableReason

  /** 重扫两个根。**唯一的刷新入口**：导入新包后由界面调它。 */
  refresh(): ScanReport
  /** 已注册人设清单（按 `role` 再按 `id` 排序）。 */
  list(): readonly PersonaSummary[]
  /**
   * 取一个人设的详情。
   * @param id 人设 id。
   */
  get(id: string): PersonaDetail | undefined
  /**
   * 有没有这个人设。
   * @param id 人设 id。
   */
  has(id: string): boolean
  /** 扫描根。 */
  roots(): readonly PersonaRoot[]

  /**
   * 读包内一个**文本**文件。首次读会解包，之后走缓存。
   * @param id 人设 id。
   * @param relPath 相对包根的路径，如 `SKILL.md` / `references/voice.md`。
   * @returns 文本；包内没有该文件、或它太大、或不是 UTF-8 文本时返回 `undefined`。
   */
  readText(id: string, relPath: string): string | undefined
  /**
   * 包内文件清单。
   * @param id 人设 id。
   */
  files(id: string): readonly PersonaFileEntry[]

  /** 当前人设 id；未设时为 `undefined`。 */
  activeId(): string | undefined
  /** 当前人设详情。 */
  active(): PersonaDetail | undefined
  /**
   * 切换当前人设（**只改内存态**，落盘归 O-005 / 界面）。
   * @param id 人设 id。
   * @returns 成功为 `true`；人设不存在为 `false`（不改动当前值）。
   */
  setActive(id: string): boolean

  /** 统计快照。 */
  stats(): PersonaStats
}

/** 错误码。 */
export type PersonaErrorCode =
  /** 人设不存在。 */
  | 'no-persona'
  /** 包内没有这个文件。 */
  | 'no-file'
  /** 文件太大。 */
  | 'too-large'
  /** 包打不开。 */
  | 'zip-error'
  /** 参数非法。 */
  | 'bad-argument'

/** 人设加载错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class PersonaError extends Error {
  /** 错误码。 */
  readonly code: PersonaErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: PersonaErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'PersonaError'
    this.code = code
    this.detail = detail
  }
}

/** 日志门面的最小形状（Cordis Logger 的结构对位子集）。 */
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

/** O-002 路径服务的结构对位子集（只用 `ensure` / `fileIn` / `exists` / `display`）。 */
export interface PathLayoutLike {
  readonly display: string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  exists(filePath: string): boolean
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/* ------------------------------------------------------------------ *
 * 维护纪律（改契约前必读）
 *
 * 1. **ZIP 解码只能有 `zip.ts` 一份。** `ondra-persona-core` 通过 `readText()` 拿文本，
 *    不许自己再解一次包。两份解码 = 两份「哪个文件才算 SKILL.md」的判定。
 * 2. **`PersonaDetail.profile` 的字段名跟 `meta.json` 的 snake_case 是一一映射的**
 *    （`full_name` → `fullName`）。加字段时两边同改，否则会出现「包里有、界面上没有」。
 * 3. **不要在 `PersonaSummary` 里塞正文。** 列表会被界面与自检反复读，
 *    塞了正文就等于每次刷新都把几百 KB 文本搬一遍。
 * 4. **`role` 只由 `id` 与配置比对得出**，不许按文件名、不许按包内 `name`（中文名会重名）。
 * ------------------------------------------------------------------ */
