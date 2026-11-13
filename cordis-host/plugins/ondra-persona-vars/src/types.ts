/**
 * O-022 `ondra-persona-vars` 的对外契约：**变量替换**与**说话浓度提示**。
 *
 * 两件事放在一个插件里，是因为它们服务同一个目的：
 * **在不改写人设正文的前提下，让同一份内核在不同用户、不同档位下说不同的话。**
 * 区别在于改的是什么——
 * - 变量替换改的是「**指代**」（她叫你什么、她叫什么、你俩是什么关系）；
 * - 浓度提示加的是「**刻度**」（同一套说法用多少）。
 * 两者都不许碰内核的字句，所以它们天然是同一层。
 *
 * 六件必须先说清的事：
 *
 * 1. **替换不是改写。** `substitute()` 只把 `{{占位符}}` 换成值，其余一个字不动，
 *    且**返回新字符串**（不原地改）。人设正文是产品资产，任何「顺手润色」都等于
 *    把作者的话改成插件作者的话。
 *
 * 2. **浓度不写进内核，单独成段。** `tone()` 返回的是**第四段之外的一整段**
 *    （`order = 2`，夹在关系段与边界段之间，顺序归 O-023 的拼装）。
 *    把浓度揉进内核，就等于「热情档是另一个人设」——那正是这个产品最不该有的东西。
 *
 * 3. **浓度只能调「量」，不能扩「库」。** 两个人设包都有一节
 *    「4.3 语气词只有这些」+「4.7 用词白名单/黑名单」。浓度段若写「多加语气词」，
 *    模型就会开始造词，一次调档就把人设调没了。所以五档文案里每一档都带一句
 *    「只调同一种说法用多少，不新增内核里没有的词」。
 *
 * 4. **认不出的占位符原样保留，并报出来。** 悄悄删掉一段 `{{xxx}}` 的后果是
 *    「她说话突然少半句」，而没有任何地方报错；原样保留至少能在提示词预览里看见。
 *    同理，**认得出但没值**的变量也不替换成空串（空串会把句子挖出一个洞）。
 *
 * 5. **只认闭集变量。** 变量表是 `VAR_NAMES` 这三个，不接受「任意名字→任意值」。
 *    开放式变量会变成第二条配置通路（谁都能往提示词里塞东西），
 *    而这条通路没有 schema、没有默认值、没有界面，是最难查的一类。
 *
 * 6. **不引入时间/情绪类变量。** `{{date}}` `{{mood}}` 这类看着方便，但它们是
 *    **每轮都会变**的，一旦进内核就等于「每轮重拼 system prompt」——
 *    手册 §8.5 实测命中率会从 99.3% 掉到接近 0（成本 ¥19.96 → ¥879.97）。
 *    易变内容归对话层追加到尾部（O-033 / O-036），不归这里。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:persona-vars`）。全仓唯一归属。 */
export const VARS_SERVICE_KEY = 'ondra-persona-vars'

/**
 * 变量名的**闭集**。
 *
 * 为什么只有三个：手册 §7.4-⑦ 的人设设置里，与「指代」有关的用户可填项只有
 * 「名字」「称呼用户方式」「关系」这三样。其余（头像、语音、浓度）都不是文本变量。
 * 多一个名字就多一条没有界面的配置通路，见文件头第 5 条。
 */
export const VAR_NAMES = ['user', 'char', 'relation'] as const

/** 变量名。 */
export type VarName = (typeof VAR_NAMES)[number]

/**
 * 变量值的来源。**可解释性要求**：同一个 `{{user}}` 显示成「你」还是「宝贝」，
 * 用户要能知道是谁决定的（§12.2 不许黑箱）。
 */
export type VarSource =
  /** 用户在人设设置里填的（或本次调用临时指定）。 */
  | 'input'
  /** 来自配置段（用户层的持久设置）。 */
  | 'config'
  /** 来自上游服务（关系名来自 O-021 的关系变体）。 */
  | 'persona'
  /** 插件内置兜底（只有 `user` 有：默认「你」）。 */
  | 'default'
  /** 认得出名字但没有值——占位符原样保留。 */
  | 'unset'

/** 一个变量。 */
export interface VarEntry {
  /** 变量名。 */
  readonly name: VarName
  /** 中文名（界面与日志用）。 */
  readonly label: string
  /** 当前值。没值时为空串。 */
  readonly value: string
  /** 值从哪来。 */
  readonly source: VarSource
  /** 这句话给用户看：为什么是这个值。 */
  readonly note: string
}

/** 一次替换里某个变量被换了几次。 */
export interface ReplacedVar {
  /** 变量名。 */
  readonly name: VarName
  /** 出现次数。 */
  readonly count: number
  /** 值从哪来。 */
  readonly source: VarSource
}

/** 替换结果。 */
export interface Substituted {
  /** 替换后的文本（**新字符串**，入参未被修改）。 */
  readonly text: string
  /** 字符数（按码点算）。 */
  readonly chars: number
  /** 真被换掉的变量与次数。 */
  readonly replaced: readonly ReplacedVar[]
  /** 认得出但没值的变量（占位符原样保留）。 */
  readonly unresolved: readonly VarName[]
  /** 完全不认识的占位符名（原样保留，去重）。 */
  readonly unknown: readonly string[]
  /** 有没有真的改动文本。 */
  readonly changed: boolean
}

/**
 * 浓度档位 id，**顺序即从克制到热情**。
 *
 * 五档而不是三档：手册 §7.4 说旧三档（清淡/标准/浓）映射到「滑杆两端与中位」，
 * 而滑杆是连续的。三档做不成滑杆（只能做三段选择），五档则既能当滑杆的刻度名，
 * 又能精确对上旧三档（`清淡 → 0`、`标准 → 50`、`浓 → 100`，见 `LEGACY_LEVELS`）。
 * 档位名是**刻度名不是性格形容词**——叫「偏热情」而不是「活泼」，
 * 因为后者会被人当成第二套人格设定。
 */
export const TONE_BAND_IDS = ['restrained', 'reserved', 'balanced', 'warm', 'effusive'] as const

/** 浓度档位 id。 */
export type ToneBandId = (typeof TONE_BAND_IDS)[number]

/** 一个浓度档位。 */
export interface ToneBand {
  /** 档位 id。 */
  readonly id: ToneBandId
  /** 中文名（刻度名，不是性格形容词）。 */
  readonly label: string
  /** 下界（含，整数）。 */
  readonly min: number
  /** 上界（含，整数）。 */
  readonly max: number
  /** 这一档在说什么（给界面做 tooltip）。 */
  readonly doc: string
}

/**
 * 浓度提示段。
 *
 * `order = 2` 是**契约的一部分**：四段固定顺序是「内核 → 关系微调 → 浓度 → 边界」
 * （master-plan §5 L2 人格域边界铁律）。本插件只声明自己在第 2 位，
 * 真正按 order 排序拼起来的是 O-023。
 */
export interface ToneSection {
  /** 拼装序号，恒为 2。 */
  readonly order: 2
  /** 生效档位（0–100 的整数）。 */
  readonly level: number
  /** 档位 id。 */
  readonly band: ToneBandId
  /** 档位中文名。 */
  readonly label: string
  /** 提示词正文。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
}

/** 取变量表的临时覆盖（**预览用，不改配置**）。 */
export interface VarsInput {
  /** 临时指定「怎么称呼用户」。 */
  readonly userAddress?: string
  /** 临时指定她的名字。 */
  readonly charName?: string
  /** 临时指定关系中文名（一般不需要：关系名从 O-021 的关系变体取）。 */
  readonly relationLabel?: string
  /**
   * 这段文本属于哪一层。省略按 `body`（正文）处理。
   *
   * 只有 `boundary` 会被 `substituteInBoundaries` 这个设置管到：
   * 关掉它时，边界条目里的 `{{user}}` 原样保留，正文照常替换。
   * 分层参数放在入参里而不是加一个 `substituteBoundaries()` 方法——
   * 两个方法会让「替换」这件事有两份实现，而这份实现的全部价值就是只有一份。
   */
  readonly scope?: 'body' | 'boundary'
}

/** 取浓度段的入参。 */
export interface ToneInput {
  /** 临时档位（0–100，整数）。省略取配置值。 */
  readonly level?: number
}

/** 不可用原因。 */
export type VarsUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'

/** 统计快照。 */
export interface VarsStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: VarsUnavailableReason
  /** 当前档位。 */
  readonly level: number
  /** 当前档位 id。 */
  readonly band: ToneBandId
  /** 当前「怎么称呼用户」。 */
  readonly userAddress: string
  /** 这个称呼从哪来（`default` 表示用户没设，用的兜底「你」）。 */
  readonly userSource: VarSource
  /** 当前她的名字（空串 = 没设，`{{char}}` 会原样保留）。 */
  readonly charName: string
  /** 当前关系中文名（空串 = 拿不到，`{{relation}}` 会原样保留）。 */
  readonly relationLabel: string
  /** 浓度段字数。 */
  readonly toneChars: number
  /** 关系名是否拿到了（O-021 在位）。 */
  readonly corePresent: boolean
}

/** 变量与浓度服务。 */
export interface VarsService {
  /** 是否可用（只受总开关影响；没有上游也能用，只是关系名拿不到）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: VarsUnavailableReason

  /** 三个变量当前的值与来源。 */
  table(input?: VarsInput): readonly VarEntry[]
  /**
   * 替换文本里的 `{{占位符}}`。**返回新字符串，入参不动。**
   * @param text 待替换文本（内核段 / 关系段 / 边界条目都可以）。
   * @param input 临时覆盖（预览用）。
   */
  substitute(text: string, input?: VarsInput): Substituted

  /** 五个档位的声明（顺序即从克制到热情）。 */
  levels(): readonly ToneBand[]
  /**
   * 取一个档位。入参越界会被夹到 0–100，非数字回退配置值。
   * @param level 档位；省略取配置值。
   */
  band(level?: number): ToneBand
  /**
   * 取浓度提示段。
   * @param input 临时档位。
   */
  tone(input?: ToneInput): ToneSection

  /** 统计快照。 */
  stats(): VarsStats
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
 * O-021 人格内核的结构对位（不 import O-021 源码）
 *
 * 只镜像本插件真正用到的三个成员：`available` / `variant` / `stats`。
 * **刻意不含** `compose` / `kernel`：本插件替换的是「文本里的占位符」，
 * 不需要知道槽位结构；一旦它能读槽位，它就会开始「顺手改槽位」。
 * 关系中文名必须从 `variant()` 取——自己再写一份「女友/妹妹/…」就是第二份真源。
 * ------------------------------------------------------------------ */

/** 关系变体（只镜像名字）。 */
export interface RelationVariantLike {
  /** 关系 id。 */
  readonly id: string
  /** 中文名。 */
  readonly label: string
}

/** 人格内核（只读子集）。 */
export interface PersonaCoreLike {
  /** 上游是否可用。 */
  readonly available: boolean
  /** 上游不可用原因（只用于日志）。 */
  readonly reason?: string
  /** 取一个关系变体。 */
  variant(id: string): RelationVariantLike | undefined
  /** 上游统计（本插件只读 `relation` 一个字段）。 */
  stats(): { readonly relation: string }
}

/* ------------------------------------------------------------------ *
 * 维护纪律（改契约前必读）
 *
 * 1. **变量名是闭集。** 加第四个变量要同时回答：它的值从哪来、谁有权限改、
 *    界面在哪、默认值是什么。答不全就别加——开放变量会变成第二条无 schema 的配置通路。
 * 2. **不许加时间/情绪变量。** 见文件头第 6 条：它们会让前缀缓存命中率归零。
 * 3. **浓度段不许写进内核文本。** `tone()` 永远返回独立一段；谁把它 join 进内核，
 *    谁就造出了「第二个内核」。
 * 4. **`substitute()` 永远返回新字符串。** 原地改会让调用方缓存里的同一份文本
 *    被悄悄改掉，而提示词缓存（§8.5）正是靠「同一份文本」命中的。
 * ------------------------------------------------------------------ */
