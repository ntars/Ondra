/**
 * O-078 `ondra-market` 的对外契约。档位〔复〕。
 *
 * ## 台账的要求，逐字
 *
 * ```
 * | O-078 | `ondra-market` | 〔复〕 | `ondra-market` 生态已有**（§1.7），只做接线 |
 * ```
 *
 * 手册 §1.7 把它列在「复用（生态成熟，直接用）」里，原话是「插件市场（`ondra-market`）」。
 * 所以本包**不自研索引格式、不自研搜索、不自研抓取**——这些全归上游的 `pluginMarket` 服务
 * （`desktop/packages/boot/plugin-market/src/index.ts`，服务键 `pluginMarket`；
 * 索引格式在 `desktop/packages/util/plugin-market-index/src/types.ts`，format 1）。
 * 本包只做三件上游不做的事：
 *
 * 1. **封闭市场**（手册 §7.4-⑩：「与 `ondra-market` 同型但**封闭**——只显示认可的插件，
 *    也支持用户上传自定义（官方组合包）」）。上游是开放索引，没有白名单概念。
 * 2. **只读目录**（master-plan §5 L7：「组合包清单，**只读**」）。本包不装、不卸、不改索引源。
 * 3. **安装方案**（master-plan §9.11：「安装依赖 snapshot 还原点」）。本包只算「该装什么、
 *    装之前必须先有什么」，真正落盘归 O-079 `ondra-installer`。
 *
 * ## 为什么不 `import` 上游那两个包的类型
 *
 * 本仓 84 个插件的 `peerDependencies` 里只有 `@ntars/cordis`。多声明一个依赖，
 * 一旦宿主没带它，`import` 在**模块加载期**就抛，整个插件连注册都做不到——比不接线更糟。
 * 所以按结构对位写一份**只含本包会读的字段**的镜像（`MarketHostLike`），
 * 上游多给的字段一概不声明，也一概不用。
 *
 * ## 镜像的维护纪律
 *
 * `HostEntryLike` 只读四个地方：标识、展示、版本、安装状态。上游改了这四个以外的字段，
 * 本包不受影响；改了这四个之内，**必须同步这里**——这是「结构对位」的固有代价，
 * 写在这里而不是藏起来。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const MARKET_SERVICE_KEY = 'ondra-market'

/** 名字合规正则（服务键 / 配置键共用）。包名不套这条，见 `isPackageName`。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 市场形态：封闭（只显示认可的）/ 开放（全显示，认可的打标）。 */
export const MARKET_MODES = Object.freeze(['closed', 'open'] as const)

/** 市场形态。 */
export type MarketMode = (typeof MARKET_MODES)[number]

/** 排序口径。只给上游真支持的两个；`published` 需要额外方向参数，本轮不暴露。 */
export const SORT_KINDS = Object.freeze(['index', 'relevance'] as const)

/** 排序口径。 */
export type MarketSortKind = (typeof SORT_KINDS)[number]

/**
 * 现有状态不能用的原因。
 *
 * 刻意只有三个：都是「整体不可用」，与「这一次查失败」（`MarketSearchOutcome.status`）分开。
 * 混在一起会让界面把一次网络抖动显示成「市场没装」。
 */
export type MarketReason = 'disabled' | 'no-market' | 'no-index'

/**
 * 本地化文本。上游 `LocalizedText = string | { en: string; [locale]: string }`。
 *
 * 这里放宽成 `Record<string, string>`：本包只做「按语言挑一条」，不需要上游的
 * 「en 必填」这个编译期约束——真运行时缺 en 时本包退到「任取一条」，不比抛错差。
 */
export type LocalizedLike = string | Readonly<Record<string, string>>

/** 上游一个版本的安装参数（`install` 是上游算好的，本包**不自己拼 spec**）。 */
export interface HostVersionLike {
  readonly version: string
  /** 发布时刻（Unix 秒）。只用于「最新版本」兜底排序说明，不参与比较。 */
  readonly publishTimestamp?: number
  /** 安装参数；缺了就是「上游没给」，本包如实报 `no-install-spec`。 */
  readonly install?: {
    readonly spec: string
    readonly registry?: string
  }
}

/** 上游一个条目的镜像（只含本包会读的字段）。 */
export interface HostEntryLike {
  /** npm 包名，索引内唯一。 */
  readonly name: string
  readonly title?: LocalizedLike
  readonly description?: LocalizedLike
  readonly icon?: string
  readonly author?: string
  readonly homepage?: string
  readonly metadata?: {
    readonly keywords?: readonly string[]
    readonly labels?: readonly string[]
    readonly category?: string
  }
  /** 上游保证「非空、按 SemVer 优先级降序」，所以 `[0]` 就是最新版。 */
  readonly versions?: readonly HostVersionLike[]
  /** 默认安装版本（上游按兼容性算好）。 */
  readonly defaultVersion?: string
  readonly installation?: {
    readonly status: string
    readonly installedVersion?: string
  }
}

/** 上游一个索引源的摘要。 */
export interface HostIndexSummaryLike {
  readonly url: string
  readonly title?: LocalizedLike
  readonly description?: LocalizedLike
  /** 上次读取失败时的错误文本。 */
  readonly error?: string
}

/** 上游一页搜索结果。 */
export interface HostSearchLike {
  readonly url?: string
  readonly entries: readonly HostEntryLike[]
  readonly total: number
  readonly nextOffset: number | null
  readonly fetchedAt?: number
}

/** 上游搜索参数（`sort` 在上游是四值联合，本包只用两种）。 */
export interface MarketQueryLike {
  readonly text?: string
  readonly sort: { readonly kind: string; readonly direction?: 'asc' | 'desc'; readonly id?: string }
  readonly offset: number
  readonly limit: number
  readonly refresh?: boolean
}

/**
 * 上游市场服务（`pluginMarket`）的结构对位镜像。
 *
 * 三个方法都是上游 `src/index.ts` 里确认存在的：`listIndexes()` / `search(url, query)` /
 * `entry(url, name)`。本包**不调** `setIndexes()`——改索引源是用户动作，不是插件的动作。
 */
export interface MarketHostLike {
  listIndexes(): readonly HostIndexSummaryLike[]
  search(url: string, query: MarketQueryLike): Promise<HostSearchLike>
  entry(url: string, name: string): Promise<HostEntryLike | undefined>
}

/** 认可来源：内置清单 / 用户自定义。 */
export type AllowOrigin = 'builtin' | 'user'

/** 一条认可记录。 */
export interface AllowEntry {
  readonly name: string
  readonly origin: AllowOrigin
  /** 用户备注（内置项恒空）。 */
  readonly note?: string
  /** 加入时刻（Unix 毫秒，内置项无）。 */
  readonly addedAt?: number
}

/** 归档后的目录条目（本包的统一形状，界面与 O-079 都只认它）。 */
export interface CatalogEntry {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string
  readonly icon?: string
  readonly keywords: readonly string[]
  readonly labels: readonly string[]
  readonly category?: string
  /** 索引里的最新版（上游保证降序，取第一个）。 */
  readonly latestVersion?: string
  /** 上游算好的默认安装版本。 */
  readonly defaultVersion?: string
  /** 上游给的安装状态（`installed` / `update-available` / …，本包不解释它）。 */
  readonly installStatus?: string
  readonly installedVersion?: string
  readonly versionCount: number
  /** 是否被认可。开放市场里一律 `true`。 */
  readonly allowed: boolean
  /** 认可来源；开放市场里未认可的是 `host`。 */
  readonly origin: AllowOrigin | 'host'
  /** 该条目来自哪个索引源。 */
  readonly indexUrl?: string
  /** 唯一版本的安装参数；没有就不给。 */
  readonly installSpec?: string
}

/** 一个索引源的一页结果。 */
export interface SearchPage {
  readonly indexUrl: string
  /** 过滤后的条目。 */
  readonly entries: readonly CatalogEntry[]
  /** 上游报的匹配总数（**过滤前**）。 */
  readonly hostTotal: number
  /** 本页被封闭市场挡掉的条数。 */
  readonly hidden: number
  /** 上游给的下一页 offset。 */
  readonly nextOffset: number | null
  /** 这一页失败时的原因（失败时 `entries` 为空）。 */
  readonly error?: string
}

/**
 * 一次搜索的结果。
 *
 * `status` 四值：`ok` 全部索引都成功；`partial` 有索引失败；`no-market` 没接上游；
 * `no-index` 接了但一个索引源都没配。**`partial` 不等于失败**——别的索引的结果照常返回。
 */
export interface MarketSearchOutcome {
  readonly status: 'ok' | 'partial' | 'no-market' | 'no-index'
  readonly pages: readonly SearchPage[]
  /** 各页合并后的条目。 */
  readonly entries: readonly CatalogEntry[]
  /** 各索引上游总数之和（过滤前）。 */
  readonly hostTotal: number
  /** 被封闭市场挡掉的总条数。 */
  readonly hidden: number
  readonly reason?: MarketReason
  /** 给人看的一句话（只在非 `ok` 时给）。 */
  readonly note?: string
}

/** 单条查询结果。 */
export interface MarketEntryOutcome {
  readonly status: 'ok' | 'not-allowed' | 'not-found' | 'no-market' | 'no-index'
  readonly entry?: CatalogEntry
  readonly reason?: MarketReason
}

/**
 * 安装方案。
 *
 * **本包不执行安装**。它只回答「装什么、从哪儿装、装之前必须先有什么」，
 * 真正落盘在 O-079 `ondra-installer`；还原点在 O-009 `ondra-snapshot`。
 */
export interface InstallPlan {
  readonly name: string
  readonly version?: string
  /** 上游给的 `pnpm add` 参数（本包不拼、不改、不猜）。 */
  readonly spec?: string
  readonly registry?: string
  readonly indexUrl?: string
  /** 恒为 `true`：手册 §9.11 明写「安装依赖 snapshot 还原点」，这一条不可关。 */
  readonly requiresRestorePoint: true
  /** 装之前必须先满足的事，逐条给人看。 */
  readonly preconditions: readonly string[]
  /** 给不出方案时的原因。 */
  readonly blocked?: 'no-market' | 'no-index' | 'not-allowed' | 'not-found' | 'no-install-spec'
}

/** 现状快照（只读）。 */
export interface MarketStatus {
  readonly mode: MarketMode
  readonly host: boolean
  readonly indexes: number
  /** 认可条数（内置 + 用户）。 */
  readonly allowCount: number
  readonly userCount: number
  /** 认可清单存在哪：`file`（落盘）/ `memory`（无 O-002，仅在内存）。 */
  readonly store: 'file' | 'memory'
  /** 认可清单解析失败过（按空处理，不猜字段）。 */
  readonly corrupt: boolean
  readonly reason?: MarketReason
}

/** 计数（只读）。 */
export interface MarketStats {
  readonly searches: number
  readonly filtered: number
  readonly failures: number
  readonly approvals: number
  readonly revocations: number
}

/** O-001 身份子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟子集（只取毫秒时间戳）。 */
export interface ClockLike {
  now(epoch?: number): number
}

/** 日志。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-002 路径子集（本包只读 `user` 区域里的一个文件）。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  /** 确保子目录存在并收紧权限（0700），返回绝对路径。越界抛 `PathEscapeError`。 */
  ensure(area: 'user', ...segments: string[]): string
}

/** O-005 字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly advancedOnly?: boolean
  readonly sensitive?: boolean
  readonly doc?: string
}

/** O-005 段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 服务形状。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}

/** 本插件对外提供的服务。 */
export interface MarketService {
  /** 能不能连上游（关掉或没接上游时 `false`）。**本地目录始终可读**。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: MarketReason
  /** 认可清单（内置 + 用户），只读。 */
  allowList(): readonly AllowEntry[]
  /** 加一条用户自定义（手册 §7.4-⑩「也支持用户上传自定义」）。 */
  approve(name: string, note?: string): AllowEntry;
  /** 撤一条用户自定义。内置项撤不掉（改配置）。 */
  revoke(name: string): boolean
  /** 搜索：委托上游，按封闭市场过滤。**永不抛错**。 */
  search(text?: string, options?: SearchOptions): Promise<MarketSearchOutcome>
  /** 单条查询。**先判认可，再问上游**（封闭市场不该去问没被认可的东西）。 */
  entry(name: string): Promise<MarketEntryOutcome>
  /** 安装方案（不执行）。 */
  plan(name: string, version?: string): Promise<InstallPlan>
  /** 现状。 */
  status(): MarketStatus
  /** 计数。 */
  stats(): MarketStats
  /** 换上游端口（`null` = 断开，退回本地目录）。 */
  useHost(host: MarketHostLike | null): void
  /** 撤（幂等）。 */
  dispose(): void
}

/** 搜索选项。 */
export interface SearchOptions {
  /** 只看某一个索引源；省略 = 全部（受 `maxIndexes` 限制）。 */
  readonly indexUrl?: string
  readonly offset?: number
  readonly limit?: number
  /** 跳过上游缓存重取。 */
  readonly refresh?: boolean
}
