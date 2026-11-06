/**
 * 服务层：索引、单包检查、全仓扫描。
 *
 * ## 索引为什么要缓存，又为什么必须能重建
 *
 * 「服务键唯一」与「依赖可解析」两项都要全仓视野。每调一次 `check()` 就重扫 82 个包，
 * 会让人再也不想点第二次——于是自检形同不存在。所以索引缓存。
 *
 * 但缓存必须能手动重建（`refresh()`）：插件是每小时长出来的，缓存不刷新，
 * 新建的包会被判成「悬空依赖」，而人看到的是「我明明刚写了提供方」。
 *
 * ## `checkAll()` 为什么只采一遍
 *
 * 它要读 82 个包的全部事实，而索引也来自这些事实。先采一遍、就地建索引、再逐包判，
 * 比「先建索引（读一遍源码）→ 再逐包采事实（再读一遍）」省掉一半 IO。
 *
 * ## 一切失败都不抛
 *
 * `check()` / `checkAll()` / `hostLoads()` 都跑在启动期与面板上。抛一个错会把
 * 启动流程或一次界面刷新打断，而自检的全部价值是「告诉人哪里不对」——它自己
 * 崩掉是最没用的失败方式。所以端口异常一律折成 `unverifiable`。
 */

import type {
  BootOracle,
  CheckId,
  CheckReport,
  CheckResult,
  KeyIndex,
  LogLike,
  PackageFacts,
  PackageSource,
  StartupCheckReason,
  StartupCheckService,
  StartupCheckStats,
  StartupCheckStatus,
} from './types.js'
import type { Config } from './settings.js'
import { TITLES, checkHostLoads, runChecks } from './checks.js'
import { scanSources } from './scan.js'
import { collectFacts, collectSources, looksLikePackage } from './source.js'
import type { CollectOptions } from './source.js'

/** 构造依赖。 */
export interface StartupDeps {
  /** 现取配置。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: LogLike
  /** 取当前时刻。 */
  readonly now: () => number
  /** 读端口（`null` = 没有可用端口）。 */
  readonly source: PackageSource | null
}

/** 可变计数。 */
type Counters = { -readonly [K in keyof StartupCheckStats]: StartupCheckStats[K] }

/** 自检服务。 */
export class StartupCheck implements StartupCheckService {
  readonly #deps: StartupDeps
  #source: PackageSource | null
  #oracle: BootOracle | null = null
  #index: KeyIndex | null = null
  #indexedAt = 0
  #packageCount = 0
  #counters: Counters = { checks: 0, scans: 0, reindexes: 0, fatal: 0, partial: 0, passed: 0 }

  /**
   * @param deps 依赖。
   */
  constructor(deps: StartupDeps) {
    this.#deps = deps
    this.#source = deps.source
  }

  /** 开关开着没有（有端口且配置开着）。 */
  get available(): boolean {
    return this.#deps.settings().enable && this.#source !== null
  }

  /** 不能用的原因。 */
  get reason(): StartupCheckReason | undefined {
    if (!this.#deps.settings().enable) return 'disabled'
    if (this.#source === null) return 'no-root'
    return undefined
  }

  /** 检查一个包。 */
  async check(name?: string): Promise<CheckReport> {
    const target = name === undefined || name === '' ? 'ondra-startup-check' : name
    const source = this.#source
    const now = this.#deps.now()
    if (source === null) return this.#blindReport(target, now, '没有可用的读端口（`root` 没配）', '把 `root` 配成插件包所在的父目录')

    this.#counters.checks += 1
    try {
      const facts = await collectFacts(source, target, this.#options())
      const keys = await this.index()
      const report = runChecks(facts, { keys, now }, this.#oracle)
      this.#tally(report)
      if (this.#deps.settings().verbose) {
        this.#deps.log.info('自检 %s → %s（%d 项过 / %d 项不过）', target, report.verdict, report.passed.length, report.failed.length)
      }
      return report
    } catch (error) {
      return this.#blindReport(target, now, `读取中断：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 扫全部包。 */
  async checkAll(): Promise<readonly CheckReport[]> {
    const source = this.#source
    const now = this.#deps.now()
    if (source === null) return Object.freeze([])
    this.#counters.scans += 1
    try {
      const names = await this.#packages()
      const factsList: PackageFacts[] = []
      for (const name of names) {
        factsList.push(await collectFacts(source, name, this.#options()))
      }
      const index = this.#buildIndex(factsList)
      this.#index = index
      this.#indexedAt = now
      this.#packageCount = factsList.length

      const reports: CheckReport[] = []
      for (const facts of factsList) {
        const report = runChecks(facts, { keys: index, now }, this.#oracle)
        this.#tally(report)
        reports.push(report)
      }
      this.#deps.log.info(
        '全仓自检：%d 个包（%d 致命 / %d 部分过 / %d 全过）',
        reports.length,
        reports.filter(item => item.verdict === 'fatal').length,
        reports.filter(item => item.verdict === 'partial').length,
        reports.filter(item => item.verdict === 'pass').length,
      )
      return Object.freeze(reports)
    } catch (error) {
      this.#deps.log.warn('全仓自检中断：%s', error instanceof Error ? error.message : String(error))
      return Object.freeze([])
    }
  }

  /** 当前索引。 */
  async index(): Promise<KeyIndex> {
    if (this.#index !== null) return this.#index
    return this.refresh()
  }

  /** 重建索引。 */
  async refresh(): Promise<KeyIndex> {
    const source = this.#source
    const hostKeys = this.#deps.settings().hostKeys
    if (source === null) {
      const empty: KeyIndex = { provided: new Map(), hostKeys }
      this.#index = empty
      this.#indexedAt = this.#deps.now()
      return empty
    }
    this.#counters.reindexes += 1
    try {
      const names = await this.#packages()
      const provided = new Map<string, string[]>()
      for (const name of names) {
        const sources = await collectSources(source, this.#options())
        for (const key of scanSources(sources).provideKeys) {
          const owners = provided.get(key)
          if (owners === undefined) provided.set(key, [name])
          else if (!owners.includes(name)) owners.push(name)
        }
      }
      const index: KeyIndex = { provided, hostKeys }
      this.#index = index
      this.#indexedAt = this.#deps.now()
      this.#packageCount = names.length
      this.#deps.log.info('服务键索引重建：%d 个包 / %d 个键', names.length, provided.size)
      return index
    } catch (error) {
      this.#deps.log.warn('索引重建失败（保留旧索引）：%s', error instanceof Error ? error.message : String(error))
      return this.#index ?? { provided: new Map(), hostKeys }
    }
  }

  /**
   * 只跑第十项。
   *
   * **刻意不走 `check()`**：`check()` 要索引（= 扫全仓源码），而启动期只想验
   * 「我自己会不会被加载」。为了一个布尔把 82 个包读一遍，启动会明显变慢，
   * 而慢下来的自检会被关掉——那就什么都没了。
   * @param name 包名（空 = 本插件）。
   */
  async hostLoads(name?: string): Promise<CheckResult> {
    const target = name === undefined || name === '' ? 'ondra-startup-check' : name
    const source = this.#source
    if (source === null) {
      return {
        id: 'host-loads',
        title: TITLES['host-loads'],
        verdict: 'unverifiable',
        detail: '没有可用的读端口（`root` 没配）',
        hint: '把 `root` 配成插件包所在的父目录',
        findings: Object.freeze([]),
      }
    }
    this.#counters.checks += 1
    try {
      const facts = await collectFacts(source, target, this.#options())
      return checkHostLoads(facts, this.#oracle)
    } catch (error) {
      return {
        id: 'host-loads',
        title: TITLES['host-loads'],
        verdict: 'unverifiable',
        detail: `读取中断：${error instanceof Error ? error.message : String(error)}`,
        findings: Object.freeze([]),
      }
    }
  }

  /** 现状。 */
  status(): StartupCheckStatus {
    const settings = this.#deps.settings()
    const reason = this.reason
    return Object.freeze({
      enabled: settings.enable,
      root: settings.root,
      source: this.#source === null ? 'none' : this.#source.id,
      packages: this.#packageCount,
      keys: this.#index === null ? 0 : this.#index.provided.size,
      hostKeys: settings.hostKeys.length,
      indexedAt: this.#indexedAt,
      ...(reason !== undefined ? { reason } : {}),
      oracle: this.#oracle !== null,
    })
  }

  /** 计数。 */
  stats(): StartupCheckStats {
    return Object.freeze({ ...this.#counters })
  }

  /** 换读端口。 */
  useSource(source: PackageSource | null): void {
    this.#source = source
    // 换了端口，索引必然失效——留着旧索引会让新根下的包被判成悬空。
    this.#index = null
    this.#indexedAt = 0
  }

  /** 换权威组合端口。 */
  useOracle(oracle: BootOracle | null): void {
    this.#oracle = oracle
  }

  /** 撤（幂等）。 */
  dispose(): void {
    this.#index = null
    this.#source = null
    this.#oracle = null
  }

  /** 采集参数。 */
  #options(): CollectOptions {
    const settings = this.#deps.settings()
    return {
      maxFiles: settings.maxFilesPerPackage,
      maxFileBytes: settings.maxFileBytes,
      log: this.#deps.log,
    }
  }

  /** 列出根下的包目录。 */
  async #packages(): Promise<readonly string[]> {
    const source = this.#source
    if (source === null) return []
    const limit = this.#deps.settings().maxPackages
    const names = (await source.list('')).filter(looksLikePackage)
    if (names.length > limit) {
      this.#deps.log.warn('包数 %d 超过上限 %d，只扫前 %d 个', names.length, limit, limit)
      return names.slice(0, limit)
    }
    return names
  }

  /**
   * 用已采好的事实建索引。
   * @param factsList 事实。
   */
  #buildIndex(factsList: readonly PackageFacts[]): KeyIndex {
    const provided = new Map<string, string[]>()
    for (const facts of factsList) {
      for (const key of scanSources(facts.sources).provideKeys) {
        const owners = provided.get(key)
        if (owners === undefined) provided.set(key, [facts.name])
        else if (!owners.includes(facts.name)) owners.push(facts.name)
      }
    }
    return { provided, hostKeys: this.#deps.settings().hostKeys }
  }

  /**
   * 记账。
   * @param report 报告。
   */
  #tally(report: CheckReport): void {
    if (report.verdict === 'fatal') this.#counters.fatal += 1
    else if (report.verdict === 'partial') this.#counters.partial += 1
    else this.#counters.passed += 1
  }

  /**
   * 「判不了」的报告（十项全出，不是只出一项）。
   *
   * 出满十项是因为界面按 id 对位渲染：少一项会让面板上那一格永远空着，
   * 而空着与「通过」在视觉上太像了。
   * @param name 包名。
   * @param now 时刻。
   * @param detail 为什么判不了。
   * @param hint 指路。
   */
  #blindReport(name: string, now: number, detail: string, hint?: string): CheckReport {
    const ids: readonly CheckId[] = [
      'files',
      'manifest',
      'tsconfig',
      'entry',
      'service-key',
      'dep-resolvable',
      'no-cross-import',
      'degrade',
      'deliverables',
      'host-loads',
    ]
    const results: CheckResult[] = ids.map(id => ({
      id,
      title: TITLES[id],
      verdict: 'unverifiable' as const,
      detail,
      ...(hint !== undefined ? { hint } : {}),
      findings: Object.freeze([]),
    }))
    return {
      package: name,
      at: now,
      verdict: 'partial',
      results: Object.freeze(results),
      passed: Object.freeze([]),
      failed: Object.freeze([]),
      warned: Object.freeze([]),
      unverifiable: Object.freeze([...ids]),
      hostLoads: null,
    }
  }
}
