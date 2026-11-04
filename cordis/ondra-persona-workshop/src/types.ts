/**
 * O-098 `ondra-persona-workshop` 的对外契约：**人格包体检 + 派生草案**。
 *
 * ## 一句话定位
 *
 * 它回答两个问题，都只出结构、不出文案：
 *
 * 1. **「这个包哪里不够？」** —— `audit(id)` 出一张逐项体检表（八项，每项给判据与证据）；
 * 2. **「想做一个变体，要改哪几处？」** —— `draft(id)` 出一张改动清单（文件路径 + 动作类型），
 *    **不含任何改写后的句子**。
 *
 * ## 三条硬边界（本文件最重要的部分）
 *
 * 1. **不写人设包，一个字节都不写。**
 *    `cordis/ondra-persona-skills/` 下是产品资产（master-plan §17-7 禁动），
 *    用户根 `user/personas` 下的包也属于用户。工坊全程只读。
 *    真要落盘成新包需要 **ZIP 编码**（写中央目录 + deflate），而仓内只有 O-020 自写的
 *    **读取**器、没有写入器；禁装依赖、禁引第三方库。所以「生成新包」这件事
 *    **不是本插件偷懒不做，是当前约束下做不了**——写进 README「明确不负责」与「已知限制」。
 * 2. **不读包内正文。**
 *    体检只需要元数据（`meta.json` 的字段、文件清单、字符数），这些 O-020 的
 *    `PersonaDetail` 已经全部给出。读 `SKILL.md` 正文只为「看看写得好不好」，
 *    那是人的判断，不是插件的判断；而且正文一进内存就多一份隐私面。
 *    **唯一的例外**是 O-021 `ondra-persona-core` 的槽位切片——它已经在内存里缓存着，
 *    本插件只问「六个槽位到齐了几个」，不碰切片正文。
 * 3. **不生成文案。**
 *    草案只写「这里要补一段自我介绍」+ 指向哪个文件哪个章节，
 *    **不写「你好，我是……」**。写文案是创作，创作要么归人，要么归模型（那要走
 *    O-035 网关并计费），插件自己编出来的句子会被人当成产品资产的一部分。
 *
 * ## 与 O-020 / O-021 的分工
 *
 * | 插件 | 管什么 |
 * |---|---|
 * | O-020 `ondra-persona-loader` | **有哪些包**（发现、解包、报账） |
 * | O-021 `ondra-persona-core` | **包里有什么**（六槽位切片、边界、激活规则） |
 * | **本插件** | **这个包缺什么、想派生要改哪几处**（判断与清单，不产成品） |
 *
 * 三者的服务键各自独立，本文件不 import 任何 `ondra-*` 源码（§15.5）。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const WORKSHOP_SERVICE_KEY = 'ondra-persona-workshop'

/**
 * 体检项的 id。八项，顺序即报告里的固定顺序。
 *
 * 为什么是这八项：它们全部**能用元数据判定**，不需要读正文、不需要模型。
 * 凡是需要「读一读才知道好不好」的（文笔、像不像、有没有 OOC），
 * 一律不在本插件职责内——那是验收测试集（O-118）与人的事。
 */
export const CHECK_IDS = [
  'id-match',
  'meta-declared',
  'skill-size',
  'slot-coverage',
  'trigger-words',
  'boundaries',
  'profile-fields',
  'license',
] as const

/** 一个体检项 id。 */
export type CheckId = (typeof CHECK_IDS)[number]

/**
 * 单项结论。
 *
 * - `pass`：判据满足。
 * - `warn`：不致命，但值得改（比如 `SKILL.md` 偏短）。
 * - `fail`：缺了会让人设「能用但不对」（比如六个槽位缺三个）。
 * - `skip`：**判定所需的上游没到位**（比如没装 O-021 就查不了槽位）。
 *   `skip` 与 `fail` 必须分开：把「查不了」记成「不合格」，
 *   用户会去改一个其实没问题的包。
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

/** 一项体检结果。 */
export interface CheckResult {
  /** 项 id。 */
  readonly id: CheckId
  /** 中文名。 */
  readonly title: string
  /** 结论。 */
  readonly status: CheckStatus
  /** 判据的一句话（「六个槽位是否齐全」这种），让用户知道在查什么。 */
  readonly criterion: string
  /** 证据：具体数字或文件名的简短说明。 */
  readonly evidence: string
  /** 建议怎么做（**只指方向，不写文案**）。`pass` 时为空串。 */
  readonly suggestion: string
}

/** 体检报告。 */
export interface AuditReport {
  /** 人设 id。 */
  readonly personaId: string
  /** 包文件名（用户可见的写法，不含机器绝对路径）。 */
  readonly archiveName: string
  /** 是否来自随包根（产品资产，只读）。 */
  readonly bundled: boolean
  /** 八项结果（顺序固定）。 */
  readonly checks: readonly CheckResult[]
  /** 通过 / 警告 / 不合格 / 跳过 四项计数。 */
  readonly tally: Readonly<Record<CheckStatus, number>>
  /**
   * 健康分 0–1。
   *
   * **只把 `pass` 记为满分、`warn` 记半分，`fail` 与 `skip` 都不计分母**
   * ——`skip` 不计分母是关键：没装 O-021 时不该让所有人的包都显得不健康。
   */
  readonly score: number
  /** 能不能用：有没有 `fail`。 */
  readonly usable: boolean
  /** 报告时刻。 */
  readonly at: number
}

/**
 * 派生草案里一条改动的动作类型。
 *
 * **只有这五种**，且都不含文案：
 * - `fill`：某处是空的，要补内容（补什么由人决定）。
 * - `shorten`：某处超长，要压缩。
 * - `declare`：文件存在但没在 `meta.files` 里登记。
 * - `rename`：id / 文件名对不上，要统一。
 * - `add-section`：`SKILL.md` 缺某个一级章节（六个槽位之一）。
 */
export const DRAFT_ACTIONS = ['fill', 'shorten', 'declare', 'rename', 'add-section'] as const

/** 一个动作用类型。 */
export type DraftAction = (typeof DRAFT_ACTIONS)[number]

/** 草案里的一条改动。 */
export interface DraftItem {
  /** 动作类型。 */
  readonly action: DraftAction
  /** 改哪个文件（包内相对路径；包级改动为空串）。 */
  readonly file: string
  /** 改哪个位置（章节名或字段名；没有为空串）。 */
  readonly where: string
  /** 为什么要改（引用体检项的结论，不重复判据）。 */
  readonly because: string
  /** 优先级：1 最要紧。 */
  readonly priority: number
}

/** 派生草案。 */
export interface VariantDraft {
  /** 源包 id。 */
  readonly sourceId: string
  /** 源包是否来自随包根（是则**新品必须另起 id**，不能就地改）。 */
  readonly fromBundled: boolean
  /** 改动清单（按优先级升序）。 */
  readonly items: readonly DraftItem[]
  /**
   * 新包骨架：目录树与文件清单，**只有路径没有内容**。
   *
   * 它是「照着建」的清单，不是模板正文——正文里每一个字都是创作，归人。
   */
  readonly skeleton: readonly string[]
  /**
   * 必须自己定的三件事（改完这三件才算「另一个人」，否则只是换皮）。
   *
   * 刻意固定三条而不是列十条：「改三处就能立住一个新角色」是可行的工作量，
   * 列十条的结果是用户一条都不做。
   */
  readonly mustChange: readonly string[]
  /** 草案时刻。 */
  readonly at: number
}

/** 服务不可用原因。 */
export type WorkshopUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** O-020 加载器缺席：连有哪些包都不知道。 */
  | 'no-loader'

/** 统计快照。 */
export interface WorkshopStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: WorkshopUnavailableReason
  /** 累计体检次数。 */
  readonly audits: number
  /** 累计草案次数。 */
  readonly drafts: number
  /** 槽位判定可用的次数（O-021 在位时 +1）。 */
  readonly slotChecks: number
}

/** 错误码。**只用闭集内的值**。 */
export type WorkshopErrorCode = 'no-persona' | 'no-loader' | 'bad-request'

/** 工坊错误。带稳定错误码。 */
export class WorkshopError extends Error {
  /** 错误码。 */
  readonly code: WorkshopErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: WorkshopErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'WorkshopError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface WorkshopService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: WorkshopUnavailableReason

  /** 当前可体检的人设 id 清单（来自 O-020）。 */
  ids(): readonly string[]

  /**
   * 体检一个包。
   * @param id 人设 id；省略时取当前激活人设。
   * @param at 时刻。
   * @throws `WorkshopError('no-persona')` 当该 id 不存在。
   */
  audit(id?: string, at?: number): AuditReport

  /**
   * 出一个派生草案。
   * @param id 人设 id；省略时取当前激活人设。
   * @param at 时刻。
   */
  draft(id?: string, at?: number): VariantDraft

  /**
   * 横向对比：所有包的体检结论并排（一次体检全部，最多 `maxPersonas` 个）。
   * @param at 时刻。
   */
  compare(at?: number): readonly AuditReport[]

  /** 统计快照。 */
  stats(): WorkshopStats
}

/* ------------------------------------------------------------------ *
 * 阈值常量（工程取值，手册无出处，依据见 `audit.ts`）
 * ------------------------------------------------------------------ */

/** `SKILL.md` 低于这个字符数算「偏短」（warn）。实包 19982 / 另一个也过万。 */
export const SKILL_CHARS_MIN = 6000

/** `SKILL.md` 高于这个字符数算「偏长」（warn）：一篇塞太满，模型反而抓不住重点。 */
export const SKILL_CHARS_MAX = 60000

/** 触发词最多几条（与 O-020 `meta.ts` 的 `TRIGGER_LIMIT` 同口径）。 */
export const TRIGGER_WORDS_MAX = 32

/** `profile` 里这几项至少要有几项（不是「全部都要」：实包也缺字段）。 */
export const PROFILE_FIELDS_MIN = 3

/** 体检/对比一次最多看几个包（防「某个用户塞了 200 个包」）。 */
export const MAX_AUDIT = 64

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§15.5：不 import 源码）
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟服务的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** 包内一个文件的元数据（O-020 `PersonaFileEntry` 的对位子集）。 */
export interface FileEntryLike {
  readonly path: string
  readonly bytes: number
  readonly declared: boolean
}

/** 人设详情（O-020 `PersonaDetail` 的对位子集，**只要元数据**）。 */
export interface PersonaDetailLike {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly version: string
  readonly role: string
  readonly rootKind: string
  readonly archiveName: string
  readonly triggerWords: readonly string[]
  readonly tags: readonly string[]
  readonly language: string
  readonly skillChars: number
  readonly fileCount: number
  readonly archiveBytes: number
  readonly profile: Readonly<Record<string, unknown>>
  readonly license: string
  readonly declaredFiles: Readonly<Record<string, string>>
  readonly files: readonly FileEntryLike[]
}

/** O-020 加载器服务的对位子集。 */
export interface LoaderLike {
  readonly available: boolean
  list(): readonly PersonaDetailLike[]
  get(id: string): PersonaDetailLike | undefined
  has(id: string): boolean
  activeId(): string | undefined
}

/**
 * O-021 人格内核服务的对位子集。
 *
 * 只取 `kernel()` 与 `boundaries()`：前者回答「六个槽位到齐几个」，
 * 后者回答「硬红线有没有」。**不取 `compose()`**——拼提示词是 O-023 的事，
 * 本插件不拼任何要进提示词的东西。
 */
export interface CoreLike {
  readonly available: boolean
  kernel(personaId?: string): { readonly slots: readonly KernelSlotLike[]; readonly missing: readonly string[] } | undefined
  boundaries(personaId?: string): readonly BoundaryLike[]
}

/** 一个槽位的对位子集（只要「找到没有」，不要正文）。 */
export interface KernelSlotLike {
  readonly id: string
  readonly label: string
  readonly found?: boolean
  readonly chars?: number
}

/** 一条边界（O-021 `BoundaryItem` 的对位子集）。 */
export interface BoundaryLike {
  readonly id: string
  readonly text: string
  readonly hard: boolean
  readonly source: string
}

/** O-005 段声明的对位子集。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置段声明的对位子集。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number } | undefined
}

/** O-005 字段声明的对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}
