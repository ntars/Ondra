/**
 * O-138 `ondra-organ-gate` 的对外契约：**工具 schema 门控 + 确定性意图路由**（手册 §8.6）。
 *
 * ## 这个包解决的是「架构级」问题，不是省钱小技巧
 *
 * 手册原文：「96 插件若全量注册工具，单轮 prompt 就会被工具定义占满。」
 * 实测 48 条命令：**55,154 → 8,433 schema token（84.7% 被门控掉）**。
 * 也就是说，不门控的话，还没开始说话，上下文已经被工具说明书吃掉一半。
 *
 * ## 门控只有一种合法做法：摘视图，不动实现
 *
 * 上游给的正规接缝是 `ctx.tools.restrict({ deny })`——它作用在**某个 agent 的
 * 作用域**上，只影响「这个 agent 能看见哪些工具」，不改任何工具的实现，
 * 也不动全局注册表。三条推论：
 *
 * 1. **必须拿 agent 的 ctx**，不能拿根 ctx。`restrict()` 在根 ctx 上直接抛错
 *    （源码原话：a context-global restriction would mask every agent）。
 * 2. **只能摘已知存在的名字**。`restrict()` 对未知工具名抛错，所以待摘名单
 *    必须先与 `schemas()` 求交——不然一个拼错的前缀会让整轮门控炸掉。
 * 3. **`run_code` 永远不许摘**。它是 PTC 模式的保留传输名，`restrict()` 对它
 *    直接抛错。本包在算名单时就把它硬剔除，不指望调用方记得。
 *
 * ## 三条安全设计（本包的全部性格）
 *
 * - **认不准就全给。** 一条规则都没命中 → 不做任何限制。门控的收益是省 token，
 *   代价是「该给的工具没给」；后者会让模型编一个替代方案出来，比多花 token 糟得多。
 * - **熔断优先于收益。** 要摘掉的比例超过 `maxDenyRatio`、或剩下的工具少于
 *   `minKeepTools` → 整轮放弃。宁可这一轮不省。
 * - **先撤再算。** 每轮重新计算前必须先撤掉自己上一轮的限制。否则 `schemas()`
 *   读到的是**被自己削过的视图**，算出来「该摘的」会越来越窄，一旦某轮给了
 *   很少的工具，之后再也回不来——而且没有任何报错。
 *
 * ## 数值口径
 *
 * - `chars` 是**精确**的（`JSON.stringify` 的码位数），可以拿去对账。
 * - `estTokens` 是**估算**（`chars / charsPerToken`）。本包不做分词，
 *   所以任何「省了 N 个 token」都只能写成估算值。手册那个 84.7% 是别人
 *   拿真 tokenizer 量出来的，本包不冒用。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const GATE_SERVICE_KEY = 'ondra-organ-gate'

/** 服务键 / 规则 id / 工具族名的唯一合法形状（手册 §8.4）。 */
export const KEY_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * PTC 模式的保留传输名。`ctx.tools.restrict()` 对它直接抛错，
 * 所以它在**任何**配置下都不可被摘——不是默认值，是硬编码。
 */
export const RESERVED_TRANSPORT = 'run_code'

/** 门控模式。三档而不是开关：中间那档是迁移期唯一安全的落点。 */
export type GateMode =
  /** 完全不做事（连算都不算）。 */
  | 'off'
  /** 只算不拦：把「本来会摘掉什么、能省多少」写进报告与日志。**默认**。 */
  | 'observe'
  /** 真摘。 */
  | 'enforce'

/** 这一轮为什么没门控。每一个都要能说出口，否则「没省」与「没算」同形。 */
export type GateSkipReason =
  /** 模式是 off。 */
  | 'mode-off'
  /** 工具注册表不在（`tools` 服务缺席）。 */
  | 'no-tools'
  /** 拿不到 agent 的作用域 ctx（`agent.ctx.tools` 缺席）。 */
  | 'no-scope'
  /** 可见工具本来就少，不值得门控。 */
  | 'too-few-tools'
  /** 本轮没有任何规则命中——认不准就全给。 */
  | 'no-rule'
  /** 规则命中了，但一个工具名都没匹配上（规则表与真实工具名对不上）。 */
  | 'no-match'
  /** 算完发现没有可摘的。 */
  | 'nothing-to-deny'
  /** 会摘得太多，触发熔断。 */
  | 'ratio-cap'
  /** 会摘到只剩不到下限，触发熔断。 */
  | 'min-keep'
  /** 本轮没有用户原话（例如系统注入的回合），意图未知。 */
  | 'no-message'
  /** 中途出了异常，已按「不门控」处理。 */
  | 'error'

/** 上游 `ToolSchema` 的结构对位子集（`@ntars/ondra-llm`）。不 import。 */
export interface ToolSchemaLike {
  readonly name: string
  readonly description?: string
  /** 参数的 JSON Schema 对象。本包只拿来数字符，不解释它。 */
  readonly parameters?: unknown
}

/**
 * 上游 `ctx.tools` 的结构对位子集。
 *
 * `restrict` 必须**经 agent 的 ctx 取**（`agent.ctx.tools.restrict`），
 * 因为上游是用 `this.ctx` 判定作用域的；`ctx.get('tools')` 拿到的是未绑定的
 * 服务实例，在它上面调 `restrict` 会被判成「全局限制」并抛错。
 */
export interface ScopedToolsLike {
  schemas(scope?: unknown): readonly ToolSchemaLike[]
  restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
}

/** agent 的作用域 ctx：只声明本包真要用的一个成员。 */
export interface AgentScopeLike {
  readonly tools?: ScopedToolsLike
}

/** 上游 `Agent` 的结构对位子集。 */
export interface AgentLike {
  readonly ctx: AgentScopeLike
}

/** 日志形状（结构对位 Cordis logger 的子集）。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-001 身份服务的形状（只取日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(decl: unknown, by?: string): () => void
  resolve(id: string, layers: Record<string, unknown>): { readonly values: unknown; readonly fallbackCount: number } | undefined
}

/**
 * 一条意图规则。
 *
 * 刻意**不是**「自然语言理解」：它是「关键词表 + 工具名模式表」的机械映射。
 * 这样每一条命中都能指着说「因为出现了这两个字」，不需要解释一个概率。
 */
export interface IntentRule {
  /** 规则 id，须匹配 `KEY_RE`。报告里报的就是它。 */
  readonly id: string
  /** 工具族名，须匹配 `KEY_RE`。只用于报告与统计，不参与匹配。 */
  readonly family: string
  /** 一句话说明这条规则想抓什么。 */
  readonly doc: string
  /** 关键词（子串匹配，大小写不敏感）。中文没有词边界，只能按子串。 */
  readonly keywords: readonly string[]
  /**
   * 工具名模式：`read` 精确匹配，`terminal_*` 匹配前缀。
   *
   * 只支持「尾部星号」一种通配，因为这是唯一不会产生歧义的一种：
   * `*read` 与 `re*d` 会让「匹配了谁」变得需要解释，而本包的价值之一
   * 就是每个决定都能一句话说清。
   */
  readonly toolPatterns: readonly string[]
}

/** 一次门控的计算结果（纯数据，不含副作用）。 */
export interface GatePlan {
  /** 命中的规则 id（升序，去重）。 */
  readonly matched: readonly string[]
  /** 命中的工具族（升序，去重）。 */
  readonly families: readonly string[]
  /** 该 agent 当前可见的工具数。 */
  readonly total: number
  /** 留下的工具名（升序）。 */
  readonly kept: readonly string[]
  /** 要摘掉的工具名（升序）。 */
  readonly denied: readonly string[]
  /** 门控前的 schema 码位数（精确）。 */
  readonly charsBefore: number
  /** 门控后的 schema 码位数（精确，按 `denied` 扣掉）。 */
  readonly charsAfter: number
  /** 门控前 token 估算值。 */
  readonly estTokensBefore: number
  /** 门控后 token 估算值。 */
  readonly estTokensAfter: number
  /** 是否真的会摘（false 时看 `skipped`）。 */
  readonly applied: boolean
  /** 没摘的原因；`applied=true` 时省略。 */
  readonly skipped?: GateSkipReason
  /** 一句人话，直接进日志与报告。 */
  readonly detail: string
}

/** 一次决策的留痕（`report()` 返回它）。 */
export interface GateDecision extends GatePlan {
  readonly at: number
  readonly turn: number
  readonly step: number
  /** 本轮用户原话的前若干字，只进报告，不进提示词。 */
  readonly excerpt: string
  /** 是否真的调了 `restrict()`。`observe` 模式下 `applied` 为真但 `enforced` 为假。 */
  readonly enforced: boolean
}

/** 服务不可用的原因。 */
export type GateUnavailableReason = 'mode-off' | 'no-tools'

/** 门控统计。 */
export interface GateStats {
  readonly at: number
  readonly mode: GateMode
  /** 走过 pre-step 的步数。 */
  readonly steps: number
  /** 真正做了计算（含 observe）的步数。 */
  readonly planned: number
  /** 真正调了 `restrict()` 的步数。 */
  readonly enforced: number
  /** 因各种原因放弃的步数。 */
  readonly skipped: number
  /** 累计「计划省下」的码位数。**observe 模式也累加**——它的全部意义就是这个数；
   * `enforced` 计数告诉你其中有多少真生效。 */
  readonly savedChars: number
  /** 累计省下的 token 估算值。 */
  readonly savedTokens: number
  /** 各放弃原因的次数。 */
  readonly byReason: Readonly<Record<string, number>>
  /** 各规则命中次数。 */
  readonly byRule: Readonly<Record<string, number>>
  /** 当前登记在册的 agent 数。 */
  readonly agents: number
}

/** 门控服务。 */
export interface GateService {
  /** 是否在工作（模式非 off 且工具注册表在位）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GateUnavailableReason
  /** 当前模式（可观测：§14.2 不许黑箱切换）。 */
  readonly mode: GateMode
  /** 内置规则表（只读副本，供界面与审计）。 */
  rules(): readonly IntentRule[]
  /**
   * 纯计算：给定用户原话与工具 schema，算出会摘掉什么。**不动任何状态。**
   * 界面预览、单测、审计都走它。
   *
   * 只给工具名也能用（传 `{ name }` 即可），但那样 `chars` 只算得到名字，
   * 数字会偏小——要准的数就把真 schema 传进来。
   */
  plan(text: string, tools: readonly ToolSchemaLike[]): GatePlan
  /** 最近 N 条决策（新的在前）。 */
  report(limit?: number): readonly GateDecision[]
  /** 最近一条决策。 */
  last(): GateDecision | undefined
  stats(): GateStats
  /** 卸载：撤掉所有 agent 上的限制，清空留痕。幂等。 */
  dispose(): void
}
