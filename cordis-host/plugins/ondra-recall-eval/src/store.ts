/**
 * 落盘：题集读写、报告写入、历史列表、旧报告修剪。
 *
 * **所有路径都经 O-002 的 `ensure` / `fileIn`**，本文件里不出现任何 `join(root, ...)`
 * 的绝对路径拼装——路径真源只有一个（master-plan §16.4 隔离五问第 2 条的答案
 * 就是「存在哪」必须能一句话说清）。
 *
 * 三条安全边界：
 *
 * 1. **写之前校验 `isInside`**：`ensure()` 已经拦了 `..` 逃逸，但写文件这一步
 *    再拦一次，成本为零，防护却从「依赖别人的实现」变成「自己说了算」。
 * 2. **修剪只删自己命名规则内的文件**：正则完整匹配 `<setName>-<13 位>.json|.md`。
 *    题集文件、别的题集的报告、用户自己的笔记，一条都不匹配。
 * 3. **修剪只在新报告写成功之后**：写失败还把旧的删了，等于「越跑报告越少」。
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  isReportFileOf,
  reportFileNames,
  serializeReport,
  setFileName,
  timestampOfReport,
} from './report.js'
import type { EvalReport, EvalSetSpec, LogLike, PathLayoutLike, ReportRef } from './types.js'

/** 报告所在的区域与子目录。 */
const AREA = 'user'
const SUBDIR = 'eval'

/** 错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 落盘结果。 */
export interface WriteOutcome {
  /** 是否写成。 */
  readonly ok: boolean
  /** 写成的绝对路径（json 在前）。 */
  readonly files: readonly string[]
  /** 失败原因（中文）。 */
  readonly error?: string
}

/** 报告存储。没有 `PathLayoutLike` 时 `available=false`，所有写操作安静失败。 */
export class ReportStore {
  private readonly paths: PathLayoutLike | undefined
  private readonly log: LogLike

  /**
   * @param paths 路径布局服务；`undefined` 表示不能落盘。
   * @param log 日志。
   */
  constructor(paths: PathLayoutLike | undefined, log: LogLike) {
    this.paths = paths
    this.log = log
  }

  /** 能否落盘。 */
  get available(): boolean {
    return this.paths !== undefined
  }

  /**
   * 确保报告目录存在，返回绝对路径。
   *
   * 抛错不吞：调用方需要区分「没有 path-layout」与「有但目录建不出来」。
   */
  private dir(): string {
    const paths = this.paths
    if (paths === undefined) throw new Error('没有路径服务（ondra-path-layout），无法落盘')
    return paths.ensure(AREA, SUBDIR)
  }

  /**
   * 拼一个文件的绝对路径（不创建）。
   * @param fileName 文件名。
   */
  private pathOf(fileName: string): string {
    const paths = this.paths
    if (paths === undefined) throw new Error('没有路径服务（ondra-path-layout），无法落盘')
    const filePath = paths.fileIn(AREA, SUBDIR, fileName)
    if (!paths.isInside(filePath)) {
      throw new Error(`路径「${filePath}」不在数据根内部，拒绝写入`)
    }
    return filePath
  }

  /**
   * 写一个私有文件（0600）。
   * @param fileName 文件名。
   * @param content 内容。
   */
  private write(fileName: string, content: string): string {
    this.dir()
    const filePath = this.pathOf(fileName)
    writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
    return filePath
  }

  /**
   * 读题集原始 JSON。
   * @param setName 题集名。
   */
  readSetRaw(setName: string): unknown {
    const filePath = this.pathOf(setFileName(setName))
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  }

  /**
   * 题集文件是否存在。
   * @param setName 题集名。
   */
  hasSet(setName: string): boolean {
    const paths = this.paths
    if (paths === undefined) return false
    try {
      return paths.exists(this.pathOf(setFileName(setName)))
    } catch {
      return false
    }
  }

  /**
   * 题集文件绝对路径（可能不存在）。
   * @param setName 题集名。
   */
  setPath(setName: string): string | null {
    try {
      return this.pathOf(setFileName(setName))
    } catch {
      return null
    }
  }

  /**
   * 写题集（`seed()` 用）。
   * @param setName 题集名。
   * @param spec 题集。
   */
  writeSet(setName: string, spec: EvalSetSpec): string {
    return this.write(setFileName(setName), `${JSON.stringify(spec, null, 2)}\n`)
  }

  /**
   * 写一份报告（json + md 两份）。
   *
   * 写失败不抛：报告已经算出来了，落盘失败只是「没留档」，
   * 不该让调用方拿不到指标。返回 `ok=false` 与原因。
   * @param report 报告。
   * @param markdown 人读文本。
   */
  writeReport(report: EvalReport, markdown: string): WriteOutcome {
    if (!this.available) {
      return Object.freeze({ ok: false, files: Object.freeze([]), error: '没有路径服务，报告只在内存里' })
    }
    const names = reportFileNames(report.setName, report.generatedAt)
    const files: string[] = []
    try {
      files.push(this.write(names.json, serializeReport(report)))
    } catch (error) {
      this.log.error('写评估报告（json）失败：%s', messageOf(error))
      return Object.freeze({ ok: false, files: Object.freeze([]), error: messageOf(error) })
    }
    try {
      files.push(this.write(names.markdown, markdown))
    } catch (error) {
      // md 失败不影响 json：机器读的那份最重要。
      this.log.warn('写评估报告（md）失败：%s', messageOf(error))
    }
    return Object.freeze({ ok: true, files: Object.freeze(files) })
  }

  /**
   * 列历史报告（新的在前）。
   *
   * 只列 json（md 是它的附属件），且时间戳取自**文件名**——
   * 文件内容坏了也要能列出来，否则「报告坏了」会表现为「报告不见了」。
   * @param setName 题集名。
   */
  list(setName: string): readonly ReportRef[] {
    const paths = this.paths
    if (paths === undefined) return []
    let entries: string[]
    try {
      entries = readdirSync(this.dir())
    } catch {
      return []
    }
    const found: ReportRef[] = []
    for (const entry of entries) {
      if (!isReportFileOf(entry, setName)) continue
      if (!entry.endsWith('.json')) continue
      const at = timestampOfReport(entry, setName)
      if (at === null) continue
      const markdownName = entry.slice(0, -'.json'.length) + '.md'
      const markdownPath = this.pathOf(markdownName)
      found.push(
        Object.freeze({
          generatedAt: at,
          setName,
          json: this.pathOf(entry),
          markdown: paths.exists(markdownPath) ? markdownPath : null,
        }),
      )
    }
    found.sort((a, b) => b.generatedAt - a.generatedAt)
    return Object.freeze(found)
  }

  /**
   * 读一份历史报告。
   * @param filePath json 绝对路径。
   */
  readReport(filePath: string): EvalReport | undefined {
    const paths = this.paths
    if (paths === undefined) return undefined
    if (!paths.isInside(filePath)) return undefined
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as EvalReport
    } catch (error) {
      this.log.warn('读历史报告失败（%s）：%s', filePath, messageOf(error))
      return undefined
    }
  }

  /**
   * 修剪旧报告，只保留最近 `keep` 份。
   *
   * **只删本插件命名规则内的文件**，且逐条 `isInside` 复核。
   * 删除失败只记日志不抛：报告写成功才是主线，清理是附带的。
   * @param setName 题集名。
   * @param keep 保留几份。
   */
  prune(setName: string, keep: number): readonly string[] {
    const paths = this.paths
    if (paths === undefined) return []
    const refs = this.list(setName)
    if (refs.length <= keep) return []
    const removed: string[] = []
    for (const ref of refs.slice(keep)) {
      const targets = ref.markdown === null ? [ref.json] : [ref.json, ref.markdown]
      for (const target of targets) {
        // 双重校验：正则命名的文件 + 落在数据根内部。两条都过才动。
        // `basename` 而不是按 '/' 切：Windows 的分隔符是 `\`，手切会把整条路径当文件名，
        // 正则永远不匹配，于是「修剪静默失效」——那是最难发现的一类失败。
        const fileName = basename(target)
        if (!isReportFileOf(fileName, setName)) continue
        if (!paths.isInside(target)) continue
        try {
          unlinkSync(target)
          removed.push(target)
        } catch (error) {
          this.log.warn('修剪旧报告失败（%s）：%s', target, messageOf(error))
        }
      }
    }
    return Object.freeze(removed)
  }
}
