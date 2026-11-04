/**
 * 审计层：内存环 + 可选 JSONL 落盘。
 *
 * ## 三条纪律
 *
 * 1. **审计永不抛错**。它长在「动作已经发生之后」的路径上：
 *    磁盘满了、权限不对、路径服务还没装载——这些都不该让一次已经成功的点击被报成失败。
 *    失败只计数（`stats().auditFailed`）并**只打一次**警告（写放大保护）。
 * 2. **只记形状，不记内容**。`AuditEntry` 里没有正文，只有 `textChars`；
 *    坐标量化到 10 像素网格。理由见 `types.ts` 文件头。
 * 3. **落盘走 O-002**，不自己拼绝对路径：`fileIn('user', …)` 给路径、
 *    `prepareFile()` 收权限（0600）。自己拼路径会在换数据根目录后写到旧位置，
 *    而症状是「审计文件突然不再增长」。
 *
 * ## 为什么轮转只留一份
 *
 * 审计不是账本，是「最近发生过什么」的取证材料。留一份上一代（`.1`）足够回答
 * 「昨天那一下是谁点的」；留 N 份会把磁盘占满，而占满的后果是整个应用写不了任何东西。
 */

import { appendFileSync, renameSync, statSync } from 'node:fs'
import type { AuditCounters, AuditEntry, AuditSink, LogLike, PathLike } from './types.js'
import { AUDIT_FILE, AUDIT_MAX_BYTES } from './types.js'

/** 一条待落库的审计（id 由本层生成）。 */
export type AuditDraft = Omit<AuditEntry, 'id'>

/** 审计层依赖。 */
export interface AuditDeps {
  /** 内存保留条数。 */
  readonly keep: number
  /** 是否落盘。 */
  readonly fileEnabled: boolean
  /** 路径服务（取值函数：上游晚装载能自愈）。 */
  readonly path: () => PathLike | undefined
  /** 日志。 */
  readonly log: LogLike
}

/** 审计层。 */
export class AuditTrail {
  private readonly deps: AuditDeps
  /** 内存环（新→旧按插入顺序，查询时倒序）。 */
  private readonly ring: AuditEntry[] = []
  /** 外送端口。 */
  private sink: AuditSink | null = null
  /** 已落盘条数。 */
  private written = 0
  /** 落盘失败条数。 */
  private failed = 0
  /** 目录是否已确认（只用于少做一次 ensure）。 */
  private dirReady = false
  /** 条目自增。 */
  private seq = 0

  constructor(deps: AuditDeps) {
    this.deps = deps
  }

  /**
   * 换外送端口。
   * @param sink 端口或 `null`。
   */
  useSink(sink: AuditSink | null): void {
    this.sink = sink
  }

  /**
   * 收一条审计，返回它的 id。
   * @param draft 内容。
   */
  record(draft: AuditDraft): string {
    this.seq += 1
    const entry: AuditEntry = { id: `a${this.seq.toString(36)}`, ...draft }

    this.ring.push(entry)
    const keep = Math.max(1, this.deps.keep)
    if (this.ring.length > keep) this.ring.splice(0, this.ring.length - keep)

    if (this.sink !== null) {
      try {
        this.sink.append(entry)
      } catch {
        // 外送端口自己坏了，不牵连本包；落盘路径还会再试一次。
        this.failed += 1
      }
    }

    if (this.deps.fileEnabled) this.appendLine(entry)
    return entry.id
  }

  /**
   * 最近 N 条（倒序：最新的在前）。
   * @param limit 条数；省略取全部内存条数。
   */
  list(limit?: number): readonly AuditEntry[] {
    const size = limit === undefined || limit <= 0 ? this.ring.length : Math.min(limit, this.ring.length)
    const out: AuditEntry[] = []
    for (let index = this.ring.length - 1; index >= 0 && out.length < size; index -= 1) {
      const item = this.ring[index]
      if (item !== undefined) out.push(item)
    }
    return Object.freeze(out)
  }

  /** 计数与当前模式。 */
  counters(): AuditCounters {
    const file = this.deps.fileEnabled && this.deps.path() !== undefined
    return {
      kept: this.ring.length,
      written: this.written,
      failed: this.failed,
      mode: file ? 'file' : 'memory',
    }
  }

  /**
   * 追加一行。
   * @param entry 审计。
   */
  private appendLine(entry: AuditEntry): void {
    const path = this.deps.path()
    if (path === undefined) return
    try {
      if (!this.dirReady) {
        path.ensure('user')
        this.dirReady = true
      }
      const file = path.fileIn('user', AUDIT_FILE)
      this.rotateIfNeeded(file)
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      // 覆盖已有文件时 `mode` 不生效，权限交给 O-002 再收一次。
      try {
        path.prepareFile(file)
      } catch {
        // 权限收紧失败不阻断：文件已经写进去了，报错反而会让人以为没记上。
      }
      this.written += 1
    } catch (error) {
      this.failed += 1
      if (this.failed === 1) {
        this.deps.log.warn('审计落盘失败（之后同类失败不再逐条打日志）：%s', textOf(error))
      }
    }
  }

  /**
   * 超过阈值就换一份（只留一代）。
   * @param file 文件路径。
   */
  private rotateIfNeeded(file: string): void {
    try {
      const stat = statSync(file)
      if (stat.size <= AUDIT_MAX_BYTES) return
      renameSync(file, `${file}.1`)
    } catch {
      // 文件不存在（首次写）或改名失败：都不影响这次追加。
    }
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
