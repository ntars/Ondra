/**
 * O-133 的实现：把一个 profile 目录算成「宿主会看到的那份入口树」。
 *
 * ## 三条实现裁决
 *
 * 1. **逐层应用，不是把多层摊平后一次性应用。** 宿主 `composeEntries` 是
 *    `applyEntryPatches([], layers.flat(), warn)`。本包逐层调用同一份移植函数，
 *    语义等价（两边都「边插边索引」，所以后层能命中前层插的行），差别只有
 *    告警里的层名与每层新增计数——而那两个正是本包存在的理由。
 * 2. **报告按内容指纹缓存，不装定时器。** 30 秒 TTL 在读取时比对；指纹 =
 *    profile 清单 mtime + 每个补丁文件 mtime/大小。这样「改完文件立刻再看」
 *    会重读，而「界面一秒刷十次」只算一次。
 * 3. **`inspect()` 永不抛错。** 它被启动自检和界面同时调用，抛一次就会被永久关掉。
 *    任何异常都折成 `verdict:'unverifiable'` + 一条 finding。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BundleLayerView,
  DoctorCache,
  DoctorReason,
  DoctorReport,
  DoctorService,
  DoctorStats,
  DoctorVerdict,
  EntryTree,
  InspectOptions,
  LogLike,
  PatchProblem,
  SkipReport,
} from './types.js'
import { PROFILE_PATCH_FILENAME } from './types.js'
import { buildFindings, decideVerdict, renderReport, summarize } from './report.js'
import { composeEntries, inspectTree } from './compose.js'
import type { LayeredPatches } from './compose.js'
import { readLayer, readProfileFacts, readUserLayer } from './source.js'
import type { LayerFacts } from './source.js'
import type { Settings } from './settings.js'

/** 服务的依赖。 */
export interface DoctorDeps {
  /** 读当前配置。 */
  readonly settings: () => Settings
  /** 日志。 */
  readonly log: LogLike
  /** 现取时刻。 */
  readonly now: () => number
}

/**
 * 算一份内容指纹：清单 + 每个补丁文件的 mtime 与大小。
 *
 * 不用文件内容哈希：`inspect()` 可能被界面高频调用，读全文只为算哈希会把
 * 「省一次计算」变成「多读几次磁盘」。mtime + size 在「改完存盘」这件事上足够
 * ——编辑器写文件几乎必然改 mtime，即使同一秒内写完，size 也会变。
 * @param profileDir profile 目录。
 * @param layers 各层的补丁路径。
 */
function fingerprintOf(profileDir: string, paths: readonly string[]): string {
  const parts: string[] = []
  const stamp = (path: string): string => {
    try {
      const info = statSync(path)
      return String(info.mtimeMs) + ':' + String(info.size)
    } catch {
      return 'missing'
    }
  }
  parts.push('manifest=' + stamp(join(profileDir, 'package.json')))
  parts.push('user=' + stamp(join(profileDir, PROFILE_PATCH_FILENAME)))
  for (const path of paths) parts.push(path + '=' + stamp(path))
  return parts.join('|')
}

/** 实现。 */
export class InstallDoctor implements DoctorService {
  private cache?: DoctorCache
  private inspected = 0
  private lastVerdict?: DoctorVerdict
  private lastCounters = { bundles: 0, skipped: 0, fatal: 0, soft: 0, entries: 0, patchFiles: 0 }

  constructor(private readonly deps: DoctorDeps) {}

  get available(): boolean {
    return this.deps.settings().enable
  }

  get reason(): DoctorReason | undefined {
    if (!this.available) return 'disabled'
    if (this.deps.settings().profilePath === '') return 'no-profile'
    return undefined
  }

  get profileDir(): string {
    return this.deps.settings().profilePath
  }

  inspect(options: InspectOptions = {}): DoctorReport {
    const settings = this.deps.settings()
    const dir = (options.profileDir ?? settings.profilePath).trim()
    const wantText = options.text !== false

    // 没配路径：如实报 no-profile，**不猜**。
    if (dir === '') {
      return this.emptyReport('', '', 'unverifiable', '没配 `profile-path`：本包不猜路径', '把它配成 profile 目录的绝对路径（`~/.ondra/profiles/<名字>` 那类）', wantText)
    }
    if (!existsSync(dir)) {
      return this.emptyReport(dir, basename(dir), 'unverifiable', '这个路径不存在：' + dir, '检查 `profile-path` 是否写错（本包不会替你猜一个候选）', wantText)
    }

    const facts = readProfileFacts(dir, settings.maxFileBytes)
    if (!facts.manifestRead) {
      return this.emptyReport(dir, facts.name, 'unverifiable', 'profile 清单读不出来：' + (facts.problem ?? ''), '确认这个目录里有可解析的 `package.json`', wantText)
    }
    if (!facts.hasProfileBlock) {
      return this.emptyReport(dir, facts.name, 'unverifiable', facts.problem ?? '`package.json` 里没有 `ondra.profile`', '本包要的是 profile 目录（含 `ondra.profile.bundles`），不是插件包目录', wantText)
    }

    // 逐层读（读盘这一步不进缓存判定，指纹要它算出来）。
    const layerFacts: LayerFacts[] = []
    for (const packageName of facts.bundles) {
      layerFacts.push(readLayer(packageName, dir, settings.maxFileBytes, this.deps.log))
    }
    const userFacts = options.userLayer === false ? undefined : readUserLayer(dir, settings.maxFileBytes)

    const patchPaths: string[] = []
    for (const item of layerFacts) {
      for (const patch of item.layer.patches) patchPaths.push(patch.path)
    }
    if (userFacts !== undefined) {
      for (const patch of userFacts.layer.patches) patchPaths.push(patch.path)
    }
    const fingerprint = fingerprintOf(dir, patchPaths)

    // 缓存命中：同一 profile、同一指纹、TTL 内。
    const cached = this.cache
    if (
      cached !== undefined &&
      settings.ttlMs > 0 &&
      cached.profileDir === dir &&
      cached.fingerprint === fingerprint &&
      this.deps.now() - cached.report.at < settings.ttlMs
    ) {
      return wantText ? cached.report : { ...cached.report, text: '' }
    }

    // 组装层（只把「没被跳过」的层喂给补丁组合：宿主也是这样）。
    const layers: LayeredPatches[] = []
    for (const item of layerFacts) {
      if (item.layer.skipped) continue
      layers.push({ layer: item.layer.packageName, rows: item.rows })
    }
    if (userFacts !== undefined && !userFacts.layer.skipped) {
      layers.push({ layer: 'user', rows: userFacts.rows })
    }

    const warnings: PatchProblem[] = []
    const composed = composeEntries(layers)
    for (const item of composed.warnings) warnings.push(item)

    const tree = inspectTree(composed.roots, composed.provenance, problem => warnings.push(problem))

    // 回填每层新增的入口数。
    const layersOut: BundleLayerView[] = layerFacts.map(item => ({
      ...item.layer,
      entries: composed.addedByLayer[item.layer.packageName] ?? 0,
    }))
    if (userFacts !== undefined) {
      layersOut.push({ ...userFacts.layer, entries: composed.addedByLayer['user'] ?? 0 })
    }

    const fatal = warnings.filter(item => item.fatal).length
    const soft = warnings.length - fatal
    const skippedLayers = layersOut.filter(item => item.skipped)
    const skip: SkipReport = {
      bundles: Object.freeze(skippedLayers),
      warnings: Object.freeze(warnings),
      fatal,
      soft,
      // 宿主 `reportSkippedBundles` 对每个被跳过的 bundle 打一行 stderr。
      willWarnOnStderr: skippedLayers.length > 0,
    }

    const unverifiable = layerFacts.some(item => item.unsupported) || (userFacts?.unsupported ?? false)
    const verdict = decideVerdict({ tree, skip, layers: layersOut, unverifiable })
    const findings = buildFindings(verdict, { tree, skip, layers: layersOut, unverifiable })
    const at = this.deps.now()

    const text = wantText
      ? renderReport({
          profileDir: dir,
          profileName: facts.name,
          layers: layersOut,
          tree,
          skip,
          verdict,
          findings,
          at,
        })
      : ''

    const report: DoctorReport = {
      at,
      profileDir: dir,
      profileName: facts.name,
      bundles: facts.bundles.length,
      layers: Object.freeze(layersOut),
      tree,
      skip,
      verdict,
      findings,
      text,
    }

    this.cache = { profileDir: dir, fingerprint, report }
    this.inspected += 1
    this.lastVerdict = verdict
    this.lastCounters = {
      bundles: report.bundles,
      skipped: skippedLayers.length,
      fatal,
      soft,
      entries: tree.total,
      patchFiles: patchPaths.length,
    }

    if (settings.verbose) {
      for (const item of warnings) {
        this.deps.log.warn('补丁告警%s（%s）：%s', item.fatal ? '·致命' : '', item.layer ?? '?', item.message)
      }
    }
    this.deps.log.info('安装自检：%s', summarize(report))
    return report
  }

  tree(options: InspectOptions = {}): EntryTree {
    return this.inspect({ ...options, text: false }).tree
  }

  skip(options: InspectOptions = {}): SkipReport {
    return this.inspect({ ...options, text: false }).skip
  }

  stats(): DoctorStats {
    return {
      at: this.deps.now(),
      inspected: this.inspected,
      bundles: this.lastCounters.bundles,
      skipped: this.lastCounters.skipped,
      fatal: this.lastCounters.fatal,
      soft: this.lastCounters.soft,
      entries: this.lastCounters.entries,
      patchFiles: this.lastCounters.patchFiles,
      lastVerdict: this.lastVerdict,
    }
  }

  invalidate(): void {
    this.cache = undefined
  }

  /**
   * 造一份「判不了」的报告。
   * @param dir profile 目录。
   * @param profileName profile 名。
   * @param verdict 结论（这里只会是 unverifiable）。
   * @param detail 一句结论。
   * @param hint 怎么修。
   * @param wantText 是否生成文本报告。
   */
  private emptyReport(
    dir: string,
    profileName: string,
    verdict: DoctorVerdict,
    detail: string,
    hint: string,
    wantText: boolean,
  ): DoctorReport {
    const at = this.deps.now()
    const tree: EntryTree = {
      roots: Object.freeze([]),
      rows: Object.freeze([]),
      total: 0,
      groups: 0,
      leaves: 0,
      disabled: 0,
      maxDepth: 0,
    }
    const skip: SkipReport = {
      bundles: Object.freeze([]),
      warnings: Object.freeze([]),
      fatal: 0,
      soft: 0,
      willWarnOnStderr: false,
    }
    const findings = Object.freeze([
      { level: 'error' as const, detail, hint },
    ])
    const text = wantText
      ? renderReport({ profileDir: dir, profileName, layers: [], tree, skip, verdict, findings, at })
      : ''
    this.inspected += 1
    this.lastVerdict = verdict
    return {
      at,
      profileDir: dir,
      profileName,
      bundles: 0,
      layers: Object.freeze([]),
      tree,
      skip,
      verdict,
      findings,
      text,
    }
  }
}

/**
 * 取目录的 basename（不引 `node:path` 只为这一处）。
 * @param dir 绝对路径。
 */
function basename(dir: string): string {
  const parts = dir.split('/').filter(part => part !== '')
  return parts.length === 0 ? dir : parts[parts.length - 1]
}
