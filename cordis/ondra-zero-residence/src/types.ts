/**
 * O-143 `ondra-zero-residence` 的对外契约：**零常驻上下文**（手册 §8.6）。
 *
 * 手册原文只有一句：「确定性指针替换常驻内容，被遮字节可从 session log 逐字恢复
 * （可逆可审计）；压缩前状态先写 SQLite」。这一句里有四个必须分开实现的动作，
 * 也就是手册给的四个名字：
 *
 * | 名字 | 本包的落点 | 它到底回答什么 |
 * |---|---|---|
 * | `zr_compact` | `compact()` | 这段正文能不能换成指针？换完省多少？ |
 * | `zr_recall` | `recall()` | 这个指针原来是什么？**还能不能一字不差地取回来？** |
 * | `zr_ledger` | `ledger()` | 账上有什么？谁在什么时候被遮了多少字？ |
 * | `zr_fast` | `fast()` | 不写盘也不建账，纯算一遍要省多少（预算预览用） |
 *
 * ## 为什么指针必须是「内容的函数」
 *
 * 零常驻的全部收益来自**前缀缓存**（§8.5：命中 99.3–99.6%，成本 ¥879.97 → ¥19.96）。
 * 一旦指针里掺了时间戳或自增序号，同一段正文每次压缩都会得到一个新指针，
 * 也就是每压一次换一次前缀 —— 缓存当场归零，省下的 token 还不够赔的。
 *
 * 所以指针 id = `zr-` + 内容指纹的前 12 位十六进制。同一段正文在同一个会话里
 * 压两次，得到的**字符串完全相同**，这一条是本包的第一性质，`pointer.test` 里
 * 对拍的就是它。
 *
 * ## 为什么「逐字恢复」不能只靠内存
 *
 * 内存账本随进程生死。手册要求「压缩前状态先写 SQLite」，原因写在另一处：
 * 「当 agent 压缩对话腾空间时，它忘了正在编辑哪些文件、哪些任务在进行」。
 * 所以本包把顺序写死：**先落盘，再交指针**。落不进去就不交——
 * 一条通向丢失的链接，比不压缩糟得多。
 *
 * 本文件不 import 任何 `ondra-*` 源码（§18.5），存储与配置全部结构对位。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const ZR_SERVICE_KEY = 'ondra-zero-residence'

/** 服务键 / 指针 id / 表名列名的唯一合法形状（手册 §8.4）。 */
export const KEY_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 指针文本的语法：`[zr-<12 位十六进制>(<撞号后缀>)?/<字符数>]`。
 *
 * 刻意把**字符数**写进指针：恢复时可以拿它对账（长度不对就是没恢复对），
 * 而且它让「这段被遮了多少」在提示词里直接可见——审计不需要另开一个接口。
 */
export const POINTER_RE_SOURCE = '\\[(zr-[0-9a-f]{12}(?:-[0-9]+)?)\\/([0-9]+)\\]'

/** 运行期用的正则（每次新建，避免 `lastIndex` 残留导致的「第二次匹配不到」）。 */
export function pointerRe(): RegExp {
  return new RegExp(POINTER_RE_SOURCE, 'g')
}

/**
 * 三档模式。
 *
 * 与 O-138 同一套迁移纪律：中间那档是唯一安全的落点——先看报告，再翻真干。
 */
export type ZrMode =
  /** 什么都不算。 */
  | 'off'
  /** 照常算、照常出指针文本，但**不写盘、不入账**，返回值标 `advisory`。**默认**。 */
  | 'observe'
  /** 真写盘、真入账、真交指针。 */
  | 'compact'

/** 可入账的片段种类。只有 `resident` 能压，其余三类是「被冻结的稳定段」。 */
export type ZrSpanKind =
  /** 常驻正文：工具输出、读进来的文件、早期对话原文。**唯一可压的一类**。 */
  | 'resident'
  /** 人格段。压了等于改人，且它是前缀的第一段。 */
  | 'persona'
  /** 世界书常驻条目。同样在前缀里。 */
  | 'worldbook'
  /** 边界与禁令。手册：边界层整层豁免裁剪。 */
  | 'boundary'

/** 不收指针的原因。每一个都要能说出口，否则「没压」与「压了但没生效」同形。 */
export type ZrRefusal =
  /** 模式是 off。 */
  | 'off'
  /** 模式是 observe：算过、报了收益，但没有写盘、没有入账。 */
  | 'observe'
  /** 正文是空的或只有空白，没有可压的东西。 */
  | 'empty'
  /** 片段种类不可入账（人格 / 世界书 / 边界）。 */
  | 'protected'
  /** 不在用户回合边界上。手册 §8.5-3：中途重写前缀会把这一轮缓存全废掉。 */
  | 'not-boundary'
  /** 省下的字还不够抵消指针本身与一次账本查询。 */
  | 'too-short'
  /** 单段超过上限且切不开（例如一整块没有分隔符的长串）。 */
  | 'too-big'
  /** 没有会话 id。跨会话共用账本会让恢复指错人。 */
  | 'no-session'
  /** 同一段正文的候选 id 全被占用（48 位指纹连环撞号）。不猜，放弃这一条。 */
  | 'id-exhausted'
  /** 账本装不下这么多条。**不淘汰旧记录**——淘汰等于删证据。 */
  | 'ledger-full'
  /** 没有存储后端，而配置要求「先落盘再交指针」。 */
  | 'no-store'
  /** 落盘失败（写库抛错）。**绝不把写不进去的指针交出去。** */
  | 'store-error'
  /** 计算过程抛错（C3：错误不传播，折成拒绝原因）。 */
  | 'error'

/** 账本里的一条记录（**不含正文**）。 */
export interface ZrRecord {
  /** 指针 id，须匹配 `KEY_RE`。 */
  readonly id: string
  /** 归属会话。 */
  readonly sessionId: string
  /** 该会话内的第几段（0 起，按压缩顺序）。**只用于排序与展示，不参与 id**。 */
  readonly ordinal: number
  /** 字符数（`Array.from` 口径，代理对一个字）。 */
  readonly chars: number
  /** 内容指纹（FNV-1a 64 位十六进制）。恢复时对账用。 */
  readonly fnv: string
  /** 入账时刻。 */
  readonly createdAt: number
}

/** 记录 + 它的指针文本（`ledger()` 的返回形状）。 */
export interface ZrRecordView extends ZrRecord {
  /** 可直接写进提示词的指针。 */
  readonly pointer: string
}

/** 一次压缩的入参。 */
export interface ZrCompactInput {
  /** 会话 id。必填——跨会话共用账本会让恢复指错人。 */
  readonly sessionId: string
  /** 要被替换掉的常驻正文。 */
  readonly text: string
  /** 片段种类，默认 `resident`。非 `resident` 一律拒收。 */
  readonly kind?: ZrSpanKind
  /**
   * 调用方断言「现在在用户回合边界上」。
   *
   * 刻意要调用方显式传 `true`，而不是本包自己猜：本包看不到消息序列，
   * 猜出来的边界（比如「距上次压缩超过 N 秒」）会在同一条用户消息里触发两次。
   */
  readonly atUserTurnBoundary: boolean
  /** 时刻；省略取当前时刻。 */
  readonly at?: number
}

/** 一次压缩的结果。 */
export interface ZrCompactOutcome {
  /** 是否真的交出了可用指针。`observe` 下恒 false（但 `pointers` 仍给出预览）。 */
  readonly ok: boolean
  /** 没交的原因；`ok=true` 时省略。 */
  readonly reason?: ZrRefusal
  /** 指针文本（按原文顺序）。`observe` 下是预览，**不可使用**。 */
  readonly pointers: readonly string[]
  /** 指针 id（与 `pointers` 同序）。 */
  readonly ids: readonly string[]
  /** 替换前的字符数。 */
  readonly charsIn: number
  /** 替换后的字符数（指针文本合计）。 */
  readonly charsOut: number
  /** 省下的字符数（`charsIn - charsOut`，不为负）。 */
  readonly savedChars: number
  /** 入库的条数。`observe` 下恒 0。 */
  readonly records: number
  /** 是否真的落盘了。`false` 且 `ok=true` 只在允许不落盘时出现。 */
  readonly durable: boolean
  /** 是不是「只算不干」的预览结果。 */
  readonly advisory: boolean
  /** 一句中文说明（给日志与界面）。 */
  readonly note: string
}

/** 一次预览（`fast()`）的结果。**不动任何状态。** */
export interface ZrPreview {
  /** 切出来的段数。 */
  readonly spans: number
  /**
   * 预览指针。传了 `sessionId` 时与真压后的指针**逐字相同**；
   * 没传时 id 是占位值（形状、字数、条数仍精确）。
   */
  readonly pointers: readonly string[]
  readonly charsIn: number
  readonly charsOut: number
  readonly savedChars: number
  /** 值不值得压（过了 `minSavingsChars`）。 */
  readonly viable: boolean
  /** 不可压的原因；`viable=true` 时省略。 */
  readonly reason?: ZrRefusal
}

/** 一次恢复的结果。 */
export interface ZrRecallOutcome {
  /** 是否拿到了正文。 */
  readonly ok: boolean
  /** 没拿到 / 拿到了但不可信的原因。 */
  readonly reason?: ZrRecallFailure
  /** 正文。`ok=true` 时必在。 */
  readonly text?: string
  /**
   * 是否**逐字可信**。
   *
   * `false` 也可能是 `ok=true`：内容取到了，但长度或指纹对不上（例如 session log
   * 被手工改过）。本包不隐瞒，也不替你决定要不要用——把判断留给调用方。
   */
  readonly verified: boolean
  /** 从哪儿取到的。 */
  readonly source?: ZrRecallSource
}

/** 取不回来的原因。 */
export type ZrRecallFailure =
  /** id 形状不合法（不是指针 id）。 */
  | 'bad-id'
  /** 账本（内存 + 库 + 外部源）都没有这条。 */
  | 'not-found'
  /** 取到了，但长度与指纹都对不上。 */
  | 'mismatch'
  /** 外部源抛错。 */
  | 'source-error'

/** 正文的来源。 */
export type ZrRecallSource =
  /** 本进程内存账本。 */
  | 'ledger'
  /** 存储后端。 */
  | 'store'
  /** 外部恢复源（应用外壳或 session log 读取器）。 */
  | 'external'

/** 一次展开的结果。 */
export interface ZrExpandOutcome {
  /** 展开后的正文。 */
  readonly text: string
  /** 认出来几个指针。 */
  readonly pointers: number
  /** 成功换回原文几个。 */
  readonly resolved: number
  /** 换不回来的个数（原样保留指针文本，**不猜**）。 */
  readonly unresolved: number
  /** 换回来了但长度/指纹对不上的个数。 */
  readonly mismatched: number
}

/** 账本快照（给设置面板与自检看）。 */
export interface ZrLedgerView {
  /** 会话 id；`null` 表示全部会话合计。 */
  readonly sessionId: string | null
  /** 条数。 */
  readonly records: number
  /** 被遮的字符总数。 */
  readonly chars: number
  /** 容量上限。 */
  readonly capacity: number
  /** 最近 20 条（新的在前）。**不返回全量**：512 条塞进界面没人看。 */
  readonly recent: readonly ZrRecordView[]
}

/** 累计统计。 */
export interface ZrStats {
  readonly at: number
  /** 当前模式。 */
  readonly mode: ZrMode
  /** 服务是否可用（模式非 off 且（能落盘 或 允许不落盘））。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: 'off' | 'no-store'
  /** 入库条数。 */
  readonly records: number
  /** 容量上限。 */
  readonly capacity: number
  /** 累计被遮的字符数。 */
  readonly chars: number
  /** 累计真正交出的指针数（`observe` 不计）。 */
  readonly pointers: number
  /** 累计省下的字符数（`observe` 也计——它的全部意义就是这个数）。 */
  readonly savedChars: number
  /** 累计压缩调用数。 */
  readonly calls: number
  /** 成功次数。 */
  readonly committed: number
  /** 被拒次数。 */
  readonly refused: number
  /** 各拒绝原因的次数。 */
  readonly byReason: Readonly<Record<string, number>>
  /** 恢复尝试次数（含 `expand()` 里的逐条恢复）/ 失败次数 / 指纹不符次数。 */
  readonly recalls: number
  readonly recallMisses: number
  readonly mismatches: number
  /** 展开次数与累计换不回来的指针数。 */
  readonly expands: number
  readonly unresolved: number
  /** 落盘失败次数。 */
  readonly storeErrors: number
  /** 是否落盘可用。 */
  readonly durable: boolean
  /** 是否接了外部恢复源。 */
  readonly external: boolean
}

/**
 * 外部恢复源：从 session log 一类的地方按 id 取回原文。
 *
 * **为什么是「挂上去」而不是「自己读」**：会话日志的存放格式与路径归应用外壳
 * （`desktop/`），本包读不到也不需要读。给一个插口，谁有谁接。
 */
export type ZrExternalSource = (id: string, sessionId: string) => string | undefined

/** 对外服务。 */
export interface ZrService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: 'off' | 'no-store'
  /** 当前模式（可观测：§14.2 不许黑箱切换）。 */
  readonly mode: ZrMode

  /**
   * `zr_fast`：纯预览，不写盘、不建账、不改任何计数。
   *
   * 省略 `sessionId` 时算出的 id 只是**占位**：指针 id 里含会话（同一段正文
   * 在两个会话里指向两份不同的证据），不是时间或序号。段数与省下的字仍然精确。
   */
  fast(text: string, kind?: ZrSpanKind, sessionId?: string): ZrPreview
  /** `zr_compact`：写盘 → 入账 → 交指针。**永不抛出。** */
  compact(input: ZrCompactInput): ZrCompactOutcome
  /** `zr_recall`：按指针（或裸 id）取回原文并校验。 */
  recall(idOrPointer: string, sessionId?: string): ZrRecallOutcome
  /** `zr_ledger`：列账（不含正文）。 */
  ledger(sessionId?: string): ZrLedgerView
  /** 把一段正文里的指针全部展开（审计用；换不回来的原样保留）。 */
  expand(text: string, sessionId?: string): ZrExpandOutcome

  /** 挂一个外部恢复源。**返回卸载函数**（§3.3-4 可逆注册）。 */
  attachSource(source: ZrExternalSource): () => void
  /** 统计。 */
  stats(): ZrStats
  /** 卸载：清内存账本。幂等。 */
  dispose(): void
}

/* ------------------------------------------------------------------ *
 * 上游与同仓形状的结构对位（一律不 import，§3.3-1）
 * ------------------------------------------------------------------ */

/** 日志形状（Cordis logger 的子集）。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-001 身份服务的形状（只取日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 的字段声明形状（只取本包用到的成员）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
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
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 一行数据（O-006 的 `Row`）。 */
export type StoreRow = Record<string, unknown>

/** 列声明（O-006 的 `ColumnSpec` 子集）。 */
export interface StoreColumnLike {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'
  readonly notNull?: boolean
  readonly primaryKey?: boolean
  readonly default?: string
}

/** 索引声明（O-006 的 `IndexSpec` 子集）。 */
export interface StoreIndexLike {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique?: boolean
}

/** 表声明（O-006 的 `TableSpec` 子集）。 */
export interface StoreTableLike {
  readonly name: string
  readonly columns: readonly StoreColumnLike[]
  readonly indexes?: readonly StoreIndexLike[]
  readonly strict?: boolean
}

/** 过滤条件（O-006 的 `Filter` 子集）。 */
export interface StoreFilterLike {
  readonly column: string
  readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'
  readonly value?: unknown
}

/** 查询（O-006 的 `SelectQuery` 子集）。 */
export interface StoreQueryLike {
  readonly where?: readonly StoreFilterLike[]
  readonly orderBy?: readonly { readonly column: string; readonly direction?: 'asc' | 'desc' }[]
  readonly limit?: number
}

/**
 * O-006 `ondra-store-sqlite` 的结构对位子集。
 *
 * **只声明本包真的调的那几个方法。** 多声明一个方法，就多一个「上游没实现、
 * 而本包以为有」的坑；少声明一个，调用处会直接编译不过，反倒是好事。
 */
export interface StorePortLike {
  readonly state: 'open' | 'degraded' | 'closed'
  readonly caps: { readonly sql: boolean; readonly persist: boolean; readonly transaction: boolean }
  ensureTable(spec: StoreTableLike): { readonly table: string; readonly created: boolean }
  insert(table: string, row: StoreRow): void
  upsert(table: string, row: StoreRow): void
  get(table: string, key: StoreRow): StoreRow | undefined
  select(table: string, query?: StoreQueryLike): StoreRow[]
  count(table: string, where?: readonly StoreFilterLike[]): number
  transaction<T>(fn: () => T): T
}
