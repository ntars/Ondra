/**
 * 服务层：目录 → 索引 → 取图。
 *
 * ## 三层顺序是"谁的图优先"，不是"哪层更可靠"
 *
 * ```
 * 人设包  →  共享包  →  内置包（含注册进来的）
 * ```
 *
 * 人设包优先，是因为**那才是"她的"表情**；共享包是"所有角色都能用的"；
 * 内置是"别人画的、兜底的"。反过来排的话，用户给人设专门放了一张图，
 * 却永远看到内置那张——而面板上两个包都显示"已加载"。
 *
 * ## 轮转而不是随机
 *
 * 同一个标签下有多张图时，按序号轮着用：连取两次必换一张，取完一轮才循环。
 * 随机会出现"连着三次同一张"（概率并不低），而用户的感受是"图没换"。
 * 轮转还有一个副作用是好的：**顺序可复现**，出了问题能按日志重放。
 *
 * ## 缓存与失效
 *
 * 目录扫描要 stat 每个文件，不能每次取图都扫。所以有 TTL（默认 60 秒）。
 * 三件事会主动让缓存失效：`refresh(true)`、`registerPack()`、`registerAlias()`。
 * 最后一条最容易被忘：改一条同义关系会让**所有包的标签**都变，
 * 不清缓存的话，`pick('高兴')` 会在接下来一分钟里继续 `no-tag`。
 */

import { joinPath } from './fs.js'
import { packFromFiles, scanDir } from './scan.js'
import type { ScannedPack, ScanDeps } from './scan.js'
import { aliasIssues, buildAliasTable, canonicalOf, orderOf, rawTagOf } from './tags.js'
import type { Config } from './settings.js'
import type {
  FsLike,
  LogLike,
  PackRegistration,
  PathLayoutLike,
  PersonaCoreLike,
  PickOptions,
  StickerDegraded,
  StickerEntry,
  StickerPackView,
  StickerPick,
  StickerReason,
  StickerService,
  StickerStats,
} from './types.js'
import { NAME_RE } from './types.js'

/** 服务依赖（全部注入，便于脱离宿主逐例核对）。 */
export interface StoreDeps {
  readonly settings: Config
  readonly log: LogLike
  /** 取当前时刻（缓存新鲜度用）。 */
  readonly now: () => number
  /** 文件系统。 */
  readonly fs: FsLike
  /** 取 O-002（可能后装载，因此每次现取）。 */
  readonly pathLayout: () => PathLayoutLike | undefined
  /** 取 O-020（当前人设 id）。 */
  readonly persona: () => PersonaCoreLike | undefined
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一次"找图"的结果（`pick` 与 `resolve` 共用）。 */
interface Located {
  readonly reason: StickerReason
  readonly tag: string
  readonly packId?: string
  readonly candidates: readonly StickerEntry[]
  readonly degraded: readonly StickerDegraded[]
}

/** 贴纸服务实现。 */
export class StickerStore implements StickerService {
  /** 配置。 */
  private readonly settings: Config
  /** 日志。 */
  private readonly log: LogLike
  /** 时钟。 */
  private readonly now: () => number
  /** 文件系统。 */
  private readonly fs: FsLike
  /** 取路径服务。 */
  private readonly pathLayout: () => PathLayoutLike | undefined
  /** 取人设服务。 */
  private readonly persona: () => PersonaCoreLike | undefined

  /** 同义表（种子 + 注册）。 */
  private table: Map<string, string> = buildAliasTable()
  /** 额外的同义关系（注册进来的，原始写法）。 */
  private extra: [string, string][] = []
  /** 注册进来的包（原始入参，便于重建）。 */
  private inputs: PackRegistration[] = []
  /** 注册包的重建缓存。 */
  private registeredCache: ScannedPack[] | null = null
  /** 磁盘索引缓存。 */
  private cache: { readonly at: number; readonly packs: readonly ScannedPack[] } | null = null
  /** 轮转游标：`包id|标签` → 下一个下标。 */
  private readonly cursors = new Map<string, number>()

  /** 扫描次数。 */
  private scans = 0
  /** 累计跳过的文件数。 */
  private skipped = 0
  /** 取图次数。 */
  private picks = 0
  /** 没取到的次数。 */
  private misses = 0
  /** 最近一次结果码。 */
  private lastReason: StickerReason | undefined
  /** 最近一次错误。 */
  private lastError: string | undefined

  constructor(deps: StoreDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.now = deps.now
    this.fs = deps.fs
    this.pathLayout = deps.pathLayout
    this.persona = deps.persona
  }

  /** 是否可用：只看开关（拼不出根目录时 `pick()` 报 `no-root`）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): 'disabled' | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /**
   * 装载期建目录。**只建默认根下的三个**，不碰 `personas/`（那是 O-020 的地盘）。
   * @returns 建好的目录数（拼不出路径或出错时为 0）。
   */
  prepare(): number {
    if (!this.settings.createDirs) return 0
    const layout = this.pathLayout()
    if (layout === undefined) return 0
    const ensure = layout.ensure
    if (typeof ensure !== 'function') return 0

    let made = 0
    for (const segments of [
      [this.settings.userSubdir],
      [this.settings.userSubdir, 'shared'],
      [this.settings.userSubdir, 'builtin'],
    ]) {
      try {
        ensure.call(layout, 'user', ...segments)
        made += 1
      } catch (error) {
        // 建不出来不是致命：用户可能就想把图放在 `rootOverride` 指的地方。
        this.lastError = messageOf(error)
        this.log.warn('建贴纸目录失败（%s）：%s', segments.join('/'), messageOf(error))
      }
    }
    return made
  }

  /** 全部包。 */
  packs(): readonly StickerPackView[] {
    return this.index(false).map(pack => pack.view)
  }

  /**
   * 标签列表。
   * @param packId 包 id；省略则合并全部包。
   */
  tags(packId?: string): readonly string[] {
    const set = new Set<string>()
    for (const pack of this.index(false)) {
      if (packId !== undefined && pack.view.id !== packId) continue
      for (const entry of pack.entries) set.add(entry.tag)
    }
    return Object.freeze([...set].sort((a, b) => a.localeCompare(b, 'zh')))
  }

  /**
   * 取一张（推进轮转）。
   * @param tag 标签。
   * @param options 入参。
   */
  pick(tag: string, options?: PickOptions): StickerPick {
    const wanted = typeof tag === 'string' ? tag : ''
    this.picks += 1
    const located = this.locate(wanted, options)

    if (located.reason !== 'ok') {
      this.misses += 1
      this.lastReason = located.reason
      if (this.settings.verbose) {
        this.log.debug('贴纸未取到：%s（要的是「%s」）', located.reason, wanted)
      }
      return Object.freeze({
        ok: false,
        reason: located.reason,
        wanted,
        tag: located.tag,
        candidates: located.candidates.length,
        degraded: located.degraded,
      })
    }

    const key = (located.packId ?? '') + '|' + located.tag
    const size = located.candidates.length
    const at = (this.cursors.get(key) ?? 0) % size
    const entry = located.candidates[at] as StickerEntry
    // 取完一轮才回到开头：`% size` 而不是无限自增，避免长时间运行后整数溢出。
    this.cursors.set(key, (at + 1) % size)
    this.lastReason = 'ok'

    if (this.settings.verbose) {
      this.log.debug('贴纸取到：%s（%s，第 %d/%d 张）', entry.file, entry.packId, at + 1, size)
    }

    return Object.freeze({
      ok: true,
      reason: 'ok',
      wanted,
      tag: located.tag,
      packId: located.packId as string,
      entry,
      candidates: size,
      degraded: located.degraded,
    })
  }

  /**
   * 只算"会取到哪张"，不推进轮转。
   * @param tag 标签。
   * @param options 入参。
   */
  resolve(tag: string, options?: PickOptions): StickerEntry | undefined {
    const located = this.locate(typeof tag === 'string' ? tag : '', options)
    if (located.reason !== 'ok') return undefined
    const key = (located.packId ?? '') + '|' + located.tag
    const at = (this.cursors.get(key) ?? 0) % located.candidates.length
    return located.candidates[at]
  }

  /**
   * 重扫。
   * @param force 为 `false` 时缓存还新鲜就直接返回旧索引。
   */
  refresh(force?: boolean): readonly StickerPackView[] {
    return this.index(force === true).map(pack => pack.view)
  }

  /**
   * 注册一个内存包（内置兜底的入口）。
   * @param input 入参。
   * @returns 撤销函数。
   */
  registerPack(input: PackRegistration): () => void {
    if (!NAME_RE.test(input.id)) {
      this.log.warn('贴纸包 id 不合规（%s）：必须匹配 ^[a-z][a-z0-9_-]{1,63}$', input.id)
      return () => undefined
    }
    if (this.inputs.some(existing => existing.id === input.id)) {
      this.log.warn('贴纸包 id 已注册过（%s）：后注册的被忽略', input.id)
      return () => undefined
    }
    const reserved = this.index(false).some(pack => pack.view.id === input.id && pack.view.kind !== 'registered')
    if (reserved) {
      // 与磁盘包同名会让"取到哪张"取决于注册时机，而日志里看不出来。
      this.log.warn('贴纸包 id 与磁盘包重名（%s）：注册被忽略，请换一个 id', input.id)
      return () => undefined
    }

    this.inputs = [...this.inputs, { ...input, files: [...input.files] }]
    this.registeredCache = null
    this.cache = null

    return () => {
      this.inputs = this.inputs.filter(existing => existing.id !== input.id)
      this.registeredCache = null
      this.cache = null
    }
  }

  /**
   * 注册一条同义标签。
   * @param alias 别名。
   * @param canonical 归一到哪个标签。
   * @returns 撤销函数。
   */
  registerAlias(alias: string, canonical: string): () => void {
    const from = alias.trim()
    const to = canonical.trim()
    if (from === '' || to === '') {
      this.log.warn('同义标签不能为空（%s → %s）', alias, canonical)
      return () => undefined
    }

    const seeds: [string, string][] = [...this.extra, [from, to]]
    const next = buildAliasTable(seeds)
    const issues = aliasIssues(next)
    if (issues.length > 0) {
      // 两级跳会让「一次归一」与「两次归一」得到不同结果，宁可拒绝。
      this.log.warn('同义标签会造成两级跳，已拒绝（%s）：%s', from, issues.join(' / '))
      return () => undefined
    }

    this.extra = seeds
    this.applyTable(next)
    return () => {
      this.extra = this.extra.filter(([key]) => key !== from)
      this.applyTable(buildAliasTable(this.extra))
    }
  }

  /** 读数。 */
  stats(): StickerStats {
    const packs = this.index(false)
    let files = 0
    for (const pack of packs) files += pack.entries.length
    return Object.freeze({
      scans: this.scans,
      files,
      skipped: this.skipped,
      packs: packs.length,
      picks: this.picks,
      misses: this.misses,
      ...(this.lastReason === undefined ? {} : { lastReason: this.lastReason }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    })
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /**
   * 换一张同义表，并让所有派生数据失效。
   * @param next 新表。
   */
  private applyTable(next: Map<string, string>): void {
    this.table = next
    this.registeredCache = null
    this.cache = null
    this.cursors.clear()
  }

  /**
   * 派生标签（磁盘包与注册包共用）。
   * @param file 文件名。
   */
  private tagOf = (file: string): string => {
    const raw = rawTagOf(file)
    return this.settings.normalizeTags ? canonicalOf(raw, this.table) : raw
  }

  /** 扫描依赖。 */
  private scanDeps(): ScanDeps {
    return { fs: this.fs, tagOf: this.tagOf, orderOf, join: joinPath }
  }

  /**
   * 当前人设 id。
   * @returns `undefined` 表示拿不到（服务缺席、抛错、或没人设）。
   */
  private personaId(): string | undefined {
    const core = this.persona()
    if (core === undefined) return undefined
    const stats = core.stats
    if (typeof stats !== 'function') return undefined
    try {
      // `call` 保住 `this`：上游是类方法，脱开实例调用读到的是一份空状态。
      const id = stats.call(core).personaId
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  /**
   * 拼一个目录。
   * @param segments 相对 `user/` 的片段。
   * @returns 空串表示拼不出来（没有路径服务也没有覆盖）。
   */
  private dirOf(...segments: string[]): string {
    if (this.settings.rootOverride !== '') return joinPath(this.settings.rootOverride, ...segments)
    const layout = this.pathLayout()
    if (layout === undefined) return ''
    const fileIn = layout.fileIn
    if (typeof fileIn !== 'function') return ''
    try {
      return fileIn.call(layout, 'user', ...segments)
    } catch (error) {
      this.lastError = messageOf(error)
      return ''
    }
  }

  /** 注册包（按当前同义表重建）。 */
  private registeredPacks(): ScannedPack[] {
    if (this.registeredCache !== null) return this.registeredCache
    const deps = { tagOf: this.tagOf, orderOf }
    const packs = this.inputs.map(input =>
      packFromFiles(input.id, input.builtin === true ? 'builtin' : 'registered', input.files, deps),
    )
    this.registeredCache = packs
    return packs
  }

  /**
   * 建索引（必要时重扫）。
   * @param force 强制重扫。
   */
  private index(force: boolean): readonly ScannedPack[] {
    const cached = this.cache
    if (!force && cached !== null && this.now() - cached.at < this.settings.cacheTtlMs) {
      return cached.packs
    }

    const deps = this.scanDeps()
    const packs: ScannedPack[] = []
    const personaId = this.personaId()

    if (personaId !== undefined) {
      let done = false
      // 手册路径优先（只读兼容层）。它有图才用它——空目录不算"用户选了它"。
      if (this.settings.readLegacyPath) {
        const legacy = scanDir(personaId, 'persona', this.dirOf(this.settings.personaSubdir, personaId, 'stickers'), deps)
        if (legacy.entries.length > 0) {
          packs.push(legacy)
          done = true
        }
      }
      if (!done) {
        packs.push(scanDir(personaId, 'persona', this.dirOf(this.settings.userSubdir, personaId), deps))
      }
    }

    packs.push(scanDir('shared', 'shared', this.dirOf(this.settings.userSubdir, 'shared'), deps))
    packs.push(scanDir('builtin', 'builtin', this.dirOf(this.settings.userSubdir, 'builtin'), deps))
    packs.push(...this.registeredPacks())

    let skipped = 0
    for (const pack of packs) skipped += pack.view.skipped
    this.skipped += skipped
    this.scans += 1

    this.cache = { at: this.now(), packs }
    return packs
  }

  /**
   * 找图：算出候选，不推进游标。
   * @param wanted 原始标签。
   * @param options 入参。
   */
  private locate(wanted: string, options?: PickOptions): Located {
    const degraded: StickerDegraded[] = []
    const tag = this.settings.normalizeTags ? canonicalOf(wanted, this.table) : wanted.trim()

    if (!this.settings.enable) return { reason: 'disabled', tag, candidates: [], degraded }
    if (tag === '') return { reason: 'bad-tag', tag, candidates: [], degraded }

    const layout = this.pathLayout()
    if (this.settings.rootOverride === '' && (layout === undefined || typeof layout.fileIn !== 'function')) {
      degraded.push('no-path-layout')
      return { reason: 'no-root', tag, candidates: [], degraded }
    }

    const personaId = this.personaId()
    if (personaId === undefined) degraded.push('no-persona')

    const packs = this.index(false)
    let total = 0
    for (const pack of packs) total += pack.entries.length
    if (total === 0) {
      degraded.push('no-builtin')
      return { reason: 'no-pack', tag, candidates: [], degraded }
    }
    if (!packs.some(pack => pack.view.kind === 'builtin' && pack.entries.length > 0)) {
      degraded.push('no-builtin')
    }
    if (packs.some(pack => pack.view.error !== undefined)) degraded.push('pack-error')

    const wantedPack = options?.packId
    if (wantedPack !== undefined) {
      // 点了名就不回退：明确要 A 包却拿到 B 包的图，比拿不到更难查。
      const pack = packs.find(item => item.view.id === wantedPack)
      if (pack === undefined) return { reason: 'no-pack', tag, candidates: [], degraded }
      const candidates = pack.entries.filter(entry => entry.tag === tag)
      return candidates.length === 0
        ? { reason: 'no-tag', tag, candidates: [], degraded }
        : { reason: 'ok', tag, packId: pack.view.id, candidates, degraded }
    }

    for (const pack of packs) {
      const candidates = pack.entries.filter(entry => entry.tag === tag)
      if (candidates.length > 0) {
        return { reason: 'ok', tag, packId: pack.view.id, candidates, degraded }
      }
    }
    return { reason: 'no-tag', tag, candidates: [], degraded }
  }
}
