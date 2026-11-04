/**
 * O-142 `ondra-inject-dedupe` 的对外契约：**注入去重记账**。
 *
 * 手册 §2.6 原文：「首轮一次性大块注入 + 已见 id 记账 + 压缩信号触发"释放已见"
 * + 之后只推增量。实测事故：每次唤醒重复注入一遍，一次多背 13000+ 字，
 * 修正后单次上下文省一半。」
 *
 * ## 这一层到底是「谁的事」
 *
 * 装箱归 O-036（`ondra-prompt-inject`）：它接受一个 `seen` 集合、返回
 * `plan().ids`（真装进去的）与 `plan().suppressed`（被已见挡下的）。
 * 本插件只做三件事，**一件都不多做**：
 *
 * ```
 *   账本（谁进过上下文）
 *     ├─ begin()   ── 把账本摊成 seen 交给 O-036 → 拿回增量正文与待记账 id
 *     ├─ commit()  ── 那一轮真发出去了，才记账
 *     └─ release() ── 压缩/换会话/记忆改写，把已见吐回去
 * ```
 *
 * ## 六件必须先说清的事
 *
 * 1. **误记账比漏记账严重得多。** 漏记账的代价是下一轮多花几十字；
 *    误记账的代价是「这件事她本会话内再也想不起来了」，而且**没有任何报错**。
 *    所以记账分两段：`begin()` 只出「待记账」，`commit()` 才真写。
 *    模型调用失败、用户中断、流被取消（O-033 的 `discarded`）→ 走 `discard()`。
 *
 * 2. **只记 `plan().ids`，绝不记「候选全集」。** 装不下的条目（`dropped`）没进上下文，
 *    记了它们等于**永久静默删掉**——因为它们以后都会被「已见」挡住，
 *    而用户看到的现象是「她怎么从来不提那件事了」。
 *
 * 3. **记账键按「记忆」不按「块」。** 同一条记忆这轮可能作为钉住进 ②（`pin:<factId>`），
 *    下轮作为召回进 ⑤（`mem:<factId>`）——两个 id 不同、指同一条事。
 *    按 id 记账会让她这轮说「你之前说想去冰岛」，下轮又说一遍。
 *    故记账键收敛到 `fact:<factId>`（见 `ledger.ts` 的别名族）。
 *
 * 4. **账本不落盘（刻意）。** 记账回答的是「这条现在还在不在她那轮上下文里」。
 *    进程一重启，上下文就没了；此时若把账本从磁盘读回来，她会认为「我说过了」
 *    而实际那句话不在上下文里——那正是本插件要修的那个 bug 的另一半。
 *    故账本是**纯内存、随进程生死**。这里刻意不用 `ctx.kv`。
 *
 * 5. **「只推增量」的落点是「空就不发」。** 一轮没新东西时 `state = 'nothing-new'`、
 *    `text = ''`。绝不能发一个只有段标题的空段——八段标题约 100 字，
 *    每轮白烧 100 字，比 bug 本身还贵，而且界面会显示一段空白注入。
 *
 * 6. **不改前缀。** 增量正文进的是**易变段尾部**（O-033 的 `TailPart`）。
 *    把注入拼进 system 前缀、或每轮重拼，命中率会归零（§8.5）。
 *    本插件不碰 O-033 的消息序列，只交一段文本给它。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像；O-036 的契约若变，改这里一处。
 */

/** 本插件注册的服务键（连字符，非 `ondra:inject-dedupe`）。全仓唯一归属。 */
export const DEDUPE_SERVICE_KEY = 'ondra-inject-dedupe'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 一、入参与出参
 * ------------------------------------------------------------------ */

/** 一轮开始的入参。 */
export interface BeginRequest {
  /** 会话 id。省略取配置的默认会话。 */
  readonly conversationId?: string
  /** 当前来信（话头），原样透传给 O-036；空串合法。 */
  readonly query?: string
  /** 临时预算（字符），原样透传；省略用 O-036 的配置值。 */
  readonly budgetChars?: number
  /** 时刻；省略取当前时刻。 */
  readonly at?: number
}

/**
 * 一轮的增量结果。
 *
 * 调用方按 `state` 决定怎么用：
 * - `fresh`：把 `text` 拼到易变段尾部，那一轮**真发出去之后**调 `commit()`；
 * - `nothing-new`：`text` 为空，**什么都不拼**；
 * - `bypassed` / `degraded`：本插件这次没起作用，调用方走原路径（整块注入）。
 */
export interface DedupeBatch {
  /** 批次号（本进程内单调递增）。`commit()` / `discard()` 的凭据。 */
  readonly batchId: number
  /** 归属会话。 */
  readonly conversationId: string
  /** 本轮状态。 */
  readonly state: BatchState
  /** 增量正文。只有 `fresh` 时非空。 */
  readonly text: string
  /** 增量正文字符数。 */
  readonly chars: number
  /** 本轮要注入的条目 id（`mem:` / `pin:` / `promise:`），与 O-036 的 `plan().ids` 一致。 */
  readonly ids: readonly string[]
  /** 记账键（`fact:` / `promise:` …），`commit()` 用它，不用重解析。 */
  readonly keys: readonly string[]
  /** 被「已见」挡下的条数。 */
  readonly suppressed: number
  /** 装不下的条数（**不进账本**，下次还会再试）。 */
  readonly dropped: number
  /** 是否超预算（核心段整块进导致，O-036 的口径）。 */
  readonly overBudget: boolean
  /** 本轮开始前账本是空的（= 会话首轮大块，或刚被释放过）。 */
  readonly firstOfSession: boolean
  /** 内容指纹（O-036 的 djb2），只在报告里用。 */
  readonly digest: string
  /** 本轮开始前是否刚发生过「释放已见」。 */
  readonly released: ReleaseReason | null
  /** 一句中文说明（给日志与界面，**不含用户原文**）。 */
  readonly note?: string
}

/** 本轮状态。四值闭集，`bypassed` 与 `degraded` 的处置一样但原因不同。 */
export type BatchState =
  /** 有新条目，`text` 是增量正文。 */
  | 'fresh'
  /** 全被已见挡住，或本轮根本没有可注入内容。`text` 为空串。 */
  | 'nothing-new'
  /** 去重没启用（总开关关 / O-036 不在 / O-036 自己关了）。调用方走原路径。 */
  | 'bypassed'
  /** 本次失败（C3：错误不传播）。调用方走原路径——**宁可多花字，也不能让她忘**。 */
  | 'degraded'

/** 释放已见的原因。 */
export type ReleaseReason =
  /** 上下文被压缩：注入正文从历史里删掉了，那些 id 事实上「不在上下文里」。 */
  | 'compaction'
  /** 换会话 / 重启：账本本来就该清空（虽然是纯内存，这里供显式调用）。 */
  | 'session-restart'
  /** 人工在设置里点「重新注入一遍」。 */
  | 'manual'
  /** 记忆被改写/删除：旧内容不该再算「说过了」。 */
  | 'memory-revise'

/** 记账结果。 */
export interface CommitOutcome {
  /** 是否记上。`false` 时 `reason` 必在。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly reason?: CommitFailure
  /** 归属会话。 */
  readonly conversationId: string
  /** 新记上几条。 */
  readonly added: number
  /** 本来就在账本里几条（同一轮里重复 id）。 */
  readonly skipped: number
  /** 因账本满了被挤掉几条（挤掉的可能下次再出现，见 README 已知限制）。 */
  readonly evicted: number
}

/** 记账失败原因。 */
export type CommitFailure =
  /** 批次不存在：已提交过、已作废、或被同会话的新一轮顶掉（`superseded`）。 */
  | 'stale'
  /** 批次属于别的会话。 */
  | 'mismatch'

/** 作废结果。 */
export interface DiscardOutcome {
  /** 是否作废成功。`false` 说明这个批次已经不在了（重复作废是安全的）。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly reason?: CommitFailure
}

/** 释放结果。 */
export interface ReleaseOutcome {
  /** 被释放的会话；`null` 表示全部会话。 */
  readonly conversationId: string | null
  /** 原因（原样回传，便于日志）。 */
  readonly reason: ReleaseReason
  /** 释放了多少条记账。 */
  readonly released: number
  /** 顺带作废了多少个未决批次。 */
  readonly discarded: number
}

/** 账本快照（给设置面板 / 自检看）。 */
export interface LedgerSnapshot {
  /** 会话 id。 */
  readonly conversationId: string
  /** 已记多少条。 */
  readonly seenCount: number
  /** 容量上限。 */
  readonly capacity: number
  /** 最近记上的 20 个记账键（最新在前）。**不返回全量**：2000 条塞进界面没人看。 */
  readonly recent: readonly string[]
  /** 该会话还有几个未决批次。 */
  readonly pending: number
  /** 因容量被挤掉几条（累计）。 */
  readonly evicted: number
  /** 该会话被释放过几次。 */
  readonly releases: number
}

/** 累计统计。**只在内存**，不落盘。 */
export interface DedupeStats {
  /** 是否可用（开关 + O-036 在位 + O-036 自己开着）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DedupeReason
  /** 当前记账的会话数。 */
  readonly conversations: number
  /** 全部会话合计已记条数。 */
  readonly totalSeen: number
  /** 单会话容量上限。 */
  readonly capacity: number
  /** 累计记账次数。 */
  readonly commits: number
  /** 累计记上的条数。 */
  readonly injected: number
  /** 累计被「已见」挡下的条数（**这就是省下来的重复**）。 */
  readonly suppressed: number
  /** 累计「本轮没有新东西」的轮数。 */
  readonly emptyTurns: number
  /** 累计释放次数。 */
  readonly releases: number
  /** 累计因容量挤掉的条数。 */
  readonly evictions: number
  /** 累计被同会话新一轮顶掉的批次。 */
  readonly superseded: number
  /** 累计降级次数。 */
  readonly degraded: number
  /** 压缩信号出现但**判不出是哪个会话**的次数（多会话时不做自动释放）。 */
  readonly ambiguousCompactions: number
  /** 最近一次 `begin()` 的时刻；从未调用为 0。 */
  readonly lastAt: number
}

/** 不可用原因。三值闭集。 */
export type DedupeReason =
  /** 本插件总开关关掉。 */
  | 'disabled'
  /** O-036 `ondra-prompt-inject` 不在位。 */
  | 'no-inject'
  /** O-036 在位但自己关了（`available === false`）。 */
  | 'inject-disabled'

/** 对外服务。 */
export interface DedupeService {
  /** 是否可用（每次现取，上游晚装载能自愈）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DedupeReason

  /** 一轮开始：摊账本 → 调 O-036 装箱 → 返回增量。**永不抛出**。 */
  begin(request?: BeginRequest): DedupeBatch
  /** 那一轮真发出去了：记账。 */
  commit(batchId: number, conversationId?: string): CommitOutcome
  /** 那一轮没发出去：不留痕（下一轮会再注入一次，只是多花字）。 */
  discard(batchId: number): DiscardOutcome
  /** 释放已见（压缩 / 换会话 / 记忆改写）。省略会话则针对默认会话。 */
  release(reason: ReleaseReason, conversationId?: string): ReleaseOutcome
  /** 释放全部会话的已见。 */
  releaseAll(reason: ReleaseReason): ReleaseOutcome
  /** 让指定条目下次可以再出现（用户说「你再说一遍那个」/ 记忆被改写）。 */
  resurface(ids: readonly string[], conversationId?: string): number
  /** 账本快照。 */
  snapshot(conversationId?: string): LedgerSnapshot
  /** 累计统计。 */
  stats(): DedupeStats
}

/* ------------------------------------------------------------------ *
 * 二、上游镜像（不 import，结构对位）
 * ------------------------------------------------------------------ */

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

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  /** 注册一个段，返回撤销函数。 */
  register(section: SectionDeclLike, owner?: string): () => void
  /** 解析一个段的四层合并结果。 */
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/**
 * O-036 的装箱入参（**只镜像本插件用到的四个字段**）。
 *
 * `seen` 就是账本的出口：O-036 在装箱**之前**按 `seen.has(item.id)` 摘掉已见条目，
 * 并把它们报进 `suppressed`（既不占预算也不进「另有 N 条未展开」）。
 */
export interface PackRequestLike {
  readonly budgetChars?: number
  readonly query?: string
  readonly at?: number
  readonly seen?: ReadonlySet<string>
}

/** O-036 的装箱报告（只镜像本插件读的字段）。 */
export interface PlanLike {
  /** 真装进去的条目 id —— **账本只认这个**。 */
  readonly ids: readonly string[]
  /** 被已见挡下的条目。 */
  readonly suppressed: readonly { readonly id: string; readonly block: string }[]
  /** 装不下的条目（**不进账本**）。 */
  readonly dropped: readonly { readonly id: string; readonly reason: string }[]
  /** 是否超预算。 */
  readonly overBudget: boolean
  /** 实际用了多少字。 */
  readonly usedChars: number
  /** 内容指纹。 */
  readonly digest: string
}

/** O-036 的渲染结果。 */
export interface RenderedLike {
  readonly text: string
  readonly chars: number
  readonly plan: PlanLike
}

/** O-036 注入装箱的结构对位子集。 */
export interface InjectionLike {
  readonly available: boolean
  render(request?: PackRequestLike): RenderedLike
}

/**
 * O-033 对话编排的结构对位子集（**只读两个计数器**，用来嗅「压缩发生了」）。
 *
 * 两个字段都写成可选：本插件不保证上游一定给这两个数（换一版实现就可能没有），
 * 拿不到就当作「嗅不到」，**绝不因为读一个统计数而让记账出错**。
 */
export interface DialogueLike {
  readonly available: boolean
  stats():
    | { readonly compactions?: number; readonly conversations?: number }
    | undefined
}

/** 上游取值函数。全部可缺席。 */
export interface Sources {
  readonly inject: () => InjectionLike | undefined
  readonly dialogue: () => DialogueLike | undefined
}
