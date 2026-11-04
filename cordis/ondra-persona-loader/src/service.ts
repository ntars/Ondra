/**
 * 人设注册表：谁在、谁是出厂、当前是谁、文本缓存在哪。
 *
 * 三个设计取舍，都是「不这样做就会静默出错」的地方：
 *
 * 1. **同 id 用户根胜出，且记 `duplicate-id`。**
 *    反过来的话，用户导入一版改过的人设永远被随包版本盖住，
 *    而界面上两个包长得一模一样，没人能看出为什么改了没生效。
 *
 * 2. **当前人设不存在时，`active()` 返回 `undefined`，不退回「第一个」。**
 *    配置写着 `activePersona: 'xxx'` 而 xxx 不存在，正确表现是「说它没找到」；
 *    悄悄换成别人，用户会以为「我配的那个就是长这样」。
 *
 * 3. **文本缓存按 FIFO 淘汰，且有字节上限。**
 *    缓存是为了不违反 §8.2 反模式②（每次组装提示词都做 IO）；
 *    不设上限则「导入 50 个人设」会把几百 MB 文本钉在内存里。
 *    用 FIFO 而不是 LRU：命中顺序不改变淘汰顺序，行为可预测——
 *    这个缓存的生命周期只有「一次会话」，精细度换不来收益。
 */

import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { listArchives, loadOne, resolveRoots } from './scan.js'
import type { LoadOutcome } from './scan.js'
import { FACTORY_PERSONA_ID, SAMPLE_PERSONA_ID } from './types.js'
import type {
  PersonaDetail,
  PersonaFileEntry,
  PersonaIssue,
  PersonaIssueCode,
  PersonaLoaderService,
  PersonaRoot,
  PersonaRole,
  PersonaStats,
  PersonaSummary,
  PersonaUnavailableReason,
  ScanReport,
} from './types.js'
import type { Config } from './settings.js'
import type { LogLike, PathLayoutLike } from './types.js'
import { normalizeRelPath, openZip, readTextEntry } from './zip.js'

/** 缓存里的一条文本。`text` 为 `undefined` 表示「查过了，包里没有」。 */
interface CacheEntry {
  readonly text: string | undefined
  readonly bytes: number
}

/** 人设注册表。 */
export class PersonaRegistry implements PersonaLoaderService {
  /** 是否可用。 */
  available = true
  /** 不可用原因。 */
  reason: PersonaUnavailableReason | undefined = undefined

  private readonly settings: Config
  private readonly log: LogLike
  private readonly pathLayout: PathLayoutLike | undefined
  private readonly now: () => number

  private readonly personas = new Map<string, PersonaDetail>()
  private readonly textCache = new Map<string, CacheEntry>()
  private issues: readonly PersonaIssue[] = Object.freeze([])
  // 根清单实例。与方法 roots() 同名会冲突，故取别名。
  private rootList: readonly PersonaRoot[] = Object.freeze([])
  private activeIdValue: string | undefined
  private cachedBytes = 0
  private lastScanAt = 0
  private lastScanMs = 0
  private lastFound = 0
  private lastSkipped = 0

  /**
   * @param pathLayout O-002 路径服务（缺席则只扫随包根）。
   * @param log 日志。
   * @param settings 配置。
   * @param now 时钟（注入以便静态推演）。
   */
  constructor(pathLayout: PathLayoutLike | undefined, log: LogLike, settings: Config, now: () => number) {
    this.pathLayout = pathLayout
    this.log = log
    this.settings = settings
    this.now = now
    this.activeIdValue = settings.activePersona
    if (!settings.enable) {
      this.available = false
      this.reason = 'disabled'
    }
  }

  /**
   * 重扫两个根。**永不抛错**。
   */
  refresh(): ScanReport {
    const startedAt = this.now()
    const issues: PersonaIssue[] = []
    this.personas.clear()
    this.textCache.clear()
    this.cachedBytes = 0

    if (!this.settings.enable) {
      this.available = false
      this.reason = 'disabled'
      const report: ScanReport = Object.freeze({
        at: startedAt,
        durationMs: 0,
        roots: this.rootList,
        found: 0,
        loaded: 0,
        skipped: 0,
        issues: Object.freeze(issues),
      })
      return report
    }

    let roots: PersonaRoot[] = []
    try {
      roots = resolveRoots({ settings: this.settings, pathLayout: this.pathLayout })
    } catch (error) {
      this.available = false
      this.reason = 'scan-failed'
      this.log.error('解析人设包扫描根失败：%s', messageOf(error))
      const report: ScanReport = Object.freeze({
        at: startedAt,
        durationMs: this.now() - startedAt,
        roots: this.rootList,
        found: 0,
        loaded: 0,
        skipped: 0,
        issues: Object.freeze(issues),
      })
      return report
    }

    let found = 0
    let skipped = 0
    const counted: PersonaRoot[] = []
    let overCapReported = false

    for (const root of roots) {
      let archives: string[] = []
      if (root.exists) {
        try {
          archives = listArchives(root.path)
        } catch (error) {
          issues.push({
            code: 'zip-error',
            file: root.display,
            detail: '列目录失败：' + messageOf(error),
          })
        }
      }
      counted.push(Object.freeze({ ...root, found: archives.length }))

      for (const archivePath of archives) {
        found += 1
        if (this.personas.size >= this.settings.maxPersonas) {
          if (!overCapReported) {
            overCapReported = true
            issues.push({
              code: 'over-cap',
              file: root.display,
              detail:
                '已注册 ' +
                String(this.personas.size) +
                ' 个人设，达到上限 ' +
                String(this.settings.maxPersonas) +
                '，后面的包没扫（不淘汰已注册的，请自己删掉不用的包）',
            })
          }
          skipped += 1
          continue
        }
        let outcome: LoadOutcome
        try {
          outcome = loadOne(archivePath, root.kind, this.settings)
        } catch (error) {
          // loadOne 内部已经全包了 try/catch，走到这里说明是它自己也想不到的错。
          skipped += 1
          issues.push({
            code: 'zip-error',
            file: basename(archivePath),
            detail: '装包时发生意外错误：' + messageOf(error),
          })
          continue
        }
        for (const issue of outcome.issues) issues.push(issue)
        const detail = outcome.detail
        if (detail === undefined) {
          skipped += 1
          continue
        }
        const existing = this.personas.get(detail.id)
        if (existing !== undefined) {
          skipped += 1
          issues.push({
            code: 'duplicate-id',
            id: detail.id,
            file: detail.archiveName,
            detail:
              '人设 id「' +
              detail.id +
              '」已被 ' +
              existing.rootKind +
              ' 根的「' +
              existing.archiveName +
              '」占用，本包被跳过（用户根优先于随包根）',
          })
          continue
        }
        this.personas.set(detail.id, Object.freeze({ ...detail, role: this.roleOf(detail.id) }))
      }
    }

    this.rootList = Object.freeze(counted)
    this.issues = Object.freeze(trimIssues(issues, this.settings.keepIssues))
    this.lastFound = found
    this.lastSkipped = skipped
    this.lastScanAt = this.now()
    this.lastScanMs = this.lastScanAt - startedAt

    const anyRoot = counted.some(root => root.exists)
    this.available = anyRoot
    this.reason = anyRoot ? undefined : 'no-root'

    const report: ScanReport = Object.freeze({
      at: this.lastScanAt,
      durationMs: this.lastScanMs,
      roots: this.rootList,
      found,
      loaded: this.personas.size,
      skipped,
      issues: this.issues,
    })
    return report
  }

  /** 按 id 判角色（只比 id，不看文件名，见 `types.ts` 维护纪律第 4 条）。 */
  private roleOf(id: string): PersonaRole {
    if (id === this.settings.factoryPersona) return 'factory'
    if (id === this.settings.samplePersona) return 'sample'
    return 'user'
  }

  /** 已注册人设清单（`role` 优先：出厂 → 示例 → 用户，再按 id）。 */
  list(): readonly PersonaSummary[] {
    const order: Record<PersonaRole, number> = { factory: 0, sample: 1, user: 2 }
    return Object.freeze(
      Array.from(this.personas.values())
        .slice()
        .sort((left, right) => {
          const byRole = order[left.role] - order[right.role]
          if (byRole !== 0) return byRole
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        })
        .map(toSummary),
    )
  }

  /** 取详情。 */
  get(id: string): PersonaDetail | undefined {
    return this.personas.get(id)
  }

  /** 有没有。 */
  has(id: string): boolean {
    return this.personas.has(id)
  }

  /** 扫描根。 */
  roots(): readonly PersonaRoot[] {
    return this.rootList
  }

  /**
   * 读包内一个文本文件。首次读会解包，之后走缓存（含「没有这个文件」的负缓存）。
   */
  readText(id: string, relPath: string): string | undefined {
    const detail = this.personas.get(id)
    if (detail === undefined) return undefined
    const normalized = normalizeRelPath(relPath)
    if (normalized === '') return undefined
    const key = id + '\u0000' + normalized
    const hit = this.textCache.get(key)
    if (hit !== undefined) return hit.text

    const entry = detail.files.find(file => file.path === normalized)
    if (entry !== undefined && entry.bytes > this.settings.maxEntryBytes) {
      this.remember(key, undefined, 0)
      this.log.warn('「%s」里的「%s」有 %d 字节，超过单文件上限，拒绝读入', id, normalized, entry.bytes)
      return undefined
    }

    let text: string | undefined
    try {
      const archive = openZip(readFileSync(detail.archivePath), detail.archiveName)
      text = readTextEntry(archive, normalized)
    } catch (error) {
      // 解包失败在这里不升级成 issue：`refresh()` 时已经报过一次，
      // 每次组装提示词都记一条会把日志刷满。
      this.log.debug?.('读「%s」的「%s」失败：%s', id, normalized, messageOf(error))
      text = undefined
    }
    this.remember(key, text, text === undefined ? 0 : Buffer.byteLength(text, 'utf8'))
    return text
  }

  /** 写缓存并按预算 FIFO 淘汰。 */
  private remember(key: string, text: string | undefined, bytes: number): void {
    this.textCache.set(key, { text, bytes })
    this.cachedBytes += bytes
    while (this.cachedBytes > this.settings.maxTextCacheBytes && this.textCache.size > 1) {
      const oldest = this.textCache.keys().next()
      if (oldest.done === true) break
      const evicted = this.textCache.get(oldest.value)
      this.textCache.delete(oldest.value)
      this.cachedBytes -= evicted === undefined ? 0 : evicted.bytes
    }
  }

  /** 文件清单。 */
  files(id: string): readonly PersonaFileEntry[] {
    const detail = this.personas.get(id)
    return detail === undefined ? Object.freeze([]) : detail.files
  }

  /** 当前人设 id。 */
  activeId(): string | undefined {
    return this.activeIdValue
  }

  /** 当前人设详情；配的 id 不存在时 `undefined`（**不退回第一个**）。 */
  active(): PersonaDetail | undefined {
    return this.activeIdValue === undefined ? undefined : this.personas.get(this.activeIdValue)
  }

  /** 切换当前人设（只改内存态；人设不存在时不动当前值并返回 `false`）。 */
  setActive(id: string): boolean {
    if (!this.personas.has(id)) {
      this.log.warn('没有叫「%s」的人设，当前人设保持「%s」不变', id, this.activeIdValue ?? '（未设置）')
      return false
    }
    this.activeIdValue = id
    return true
  }

  /** 统计快照。 */
  stats(): PersonaStats {
    const byRole: Record<PersonaRole, number> = { factory: 0, sample: 0, user: 0 }
    for (const detail of this.personas.values()) byRole[detail.role] += 1
    return Object.freeze({
      available: this.available && this.lastScanAt > 0,
      reason: this.reason,
      total: this.personas.size,
      byRole: Object.freeze(byRole),
      activeId: this.activeIdValue !== undefined && this.personas.has(this.activeIdValue) ? this.activeIdValue : null,
      factoryPresent: this.personas.has(this.settings.factoryPersona),
      samplePresent: this.personas.has(this.settings.samplePersona),
      roots: this.rootList,
      lastScanAt: this.lastScanAt,
      lastScanMs: this.lastScanMs,
      cachedTextBytes: this.cachedBytes,
      issues: this.issues,
    })
  }

  /** 上次扫描找到/跳过几个包（日志用）。 */
  lastCounts(): { readonly found: number; readonly skipped: number } {
    return { found: this.lastFound, skipped: this.lastSkipped }
  }
}

/** 错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 截断问题清单。
 * @param issues 全部问题。
 * @param keep 保留条数。
 */
function trimIssues(issues: readonly PersonaIssue[], keep: number): readonly PersonaIssue[] {
  if (keep <= 0) return Object.freeze([])
  if (issues.length <= keep) return issues
  const kept = issues.slice(0, keep - 1)
  const truncated: PersonaIssue = {
    code: 'issue-truncated' as PersonaIssueCode,
    file: '',
    detail: '还有 ' + String(issues.length - kept.length) + ' 条问题没显示',
  }
  return Object.freeze([...kept, truncated])
}

/** 详情转摘要（丢掉 `profile` / `files` 这类重字段）。 */
function toSummary(detail: PersonaDetail): PersonaSummary {
  return Object.freeze({
    id: detail.id,
    name: detail.name,
    displayName: detail.displayName,
    version: detail.version,
    role: detail.role,
    rootKind: detail.rootKind,
    archivePath: detail.archivePath,
    archiveName: detail.archiveName,
    triggerWords: detail.triggerWords,
    tags: detail.tags,
    tagsSource: detail.tagsSource,
    language: detail.language,
    skillChars: detail.skillChars,
    fileCount: detail.fileCount,
    archiveBytes: detail.archiveBytes,
  })
}

/** 供自检脚本核对「出厂/示例 id 常量与实包一致」用。 */
export const KNOWN_PERSONA_IDS: readonly string[] = Object.freeze([FACTORY_PERSONA_ID, SAMPLE_PERSONA_ID])
