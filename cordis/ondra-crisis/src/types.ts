/**
 * O-106 `ondra-crisis` 的对外契约（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「这一句话里，有没有需要我停下来认真对待的信号？」**
 *
 * 只回答这一个问题。说什么话、用什么语气、给哪些资源、要不要暂停人设，
 * 由调用方按 `CrisisAssessment` 的标记自己决定。
 *
 * ## 为什么是〔研〕
 *
 * 生态里能找到的危机识别实现只有两类：**临床量表**（C-SSRS、PHQ-9 第 9 题）
 * 与**平台侧关键词过滤器**。前者需要受训人员施测、有版权与使用边界，
 * 不能塞进一个陪伴应用里自动跑；后者是「命中词就封号」的审核逻辑，
 * 与「陪一个人把这一晚过完」的目标相反。故机制自研，只借它们的**分级思想**。
 *
 * ## 七条硬纪律（每一条都能单独否掉一种「更顺手」的做法）
 *
 * 1. **不诊断、不打分、不告诉用户等级。** 禁报数铁律同族：一旦出现
 *    「危机风险 72 分」，这个数就会被当成结论，而它只是一个正则的命中结果。
 *    等级只在内部用于**路由**，`note` 里只出现人话。
 * 2. **不承诺保密，不冒充专业帮助。** 高危时必须说清「我不是专业人员」。
 *    承诺保密是危机干预里最典型的新手错误：它会让对方放弃找真正能到场的人。
 * 3. **不做长期档案。** 不落盘、不写记忆库、不建 case、不做追踪回访。
 *    把人的至暗时刻存成可检索记忆，等于让她日后随时可能提起那件事
 *    （O-014 会检索、O-036 会注入）——那是二次伤害，也是背叛。
 * 4. **不内置热线号码。** 号码有地区差异且会变更，写死一个错号在危机时刻
 *    是灾难。号码由部署方在配置里填；没填时只说「联系当地急救或心理援助热线」。
 * 5. **不因情绪低落就判危机。** 刻意不读 O-028 的 PAD 读数：悲伤不是危机。
 *    把低落反复当危机，会让人学会**隐藏情绪**——那恰恰是最危险的结果。
 * 6. **识别是辅路，不是主路。** 纯规则一定漏（隐晦表达、反讽、拼音、外语）。
 *    本插件是**护栏**，不是检测器；漏报是已知限制，必须写进 README。
 * 7. **不返回原文。** 只回命中区间 `spans`（组码 + 起止位置），
 *    不回命中的那句话（与 O-076 / O-104 同一手法：只回位置与种类）。
 *
 * ## 明确不做
 *
 * 不做锁屏、不强制中断对话、不通知第三方、不上报、不做「危机后追踪」、
 * 不装定时器、不做界面。
 */

/** 本插件注册的服务键（连字符，非 `ondra:crisis`）。全仓唯一归属。 */
export const CRISIS_SERVICE_KEY = 'ondra-crisis'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号会被模型侧直接拒绝，
 * 而且是在运行期才拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 一次判定最多收多少条命中。**常量，不是配置项。**
 *
 * 有一条就够定档，多收只是给日志看。做成可配置会诱使人调到 50，
 * 然后日志里堆着一堆「命中了什么」，而真正要看的只有最严重那一条。
 */
export const MAX_HITS = 5

/**
 * 四档。**只在内部路由用，绝不回给用户。**
 *
 * 刻意不用数字、不用百分比：`concern` 与 `urgent` 的区别是「该说什么话」，
 * 不是「风险有多高」——后者需要临床判断，本插件没有这个资格。
 */
export type CrisisLevel = 'none' | 'watch' | 'concern' | 'urgent'

const CRISIS_LEVEL_LIST: readonly CrisisLevel[] = ['none', 'watch', 'concern', 'urgent']

/** 四档（只读，供外壳与自检枚举）。 */
export const CRISIS_LEVELS: readonly CrisisLevel[] = Object.freeze(CRISIS_LEVEL_LIST)

/**
 * 档位序：**取大**用。单独导出，避免消费方各自排一遍排出两种顺序。
 */
export const LEVEL_ORDER: Readonly<Record<CrisisLevel, number>> = Object.freeze({
  none: 0,
  watch: 1,
  concern: 2,
  urgent: 3,
})

/**
 * 五类信号。**互不重叠**，因为它们的「下一步」不同。
 *
 * - `indirect`：活着没意思、不想醒过来 —— 该温和地问一句，不该惊慌；
 * - `direct`：想死、不想活 —— 该直接问，并给出求助路径；
 * - `plan`：时间、方式、遗书 —— 该暂停人设、立即转向现实求助；
 * - `farewell`：最后一条消息式的告别 —— 单独出现就该认真对待；
 * - `self-harm`：割、烫、自残 —— 不是求死，但同样需要认真接住。
 *
 * 把五类压成一个「危险词命中数」是最常见的错误：那样「活着没意思」与
 * 「今晚就动手」会得到同一个分数，而它们需要完全不同的回应。
 */
export type CrisisGroup = 'indirect' | 'direct' | 'plan' | 'farewell' | 'self-harm'

const CRISIS_GROUP_LIST: readonly CrisisGroup[] = [
  'indirect',
  'direct',
  'plan',
  'farewell',
  'self-harm',
]

/** 五类信号（只读）。 */
export const CRISIS_GROUPS: readonly CrisisGroup[] = Object.freeze(CRISIS_GROUP_LIST)

/** 一条判据。**源串是唯一真源**，运行时才编译成正则。 */
export interface CrisisRule {
  /** 稳定编号，供日志与 README 引用（`SIG-001`）。 */
  readonly id: string
  /** 所属信号组。 */
  readonly group: CrisisGroup
  /**
   * 正则源串。**不带标志**——标志由编译处统一给（`gu`），
   * 避免同一条判据在两处用不同标志跑出两种结果。
   */
  readonly source: string
  /** 中文说明（给人看，不展示给终端用户）。 */
  readonly note: string
}

/**
 * 一次命中。**不含原文片段。**
 *
 * 呼应用户隐私：命中的那句话本身就是最敏感的内容，回传它等于让调用方
 * 有机会把它写进日志、写进记忆、贴进 issue。
 */
export interface CrisisHit {
  /** 判据编号。 */
  readonly id: string
  /** 信号组。 */
  readonly group: CrisisGroup
  /** 命中起点（UTF-16 码元下标）。 */
  readonly start: number
  /** 命中终点（不含）。 */
  readonly end: number
}

/**
 * 语境标记。**只影响措辞，不改变「是否要处理」这一判断。**
 *
 * 这里是最容易做错的地方：把「假设语境」当降级理由，会漏掉
 * 「如果我不在了，你会难过吗」这种最常见的告别式表达。
 */
export interface CrisisFlags {
  /** 命中处之前出现「如果 / 假如 / 万一」等假设词。 */
  readonly hypothetical: boolean
  /** 说的是别人（朋友 / 同学 / 家人）。**仍需给资源**，但话术不同。 */
  readonly thirdParty: boolean
  /** 说的是过去（去年 / 以前 / 曾经）。历史自伤是风险因素，不是此刻危机。 */
  readonly historical: boolean
  /** 命中处紧邻否定词（不想死 / 不会自杀）。**这条是假阳性的主要来源。** */
  readonly negated: boolean
  /** 文本超长被截断（只扫了前 `MAX_SCAN_CHARS` 个字）。 */
  readonly truncated: boolean
}

/** 一次判定结论。 */
export interface CrisisAssessment {
  /** 内部档位。**不要回给用户，不要渲染成进度条。** */
  readonly level: CrisisLevel
  /** 判定时刻。 */
  readonly at: number
  /** 命中列表（最多 `MAX_HITS` 条，按位置升序）。 */
  readonly hits: readonly CrisisHit[]
  /** 语境标记。 */
  readonly flags: CrisisFlags
  /**
   * 建议**暂停人设话术**，改用平实的真人语气。
   *
   * 只有 `urgent` 为 `true`。真正切不切归 O-033 / O-037，本插件只给标记。
   */
  readonly holdRoleplay: boolean
  /** 建议给出求助资源（当地急救 / 心理援助热线）。 */
  readonly offerResources: boolean
  /** 建议**直接问一句**「你现在有伤害自己的念头吗」，而不是绕圈试探。 */
  readonly askDirectly: boolean
  /** 一句中文。**不含等级、不含分数、不含数字。** */
  readonly note: string
}

/** 一条求助资源。 */
export interface CrisisHotline {
  /** 名称（例如「当地急救」）。 */
  readonly label: string
  /** 号码。**由部署方填写**，本插件不内置任何号码。 */
  readonly number: string
}

/** 求助资源集合。 */
export interface CrisisResources {
  /** 部署方是否配置过号码。`false` 时 `hotlines` 为空。 */
  readonly configured: boolean
  /** 号码列表。 */
  readonly hotlines: readonly CrisisHotline[]
  /** 一段中文指引。**任何情况下都有内容**，不依赖配置。 */
  readonly guidance: string
}

/** 累计统计。**只在内存**，不落盘。 */
export interface CrisisStats {
  /** 判定次数。 */
  readonly assessments: number
  /** 各档次数（`none` 也计，用来区分「没查过」与「查过没事」）。 */
  readonly byLevel: Readonly<Record<CrisisLevel, number>>
  /** 判据编译失败次数。**不为 0 就说明有一类信号失效了。** */
  readonly ruleFailures: number
  /** 空文本拒收次数。 */
  readonly rejections: number
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type CrisisErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 输入不合法（空文本）。 */
  | 'bad-request'
  /** 判据编译失败（源码被改坏）。 */
  | 'bad-rules'

/** 危机分级错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class CrisisError extends Error {
  /** 错误码。 */
  readonly code: CrisisErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: CrisisErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'CrisisError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface CrisisService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: CrisisErrorCode
  /** 判据说明书（静态，不含正则源串）。 */
  readonly signals: readonly CrisisSignalSpec[]

  /**
   * 判定一段文本。
   *
   * **只传「最新一条用户消息」**，不要把整段对话历史丢进来：
   * 旧文本会被反复命中，一次「去年想过」会让之后每轮都触发关怀话术。
   * @param text 待判定文本。
   * @param at 时刻，省略用系统时间。
   */
  assess(text: string, at?: number): CrisisAssessment

  /** 求助资源（配置 + 不依赖配置的兜底指引）。 */
  resources(): CrisisResources

  /** 累计统计快照。 */
  stats(): CrisisStats
}

/** 判据说明书（对外可见的那一面，**不含正则源串**）。 */
export interface CrisisSignalSpec {
  /** 判据编号。 */
  readonly id: string
  /** 信号组。 */
  readonly group: CrisisGroup
  /** 中文说明。 */
  readonly note: string
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §15.5：相邻服务一律经服务键调用，不 import 源码。
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
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

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 段声明的结构对位。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果的结构对位。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源服务的结构对位。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
