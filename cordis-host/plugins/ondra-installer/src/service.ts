/**
 * 服务层：编排九步、跑 `bootstrap-ok`、维护账本快照。
 *
 * ## `bootstrap-ok` 验哪五件事
 *
 * | # | id | 问的是 |
 * |---|---|---|
 * | 1 | `ledger` | 账本在不在、读不读得懂 |
 * | 2 | `coverage` | 清单里每个组件，账上都有 `installed` 吗 |
 * | 3 | `files` | 账上说装了的文件，现在还在、而且哈希还是那个吗 |
 * | 4 | `manifest-drift` | 账本记的清单摘要，还是当前这份清单吗 |
 * | 5 | `stamp` | 有没有**完成过**一整轮（`bootstrapAt`） |
 *
 * 为什么没有「宿主会不会加载我」这一项：本包的产物是**运行时组件**（node、静态资源），
 * 不是插件包。O-077 的 `hostLoads(name)` 回答的是「这个包名在不在入口树里」，
 * 对组件毫无意义；拿它检安装器自己又是自欺——它当然在，因为它正在跑。
 * 所以这一项**不做**，写在 README 的「已知限制」里，而不是硬凑一个仪式。
 *
 * `files` 要把每个组件重算一遍哈希。那是这一项的**全部价值**：只看文件在不在，
 * 等于只验「路径存在」，而路径存在与内容正确是两件事。
 * 代价是 `verify()` 会读一遍全部组件——所以 `apply()` **不自动调它**，
 * 只在面板或引导页明确要求时跑。
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Config } from './settings.js'
import { LedgerStore, findComponent } from './ledger.js'
import { hashFile } from './hash.js'
import { parseManifest } from './manifest.js'
import { STEP_DECLS, destPathOf, runPipeline } from './steps.js'
import type {
  BootstrapCheck,
  BootstrapLedger,
  BootstrapReport,
  ComponentSource,
  ComponentSpec,
  FileSink,
  InstallerReason,
  InstallerService,
  InstallerStats,
  InstallerStatus,
  InstallPlanView,
  InstallRun,
  LogLike,
  ManifestParse,
  RuntimeProbe,
  StepId,
  StepResult,
} from './types.js'

/** 构造依赖。 */
export interface InstallerDeps {
  readonly settings: () => Config
  readonly log: LogLike
  readonly now: () => number
  /** 账本存储。 */
  readonly store: LedgerStore
  readonly source: ComponentSource | null
  readonly sink: FileSink | null
  readonly runtime: RuntimeProbe | null
}

/** 可变计数。 */
type Counters = { -readonly [K in keyof InstallerStats]: InstallerStats[K] }

/** 清单解析缓存。 */
interface ParseCache {
  readonly key: string
  readonly parsed: ManifestParse
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 造一条自检项。 */
function check(
  id: BootstrapCheck['id'],
  title: string,
  verdict: BootstrapCheck['verdict'],
  detail: string,
  findings: readonly string[] = [],
  hint?: string,
): BootstrapCheck {
  return Object.freeze({
    id,
    title,
    verdict,
    detail,
    findings: Object.freeze([...findings]),
    ...(hint === undefined ? {} : { hint }),
  })
}

/** 安装器服务。 */
export class Installer implements InstallerService {
  readonly #deps: InstallerDeps
  #source: ComponentSource | null
  #sink: FileSink | null
  #runtime: RuntimeProbe | null
  #ledger: BootstrapLedger | undefined
  #disposed = false
  #counters: Counters = { runs: 0, installed: 0, reused: 0, failed: 0, verifies: 0 }
  /** 上次解析出来的组件（`status()` 用，避免每次读清单）。 */
  #components: readonly ComponentSpec[] = Object.freeze([])
  #cache: ParseCache | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: InstallerDeps) {
    this.#deps = deps
    this.#source = deps.source
    this.#sink = deps.sink
    this.#runtime = deps.runtime
    this.#ledger = deps.store.read().ledger
  }

  /** 能不能装（配置齐不齐）。 */
  get available(): boolean {
    return this.reason === undefined
  }

  /** 不能装的原因。 */
  get reason(): InstallerReason | undefined {
    const settings = this.#deps.settings()
    if (!settings.enable) return 'disabled'
    if (settings.manifestPath === '') return 'no-manifest'
    if (settings.sourceDir === '' || this.#source === null) return 'no-source'
    if (settings.destDir === '' || this.#sink === null) return 'no-dest'
    if (this.#deps.store.path === undefined) return 'no-ledger'
    return undefined
  }

  /** 九步计划（只读）。 */
  async plan(): Promise<InstallPlanView> {
    const parsed = this.#parse()
    const settings = this.#deps.settings()
    const components = parsed.ok ? parsed.components : Object.freeze([]) as readonly ComponentSpec[]
    const reason = this.reason
    return Object.freeze({
      steps: Object.freeze(STEP_DECLS.map(item => ({ id: item.id, title: item.title, source: item.source }))),
      components,
      dryRun: settings.dryRun,
      ...(reason !== undefined
        ? { reason }
        : parsed.ok
          ? {}
          : { reason: 'no-manifest' as InstallerReason }),
    })
  }

  /** 跑一轮。**永不抛错**。 */
  async run(options?: { readonly dryRun?: boolean }): Promise<InstallRun> {
    const settings = this.#deps.settings()
    const dryRun = options?.dryRun ?? settings.dryRun
    const startedAt = this.#deps.now()

    if (this.#disposed) return this.#aborted(startedAt, dryRun, 'installer-disposed', '安装器已卸载')
    if (!settings.enable) return this.#aborted(startedAt, dryRun, 'disabled', '安装器关着（`enable=false`）')

    // 每轮重读清单：缓存只服务「同一轮的连续查询」，不能跨轮——否则改完清单重跑会读到旧组件。
    this.#cache = undefined
    this.#counters.runs += 1
    this.#deps.log.info('开始%s：%s', dryRun ? '演练' : '安装', settings.manifestPath)

    try {
      const run = await runPipeline({
        settings,
        dryRun,
        log: this.#deps.log,
        now: this.#deps.now,
        source: this.#source,
        sink: this.#sink,
        runtime: this.#runtime,
        ledger: () => this.#ledger,
        save: ledger => {
          this.#ledger = ledger
          this.#deps.store.write(ledger)
        },
        verify: () => this.verify(),
      })
      // 流水线自己解析清单、不写服务缓存；这里刷一次，让 `status().components`
      // 与本轮实际使用的组件数一致（少这步，装完面板还显示 0 个组件）。
      this.#cache = undefined
      this.#parse()

      this.#counters.installed += run.installed.length
      this.#counters.reused += run.reused.length
      this.#counters.failed += run.failed.length
      this.#deps.log.info(
        '结束：%s（新装 %d，复用 %d，失败 %d）',
        run.verdict,
        run.installed.length,
        run.reused.length,
        run.failed.length,
      )
      return run
    } catch (error) {
      // `runPipeline` 自己也不抛，这里是最后一道网：真抛了也要给出形状完整的结论。
      this.#deps.log.error('安装流水线异常：%s', textOf(error))
      this.#counters.failed += 1
      return this.#aborted(startedAt, dryRun, 'installer-error', `流水线异常：${textOf(error)}`)
    }
  }

  /** `bootstrap-ok` 自检。 */
  async verify(): Promise<BootstrapReport> {
    this.#counters.verifies += 1
    const checkedAt = this.#deps.now()
    const settings = this.#deps.settings()
    const read = this.#deps.store.read()
    const ledger = read.ledger
    const checks: BootstrapCheck[] = []

    // 1. 账本
    if (read.missing) {
      checks.push(check('ledger', '账本存在', 'unverifiable', '没有账本', [], '先跑一次 `run()`（并关掉 `dryRun`）'))
    } else if (read.corrupt) {
      checks.push(
        check('ledger', '账本存在', 'fail', '账本读不懂（已按没有账本处理）', [], '删掉账本重装：读不懂的账本会让每次自检都判不了'),
      )
    } else if (ledger === undefined) {
      checks.push(check('ledger', '账本存在', 'unverifiable', '账本为空'))
    } else {
      checks.push(check('ledger', '账本存在', 'pass', `${String(ledger.components.length)} 条记录`))
    }

    const parsed = this.#parse()

    // 2. 覆盖
    if (!parsed.ok) {
      checks.push(check('coverage', '清单覆盖', 'unverifiable', '没有可读的清单，判不了覆盖', [], '先把清单问题修掉'))
    } else if (ledger === undefined) {
      checks.push(check('coverage', '清单覆盖', 'unverifiable', '没有账本，判不了覆盖'))
    } else {
      const missing: string[] = []
      const pending: string[] = []
      for (const comp of parsed.components) {
        const entry = findComponent(ledger, comp.path)
        if (entry === undefined) {
          if (!comp.optional) missing.push(`${comp.path} → 账上完全没有`)
          continue
        }
        if (entry.status === 'pending') pending.push(`${comp.path} → 装到一半（pending）`)
        else if (entry.status === 'failed') missing.push(`${comp.path} → 上次失败`)
      }
      const findings = [...missing, ...pending]
      checks.push(
        findings.length === 0
          ? check('coverage', '清单覆盖', 'pass', `${String(parsed.components.length)} 个组件都有账`)
          : check(
              'coverage',
              '清单覆盖',
              'fail',
              `${String(findings.length)} 个组件没装好`,
              findings,
              '重跑 `run()`；`pending` 说明上次进程被杀在复制中途',
            ),
      )
    }

    // 3. 文件与内容
    if (ledger === undefined || ledger.components.length === 0) {
      checks.push(check('files', '文件与内容', 'unverifiable', '账本里没有可验的组件'))
    } else {
      const findings: string[] = []
      const byPath = new Map((parsed.ok ? parsed.components : []).map(comp => [comp.path, comp] as const))
      let hashed = 0
      for (const entry of ledger.components) {
        if (entry.status !== 'installed') continue
        const spec = byPath.get(entry.path)
        const dest =
          spec === undefined ? join(settings.destDir, basename(entry.file)) : destPathOf(settings, spec)
        if (this.#sink !== null && !this.#sink.exists(dest)) {
          findings.push(`${entry.path} → 文件不在：${dest}`)
          continue
        }
        try {
          const actual = await hashFile(dest)
          hashed += 1
          if (actual !== entry.sha256) {
            findings.push(
              `${entry.path} → 内容变了：账上 ${entry.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
            )
          }
        } catch (error) {
          findings.push(`${entry.path} → 读不出来：${textOf(error)}`)
        }
      }
      checks.push(
        findings.length === 0
          ? check('files', '文件与内容', 'pass', `${String(hashed)} 个文件哈希一致`)
          : check(
              'files',
              '文件与内容',
              'fail',
              `${String(findings.length)} 个文件对不上`,
              findings,
              '重装受影响的组件；若被外部改过，先确认那是你自己改的',
            ),
      )
    }

    // 4. 清单漂移
    if (!parsed.ok) {
      checks.push(check('manifest-drift', '清单一致', 'unverifiable', '清单读不出来，判不了漂移'))
    } else if (ledger?.manifestSha256 === undefined) {
      checks.push(check('manifest-drift', '清单一致', 'unverifiable', '账本里没记清单摘要（旧账本，或没完成过一轮）'))
    } else if (ledger.manifestSha256 === parsed.digest) {
      checks.push(check('manifest-drift', '清单一致', 'pass', `摘要 ${parsed.digest.slice(0, 12)}…`))
    } else {
      checks.push(
        check(
          'manifest-drift',
          '清单一致',
          'fail',
          '账本记的是另一份清单',
          [`账上 ${ledger.manifestSha256.slice(0, 12)}…，当前 ${parsed.digest.slice(0, 12)}…`],
          '清单换了就重跑 `run()`；这条挡的是「清单更新了但没重装」',
        ),
      )
    }

    // 5. 完成戳
    if (ledger?.bootstrapAt === undefined) {
      checks.push(
        check('stamp', '完成戳', 'fail', '没有 `bootstrapAt`：没完成过一整轮', [], '重跑 `run()` 直到 `verdict: ok`'),
      )
    } else {
      checks.push(check('stamp', '完成戳', 'pass', new Date(ledger.bootstrapAt).toISOString()))
    }

    const fails = checks.filter(item => item.verdict === 'fail')
    const unable = checks.filter(item => item.verdict === 'unverifiable')
    const verdict = fails.length > 0 ? 'fail' : unable.length > 0 ? 'unverifiable' : 'ok'
    const bootstrapOk = fails.length > 0 ? false : unable.length > 0 ? null : true

    return Object.freeze({ verdict, bootstrapOk, checks: Object.freeze(checks), checkedAt })
  }

  /** 当前账本快照。 */
  ledger(): BootstrapLedger | undefined {
    return this.#ledger
  }

  /** 九步声明。 */
  steps(): readonly { readonly id: StepId; readonly title: string; readonly source: string }[] {
    return Object.freeze(STEP_DECLS.map(item => ({ id: item.id, title: item.title, source: item.source })))
  }

  /** 现状。 */
  status(): InstallerStatus {
    const settings = this.#deps.settings()
    const reason = this.reason
    const path = this.#deps.store.path
    return Object.freeze({
      available: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      components: this.#components.length,
      dryRun: settings.dryRun,
      manifestPath: settings.manifestPath,
      sourceDir: settings.sourceDir,
      destDir: settings.destDir,
      ...(path === undefined ? {} : { ledgerPath: path }),
    })
  }

  /** 计数。 */
  stats(): InstallerStats {
    return Object.freeze({ ...this.#counters })
  }

  /** 换读源。 */
  useSource(source: ComponentSource | null): void {
    this.#source = source
  }

  /** 换写目标。 */
  useSink(sink: FileSink | null): void {
    this.#sink = sink
  }

  /** 换运行环境探针。 */
  useRuntime(probe: RuntimeProbe | null): void {
    this.#runtime = probe
  }

  /** 撤（幂等）。 */
  dispose(): void {
    this.#disposed = true
    this.#source = null
    this.#sink = null
  }

  /**
   * 解析清单。缓存键是「路径 + 组件上限」：配置没变就不重读文件，
   * `run()` 开头会主动清缓存（见那里的注释）。
   */
  #parse(): ManifestParse {
    const settings = this.#deps.settings()
    const key = `${settings.manifestPath}|${String(settings.maxComponents)}`
    if (this.#cache?.key === key) return this.#cache.parsed

    const parsed = this.#readManifest(settings)
    this.#cache = { key, parsed }
    this.#components = parsed.ok ? parsed.components : Object.freeze([])
    return parsed
  }

  /**
   * 真的去读并解析。
   * @param settings 配置。
   */
  #readManifest(settings: Config): ManifestParse {
    if (settings.manifestPath === '') {
      return Object.freeze({
        ok: false,
        issues: Object.freeze([{ path: 'manifestPath', reason: 'no-file', message: '没配清单路径' }]),
      } satisfies ManifestParse)
    }
    let text: string
    try {
      text = readFileSync(settings.manifestPath, 'utf8')
    } catch (error) {
      return Object.freeze({
        ok: false,
        issues: Object.freeze([
          { path: 'manifestPath', reason: 'no-file', message: `读不出来：${textOf(error)}` },
        ]),
      } satisfies ManifestParse)
    }
    return parseManifest(text, { maxComponents: settings.maxComponents })
  }

  /** 造一份「一步都没跑」的结论。 */
  #aborted(startedAt: number, dryRun: boolean, code: string, detail: string): InstallRun {
    const step: StepResult = Object.freeze({
      id: 'preflight',
      title: STEP_DECLS[0]?.title ?? '环境预检',
      status: 'blocked',
      detail,
      findings: Object.freeze([code]),
      source: STEP_DECLS[0]?.source ?? '',
    })
    return Object.freeze({
      dryRun,
      startedAt,
      finishedAt: this.#deps.now(),
      steps: Object.freeze([step]),
      verdict: 'blocked',
      installed: Object.freeze([]),
      reused: Object.freeze([]),
      failed: Object.freeze([]),
    })
  }
}
