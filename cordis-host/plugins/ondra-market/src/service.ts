/**
 * 服务层：委托上游搜索 + 封闭市场过滤 + 安装方案。
 *
 * ## 本包不做的事，比做的事更重要
 *
 * 手册 §1.7 把市场列进〔复〕。所以这里**没有**索引解析、**没有**模糊匹配、
 * **没有**网络抓取、**没有**版本兼容判定——那四件全在上游，本包只把它们的输出
 * 套一层白名单，再算一份「装之前得先有什么」。
 *
 * 一旦本包自己拼一遍搜索，就会出现两份「什么算匹配」，而分叉的表现是
 * 「同一个关键词，市场页有 3 个，工具查只有 1 个」——这类 bug 没人能复现。
 *
 * ## 过滤之后不能再报过滤前的数
 *
 * 上游的 `total` 是**过滤前**的匹配数。封闭市场挡掉一部分后，若还拿它当 `total`
 * 显示「共 12 个」而列表只有 2 条，人会以为分页坏了。所以每个 `SearchPage`
 * 同时给 `hostTotal`（上游）与 `hidden`（挡掉的），两者相加才是上游看到的全貌。
 *
 * ## 安装方案为什么要再看一次上游
 *
 * `CatalogEntry.installSpec` 是**默认版本**的参数。若 `plan(name, '1.2.0')` 直接复用它，
 * 就会给出「标签写 1.2.0、spec 指向 1.3.0」——装完发现版本不对，而记录里查不出错。
 * 所以 `plan()` 自己按版本再取一次 spec。
 *
 * ## 所有方法都不抛
 *
 * 面板与设置页会调它。抛一个错会把一次界面刷新打断，而市场挂了不该影响对话。
 * 上游的异常一律折成 `pages[].error` 或 `blocked`。
 */

import type { Config } from './settings.js'
import { isPackageName } from './settings.js'
import { installSpecOf, toCatalog } from './normalize.js'
import type { ApprovalStore, StoredApproval } from './store.js'
import type {
  AllowEntry,
  CatalogEntry,
  HostEntryLike,
  InstallPlan,
  LogLike,
  MarketEntryOutcome,
  MarketHostLike,
  MarketReason,
  MarketSearchOutcome,
  MarketService,
  MarketStats,
  MarketStatus,
  SearchOptions,
  SearchPage,
} from './types.js'

/** 构造依赖。 */
export interface MarketDeps {
  /** 现取配置。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: LogLike
  /** 取当前时刻（Unix 毫秒）。 */
  readonly now: () => number
  /** 认可清单存储。 */
  readonly store: ApprovalStore
  /** 上游端口（`null` = 没接）。 */
  readonly host: MarketHostLike | null
}

/** 可变计数。 */
type Counters = { -readonly [K in keyof MarketStats]: MarketStats[K] }

/** 定位结果。 */
type LocateResult =
  | { readonly ok: true; readonly entry: HostEntryLike; readonly indexUrl: string }
  | { readonly ok: false; readonly status: 'not-allowed' | 'not-found' | 'no-market' | 'no-index' }

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 空结果。 */
function emptyOutcome(reason: MarketReason, note: string): MarketSearchOutcome {
  return Object.freeze({
    status: reason === 'no-index' ? 'no-index' : 'no-market',
    pages: Object.freeze([]) as readonly SearchPage[],
    entries: Object.freeze([]) as readonly CatalogEntry[],
    hostTotal: 0,
    hidden: 0,
    reason,
    note,
  })
}

/** 市场服务。 */
export class Market implements MarketService {
  readonly #deps: MarketDeps
  #host: MarketHostLike | null
  #disposed = false
  #counters: Counters = { searches: 0, filtered: 0, failures: 0, approvals: 0, revocations: 0 }

  /**
   * @param deps 依赖。
   */
  constructor(deps: MarketDeps) {
    this.#deps = deps
    this.#host = deps.host
  }

  /** 能不能连上游。**本地目录始终可读**，所以这个字段只答「上游通不通」。 */
  get available(): boolean {
    if (!this.#deps.settings().enable) return false
    return this.#host !== null
  }

  /** 不能用的原因。 */
  get reason(): MarketReason | undefined {
    const settings = this.#deps.settings()
    if (!settings.enable) return 'disabled'
    if (this.#host === null) return 'no-market'
    return this.#indexes().length === 0 ? 'no-index' : undefined
  }

  /** 认可清单（内置 + 用户）。内置优先，同名用户项被跳过。 */
  allowList(): readonly AllowEntry[] {
    const settings = this.#deps.settings()
    const out: AllowEntry[] = []
    const seen = new Set<string>()
    for (const name of settings.builtin) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(Object.freeze({ name, origin: 'builtin' }))
    }
    for (const item of this.#deps.store.entries) {
      if (seen.has(item.name)) continue
      seen.add(item.name)
      out.push(
        Object.freeze({
          name: item.name,
          origin: 'user',
          ...(item.note === undefined ? {} : { note: item.note }),
          addedAt: item.addedAt,
        }),
      )
    }
    return Object.freeze(out)
  }

  /** 加一条用户自定义。 */
  approve(name: string, note?: string): AllowEntry {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!isPackageName(trimmed)) {
      throw new TypeError(`包名不合法：${String(name)}`)
    }
    const existing = this.allowList().find(item => item.name === trimmed)
    if (existing !== undefined) return existing

    const record: StoredApproval = Object.freeze({
      name: trimmed,
      ...(typeof note === 'string' && note.trim() !== '' ? { note: note.trim() } : {}),
      addedAt: this.#deps.now(),
    })
    this.#deps.store.save([...this.#deps.store.entries, record])
    this.#counters.approvals += 1
    this.#deps.log.info('认可了自定义条目：%s', trimmed)
    return Object.freeze({
      name: trimmed,
      origin: 'user',
      ...(record.note === undefined ? {} : { note: record.note }),
      addedAt: record.addedAt,
    })
  }

  /** 撤一条用户自定义。内置项撤不掉——改配置 `builtin`。 */
  revoke(name: string): boolean {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (trimmed === '') return false
    const before = this.#deps.store.entries
    const next = before.filter(item => item.name !== trimmed)
    if (next.length === before.length) return false
    this.#deps.store.save(next)
    this.#counters.revocations += 1
    this.#deps.log.info('撤回了自定义条目：%s', trimmed)
    return true
  }

  /** 搜索：委托上游，按封闭市场过滤。 */
  async search(text?: string, options?: SearchOptions): Promise<MarketSearchOutcome> {
    if (this.#disposed) return emptyOutcome('no-market', '市场服务已卸载')
    const settings = this.#deps.settings()
    if (!settings.enable) return emptyOutcome('disabled', '市场开关关着')

    const host = this.#host
    if (host === null) return emptyOutcome('no-market', '没接上游市场服务（`pluginMarket`）')

    const indexes = this.#indexes()
    if (indexes.length === 0) return emptyOutcome('no-index', '上游没配任何索引源')

    const wanted = typeof options?.indexUrl === 'string' && options.indexUrl !== '' ? options.indexUrl : undefined
    const chosen = wanted === undefined ? indexes : indexes.filter(item => item.url === wanted)
    if (chosen.length === 0) return emptyOutcome('no-index', `索引源不在配置里：${wanted ?? ''}`)

    const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = clampInt(options?.limit, settings.pageSize, 1, 100)
    const sort = { kind: settings.sort }
    const query = String(text ?? '').trim()

    this.#counters.searches += 1
    if (settings.verbose) {
      this.#deps.log.info('查市场：文本=%s 索引 %d 个 offset=%d limit=%d', query, chosen.length, offset, limit)
    }

    const pages: SearchPage[] = []
    const names = this.#allowedNames()
    let failures = 0

    for (const index of chosen.slice(0, settings.maxIndexes)) {
      try {
        const result = await host.search(index.url, {
          ...(query === '' ? {} : { text: query }),
          sort,
          offset,
          limit,
          ...(options?.refresh === true ? { refresh: true } : {}),
        })
        const raw = Array.isArray(result.entries) ? result.entries : []
        const decorated = raw.map(item => this.#decorate(item, index.url, names))
        const visible = settings.mode === 'closed' ? decorated.filter(item => item.allowed) : decorated
        const hidden = decorated.length - visible.length
        pages.push(
          Object.freeze({
            indexUrl: index.url,
            entries: Object.freeze(visible),
            hostTotal: typeof result.total === 'number' ? result.total : raw.length,
            hidden,
            nextOffset: typeof result.nextOffset === 'number' ? result.nextOffset : null,
          }),
        )
        this.#counters.filtered += hidden
      } catch (error) {
        failures += 1
        this.#counters.failures += 1
        pages.push(
          Object.freeze({
            indexUrl: index.url,
            entries: Object.freeze([]) as readonly CatalogEntry[],
            hostTotal: 0,
            hidden: 0,
            nextOffset: null,
            error: textOf(error),
          }),
        )
        this.#deps.log.warn('索引读失败（%s）：%s', index.url, textOf(error))
      }
    }

    const merged: CatalogEntry[] = []
    const dedupe = new Set<string>()
    let hostTotal = 0
    let hiddenTotal = 0
    for (const page of pages) {
      hostTotal += page.hostTotal
      hiddenTotal += page.hidden
      for (const entry of page.entries) {
        if (dedupe.has(entry.name)) continue
        dedupe.add(entry.name)
        merged.push(entry)
      }
    }

    const status = failures === 0 ? 'ok' : 'partial'
    return Object.freeze({
      status,
      pages: Object.freeze(pages),
      entries: Object.freeze(merged),
      hostTotal,
      hidden: hiddenTotal,
      ...(status === 'ok'
        ? {}
        : {
            note:
              failures === pages.length
                ? '所有索引都没读成功，见 pages[].error'
                : `${String(failures)} 个索引没读成功`,
          }),
    })
  }

  /** 单条查询。**先判认可，再问上游**。 */
  async entry(name: string): Promise<MarketEntryOutcome> {
    const located = await this.#locate(name)
    if (!located.ok) {
      return Object.freeze({
        status: located.status,
        ...(located.status === 'not-allowed' || located.status === 'not-found'
          ? {}
          : { reason: located.status as MarketReason }),
      })
    }
    return Object.freeze({
      status: 'ok',
      entry: this.#decorate(located.entry, located.indexUrl, this.#allowedNames()),
    })
  }

  /** 安装方案。**不执行**。 */
  async plan(name: string, version?: string): Promise<InstallPlan> {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const preconditions = Object.freeze([
      '版本与运行中的 DSH 相容（上游 `engines.ondra` 已判，本包不重判）',
      '先建立快照还原点：O-009 `ondra-snapshot` 的 `snapshot()`',
      '安装动作归 O-079 `ondra-installer`；本包只给参数，不落盘、不跑包管理器',
    ])
    const base = { name: trimmed, requiresRestorePoint: true as const, preconditions }

    const located = await this.#locate(trimmed)
    if (!located.ok) {
      const blocked: NonNullable<InstallPlan['blocked']> =
        located.status === 'not-allowed'
          ? 'not-allowed'
          : located.status === 'no-market'
            ? 'no-market'
            : located.status === 'no-index'
              ? 'no-index'
              : 'not-found'
      return Object.freeze({ ...base, blocked })
    }

    const spec = installSpecOf(located.entry, version)
    return Object.freeze({
      ...base,
      ...(spec.version === undefined ? {} : { version: spec.version }),
      indexUrl: located.indexUrl,
      ...(spec.spec === undefined ? { blocked: 'no-install-spec' as const } : { spec: spec.spec }),
      ...(spec.registry === undefined ? {} : { registry: spec.registry }),
    })
  }

  /** 现状。 */
  status(): MarketStatus {
    const settings = this.#deps.settings()
    const store = this.#deps.store
    const allow = this.allowList()
    const reason = this.reason
    return Object.freeze({
      mode: settings.mode,
      host: this.#host !== null,
      indexes: this.#indexes().length,
      allowCount: allow.length,
      userCount: allow.filter(item => item.origin === 'user').length,
      store: store.kind,
      corrupt: store.corrupt,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  /** 计数。 */
  stats(): MarketStats {
    return Object.freeze({ ...this.#counters })
  }

  /** 换上游端口。 */
  useHost(host: MarketHostLike | null): void {
    this.#host = host
  }

  /** 撤（幂等）。 */
  dispose(): void {
    this.#disposed = true
    this.#host = null
  }

  /**
   * 定位一个条目：判认可 → 逐个索引问上游。
   * @param name 包名。
   */
  async #locate(name: string): Promise<LocateResult> {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!isPackageName(trimmed)) return { ok: false, status: 'not-found' }
    if (this.#disposed) return { ok: false, status: 'no-market' }

    const settings = this.#deps.settings()
    // 开关关掉只停「查上游」；`plan()` 也走这里，所以关掉后 plan 会报 no-market（而不是给一份旧缓存）。
    if (!settings.enable) return { ok: false, status: 'no-market' }

    const host = this.#host
    if (host === null) return { ok: false, status: 'no-market' }

    const indexes = this.#indexes()
    if (indexes.length === 0) return { ok: false, status: 'no-index' }

    if (settings.mode === 'closed' && !this.#allowedNames().has(trimmed)) {
      // 封闭市场不该去问上游「这个没被认可的东西是什么」——问一次就等于承认它存在。
      return { ok: false, status: 'not-allowed' }
    }

    for (const index of indexes.slice(0, settings.maxIndexes)) {
      try {
        const found = await host.entry(index.url, trimmed)
        if (found !== undefined) return { ok: true, entry: found, indexUrl: index.url }
      } catch (error) {
        this.#counters.failures += 1
        this.#deps.log.warn('查条目失败（%s / %s）：%s', index.url, trimmed, textOf(error))
      }
    }
    return { ok: false, status: 'not-found' }
  }

  /**
   * 把上游条目归一并打上认可标记。
   * @param entry 上游条目。
   * @param indexUrl 索引源。
   * @param names 认可集合。
   */
  #decorate(entry: HostEntryLike, indexUrl: string, names: ReadonlySet<string>): CatalogEntry {
    const settings = this.#deps.settings()
    const allowed = settings.mode === 'open' ? true : names.has(entry.name)
    const origin: 'builtin' | 'user' | 'host' = settings.builtin.includes(entry.name)
      ? 'builtin'
      : this.#deps.store.entries.some(item => item.name === entry.name)
        ? 'user'
        : 'host'
    return toCatalog(entry, { language: settings.language, allowed, origin, indexUrl })
  }

  /** 认可集合。 */
  #allowedNames(): ReadonlySet<string> {
    const settings = this.#deps.settings()
    const names = new Set<string>(settings.builtin)
    for (const item of this.#deps.store.entries) names.add(item.name)
    return names
  }

  /**
   * 取上游索引源摘要。上游 `listIndexes` 本身不抛，但端口是任意实现，
   * 所以包一层：**拿不到就当没有索引**。
   */
  #indexes(): readonly { readonly url: string }[] {
    const host = this.#host
    if (host === null) return Object.freeze([])
    try {
      const list = host.listIndexes()
      if (!Array.isArray(list)) return Object.freeze([])
      return Object.freeze(list.filter(item => typeof item?.url === 'string' && item.url !== ''))
    } catch (error) {
      this.#deps.log.warn('取索引源失败：%s', textOf(error))
      return Object.freeze([])
    }
  }
}
