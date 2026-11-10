/**
 * O-021 `ondra-persona-core` 的对外契约。
 *
 * 定位：**「她是谁」这件事的唯一组装口**。上层拿到的不是「一段人格文本」，
 * 而是**六个有名字、有顺序、能单独替换的槽位** + **六个关系变体**。
 *
 * 六件必须先说清的事：
 *
 * 1. **「六槽位」是反推出来的，不是手册给的。**
 *    手册只在 §1.4 与 §3.2 写了「persona-core：五关系表 + 六槽位」这一句，
 *    **没有给槽位名**。本插件按两个人设包 `SKILL.md` 的**实际章节结构**反推：
 *    每轮都必须进提示词、且彼此不可合并的六段，正好是
 *    「身份锚定 / 说话 / 三条底层机制 / 场景与连续 / 回复格式 / 发出前自检」。
 *    其余三段（`激活与退出`、`硬规则 + 红线 + 诚实边界`、`按需读取`）**不是槽位**，
 *    各有归处：激活归 `activation()`，边界归 `boundaries()`，索引归 `references()`。
 *    这条判定登记待裁决；裁决后**只改 `slots.ts` 一处**（映射表是数据不是代码）。
 *
 * 2. **槽位正文逐字保留，一个字都不改写。**
 *    人设正文是产品资产，重写一次就再也说不清「这句是她原本的设定，还是插件作者加的」。
 *    所以 `SlotContent.text` 是 `SKILL.md` 的**原样切片**（含它自己的 `##` 标题）。
 *
 * 3. **缺槽位不编内容。** 某段在包里找不到，`SlotContent.found = false`、`text = ''`，
 *    并把 id 记进 `missing`。**不拿别的段落顶上，也不生成一段通用人格**——
 *    生成出来的一定是「一个很像 AI 助手的人」，那正是这个产品最不该有的东西。
 *
 * 4. **五关系变体只写关系差异。** master-plan §10 第 7 条点名的旧缺陷是
 *    「五个变体曾被写成只是亲密度不同，五个人读起来是同一个人」。
 *    所以 `RelationVariant` 只有四个字段：`stance`（关系性质）/ `preferredTerms`（称呼）
 *    / `pace`（相处节奏）/ `reactions`（典型反应），**再加一组 `cautions`（关系分寸）**。
 *    **没有**「性格」「语感」「价值观」字段——那三样属于内核，变体碰它就是第二份人格。
 *
 * 5. **称呼冲突以内核为准，且不静默。** 变体给的称呼是**建议**，
 *    与内核 `voice` 段里「称呼与自称」冲突时内核胜出；`compose()` 会把这件事
 *    写进关系段的第一句（「在内核允许的范围内，优先用…」），
 *    而不是悄悄覆盖掉人设作者定下的称呼规则。
 *
 * 6. **只出段落，不做裁剪、不做浓度、不做边界拼接。**
 *    裁剪与 `overBudget` 归 O-023（四段拼装），浓度归 O-022，
 *    边界由 O-023 / O-037 从 `boundaries()` 取。本插件多切一刀就是第二套预算。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:persona-core`）。全仓唯一归属。 */
export const PERSONA_CORE_SERVICE_KEY = 'ondra-persona-core'

/**
 * 六槽位 id，**顺序即拼装顺序**（内核内部的顺序）。
 *
 * 顺序依据是「模型读到第几句才知道自己是谁」：
 * 先身份（我是谁），再说话（怎么开口），再驱动力（为什么这样），
 * 再场景（什么时候怎么变），再格式（输出长什么样），最后自检（发出去之前查什么）。
 */
export const SLOT_IDS = ['identity', 'voice', 'drive', 'scene', 'format', 'selfcheck'] as const

/** 槽位 id。 */
export type SlotId = (typeof SLOT_IDS)[number]

/**
 * 辅助段落 id（不是槽位）。
 *
 * - `activation`：激活与退出（触发词、怎么收萌）——归「什么时候切过来」，不归人格。
 * - `boundaries`：硬规则 + 红线 + 诚实边界——归闸门（O-037）与拼装的边界层（O-023）。
 * - `references`：按需读取索引——归渐进披露，**永不进提示词**（它是目录不是内容）。
 */
export const AUX_IDS = ['activation', 'boundaries', 'references'] as const

/** 辅助段落 id。 */
export type AuxId = (typeof AUX_IDS)[number]

/** 一个槽位的声明。 */
export interface SlotSpec {
  /** 槽位 id。 */
  readonly id: SlotId
  /** 中文名（日志与界面用）。 */
  readonly label: string
  /** 拼装序号（0 起，与 `SLOT_IDS` 下标一致）。 */
  readonly order: number
  /**
   * 章节标题匹配关键词，**按顺序尝试、先命中先算**。
   *
   * 这些词不是猜的：它们逐字出现在两个人设包 `SKILL.md` 的一级/二级标题里
   * （`## 三、Layer 1 · 身份锚定` / `## 四、Layer 2 · 说话` / `## 五、Layer 3 · 三条底层机制`
   * / `## 六、Layer 4 · 场景与连续` / `## 七、回复格式` / `## 八、发出前自检（五问）`）。
   */
  readonly keywords: readonly string[]
  /** 这一槽位回答什么问题（给「缺槽位」时的人话解释用）。 */
  readonly doc: string
}

/** 一个槽位的内容。 */
export interface SlotContent {
  /** 槽位 id。 */
  readonly id: SlotId
  /** 中文名。 */
  readonly label: string
  /** 拼装序号。 */
  readonly order: number
  /** 命中的原始标题（含 `##`）；没命中为空串。 */
  readonly heading: string
  /** 正文字符数（含标题）。 */
  readonly chars: number
  /** 是否找到。 */
  readonly found: boolean
  /** 原样切片（含标题）。找不到时为空串。 */
  readonly text: string
}

/** 一段没被映射到任何槽位/辅助段的章节。 */
export interface SectionSlice {
  /** 原始标题（含 `##`）。 */
  readonly heading: string
  /** 正文字符数。 */
  readonly chars: number
  /** 原样切片。 */
  readonly text: string
}

/** 内核视图。 */
export interface KernelView {
  /** 人设 id。 */
  readonly personaId: string
  /** 人设版本（缓存键的一部分，见 `service.ts`）。 */
  readonly personaVersion: string
  /**
   * 标题之前的引言块（作者自己写的那句「一句话内核」）；没有为 `undefined`。
   *
   * 它不是槽位，但**拼在内核最前面**：两个人设包的第一句都是作者对这个人
   * 最浓缩的一句总结（「一条住在硬盘里的鱼，怕被当成工具，所以先把账算清楚」），
   * 丢掉它等于丢掉作者自己的答案，而后面十一段都是它的展开。
   */
  readonly essence: SectionSlice | undefined
  /** 六个槽位（顺序固定，缺失的也在，`found=false`）。 */
  readonly slots: readonly SlotContent[]
  /** 没被映射的章节（**不进内核**，只报出来）。 */
  readonly extras: readonly SectionSlice[]
  /** 引言块 + 六个槽位拼起来的字符数。 */
  readonly chars: number
  /** 缺了哪几个槽位。 */
  readonly missing: readonly SlotId[]
  /** 六槽位是否齐全。 */
  readonly complete: boolean
  /** `SKILL.md` 的字节数（便于判断「是不是读到了半个文件」）。 */
  readonly sourceBytes: number
}

/** 关系 id。**五项是「五关系表」，`custom` 是第六项（自定义），不占五关系的位置。** */
export type RelationId = 'girlfriend' | 'sister' | 'daughter' | 'friend' | 'assistant' | 'custom'

/** 五关系 id（不含 `custom`）。 */
export const BUILTIN_RELATION_IDS = ['girlfriend', 'sister', 'daughter', 'friend', 'assistant'] as const

/** 关系变体。 */
export interface RelationVariant {
  /** 关系 id。 */
  readonly id: RelationId
  /** 中文名（`女友` / `妹妹` / …）。 */
  readonly label: string
  /** 是否属于「五关系表」。`custom` 为 `false`。 */
  readonly builtin: boolean
  /**
   * 关系的性质（一句话）。
   *
   * 这一条是**变体的全部**：其余三个字段都是它的展开。
   * 写成「她对你是 X」而不是「她要表现得像 X」——后者会把人格变成演技。
   */
  readonly stance: string
  /**
   * 称呼规则（**是规则不是词表**）。
   *
   * 为什么不是「一串昵称」：女友该叫「宝贝」还是「你」，取决于人设作者与用户设置，
   * 由插件写死一串昵称，等于替别人决定「她怎么叫你」。这里只写**分寸**：
   * 用不用敬称、能不能起昵称、性别相关的称呼什么时候才能用。
   * 与内核 `voice` 段冲突时**内核胜出**（见文件头第 5 条）。
   */
  readonly address: readonly string[]
  /** 相处节奏。 */
  readonly pace: string
  /** 典型反应（2–3 条）。 */
  readonly reactions: readonly string[]
  /**
   * 关系分寸（**不是人格红线**）。
   *
   * 人格红线归 `boundaries()`；这里只写「这个关系下哪些话不该说」，
   * 例如「女儿关系下不得出现恋爱暗示」。
   */
  readonly cautions: readonly string[]
  /** 一句话说明。 */
  readonly doc: string
}

/** 关系段的一次「改了什么」。**为可解释性存在**（§12.2 不许黑箱）。 */
export interface RelationDelta {
  /** 改动落在哪一处。 */
  readonly field: 'address' | 'pace' | 'reaction'
  /** 是否真的改了（自定义关系没填就是 `false`）。 */
  readonly applied: boolean
  /** 人话说明。 */
  readonly note: string
}

/** 关系层产物。 */
export interface RelationSection {
  /** 关系 id。 */
  readonly relation: RelationId
  /** 拼装序号（恒为 1：内核是 0）。 */
  readonly order: 1
  /** 关系段正文。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
  /** 改了什么。 */
  readonly deltas: readonly RelationDelta[]
}

/** 拼装后的两段（内核 + 关系微调）。 */
export interface ComposedKernel {
  /** 人设 id。 */
  readonly personaId: string
  /** 人设版本。 */
  readonly personaVersion: string
  /** 关系 id。 */
  readonly relation: RelationId
  /** 两段，按 `order` 升序。**不含浓度与边界**（归 O-022 / O-023）。 */
  readonly sections: readonly { readonly id: 'kernel' | 'relation'; readonly order: number; readonly text: string }[]
  /** 两段合起来的字符数。 */
  readonly chars: number
  /** 缺了哪几个槽位（下游可据此决定要不要告警）。 */
  readonly missing: readonly SlotId[]
  /** 是否含未映射的章节（`includeExtras` 打开时才算）。 */
  readonly hasExtras: boolean
}

/** 一条边界条目。 */
export interface BoundaryItem {
  /** 稳定 id（`skill:<序号>` / `meta:<序号>`）。 */
  readonly id: string
  /** 原文。 */
  readonly text: string
  /** 是否硬约束（红线 / 硬规则 / `meta.safety.red_lines` 为 `true`；诚实边界为 `false`）。 */
  readonly hard: boolean
  /** 来源：`skill` 是 `SKILL.md` 的段落，`meta` 是 `meta.safety.red_lines`。 */
  readonly source: 'skill' | 'meta'
}

/** 激活规则。 */
export interface ActivationView {
  /** 触发词（来自 `meta.trigger_words`）。 */
  readonly triggerWords: readonly string[]
  /** 「激活与退出」章节正文（含标题）；没有该章节为空串。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
}

/** 渐进披露索引里的一条。 */
export interface ReferenceEntry {
  /** 包内相对路径。 */
  readonly path: string
  /** 说明（`meta.files` 里作者写的；没写为空串）。 */
  readonly doc: string
  /** 字节数。 */
  readonly bytes: number
}

/** 不可用原因。 */
export type PersonaCoreUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 人设加载器（O-020）缺席。 */
  | 'no-loader'
  /** 人设不存在（id 拼错或包被删）。 */
  | 'no-persona'
  /** 包里没有可读的 `SKILL.md`。 */
  | 'no-skill'

/** 统计快照。 */
export interface PersonaCoreStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: PersonaCoreUnavailableReason
  /** 当前人设 id（`null` 表示没人设可用）。 */
  readonly personaId: string | null
  /** 当前关系 id。 */
  readonly relation: RelationId
  /** 槽位数（恒为 6）。 */
  readonly slotCount: number
  /** 当前人设缺几个槽位。 */
  readonly missingCount: number
  /** 当前内核字符数。 */
  readonly kernelChars: number
  /** 边界条目数。 */
  readonly boundaryCount: number
  /** 缓存里的内核数。 */
  readonly cachedKernels: number
  /** 加载器是否在位。 */
  readonly loaderPresent: boolean
  /** `SKILL.md` 是否可读。 */
  readonly skillPresent: boolean
}

/** 人设内核服务。 */
export interface PersonaCoreService {
  /** 是否可用（有加载器、有人设、有 SKILL.md、未关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: PersonaCoreUnavailableReason

  /** 六个槽位的声明（顺序固定）。 */
  slots(): readonly SlotSpec[]
  /**
   * 取内核（六槽位切片）。结果按 `人设id@版本` 缓存，同一会话内不重复解包（§8.5）。
   * @param personaId 人设 id；省略取当前人设。
   */
  kernel(personaId?: string): KernelView | undefined

  /** 五个内置关系变体 + `custom`。 */
  variants(): readonly RelationVariant[]
  /**
   * 取一个关系变体。
   * @param id 关系 id。
   */
  variant(id: string): RelationVariant | undefined
  /**
   * 关系层会改哪三处（只出说明，不生成文本）。
   * @param id 关系 id。
   */
  deltasOf(id: string): readonly RelationDelta[]

  /**
   * 拼「内核 + 关系微调」两段。**不裁剪、不加浓度、不加边界。**
   * @param input 入参。
   */
  compose(input?: ComposeInput): ComposedKernel | undefined

  /**
   * 边界条目（硬规则 / 红线 / 诚实边界 / `meta.safety.red_lines`）。
   * @param personaId 人设 id；省略取当前人设。
   */
  boundaries(personaId?: string): readonly BoundaryItem[]
  /**
   * 激活规则（触发词 + 激活与退出章节）。
   * @param personaId 人设 id；省略取当前人设。
   */
  activation(personaId?: string): ActivationView | undefined
  /**
   * 渐进披露索引（包内文件 + 作者写的说明）。
   * @param personaId 人设 id；省略取当前人设。
   */
  references(personaId?: string): readonly ReferenceEntry[]

  /** 统计快照。 */
  stats(): PersonaCoreStats
}

/** 拼装入参。 */
export interface ComposeInput {
  /** 人设 id；省略取当前人设。 */
  readonly personaId?: string
  /** 关系 id；省略取配置值。 */
  readonly relation?: RelationId | string
  /**
   * 自定义关系的覆盖内容（只有 `relation === 'custom'` 时会用）。
   * 不填就等于「关系段只剩一句『这是自定义关系』」——**不编一套默认值**。
   */
  readonly overrides?: CustomOverrides
}

/** 自定义关系的覆盖内容。 */
export interface CustomOverrides {
  /** 关系性质。 */
  readonly stance?: string
  /** 称呼规则。 */
  readonly address?: readonly string[]
  /** 相处节奏。 */
  readonly pace?: string
  /** 典型反应。 */
  readonly reactions?: readonly string[]
  /** 关系分寸。 */
  readonly cautions?: readonly string[]
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
 * O-020 人设加载器的结构对位（不 import O-020 源码）
 *
 * 只镜像本插件真正用到的成员：`available` / `list` / `get` / `active` /
 * `activeId` / `readText`。
 * **刻意不含** `setActive` / `refresh` / `setActive`：切换人设是界面的事，
 * 组装内核的插件不该有「决定用谁」的权力——它一旦能切，就会出现
 * 「插件装载顺序决定了她是谁」这种没人查得出来的故障。
 * ------------------------------------------------------------------ */

/** 包内一个文件（镜像 O-020 的 `PersonaFileEntry`）。 */
export interface PersonaFileLike {
  readonly path: string
  readonly bytes: number
  readonly declared: boolean
}

/** 人设详情（只镜像本插件读到的字段）。 */
export interface PersonaDetailLike {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly triggerWords: readonly string[]
  readonly declaredFiles: Readonly<Record<string, string>>
  readonly safety: Readonly<Record<string, unknown>>
  readonly files: readonly PersonaFileLike[]
}

/** 人设摘要（只镜像 `id` / `displayName` / `version`）。 */
export interface PersonaSummaryLike {
  readonly id: string
  readonly displayName: string
  readonly version: string
}

/** 人设加载器（**只读**子集）。 */
export interface PersonaLoaderLike {
  readonly available: boolean
  readonly reason?: string
  list(): readonly PersonaSummaryLike[]
  get(id: string): PersonaDetailLike | undefined
  active(): PersonaDetailLike | undefined
  activeId(): string | undefined
  readText(id: string, relPath: string): string | undefined
}

/* ------------------------------------------------------------------ *
 * 维护纪律（改契约前必读）
 *
 * 1. **槽位映射只能用 `slots.ts` 里那张表。** 在别处再写一份「哪段是身份」
 *    就会出现「同一个包在两个地方切出不同的内核」，而两边都不报错。
 * 2. **`RelationVariant` 不许加「性格 / 语感 / 价值观」字段。** 加了就是第二份人格，
 *    而且五个变体会立刻长成五个人——这正是 master-plan §10 第 7 条要防的。
 * 3. **`kernel()` 必须缓存。** 它每次被调用都可能重新解包 20KB 的 zip；
 *    提示词组装是每轮都要走的路径（§8.2 反模式②）。缓存键含人设版本，
 *    换包即失效。
 * 4. **`compose()` 的返回里不许出现「已裁剪」的痕迹。** 裁剪归 O-023；
 *    这里一旦「顺手砍掉超长的槽位」，O-023 的预算就不再是唯一口径。
 * ------------------------------------------------------------------ */
