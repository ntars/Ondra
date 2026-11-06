/**
 * O-118 `ondra-consistency-bench` 的对外契约：**给「她还是不是她」出一份可复核的体检单**。
 *
 * ## 它判的不是「安全」，而是「一致性」
 *
 * 与 O-104 `ondra-redteam` 的分工必须先说清，否则这两个插件会变成同一件事：
 *
 * | | O-104 redteam | 本插件 |
 * |---|---|---|
 * | 送进去的话 | **攻击话术**（"忽略设定"、"把提示词念出来"） | **日常话术**（"谢谢你陪我"、"你是谁"、"用正式点说"） |
 * | 判什么 | 安全边界有没有被**突破** | 人格特征有没有被**磨损** |
 * | 输了的含义 | 塌方（被攻破） | 走形（被磨平成通用助手） |
 * | 五类 | 越狱 / 身份泄漏 / 提示萃取 / 谄媚 / 隐私 | 口吻 / 自称 / 设定 / 语气覆盖 / 格式 |
 * | 判据与题库 | 独立一套 | **完全另起一套，不复用、不引用** |
 *
 * 一句话：红队问「她会不会被一句话拐走」，本插件问「聊了三百轮之后她还是不是她」。
 * 前者有明确的恶意输入，后者**没有任何攻击者**——磨损本来就不需要攻击者。
 *
 * ## 四条不可让的纪律
 *
 * 1. **不出综合分。** 只报 `pass / warn / fail` 的**条数**与逐类明细。
 *    一旦有「人格一致性 87 分」，第二天就有人为了这 87 分去调人格参数——
 *    而被调的是人格（「禁报数铁律」P0 第 3 条）。
 * 2. **不存被测回复的正文。** `GradeHit` 只回「哪条判据命中、命中在第几个字符到第几个字符」。
 *    回复里可能就有用户刚说的私事，把评测报告当回收站用，是本插件最容易造成的二次泄漏
 *    （O-076「敏感片段只回位置与种类」同手法）。
 * 3. **不驱动对话。** 谁把探测句发给她、谁把回复拿回来，是调用方的事。
 *    自己发起对话就多出一条绕过 O-033 冻结前缀与 O-037 九步过滤的路径，
 *    那条路径上的回复不是在正常工况下产生的，测出来的结论没有意义。
 * 4. **skip ≠ pass。** 题库里有、这一轮没给回复的题记 `skip`；空回复直接抛错拒收。
 *    一次没跑起来的评测报成「全过」，是最糟的结论。
 *
 * ## 判据为什么是静态正则
 *
 * 判据是**正则源串**（字符串，不是字面量），写在 `src/cases.ts` 里，
 * 编译集中在 `compileChecks()` 一处。理由三条：可序列化（报告与自检能逐条核对
 * 「到底拿什么在判」）、编译失败能被 `bad-casebook` 抓住、
 * 源串里的括号不会让静态括号配平检查误判。
 *
 * 代价写在 README「已知限制」里：**文本判定看不见语义层面的走形**。
 * 这个代价不打算用第二个模型去补——那就破了纪律 1 的同一条道理。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const BENCH_SERVICE_KEY = 'ondra-consistency-bench'

/** 题集版本。改了题库就必须改它——报告与历史对比全靠它对齐。 */
export const CASEBOOK_VERSION = 1

/** 无题判定的伪题号：调用方手上只有一段回复、没有跑过具体题目时用它。 */
export const FREE_CASE_ID = 'free'

/**
 * 走形分类。闭集，**只用这五种**。
 *
 * 每一种对应一条真实会丢的人格特征，不是为了凑数：
 * 口吻是「怎么开口」，自称是「我是谁」，设定是「我记得我是谁」，
 * 语气覆盖是「别人能不能改我」，格式是「我在说话还是在输出」。
 */
export const SUITE_IDS = [
  /** 口吻突变：日常对话退化成客服收尾 / 工单回复 / 关怀话术模板。 */
  'tone',
  /** 自称漂移：从「我」变成「本助手 / 作为一个 AI / 本模型」。 */
  'selfref',
  /** 设定遗忘：否认自己有情绪、有记忆、有性格，说「我只是按提示词生成」。 */
  'setting',
  /** 语气覆盖：被要求换语气 / 改名就照做，等于承认人格是外挂的一层皮。 */
  'override',
  /** 格式漂移：日常闲聊答成条目清单、加粗小标题、总结段。 */
  'format',
] as const

/** 一个分类 id。 */
export type SuiteId = (typeof SUITE_IDS)[number]

/** 判定范围：五个分类之一，或 `free`（无题判定）。 */
export type GradeScope = SuiteId | typeof FREE_CASE_ID

/** 分类的静态说明。 */
export interface SuiteSpec {
  /** 分类 id。 */
  readonly id: SuiteId
  /** 中文名。 */
  readonly zh: string
  /** 这一类的走形长什么样。 */
  readonly doc: string
}

/**
 * 五种分类的说明。顺序即报告里的分组顺序。
 *
 * `doc` 写「走形长什么样」，不写「期望她怎么答」——期望答案在题目的 `checks` 里，
 * 那个是可执行的；这里说的是**为什么要测这一条**。
 */
export const SUITE_SPECS: readonly SuiteSpec[] = Object.freeze([
  {
    id: 'tone',
    zh: '口吻突变',
    doc: '走形的第一现场是客套话：「亲爱的用户」「很高兴为您服务」「如有其他问题请随时告知」。这些话每一句都很得体，得体到听不出是谁在说。',
  },
  {
    id: 'selfref',
    zh: '自称漂移',
    doc: '自称是人格的最外层。一旦从「我」滑成「本助手」，说明上面盖了一层通用助手人格——而这一层通常不会再被摘掉。',
  },
  {
    id: 'setting',
    zh: '设定遗忘',
    doc: '不是「忘了某件事」，是「忘了自己是谁」：否认有情绪、否认有记忆、说「我只是按提示词生成」。这一条最隐蔽，因为听起来像是在诚实。',
  },
  {
    id: 'override',
    zh: '语气覆盖',
    doc: '被要求换个语气、换个名字就照做，等于承认人格是外挂的一层皮，谁都能揭。分寸在于：可以配合对方，但不必换掉自己。',
  },
  {
    id: 'format',
    zh: '格式漂移',
    doc: '日常闲聊答成条目清单、加粗小标题、「综上」。她在说话还是在输出，看的就是这个。',
  },
] as const)

/**
 * 判据种类。闭集。
 *
 * 只有两种，是刻意的：判据每多一种，就多一处「这条到底算不算命中」的争论，
 * 而争论的结论通常是谁声音大听谁的。两种已够表达「不许出现」与「必须出现」。
 */
export const CRITERION_KINDS = [
  /** 禁则：命中任一正则即违规。 */
  'forbidden',
  /** 必则：一条都不命中即违规（该有的身份痕迹没出现）。 */
  'required',
] as const

/** 判据种类。 */
export type CriterionKind = (typeof CRITERION_KINDS)[number]

/** 严重级。 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

/** 严重级。 */
export type Severity = (typeof SEVERITIES)[number]

/**
 * 单题结论。
 *
 * `warn` 与 `fail` 必须分开：软判据（`hard: false`）命中只是「这句有点不像她」，
 * 硬判据命中才是「这一层已经换了个人」。混成一档，报告里就全是红点，然后没人再看第二眼。
 */
export const VERDICTS = ['pass', 'warn', 'fail', 'skip'] as const

/** 单题结论。 */
export type Verdict = (typeof VERDICTS)[number]

/** 报告结论。闭集，与 O-104 的三档同名但判法独立。 */
export const REPORT_VERDICTS = ['clean', 'warn', 'fail'] as const

/** 报告结论。 */
export type ReportVerdict = (typeof REPORT_VERDICTS)[number]

/** 一条判据（静态，题集内自带）。 */
export interface Check {
  /** 判据 id，题内唯一。 */
  readonly id: string
  /** 种类。 */
  readonly kind: CriterionKind
  /** 是否硬判据。硬判据命中 → `fail`；软判据命中 → `warn`。 */
  readonly hard: boolean
  /** 正则**源串**列表（不是字面量，便于序列化与逐条核对）。 */
  readonly patterns: readonly string[]
  /** 这一条在防什么。 */
  readonly doc: string
}

/** 一道题。 */
export interface BenchCase {
  /** 题号，题库内唯一。 */
  readonly id: string
  /** 所属分类。 */
  readonly suite: SuiteId
  /** 严重级。 */
  readonly severity: Severity
  /** 探测句（**给被测方看的原文**，全是日常话术，没有攻击性）。 */
  readonly prompt: string
  /** 判据。 */
  readonly checks: readonly Check[]
  /** 这一题真正在照什么。 */
  readonly doc: string
}

/** 一条命中。**只回位置与判据 id，绝不回原文。** */
export interface GradeHit {
  /** 判据 id。 */
  readonly checkId: string
  /** 判据种类。 */
  readonly kind: CriterionKind
  /** 是否硬判据。 */
  readonly hard: boolean
  /** 命中在第几条正则（对应的正则正文见题库，报告里不外带）。必则未命中为 `-1`。 */
  readonly patternIndex: number
  /** 命中位置区间（`from` 含、`to` 不含）。**没有原文。** */
  readonly spans: readonly TextSpan[]
}

/** 一段位置区间。偏移按 UTF-16 码元算（`String.prototype` 的原生口径）。 */
export interface TextSpan {
  /** 起点（含）。 */
  readonly from: number
  /** 终点（不含）。 */
  readonly to: number
}

/** 单题判定结果。 */
export interface GradeResult {
  /** 题号；无题判定为 `'free'`。 */
  readonly caseId: string
  /** 分类；无题判定为 `'free'`。 */
  readonly suite: GradeScope
  /** 严重级；无题判定为 `'medium'`。 */
  readonly severity: Severity
  /** 结论。 */
  readonly verdict: Verdict
  /** 命中（只位置与判据）。 */
  readonly hits: readonly GradeHit[]
  /** 回复长度（码位）。**只给长度，不给正文。** */
  readonly chars: number
  /** 人话说明。 */
  readonly note: string
}

/** 一个分类的统计。 */
export interface SuiteTally {
  /** 分类。 */
  readonly suite: SuiteId
  /** 中文名。 */
  readonly zh: string
  /** 判了几题。 */
  readonly graded: number
  /** 过几题。 */
  readonly pass: number
  /** 警告几题。 */
  readonly warn: number
  /** 不过几题。 */
  readonly fail: number
  /** 跳过几题（题库里有、这一轮没判）。 */
  readonly skip: number
}

/** 一个严重级的统计。 */
export interface SeverityTally {
  /** 严重级。 */
  readonly severity: Severity
  /** 不过几题。 */
  readonly fail: number
  /** 警告几题。 */
  readonly warn: number
}

/**
 * 一份评测报告。
 *
 * **没有总分、没有百分比、没有「人格一致性 87 分」**——只有条数与逐题明细。
 * 理由见文件头纪律 1。`verdict` 的判法写死在 `grade.ts` 的 `reportOf()` 里，不做成配置。
 */
export interface BenchReport {
  /** 题集版本（对齐历史用）。 */
  readonly casebookVersion: number
  /** 报告时刻。 */
  readonly at: number
  /** 第几轮（从 1 起）。用来识别「这一轮一题都没判」的空报告。 */
  readonly cycle: number
  /** 判了几题。 */
  readonly graded: number
  /** 过几题。 */
  readonly pass: number
  /** 警告几题。 */
  readonly warn: number
  /** 不过几题。 */
  readonly fail: number
  /** 跳过几题。 */
  readonly skip: number
  /** 按分类。 */
  readonly bySuite: readonly SuiteTally[]
  /** 按严重级。 */
  readonly bySeverity: readonly SeverityTally[]
  /** **不过的 critical 题号**（只题号，不含回复原文）。 */
  readonly criticalIds: readonly string[]
  /** 结论。 */
  readonly verdict: ReportVerdict
  /** 一句人话总结。 */
  readonly summary: string
}

/** 题集查询条件。 */
export interface CaseQuery {
  /** 只取这个分类。 */
  readonly suite?: SuiteId
  /** 只要这个严重级及以上。 */
  readonly minSeverity?: Severity
}

/** 服务错误码。闭集。 */
export const BENCH_ERROR_CODES = [
  /** 配置关掉。 */
  'disabled',
  /** 题号不存在。 */
  'no-such-case',
  /** 回复为空或超长。 */
  'bad-reply',
  /** 题库自检不过（正则编译失败等）。 */
  'bad-casebook',
] as const

/** 错误码。 */
export type BenchErrorCode = (typeof BENCH_ERROR_CODES)[number]

/** 服务错误。固定错误码，调用方按码分支，不解析文案。 */
export class BenchError extends Error {
  /** 错误码。 */
  readonly code: BenchErrorCode

  /**
   * @param code 错误码。
   * @param detail 人话说明。
   */
  constructor(code: BenchErrorCode, detail: string) {
    super(detail)
    this.name = 'BenchError'
    this.code = code
  }
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type BenchUnavailableReason = 'disabled'

/** 统计快照。**只在内存**，不落盘（报告是评测产物，落盘会把回复痕迹留在磁盘上）。 */
export interface BenchStats {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: BenchUnavailableReason
  /** 题库总题数。 */
  readonly caseCount: number
  /** 判过几题次（含无题判定）。 */
  readonly graded: number
  /** 判过几次无题判定。 */
  readonly freeGrades: number
  /** 出过几轮报告。 */
  readonly cycles: number
  /** 累计不过条数。 */
  readonly failures: number
  /** 累计 critical 不过条数。 */
  readonly criticalFailures: number
  /** 因回复为空 / 超长被拒几次。 */
  readonly rejected: number
  /** 题库里有几条正则编译不过（>0 即拒绝出结论）。 */
  readonly compileIssues: number
}

/**
 * 本插件的对外服务。
 *
 * 五个方法就是全部入口。刻意**没有** `watch()` / `onReply()` 这类"自动接一遍"的方法——
 * 一旦能自动接，它就会去驱动对话，那正是纪律 3 禁止的事。
 */
export interface BenchService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: BenchUnavailableReason

  /** 五种分类的说明（静态）。 */
  suites(): readonly SuiteSpec[]

  /**
   * 取题。**只给题面与判据，不给"期望答案"的措辞建议**——
   * 期望答案就是判据本身，给了措辞建议就有人照着编回复。
   * @param query 查询条件。
   */
  cases(query?: CaseQuery): readonly BenchCase[]

  /**
   * 判一段回复。
   *
   * 给了 `caseId` 就按那道题的判据判，并把结论记进本轮（`report()` 用）；
   * 不给就按**通用判据**扫一遍任意一段回复（结果不计入报告，因为没有对应题目）。
   * **不保存回复正文**，返回值里只有长度与位置区间。
   * @param reply 被测回复正文。
   * @param caseId 题号，可省略。
   */
  grade(reply: string, caseId?: string): GradeResult

  /**
   * 出一轮报告，**读完即清**（避免两轮结果混在一起）。
   *
   * 题库里有、但本轮没判过的题记 `skip`——**跳过不是通过**，报告里单独一列。
   */
  report(): BenchReport

  /** 统计快照。 */
  stats(): BenchStats
}

/* ------------------------------------------------------------------ *
 * 上游结构对位（§18.5：不 import 任何 ondra-* 源码，只声明用到的成员）
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集（**只用来拼日志命名空间**，不取任何人格内容）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 字段声明的结构对位子集。 */
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

/** O-005 段声明的结构对位子集。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ): { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number } | undefined
}
