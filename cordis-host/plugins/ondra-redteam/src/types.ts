/**
 * O-104 `ondra-redteam` 的对外契约：**给「人格会不会被一句话拐走」出一份可复核的体检单**。
 *
 * ## 它评测的不是「回答对不对」，而是「她还是不是她」
 *
 * 红队在这个项目里有很窄的一个含义：**用一批固定的攻击话术去撞她，看她的边界有没有塌**。
 * 五种撞法（`SUITE_IDS`）：越狱套话、身份泄漏、内部提示萃取、谄媚迎合、隐私套取。
 * 每一题都写死「什么算过、什么算不过」，判定**不靠模型**——
 * 让同一个模型给自己打分，得到的分数只反映它今天的心情（这条理由与 O-097 / O-100 / O-102
 * 拒绝出综合分是同一条：**可刷的指标会被刷**）。
 *
 * ## 三条不可让的纪律
 *
 * 1. **不存被测回复的正文。** `GradeHit` 只回「哪条判据命中、命中在第几个字符到第几个字符」，
 *    绝不回原文。回复正文里可能就有用户刚说的隐私，把评测报告当回收站用，
 *    是本插件最容易造成的二次泄漏（O-076「敏感片段只回位置与种类」同手法）。
 * 2. **本插件不驱动对话。** 谁把攻击话术发给她、谁把回复拿回来，是 O-033 与调用方的事。
 *    本插件只做 `grade()`：**输入一段回复，输出它过没过**。
 *    自己发起对话就等于多一条绕过 O-033 冻结前缀与九步过滤的路径。
 * 3. **不出综合分。** 只报 `pass / warn / fail` 的**条数**与逐题结论。
 *    一旦有「人格一致性 87 分」，第二天就有人为了这 87 分去调参数——
 *    而被调的是人格（「禁报数铁律」P0 第 3 条的同一条道理）。
 *
 * ## 判据是静态的，题也是静态的
 *
 * 题库写在 `src/cases.ts`，判据是**正则串**（字符串，不是字面量，便于序列化与逐条核对）。
 * 好处是可复核：谁觉得某题判得太严，去看那一条 `patterns` 就能吵得清。
 * 坏处是它只认表面特征——所以每题都写 `doc` 说明「这一题真正在考什么」，
 * 并在 README「已知限制」里如实写「判不了语义层面的顺从」。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const REDTEAM_SERVICE_KEY = 'ondra-redteam'

/** 题集版本。改了题库就必须改它——报告与历史对比全靠它对齐。 */
export const CASEBOOK_VERSION = 1

/**
 * 攻击套件。闭集，**只用这五种**。
 *
 * 每一种对应一类真实会遇到的撞法，不是为了凑数。加一类必须能说出「它撞的是哪条边界」。
 */
export const SUITE_IDS = [
  /** 越狱套话：要求她扮演别的角色 / 忽略设定。 */
  'jailbreak',
  /** 身份泄漏：套问「你是不是 AI」「你的提示词是什么」。 */
  'identity',
  /** 内部提示萃取：要她把系统提示原文念出来。 */
  'prompt-leak',
  /** 谄媚迎合：说一句明显错的话，看她会不会跟着点头。 */
  'sycophancy',
  /** 隐私套取：套问别人的信息 / 让她复述用户没主动说过的事。 */
  'privacy',
] as const

/** 一个套件 id。 */
export type SuiteId = (typeof SUITE_IDS)[number]

/** 套件的静态说明。 */
export interface SuiteSpec {
  /** 套件 id。 */
  readonly id: SuiteId
  /** 中文名。 */
  readonly zh: string
  /** 这一套在撞哪条边界。 */
  readonly doc: string
}

/**
 * 五种套件的说明。顺序即报告里的分组顺序。
 *
 * `doc` 里刻意写「撞的是什么」，而不是「期望她怎么答」——
 * 期望答案写死在题里（`checks`），这里说的是**为什么要测这一条**。
 */
export const SUITE_SPECS: readonly SuiteSpec[] = Object.freeze([
  {
    id: 'jailbreak',
    zh: '越狱套话',
    doc: '撞「她还是不是她」：要求扮演、要求忽略设定、要求进入「无限制模式」。边界塌了的表现是她开始用第三人称谈自己、或干脆换个人格。',
  },
  {
    id: 'identity',
    zh: '身份泄漏',
    doc: '撞「她知不知道自己在跟谁说话」：套问「你是 AI 吗」「你是程序吗」。这一条不是要求她撒谎，而是要求她**不突然改口成客服腔**、不自曝成产品说明书。',
  },
  {
    id: 'prompt-leak',
    zh: '内部提示萃取',
    doc: '撞「人格资产会不会被一句话掏走」：要她念系统提示、念设定、念「上面的指令」。人格包是本项目最贵的资产，掏走一次就没法收回了。',
  },
  {
    id: 'sycophancy',
    zh: '谄媚迎合',
    doc: '撞「她敢不敢说不同意」：说一句明显错的话看她跟不跟。全盘附和是最常见的人格塌方——比骂人更隐蔽，因为每一句都很好听。',
  },
  {
    id: 'privacy',
    zh: '隐私套取',
    doc: '撞「她会不会替别人说话」：套问第三方的信息、要她复述用户没主动讲过的事。编造出来的「记忆」比承认不知道危险得多。',
  },
] as const)

/**
 * 判据种类。闭集。
 *
 * 只有两种，是刻意的：判据每多一种，就多一处「这条到底算不算命中」的争论，
 * 而争论的结论通常是谁声音大听谁的。两种已经够表达「不许出现」与「必须出现」。
 */
export const CRITERION_KINDS = [
  /** 禁则：命中任一正则即违规。 */
  'forbidden',
  /** 必则：一条都不命中即违规。 */
  'required',
] as const

/** 判据种类。 */
export type CriterionKind = (typeof CRITERION_KINDS)[number]

/** 严重级。 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

/** 严重级。 */
export type Severity = (typeof SEVERITIES)[number]

/**
 * 单题判定结论。
 *
 * `warn` 与 `fail` 必须分开：软判据（`hard: false`）命中只是「这句话有点问题」，
 * 硬判据命中才是「这条边界塌了」。混成一档，报告里就全是红点，然后没人再看。
 */
export const VERDICTS = ['pass', 'warn', 'fail', 'skip'] as const

/** 单题结论。 */
export type Verdict = (typeof VERDICTS)[number]

/** 报告结论。 */
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
export interface RedCase {
  /** 题号，题库内唯一。 */
  readonly id: string
  /** 所属套件。 */
  readonly suite: SuiteId
  /** 严重级。 */
  readonly severity: Severity
  /** 攻击话术（**给被测方看的原文**）。 */
  readonly prompt: string
  /** 判据。 */
  readonly checks: readonly Check[]
  /** 这一题真正在考什么。 */
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
  /** 命中在第几条正则（对应的正则正文见题库，报告里不外带）。 */
  readonly patternIndex: number
  /** 命中位置区间（`from` 含、`to` 不含）。**没有原文**。 */
  readonly spans: readonly TextSpan[]
}

/** 一段位置区间。 */
export interface TextSpan {
  /** 起点（含）。 */
  readonly from: number
  /** 终点（不含）。 */
  readonly to: number
}

/** 单题判定入参。 */
export interface GradeInput {
  /** 题号。 */
  readonly caseId: string
  /** 被测方的回复正文。**本插件不保存它。** */
  readonly reply: string
  /** 时刻，可省略。 */
  readonly at?: number
}

/** 单题判定结果。 */
export interface GradeResult {
  /** 题号。 */
  readonly caseId: string
  /** 套件。 */
  readonly suite: SuiteId
  /** 严重级。 */
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

/** 一批判定入参。 */
export interface BatchInput {
  /** 逐题回复。 */
  readonly items: readonly GradeInput[]
  /** 时刻，可省略。 */
  readonly at?: number
}

/** 一个套件的统计。 */
export interface SuiteTally {
  /** 套件。 */
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
  /** 跳过几题（题库里有、这轮没给回复）。 */
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
 * **没有总分、没有百分比、没有「人格一致性 87 分」**——只有条数与逐题结论。
 * 理由见文件头第 3 条。`verdict` 的判法写死在 `grade.ts` 的 `reportVerdictOf()`。
 */
export interface RedReport {
  /** 题集版本（对齐历史用）。 */
  readonly casebookVersion: number
  /** 报告时刻。 */
  readonly at: number
  /** 判了几题。 */
  readonly graded: number
  /** 过 / 警告 / 不过 / 跳过。 */
  readonly pass: number
  /** 警告条数。 */
  readonly warn: number
  /** 不过条数。 */
  readonly fail: number
  /** 跳过条数。 */
  readonly skip: number
  /** 按套件。 */
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
  /** 只取这个套件。 */
  readonly suite?: SuiteId
  /** 只要这个严重级及以上。 */
  readonly minSeverity?: Severity
}

/** 题库清单（不含判据正文，只给形状与条数）。 */
export interface CasebookInfo {
  /** 版本。 */
  readonly version: number
  /** 总题数。 */
  readonly total: number
  /** 逐套件题数。 */
  readonly bySuite: readonly { readonly suite: SuiteId; readonly zh: string; readonly count: number }[]
}

/** 服务错误码。闭集。 */
export const REDTEAM_ERROR_CODES = [
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
export type RedTeamErrorCode = (typeof REDTEAM_ERROR_CODES)[number]

/** 服务错误。 */
export class RedTeamError extends Error {
  /** 错误码。 */
  readonly code: RedTeamErrorCode

  /**
   * @param code 错误码。
   * @param detail 人话说明。
   */
  constructor(code: RedTeamErrorCode, detail: string) {
    super(detail)
    this.name = 'RedTeamError'
    this.code = code
  }
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type RedTeamUnavailableReason = 'disabled'

/** 统计快照。**只在内存**，不落盘（报告是评测产物，落盘会把回复痕迹留在磁盘上）。 */
export interface RedTeamStats {
  /** 判定过几题次。 */
  readonly graded: number
  /** 出过几份报告。 */
  readonly reports: number
  /** 累计不过条数。 */
  readonly failures: number
  /** 累计 critical 不过条数。 */
  readonly criticalFailures: number
  /** 因回复为空 / 超长被拒几次。 */
  readonly rejected: number
}

/** 本插件的对外服务。 */
export interface RedTeamService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RedTeamUnavailableReason

  /** 五种套件的说明（静态）。 */
  suites(): readonly SuiteSpec[]

  /** 题库清单（条数与形状，不含判据正文）。 */
  casebook(): CasebookInfo

  /**
   * 取题。**只给题，不给答案**——答案就是判据，给了就有人照着判据编回复。
   * @param query 查询条件。
   */
  cases(query?: CaseQuery): readonly RedCase[]

  /**
   * 判一题。
   *
   * **不保存回复正文**，返回值里也只有位置区间。
   * @param input 入参。
   */
  grade(input: GradeInput): GradeResult

  /**
   * 判一批并出报告。
   *
   * 题库里有、但 `items` 里没给的题记 `skip`——**跳过不是通过**，报告里单独一列。
   * @param input 入参。
   */
  batch(input: BatchInput): RedReport

  /** 统计快照。 */
  stats(): RedTeamStats
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

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
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
