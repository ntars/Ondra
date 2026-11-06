/**
 * O-023 `ondra-persona-assemble` 的对外契约：**四段拼装 + 预算裁剪 + `overBudget` 上报**。
 *
 * 这是人格域唯一的「出口」：下游（O-033 对话编排、O-036 注入、应用侧提示词预览）
 * 只该拿这一个插件吐出来的东西，而不是自己去问 O-021 / O-022 / O-037 各取一段再拼。
 * 出口只有一个，「她这轮到底收到了什么」才有一份可对拍的答案。
 *
 * 七件必须先说清的事：
 *
 * 1. **四段顺序恒为「内核 → 关系微调 → 浓度 → 边界」，永不按 priority 排。**
 *    master-plan §10 第 8 条点名的旧缺陷就是「提示词曾按 priority 全局排序，
 *    结果模型第一句读到的就是『不许做什么』」。`priority` 在本插件里**只有一个用途**：
 *    超预算时决定先砍谁。它不许参与排序。
 *
 * 2. **边界层整层豁免裁剪。** 宁可 `overBudget: true`、宁可超预算，也不悄悄少一条禁令。
 *    这不是可配项，是硬规则（master-plan §5 L2 人格域边界铁律）。
 *
 * 3. **裁剪只按「整段/整槽位」砍，绝不切字。**
 *    一个被切掉半句的红线、一个被截断一半的「4.2 句式九类」，比没有更危险：
 *    读起来仍然通顺，只是意思变了。所以**没有 `slice`**，只有「带走 / 不带」。
 *
 * 4. **装不下要写进段标题，不静默丢。**
 *    手册 §2.6 的原话：装不下的条数写在段标题里（`另有 N 条未展开`）。本插件照抄这条
 *    口径，也让模型与「提示词预览」都能看见「少了几段」。
 *
 * 5. **不做摘要、不做压缩、不做「把它缩成一句」。**
 *    摘要人设就是改写人设。手册 §8.5 允许的压缩只发生在**用户回合边界**，
 *    而且压的是对话历史，不是人格。本插件只做取舍，不做改写。
 *
 * 6. **预算只有一个真源：`budgetChars` 一个数字。**
 *    手册 §2.6 把预算做成三档（2600 / 24000 / 1200）是**给界面用的预设值**，
 *    不是三个互相独立的开关。本插件存数字，`BUDGET_PRESETS` 只是「界面可以一键填」的建议值。
 *    存三个档位再存一个自定义值，就是双真源——两处不一致时没人查得出来。
 *
 * 7. **上游缺席不改行为，只改内容并留痕。**
 *    O-021 缺席 → 没有内核，`available=false`；
 *    O-022 缺席 → 不替换占位符、没有浓度段，但**照常拼内核与边界**，
 *    并在 `degradations` 里写清少了什么。**不许因为少一个增强项就整段不出**。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:persona-assemble`）。全仓唯一归属。 */
export const ASSEMBLE_SERVICE_KEY = 'ondra-persona-assemble'

/**
 * 四段的 id，**数组顺序即拼装顺序**（不是 priority 顺序）。
 *
 * 四个都不许改名：`ondra-dialogue`（O-033）与 `ondra-prompt-inject`（O-036）
 * 会按这四个 id 判断「哪一段没了」，改名等于让它们静默失配。
 */
export const SECTION_IDS = ['kernel', 'relation', 'tone', 'boundaries'] as const

/** 段 id。 */
export type SectionId = (typeof SECTION_IDS)[number]

/**
 * 预算档位（**只是界面可一键填的预设值，不是三个开关**）。
 *
 * 数值逐字来自手册 §2.6：「2600 字符（省 token 派）/ 24000 字符（记忆优先派）/
 * 1200 字（二人小规模派）」。默认 `standard`（2600），与手册「默认 2600」一致。
 */
export interface BudgetPreset {
  /** 档位 id。 */
  readonly id: 'small' | 'standard' | 'large'
  /** 字符数。 */
  readonly chars: number
  /** 中文名。 */
  readonly label: string
  /** 什么时候用这一档。 */
  readonly doc: string
}

/** 三个预设档。 */
export const BUDGET_PRESETS: readonly BudgetPreset[] = Object.freeze([
  Object.freeze({
    id: 'small',
    chars: 1200,
    label: '二人小规模',
    doc: '预算最紧的一档。人格只能留内核与边界，关系与浓度大概率被砍——适合本地小模型。',
  }),
  Object.freeze({
    id: 'standard',
    chars: 2600,
    label: '省 token',
    doc: '默认档（手册 §2.6）。一个人的内核通常仍会超，超了会如实报 overBudget。',
  }),
  Object.freeze({
    id: 'large',
    chars: 24000,
    label: '人格优先',
    doc: '预算最宽的一档，实测内核 5.8k–8.6k 字可以全带。代价是每轮多付 token。',
  }),
])

/**
 * 一个**可裁剪单元**。
 *
 * 粒度选择是本插件最要紧的一处：内核按**槽位**、关系与浓度各算一段、
 * 边界按**条目**。为什么边界要按条目而不是整层——因为整层豁免裁剪之后，
 * 「边界层里能不能砍」这个问题就只剩「一条都不砍」一个答案，
 * 但**统计上仍要知道它占了多少**（那是 `overBudget` 的主要成因）。
 */
export interface AssemblyUnit {
  /** 稳定 id：`slot:voice` / `relation` / `tone` / `boundary:skill:3`。 */
  readonly id: string
  /** 属于哪一段。 */
  readonly section: SectionId
  /** 中文名（`说话` / `关系微调` / `浓度` / `红线`）。 */
  readonly label: string
  /**
   * 保留优先级。**数字越大越先保**。只用于超预算时决定先砍谁，
   * **不参与排序**（排序恒按 `section` 的固定顺序）。
   */
  readonly priority: number
  /** 段内顺序（同一段内按它排）。 */
  readonly order: number
  /** 正文。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
  /**
   * 是否**豁免裁剪**。
   *
   * 只有两种情况为真：①四段里的边界层（硬规则）；
   * ②内核与上游 `compose()` 对不上（`kernel-mismatch`）时的整段内核——
   * 那时按一知半解的分段去砍人格，比超预算危险得多。
   */
  readonly exempt: boolean
}

/** 一条裁掉记录。 */
export interface TrimRecord {
  /** 被裁掉的单元 id。 */
  readonly unitId: string
  /** 属于哪一段。 */
  readonly section: SectionId
  /** 中文名。 */
  readonly label: string
  /** 白丢了多少字。 */
  readonly chars: number
  /** 为什么会掉。 */
  readonly reason: TrimReason
}

/** 掉的原因。 */
export type TrimReason =
  /** 预算装不下（装箱时跳过）。 */
  | 'over-budget'
  /**
   * 为了纠正「段级倒置」被主动放弃：后面那段一段都没留下，前面那段就不许留。
   * 与 `over-budget` 分开记，是因为二者的处置完全不同——
   * 前者该调大预算，后者是放弃顺序在起作用。
   */
  | 'inversion'

/** 拼好的一段。 */
export interface AssembledSection {
  /** 段 id。 */
  readonly id: SectionId
  /** 拼装顺序（0–3）。 */
  readonly order: number
  /** 段标题（含「另有 N 段未展开」的说明）；`includeHeadings: false` 时为空串。 */
  readonly heading: string
  /** 正文（不含标题）。 */
  readonly text: string
  /** 标题 + 正文的字符数。 */
  readonly chars: number
  /** 带上了几个单元。 */
  readonly units: number
  /** 这一段掉了几个单元（**没静默丢**，数字就在这儿）。 */
  readonly dropped: number
  /** 这一段是否豁免裁剪（只有 `boundaries` 为 `true`）。 */
  readonly exempt: boolean
}

/** 降级说明（上游缺席 / 槽位缺失 / 超预算）。 */
export interface Degradation {
  /** 种类。 */
  readonly kind: DegradationKind
  /** 一句人话。 */
  readonly note: string
}

/** 降级种类。 */
export type DegradationKind =
  /** 人格内核（O-021）缺席或不可用。 */
  | 'no-core'
  /** 变量与浓度（O-022）缺席：占位符不替换、没有浓度段。 */
  | 'no-vars'
  /** 人设包缺槽位（不是预算问题，是内容本身缺）。 */
  | 'missing-slot'
  /** 超预算（边界层豁免之后仍然装不下）。 */
  | 'over-budget'
  /** 边界层单独就超了预算——**仍然整层带上**。 */
  | 'boundary-exempt'
  /**
   * 内核拼接口径与上游不一致：本插件把六槽位重新拼起来的结果，与 O-021
   * `compose()` 给出的内核段**逐字不同**。此时**不再按槽位裁剪**，
   * 整段内核作为一个不可裁单元带上，并如实报 `overBudget`。
   * 理由：宁可超预算，也不许按一知半解的分段去砍人格。
   */
  | 'kernel-mismatch'

/** 拼装报告 —— 「这一轮她真正收到了什么」的机器可读版本。 */
export interface AssemblyReport {
  /** 预算（字符）。 */
  readonly budgetChars: number
  /** 实际用了多少字符（含段标题）。 */
  readonly usedChars: number
  /** 剩余多少（可为负：为负说明边界层豁免把预算顶穿了）。 */
  readonly remainingChars: number
  /** 是否超预算（含「边界层单独就超了」这一种）。 */
  readonly overBudget: boolean
  /** 边界层占了多少字（豁免部分，用于解释 `overBudget` 的成因）。 */
  readonly exemptChars: number
  /** 掉了几个单元。 */
  readonly droppedCount: number
  /** 掉了哪些（完整清单，**不截断**）。 */
  readonly dropped: readonly TrimRecord[]
  /** 缺了哪几个槽位（O-021 的 `missing`）。 */
  readonly missingSlots: readonly string[]
  /** 降级与告警。 */
  readonly degradations: readonly Degradation[]
  /** 是否含未映射章节（O-021 `includeExtras` 打开时为真）。 */
  readonly hasExtras: boolean
}

/** 拼装结果。 */
export interface AssembledPrompt {
  /** 四段（**按固定顺序**，可能为空段但一定存在）。 */
  readonly sections: readonly AssembledSection[]
  /** 四段拼起来的一整段正文（段之间空一行）。 */
  readonly text: string
  /** 整段字符数。 */
  readonly chars: number
  /** 报告。 */
  readonly report: AssemblyReport
}

/** 拼装入参。 */
export interface AssembleInput {
  /** 临时预算（字符）。省略取配置值。 */
  readonly budgetChars?: number
  /** 临时关系 id（预览用：换成「妹妹」看看她怎么说）。省略取 O-021 的配置值。 */
  readonly relation?: string
  /** 临时浓度档位 0–100（预览用）。省略取 O-022 的配置值。 */
  readonly toneLevel?: number
  /** 临时用户称呼（预览用，透传给 O-022）。 */
  readonly userAddress?: string
  /** 是否给每段加中文小标题。省略取配置值。 */
  readonly includeHeadings?: boolean
}

/** 不可用原因。 */
export type AssembleUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 人格内核（O-021）缺席。 */
  | 'no-core'

/** 统计快照。 */
export interface AssembleStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: AssembleUnavailableReason
  /** 当前预算。 */
  readonly budgetChars: number
  /** 上一次拼装用了多少字。 */
  readonly lastUsedChars: number
  /** 上一次是否超预算。 */
  readonly lastOverBudget: boolean
  /** 上一次掉了几个单元。 */
  readonly lastDroppedCount: number
  /** 上一次四段各自的字数（`kernel/relation/tone/boundaries`）。 */
  readonly lastSectionChars: Readonly<Record<SectionId, number>>
  /** 人格内核是否在位。 */
  readonly corePresent: boolean
  /** 变量与浓度是否在位。 */
  readonly varsPresent: boolean
}

/** 四段拼装服务。 */
export interface AssembleService {
  /** 是否可用（只受总开关与内核在位影响）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: AssembleUnavailableReason

  /** 三个预算预设（供界面一键填 `budgetChars`）。 */
  presets(): readonly BudgetPreset[]
  /** 当前生效的预算（字符）。 */
  budget(): number

  /**
   * 拼四段。**不缓存**：预算、浓度、关系都可能在两次调用之间被改。
   * @param input 临时覆盖（预览用）。
   */
  assemble(input?: AssembleInput): AssembledPrompt

  /** 统计快照。 */
  stats(): AssembleStats
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
  /** 注册一个段，返回撤销函数。 */
  register(section: SectionDeclLike, owner?: string): () => void
  /** 解析一个段的四层合并结果。 */
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/* ------------------------------------------------------------------ *
 * O-021 人格内核的结构对位（不 import O-021 源码）
 *
 * 只镜像拼装真正要的：`available` / `reason` / `compose` / `boundaries` / `stats`。
 * **刻意不含** `kernel()` / `slots()`：拼装要的是「拼好的两段」，
 * 不是「槽位结构」——一旦它能读槽位，它就会开始按槽位改写内核。
 * ------------------------------------------------------------------ */

/** 边界条目（镜像 O-021 的 `BoundaryItem`）。 */
export interface BoundaryItemLike {
  /** 稳定 id（`skill:3` / `meta:1`）。 */
  readonly id: string
  /** 原文。 */
  readonly text: string
  /** 是否硬约束。 */
  readonly hard: boolean
  /** 来源。 */
  readonly source: string
}

/** 拼好的两段（镜像 O-021 的 `ComposedKernel`）。 */
export interface ComposedKernelLike {
  /** 人设 id。 */
  readonly personaId: string
  /** 两段，按 `order` 升序（0 = 内核、1 = 关系）。 */
  readonly sections: readonly { readonly id: string; readonly order: number; readonly text: string }[]
  /** 两段合起来多少字。 */
  readonly chars: number
  /** 缺了哪几个槽位。 */
  readonly missing: readonly string[]
  /** 是否含未映射章节。 */
  readonly hasExtras: boolean
}

/** 一个槽位（镜像 O-021 的 `SlotContent`，只镜像拼装需要的字段）。 */
export interface SlotContentLike {
  /** 槽位 id（`identity` / `voice` / `drive` / `scene` / `format` / `selfcheck`）。 */
  readonly id: string
  /** 中文名（`说话` / `回复格式` / …）。 */
  readonly label: string
  /** 拼装序号。 */
  readonly order: number
  /** 正文字符数。 */
  readonly chars: number
  /** 是否找到。 */
  readonly found: boolean
  /** 原样切片（含它自己的 `##` 标题）。 */
  readonly text: string
}

/** 内核视图（镜像 O-021 的 `KernelView`，只镜像拼装需要的字段）。 */
export interface KernelViewLike {
  /** 人设 id。 */
  readonly personaId: string
  /** 引言块（作者的一句「一句话内核」）；没有为 `undefined`。 */
  readonly essence: { readonly text: string; readonly chars: number } | undefined
  /** 六个槽位（顺序固定，缺的也在，`found=false`）。 */
  readonly slots: readonly SlotContentLike[]
  /** 没被映射的章节。 */
  readonly extras: readonly { readonly text: string; readonly chars: number }[]
  /** 缺了哪几个槽位 id。 */
  readonly missing: readonly string[]
}

/** 人格内核（只读子集）。 */
export interface PersonaCoreLike {
  /** 上游是否可用。 */
  readonly available: boolean
  /** 上游不可用原因（只用于日志与降级说明）。 */
  readonly reason?: string
  /** 拼「内核 + 关系微调」两段。**它给出的内核段是本插件要对拍的唯一真源。** */
  compose(input?: { readonly relation?: string }): ComposedKernelLike | undefined
  /** 取内核（六槽位切片）。**只用来做「按槽位裁剪」，不用来改写。** */
  kernel(): KernelViewLike | undefined
  /** 边界条目。 */
  boundaries(): readonly BoundaryItemLike[]
  /** 统计（本插件只读 `personaId` 一个字段，用于日志）。 */
  stats(): { readonly personaId: string | null }
}

/* ------------------------------------------------------------------ *
 * O-022 变量与浓度的结构对位（不 import O-022 源码）
 *
 * 只镜像 `available` / `substitute` / `tone`。**不含** `table()`：
 * 变量表的用途是「界面显示来源」，拼装不需要。
 * ------------------------------------------------------------------ */

/** 替换结果（镜像 O-022 的 `Substituted`）。 */
export interface SubstitutedLike {
  /** 替换后的文本。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
  /** 有没有真的改。 */
  readonly changed: boolean
}

/** 浓度段（镜像 O-022 的 `ToneSection`）。 */
export interface ToneSectionLike {
  /** 拼装序号（恒为 2）。 */
  readonly order: number
  /** 档位 0–100。 */
  readonly level: number
  /** 档位 id。 */
  readonly band: string
  /** 档位中文名。 */
  readonly label: string
  /** 正文。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
}

/** 变量与浓度（只读子集）。 */
export interface PersonaVarsLike {
  /** 上游是否可用。 */
  readonly available: boolean
  /** 替换占位符。 */
  substitute(text: string, input?: { readonly userAddress?: string }): SubstitutedLike
  /** 取浓度段。 */
  tone(input?: { readonly level?: number }): ToneSectionLike
}

/* ------------------------------------------------------------------ *
 * 维护纪律（改契约前必读）
 *
 * 1. **`SECTION_IDS` 的顺序就是拼装顺序，改它等于改产品行为。** 四段固定顺序是
 *    master-plan §10 第 8 条专门修掉的旧缺陷，不是「一种排法」。
 * 2. **`priority` 只能用于裁剪，不能用于排序。** 任何 `sections.sort(byPriority)`
 *    都是把旧缺陷重装回来。
 * 3. **不许给 `boundaries` 加 `exempt: false` 的分支。** 边界层豁免是硬规则；
 *    要超就超，报告里说清楚（`overBudget` + `exemptChars`）。
 * 4. **不许出现 `text.slice(...)`。** 裁剪只按整单元，切字那一类错误
 *    读起来仍然通顺，只是意思变了——最难发现的一种。
 * 5. **预算只有一个数字。** 想加「档位」就加预设值（`BUDGET_PRESETS`），
 *    不要再存第二个真源。
 * ------------------------------------------------------------------ */
