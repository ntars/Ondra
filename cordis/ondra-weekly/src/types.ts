/**
 * O-113 `ondra-weekly` 的对外契约：**把「这一周发生过什么」整理成一份可读骨架**。
 *
 * ## 「周报」在这里指的是一件很窄的事
 *
 * 不是一篇文章，是一张**骨架**：分几段、每段写什么、哪些必须提、哪些可以省。
 * 成稿、语气、称呼、发不发出去，全部不归这里（发消息是 O-042 的事）。
 *
 * ## 三条会决定成败的判据
 *
 * 1. **不报情绪数值。** 这是全仓的禁报数铁律。周报是最容易破这条的地方——
 *    「本周幸福度 7.2 分」一旦出现，下一次就会有人为了让分数好看而调整人格参数。
 *    情绪类的东西本插件一个字都不取。
 * 2. **可以有客观计数，但不换算成评分。** 「本周记住 6 件事、写下 3 篇日记」是事实；
 *    「本周亲密度上升 12%」不是事实，是编出来的度量。故 `WeeklyCount` 只承载计数，
 *    并且强制带 `window`（这一周 / 此刻）与 `exact`（是不是全量）。
 * 3. **取不到就是 `not-available`，绝不用 0 顶替。** 0 会被读成「这周她一句话都没记住」，
 *    而真相是「这个数这会儿读不出来」。这两个结论对用户的意义完全相反，
 *    所以 `SectionState` 里 `no-material`（上游说这周确实没有）与
 *    `not-available`（上游没给）**必须是两档**。
 *
 * ## 空周怎么办
 *
 * 空周也出骨架，但骨架里必须显式说「这周很安静」，不许拿旧事填满四段。
 * `draft().quiet` 就是这条判据的落点：只有三段都**真的**回了「没有材料」才为 `true`；
 * 只要有一段读不到，`quiet` 恒为 `false`——**读不到不等于安静**。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§15.5 / §18.5），上游形状全部结构对位。
 * 所有上游都是软依赖：缺哪一段就在 `missing` 里点名，其余照常出骨架。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const WEEKLY_SERVICE_KEY = 'ondra-weekly'

/** 服务键 / 工具名 / 配置键的形状（§8.4）。带冒号的写法会在运行期才被拒。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 一天的毫秒数。只用来估窗口起点，精确日界一律问 O-003。 */
export const DAY_MS = 86_400_000

/** 窗口最短天数。1 天 = 「只看今天」，仍然是一份合法骨架。 */
export const MIN_WINDOW_DAYS = 1

/** 窗口最长天数。再长就不叫周报了，而且扫描量与误读一起涨。 */
export const MAX_WINDOW_DAYS = 31

/**
 * 四段骨架的 id（闭集）。
 *
 * 顺序即阅读顺序。`quiet` 排最后：它说的是前三段空在哪，
 * 放在开头会让人先读到「这周很安静」再去找材料，顺序就倒了。
 */
export const SECTION_IDS = ['moments', 'promises', 'diary', 'quiet'] as const

/** 一段骨架的 id。 */
export type SectionId = (typeof SECTION_IDS)[number]

/**
 * 一段骨架的状态。
 *
 * `no-material` 与 `not-available` 分开是本文件最重要的一条：
 * 前者是「上游回答了这一周确实没有」，后者是「上游没回答」。
 * 合成一档，空周与降级就再也分不开，而这两种情况的写法完全相反。
 */
export const SECTION_STATES = ['has-material', 'no-material', 'not-available'] as const

/** 一段骨架的状态。 */
export type SectionState = (typeof SECTION_STATES)[number]

/** 一段骨架的说明书（静态，不含材料）。 */
export interface SectionSpec {
  /** 段 id。 */
  readonly id: SectionId
  /** 中文段名。给骨架与日志用，**不是标题成稿**。 */
  readonly title: string
  /** 一句话：这段写什么。 */
  readonly ask: string
  /** 必须提到的东西。 */
  readonly mustMention: readonly string[]
  /** 可以省掉的东西。 */
  readonly maySkip: readonly string[]
}

/**
 * 四段说明书 —— **本插件全部段定义的唯一真源**。
 *
 * `mustMention` / `maySkip` 都是写作口径，不是文案：它们说明「什么不能漏」，
 * 但一个例句都不给。给例句就等于替人写成了稿。
 */
export const SECTION_SPECS: Readonly<Record<SectionId, SectionSpec>> = Object.freeze({
  moments: Object.freeze({
    id: 'moments',
    title: '这周留下的事',
    ask: '这一周真正留下痕迹的事：她记住了什么、你们一起经过了什么。',
    mustMention: Object.freeze([
      '素材里真的有的那一两件事，一件一句就够',
      '如果这周有一件事只有你们俩知道，优先写它',
    ]),
    maySkip: Object.freeze(['零碎的一两句寒暄', '以前已经提过好几遍的旧事']),
  }),
  promises: Object.freeze({
    id: 'promises',
    title: '这周悬着的事',
    ask: '眼下还没落地的承诺与待办：还悬着几条、有没有已经过期的。',
    mustMention: Object.freeze(['还悬着几条（只报条数，不排优先级、不排名）', '已经过期的那几条要提一句']),
    maySkip: Object.freeze(['已经办完且没有下文的待办', '具体哪天到期（骨架不需要日历）']),
  }),
  diary: Object.freeze({
    id: 'diary',
    title: '她自己写的',
    ask: '这一周她给自己写下的那几篇日记：有几篇、其中一篇在说什么。',
    mustMention: Object.freeze(['这周写了几篇', '挑其中一篇说一句它写了什么']),
    maySkip: Object.freeze(['没写日记的那几天不必逐日交代', '日记原文不必整段引用']),
  }),
  quiet: Object.freeze({
    id: 'quiet',
    title: '这周安静的地方',
    ask: '明说哪几段这周没有材料，以及整周是不是都很安静。',
    mustMention: Object.freeze(['哪几段没有材料要明说', '整周安静时，必须写「这周很安静」而不是编一件小事']),
    maySkip: Object.freeze(['安慰、鼓励、寄语——这些都不是骨架该说的话']),
  }),
})

/** 一个数据来源。**供核对，不供展示**：别把服务键渲染到界面上。 */
export interface WeeklySource {
  /** 服务键。 */
  readonly service: string
  /** 字段或方法名。 */
  readonly field: string
  /** 读到了没有。 */
  readonly ok: boolean
}

/** 计数的口径：落在本周窗口里，还是「此刻」的存量。 */
export type CountWindow = 'week' | 'now'

/**
 * 一个客观计数。
 *
 * `exact=false` 表示上游只返回了扫描上限那么多条，实际可能更多——
 * 这时数字是**下界**。宁可标不清楚，也不把下界说成准确值。
 */
export interface WeeklyCount {
  /** 计数键（英文，给机器）。 */
  readonly key: string
  /** 中文名。 */
  readonly zh: string
  /** 数值。非负整数。 */
  readonly value: number
  /** 口径。 */
  readonly window: CountWindow
  /** 是否全量。 */
  readonly exact: boolean
}

/** 一段骨架。 */
export interface WeeklySection {
  /** 段 id。 */
  readonly id: SectionId
  /** 中文段名。 */
  readonly title: string
  /** 这段写什么。 */
  readonly ask: string
  /** 必须提到的东西。 */
  readonly mustMention: readonly string[]
  /** 可以省掉的东西。 */
  readonly maySkip: readonly string[]
  /** 状态。`not-available` 与 `no-material` **不是一回事**。 */
  readonly state: SectionState
  /** 可直接引用的素材（纯文本，最多 `maxItemsPerSection` 条，**不是成稿句子**）。 */
  readonly material: readonly string[]
  /** 这一段的客观计数。空数组 = 这段没有可报的数。 */
  readonly counts: readonly WeeklyCount[]
  /** 这一段的材料来自哪。 */
  readonly sources: readonly WeeklySource[]
  /** 一句中文说明（为什么是现在这个状态）。 */
  readonly note: string
}

/** 一个时间窗口。**滚动窗口，不判自然周**（周一起点各地说法不一，见 README）。 */
export interface WeeklyRange {
  /** 起点时刻（含）。 */
  readonly from: number
  /** 终点时刻（含，即调用时刻）。 */
  readonly to: number
  /** 实际自然日数，由 O-003 的 `daysBetween` 算（夏令时也不会数错）。 */
  readonly days: number
  /** 起点自然日键 `YYYY-MM-DD`。 */
  readonly fromKey: string
  /** 终点自然日键 `YYYY-MM-DD`。 */
  readonly toKey: string
  /** 日界是否由 O-003 给出。`false` = 退回本机时区，跨时区会差一天。 */
  readonly clock: boolean
}

/** 一份周报骨架。 */
export interface WeeklyDraft {
  /** 生成时刻。 */
  readonly at: number
  /** 窗口。 */
  readonly range: WeeklyRange
  /** 四段（顺序即 `SECTION_IDS`）。 */
  readonly sections: readonly WeeklySection[]
  /** 段的账目。`empty` 是「这周确实没有」，`unavailable` 是「读不到」。 */
  readonly tally: {
    readonly sections: number
    readonly withMaterial: number
    readonly empty: number
    readonly unavailable: number
  }
  /** 缺席的上游（服务键，去重）。空数组 = 全齐。 */
  readonly missing: readonly string[]
  /** 整周是否真的安静。**只有三段都是 `no-material` 时才是 `true`**。 */
  readonly quiet: boolean
  /** 一句话自述（中文）。只说事，不评价、不打分、不是周报正文。 */
  readonly summary: string
}

/** 统计快照。**只在内存**，不落盘。 */
export interface WeeklyStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: WeeklyUnavailableReason
  /** 累计出骨架次数。 */
  readonly built: number
  /** 累计上游调用失败次数。**不为 0 说明有段在降级**。 */
  readonly degraded: number
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type WeeklyUnavailableReason = 'disabled'

/** 错误码闭集。刻意没有「未知错误」一档：走到未知分支说明本插件有 bug，该让它抛出来。 */
export const WEEKLY_ERROR_CODES = ['disabled', 'bad-request'] as const

/** 错误码。 */
export type WeeklyErrorCode = (typeof WEEKLY_ERROR_CODES)[number]

/** 一件错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class WeeklyError extends Error {
  /** 错误码。 */
  readonly code: WeeklyErrorCode

  /**
   * @param code 错误码。
   * @param detail 中文说明。
   */
  constructor(code: WeeklyErrorCode, detail: string) {
    super(detail)
    this.name = 'WeeklyError'
    this.code = code
  }
}

/** 周报骨架服务。 */
export interface WeeklyService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: WeeklyUnavailableReason

  /**
   * 取窗口。**只读，不落盘**。
   * @param at 参照时刻，省略取现在。
   */
  range(at?: number): WeeklyRange

  /**
   * 取四段骨架。**只读，不写任何上游**。
   * @param at 参照时刻，省略取现在。
   */
  sections(at?: number): readonly WeeklySection[]

  /**
   * 出骨架（含段、账目、缺席名单、一句话自述）。**不生成成稿文案**。
   * @param at 参照时刻，省略取现在。
   */
  draft(at?: number): WeeklyDraft

  /** 统计快照。 */
  stats(): WeeklyStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §18.5：相邻服务一律经服务键调用，不 import 源码。
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

/**
 * O-003 时钟的结构对位子集。
 *
 * **只用日历日算术，不碰定时器**：本插件刻意不装 `every` / `dailyAt` / `after`，
 * 出周报的时机归应用外壳。因而这里连那几个方法都不声明——接口上没有那条路。
 */
export interface ClockLike {
  /** 当前毫秒时间戳。 */
  now(): number
  /** 某时刻所在自然日的 00:00 时间戳。 */
  startOfDay(epoch?: number): number
  /** 自然日键 `YYYY-MM-DD`。 */
  dayKey(epoch?: number): string
  /** 两个时刻相差几个自然日（`b - a`）。 */
  daysBetween(a: number, b: number): number
}

/** O-010 记忆条目的结构对位子集（只取本插件要读的字段）。 */
export interface FactLike {
  /** 记忆 id。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 写入时刻。 */
  readonly createdAt: number
}

/**
 * O-010 `ondra-memory-core` 的结构对位子集。
 *
 * 只取 `listFacts()`：它的 `orderBy='created-at'` 让「本周新增」可以按时间倒序截断，
 * 不必把整库拉出来。**不用 `countFacts()`**——它没有时间条件，拿它算「本周」会撒谎。
 */
export interface MemoryCoreLike {
  /** 是否可用。 */
  readonly available: boolean
  listFacts(query?: {
    readonly state?: string
    readonly limit?: number
    readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
  }): readonly FactLike[]
}

/** O-021 承诺统计的结构对位子集。 */
export interface PromiseStatsLike {
  readonly promises: {
    readonly open: number
    readonly kept: number
    readonly broken: number
    readonly expired: number
    readonly total: number
  }
  readonly todos?: {
    readonly open: number
    readonly done: number
    readonly total: number
  }
  readonly overdue: number
}

/** O-021 到期提醒项的结构对位子集（只要原话）。 */
export interface ReminderLike {
  readonly promise: {
    readonly id: string
    readonly text: string
    readonly dueAt: number
  }
}

/** O-021 `ondra-memory-prospective` 的结构对位子集（只取统计与未结算清单）。 */
export interface ProspectiveLike {
  /** 是否可用。 */
  readonly available: boolean
  stats(): PromiseStatsLike
  listOpen(at?: number): readonly ReminderLike[]
}

/** O-045 日记引用的结构对位子集（列表用，不带正文）。 */
export interface DiaryRefLike {
  /** 自然日键 `YYYY-MM-DD`。 */
  readonly dayKey: string
  /** 正文字符数。 */
  readonly chars: number
}

/** O-045 读完的一篇日记（只取标题）。 */
export interface DiaryEntryLike {
  /** 自然日键。 */
  readonly dayKey: string
  /** 标题行。 */
  readonly title: string
}

/** O-045 `ondra-diary` 的结构对位子集。**只读**：契约里连 `write()` / `ensure()` 都不镜像。 */
export interface DiaryLike {
  /** 是否可用。 */
  readonly available: boolean
  /** 最近的几篇（按日期倒序）。 */
  list(limit?: number): readonly DiaryRefLike[]
  /** 读某天；读不动时 `undefined`（上游不抛）。 */
  entry(dayKey: string): DiaryEntryLike | undefined
}

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
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
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}
