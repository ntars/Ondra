/**
 * O-024 `ondra-worldbook` 的对外契约。
 *
 * 定位：**「这个世界怎么运转」的唯一预算口**。上层给它一批候选条目 id，
 * 它按六层硬分桶把条目装进 token 预算，**装不下的整条丢**，返回可直接进提示词的文本。
 *
 * 四件必须先说清的事：
 *
 * 1. **六层是「预算桶」，不是「语义分类」。**
 *    手册 §1.4 / §2.6 只给了六层的**预算数字**（L1 350 / L2 180 / L3 100 / L4 500 /
 *    L5 200 / L6 150），**一个字都没说每层叫什么**。本插件因此只认 `l1…l6` 六个桶：
 *    层义由世界书的作者在条目里声明，插件**不猜**「L1 一定是世界观」。
 *    猜错一次的代价是：作者按别家的习惯归了层，条目全部挤进一个桶，
 *    然后被「撞限整条丢」静默丢干净——而日志里只有一行「预算不足」。
 *    这条判定登记待裁决；裁决后**只改 `layers.ts` 的 `LAYER_LABELS` 一处**（标签是数据）。
 *
 * 2. **总预算 1600 与六层之和 1480 不相等。**
 *    350+180+100+500+200+150 = **1480**，而手册与台账都写「总 1600 token」。
 *    两个数都是原文，都不是笔误能解释的：一个是总量上限，一个是分桶配额。
 *    本插件**两个都保留、都报出来**（`totalTokens` / `allocatedTokens` / `slackTokens`），
 *    既不擅自把 1600 改成 1480，也不把 120 的余量私自挪给某一层。
 *    挪用会让「层预算」这件事失去意义：谁都能说自己该多分一点。
 *
 * 3. **撞限整条丢，与人格段的「跳过继续试」刻意不同。**
 *    手册 §2.6 对记忆注入写的是「装不下跳过这条、继续试下一条」；
 *    对世界书写的是「撞限**整条丢弃**」。两条是两套机制，不能揉。
 *    默认 `fitPolicy: 'stop'`——一层里第一条装不下，这一层后面的就此打住，
 *    而不是"捡小的塞"：世界书条目是有先后依赖的设定（先有势力再有冲突），
 *    捡小的塞会拼出一份「设定互相打架」的世界，而它看起来完全正常。
 *    想要「跳过继续试」的场合（例如条目彼此独立）把 `fitPolicy` 调成 `'skip'` 即可。
 *
 * 4. **常驻段进冻结前缀，且排序绝不随命中次数浮动。**
 *    手册 §8.5 的实测是「稳」比「准」值钱：会话内冻结前缀，命中率 99.3–99.6%，
 *    成本 ¥879.97 → ¥19.96。所以常驻条目按 `priority` + 注册序号排序，
 *    **不按命中次数、不按最近使用**——按命中排会让同一会话里前缀每轮都变，
 *    缓存命中率直接归零，而现象只是「账单变贵」，没人会想到是排序。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:worldbook`）。全仓唯一归属。 */
export const WORLDBOOK_SERVICE_KEY = 'ondra-worldbook'

/**
 * 六个预算桶的 id，**顺序即拼装顺序**。
 *
 * 顺序不是"重要性排序"，而是「读者先知道什么、后知道什么」：
 * 先给世界的底（l1），再给具体的地方（l2）、人（l3）、发生过的事（l4）、
 * 不能做的事（l5），最后给语域与称呼这类"怎么说"（l6）。
 * 这套先后依据的是世界书作者普遍的书写顺序，**不是手册给的分类**（见文件头第 1 条）。
 */
export const LAYER_IDS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] as const

/** 预算桶 id。 */
export type LayerId = (typeof LAYER_IDS)[number]

/**
 * 六层预算（token），**逐字来自手册 §1.4 / §2.6**。
 *
 * 这里的数字是**真源**：`settings.ts` 不复制一份、`cordis.patch.yml` 也不写。
 * 要改预算只能改这里一处，否则「界面显示 350、实际 500」这种错会静默存在。
 */
export const LAYER_BUDGETS: Readonly<Record<LayerId, number>> = Object.freeze({
  l1: 350,
  l2: 180,
  l3: 100,
  l4: 500,
  l5: 200,
  l6: 150,
})

/** 手册写的总预算（token）。 */
export const TOTAL_TOKENS = 1600

/** 六层预算之和。与 `TOTAL_TOKENS` 的差额见文件头第 2 条。 */
export const ALLOCATED_TOKENS = 1480

/** 一层的声明。 */
export interface LayerSpec {
  /** 层 id。 */
  readonly id: LayerId
  /** 拼装序号（0 起。**不是** 1 起：`l1` 在这里是下标 0）。 */
  readonly order: number
  /** 中文名。默认是中性名（「第一层」），语义由作者声明。 */
  readonly label: string
  /** 该层预算（token）。 */
  readonly budget: number
}

/** token 估算器：把一段文本折算成 token 数。 */
export type TokenMeter = (text: string) => number

/** 条目的来源。**为审计存在**：出问题时能说清「这条是谁放进来的」。 */
export type EntrySource = 'file' | 'runtime' | 'scene'

/** 注册一条条目时交进来的东西（只有这些是作者要写的）。 */
export interface EntryInput {
  /** 稳定 id（换机器、换会话都不能变）。 */
  readonly id: string
  /** 归哪一层。 */
  readonly layer: LayerId
  /** 标题（进提示词时当作条目名）。 */
  readonly title: string
  /** 正文（逐字进提示词，只折叠换行，不改写）。 */
  readonly text: string
  /**
   * 是否常驻（每轮都进，进冻结前缀）。
   *
   * 常驻条目**照样占它那一层的预算**——不占的话「总 1600」就是一句空话，
   * 而超预算的表现是「模型开始忘事」，没人查得到是世界书撑爆的。
   */
  readonly constant?: boolean
  /**
   * 互斥槽（可选）。`slot` 相同的条目在同一轮里互斥，取分高者。
   *
   * 只是把「谁跟谁不能同时出现」这件事**显式化**，本插件自己不做任何语义推断。
   */
  readonly slot?: string
  /** 层内排序键，大者先装。默认 0。 */
  readonly priority?: number
  /** 是否启用。默认 `true`（显式写 `false` 才关）。 */
  readonly enabled?: boolean
  /** 来源，默认 `runtime`。 */
  readonly source?: EntrySource
}

/** 注册后落库的条目（补上了序号与计量结果）。 */
export interface WorldbookEntry {
  readonly id: string
  readonly layer: LayerId
  readonly title: string
  readonly text: string
  readonly constant: boolean
  /** 没有声明时为空串（**不是** `undefined`：省掉调用方四种判空形态）。 */
  readonly slot: string
  readonly priority: number
  readonly enabled: boolean
  readonly source: EntrySource
  /** 注册序号：同一层里 `priority` 相同时的唯一稳定顺序。 */
  readonly seq: number
  /** 正文字符数（折叠换行后的长度）。 */
  readonly chars: number
  /** 估算 token 数（用注册当时的计量器算的，见 `stats().meter`）。 */
  readonly tokens: number
}

/** 一条条目被拒的原因码。**每一个都要能让人看懂并自己修**。 */
export type EntryProblemCode =
  /** 缺 id，或 id 里有空白 / 冒号 / 超过 64 个字符。 */
  | 'bad-id'
  /** 层不是 `l1…l6`。 */
  | 'bad-layer'
  /** 标题或正文是空的。 */
  | 'empty-text'
  /** 正文超过单条上限（`maxEntryTokens`），整条拒收而不是截断。 */
  | 'too-large'
  /** id 已被占用（同 id 不同内容会静默覆盖，故拒收并要求显式 `remove` 后再注册）。 */
  | 'duplicate'

/** 一条被拒的条目。 */
export interface EntryProblem {
  /** 原始 id（可能为空串）。 */
  readonly id: string
  /** 原因码。 */
  readonly code: EntryProblemCode
  /** 人话说明。 */
  readonly detail: string
}

/** 注册结果。 */
export interface RegisterResult {
  /** 真正入库的 id。 */
  readonly accepted: readonly string[]
  /** 被拒的条目。 */
  readonly rejected: readonly EntryProblem[]
}

/** 条目筛选条件（全部为可选，缺省即不筛）。 */
export interface EntryFilter {
  readonly layer?: LayerId
  readonly source?: EntrySource
  readonly constant?: boolean
  readonly enabled?: boolean
}

/** 打包时交进来的一个候选。 */
export interface PackCandidate {
  /** 条目 id。 */
  readonly id: string
  /** 相关度分数（由检索/触发方给）。缺省 0。 */
  readonly score?: number
  /** 递归深度（场景卡用；0 是直接命中）。缺省 0。 */
  readonly depth?: number
}

/** 打包请求。 */
export interface PackRequest {
  /** 候选条目（顺序无所谓，本插件自己排）。 */
  readonly candidates?: readonly PackCandidate[]
  /** 只装这一层的候选（可选；省略即全层）。 */
  readonly onlyLayer?: LayerId
  /** 覆盖某几层的预算（可选；**不覆盖**就不动，绝不把差额挪走）。 */
  readonly budgets?: Partial<Record<LayerId, number>>
  /** 段标题是否带「另有 N 条未展开」（默认跟配置 `annotateDropped`）。 */
  readonly annotateDropped?: boolean
}

/** 一条被丢掉的条目。 */
export interface DroppedEntry {
  readonly id: string
  /** 归层；**未登记的 id 没有层**（`unknown` 时省略），不要在这里编一个。 */
  readonly layer?: LayerId
  readonly title: string
  /** 估算 token 数（便于解释「为什么装不下」）。 */
  readonly tokens: number
  /** 丢的原因码。 */
  readonly code: DroppedCode
  /** 人话说明。 */
  readonly detail: string
}

/** 丢弃原因码。 */
export type DroppedCode =
  /** 该层预算不够。 */
  | 'over-budget'
  /** 候选里的 id 在本插件没有登记。 */
  | 'unknown'
  /** 条目被作者关掉了。 */
  | 'disabled'
  /** 互斥槽里输给了别人（只在这一层同时出现两条同槽时发生）。 */
  | 'slot-lost'
  /** 被 `onlyLayer` 排除在外。 */
  | 'layer-skipped'

/** 一层的用量。 */
export interface LayerUsage {
  readonly id: LayerId
  /** 该层预算（可能被请求覆盖过）。 */
  readonly budget: number
  /** 已用 token（**含常驻**：常驻照样占本层预算）。 */
  readonly used: number
  /** 其中常驻占了多少（已进冻结前缀，不重复渲染）。 */
  readonly constantTokens: number
  /** 装进去的条目 id（按拼装顺序，**不含常驻**）。 */
  readonly included: readonly string[]
  /** 这一层丢了几条。 */
  readonly dropped: number
}

/** 打包产物。 */
export interface WorldbookBlock {
  /** 可直接进提示词的文本（层标题 + 条目行）。未装任何条目时为空串。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
  /** 估算 token 数。 */
  readonly tokens: number
  /** 装进去的条目（按拼装顺序）。 */
  readonly included: readonly WorldbookEntry[]
  /** 被丢的条目（逐条带原因，不只是计数）。 */
  readonly dropped: readonly DroppedEntry[]
  /** 逐层用量。 */
  readonly perLayer: readonly LayerUsage[]
  /** 本次用的总预算（含六层之和与总量上限的较小者）。 */
  readonly budget: number
  /**
   * 是否超预算。
   *
   * 正常永远是 `false`——「撞限整条丢」保证了这点。
   * 只有一种情况会 `true`：某层的**常驻**条目自己就超了该层预算，
   * 此时仍然照装（常驻是作者明说「每轮都要在」的），但如实标记，让上层能看见。
   */
  readonly overBudget: boolean
  /** 文本指纹（djb2），用于确认「这一轮的前缀有没有变」。 */
  readonly digest: string
}

/** 常驻段（冻结前缀的候选）。 */
export interface ConstantBlock {
  /** 文本；没有常驻条目时为空串。 */
  readonly text: string
  readonly chars: number
  readonly tokens: number
  /** 按顺序的条目 id。 */
  readonly ids: readonly string[]
  readonly digest: string
}

/** 加载世界书文件时出的问题（不是异常，是报告）。 */
export type FileIssueCode =
  /** 文件不存在（**不算问题**：没配世界书是正常状态）。 */
  | 'no-file'
  /** 文件不是合法 JSON。 */
  | 'bad-json'
  /** 顶层结构不对（应为对象，`entries` 为数组）。 */
  | 'bad-shape'
  /** 无读取权限 / 磁盘错。 */
  | 'read-error'

/** 文件问题。 */
export interface FileIssue {
  readonly code: FileIssueCode
  readonly detail: string
}

/** 加载结果。 */
export interface LoadResult {
  /** 入库条数。 */
  readonly loaded: number
  /** 被拒的条目。 */
  readonly rejected: readonly EntryProblem[]
  /** 文件级问题。 */
  readonly issue: FileIssue | undefined
}

/** 不可用原因。 */
export type WorldbookUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 一条条目都没有（服务可用，但没什么可装）。 */
  | 'empty'

/** 统计快照。 */
export interface WorldbookStats {
  readonly available: boolean
  readonly reason?: WorldbookUnavailableReason
  /** 条目总数。 */
  readonly entries: number
  /** 启用的条目数。 */
  readonly enabled: number
  /** 常驻条目数。 */
  readonly constant: number
  /** 逐层条目数。 */
  readonly perLayer: Readonly<Record<LayerId, number>>
  /** 常驻段 token。 */
  readonly constantTokens: number
  /** 常驻段是否超出它各自那层的预算。 */
  readonly constantOverBudget: boolean
  /** 总预算（手册口径 1600）。 */
  readonly totalTokens: number
  /** 六层之和（1480）。 */
  readonly allocatedTokens: number
  /** 余量（1600 − 1480 = 120）。**不挪用**，只是报出来。 */
  readonly slackTokens: number
  /** 当前计量器的口径说明（给「为什么装得比想象少」一个可查的答案）。 */
  readonly meter: string
  /** 世界书文件路径（用户可见写法）；没配为 `undefined`。 */
  readonly file: string | undefined
  /** 注册版本号（每次增删都 +1，用于判断常驻段缓存是否失效）。 */
  readonly revision: number
}

/** 世界书服务。 */
export interface WorldbookService {
  /** 是否可用（`enable` 且至少有一条启用条目）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: WorldbookUnavailableReason

  /** 六层的声明（含标签与预算，顺序固定）。 */
  layers(): readonly LayerSpec[]
  /** 已登记条目（可筛）。 */
  entries(filter?: EntryFilter): readonly WorldbookEntry[]
  /**
   * 取一条。
   * @param id 条目 id。
   */
  entry(id: string): WorldbookEntry | undefined

  /**
   * 注册一批条目。**逐条判定，一条坏不连累其余**。
   * @param input 条目。
   */
  register(input: readonly EntryInput[]): RegisterResult
  /**
   * 删一条。
   * @param id 条目 id。
   * @returns 是否真的删掉了。
   */
  remove(id: string): boolean
  /**
   * 清空（可按来源）。
   * @param source 只清这个来源；省略清全部。
   * @returns 清掉的条数。
   */
  clear(source?: EntrySource): number

  /** 当前的 token 估算器。 */
  meter(): TokenMeter
  /**
   * 换一个 token 估算器（**唯一合法的替换口**，O-036 装真分词器时用它）。
   *
   * 换完会**重算全部条目的 token 数**——不重算就会出现「新计量器算候选、
   * 旧数字算预算」，装出来的量谁也说不清。
   * @param meter 新估算器；传 `undefined` 恢复默认。
   */
  setMeter(meter: TokenMeter | undefined): void
  /**
   * 用当前计量器量一段文本。
   * @param text 文本。
   */
  measure(text: string): number

  /** 常驻段（冻结前缀）。注册版本没变时走缓存。 */
  constantBlock(): ConstantBlock
  /**
   * 按六层预算打包。
   * @param request 请求。
   */
  pack(request?: PackRequest): WorldbookBlock
  /** 从世界书文件加载（幂等：同 id 已存在即视为已加载，不重复报错）。 */
  loadFromFile(): LoadResult

  /** 统计快照。 */
  stats(): WorldbookStats
}

/* ------------------------------------------------------------------ *
 * 与上游的结构对位（不 import 任何 ondra-* 源码）
 * ------------------------------------------------------------------ */

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-002 路径服务的结构对位子集（只用到拼路径与存在性判断）。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  exists(filePath: string): boolean
  /** 数据根的用户可见写法（日志里用，不暴露机器绝对路径）。 */
  readonly display: string
}

/** 日志门面（只用到三档）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-005 字段声明形状。 */
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

/** O-005 段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/* ------------------------------------------------------------------ *
 * 镜像维护纪律（给下一轮的人看）
 *
 * 1. `LAYER_IDS` / `LAYER_BUDGETS` 是**本插件专属**的真源，O-025 只按结构对位镜像，
 *    不 import。改这里必须同改 O-025 的 `LAYER_IDS` 镜像（两处都在文件头标了对应关系）。
 * 2. `WorldbookService` 只加不改：新增方法可以，改签名会让已发布的下游在运行期
 *    拿到 `undefined is not a function`，而静态检查看不出来。
 * 3. `EntryInput` 的字段名一旦发布就是契约。要加字段，先加可选字段。
 * ------------------------------------------------------------------ */
