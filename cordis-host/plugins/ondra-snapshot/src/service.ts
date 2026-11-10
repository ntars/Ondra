/**
 * 快照服务的实现：编排「做、列、验、轮转、登记、恢复」六件事。
 *
 * 有一条纪律贯穿全文：**任何一步失败都返回结构化拒绝，不抛错给上层**。
 * 理由和 O-006 一致——备份是「增强能力」，它挂了主对话必须还能进行；
 * 但它又必须「说清楚为什么没成」，否则用户会以为自己有备份。
 * 所以是「不抛错 + 必带原因」，不是「静默返回空」。
 *
 * 恢复这一段有一个容易毁库的细节，写在这里：
 * 换掉库文件之后，**旧的 `-wal` / `-shm` 必须一起挪走或删掉**。
 * 它们记的是旧库的事务，留在原处会让 SQLite 拿旧 WAL 去「恢复」新文件，
 * 结果是新数据被旧事务覆盖，而且报的错看起来跟恢复毫无关系。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { checkSnapshot, errorMessage, vacuumInto } from './backup.js'
import { formatStamp, listSnapshotFiles, nextFileName, removeFile } from './registry.js'
import { SNAPSHOT_DIR_SEGMENTS } from './types.js'
import type {
  PruneOutcome,
  RestoreOutcome,
  RestoreTicket,
  SnapshotLog,
  SnapshotOutcome,
  SnapshotRecord,
  SnapshotRefusal,
  SnapshotService,
  SnapshotStats,
  StageOutcome,
  StoreLike,
  VerifyOutcome,
} from './types.js'

/** 路径服务的结构对位子集（O-002 `PathLayoutService`）。 */
export interface PathLayoutLike {
  /** 五个区域的绝对路径。 */
  readonly areas: { readonly root: string }
  /** 数据根的用户可见写法。 */
  readonly display: string
  /** 建目录并返回绝对路径。 */
  ensure(area: 'backups' | 'user', ...segments: string[]): string
  /** 只拼路径不建目录。 */
  fileIn(area: 'backups' | 'user', ...segments: string[]): string
  /** 判断是否在数据根内。 */
  isInside(filePath: string): boolean
}

/** 服务选项，全部来自 Config（只收本层真正用到的两项）。 */
export interface SnapshotOptions {
  /** 保留份数，最小 1。 */
  readonly keep: number
  /** 做完是否立刻校验。 */
  readonly verifyAfterCreate: boolean
}

/** 待恢复票的文件名（放 `user/` 区域，0600）。 */
const PENDING_FILE = 'restore-pending.json'

/**
 * 把绝对路径换算成用户可见写法。绝不把机器绝对路径塞进界面。
 * @param filePath 绝对路径。
 * @param layout 路径服务。
 */
function displayOf(filePath: string, layout: PathLayoutLike): string {
  if (!layout.isInside(filePath)) return filePath
  const root = layout.areas.root
  const tail = filePath
    .slice(root.length)
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .join('/')
  return tail === '' ? layout.display : `${layout.display}/${tail}`
}

/** 快照服务实现。 */
export class SnapshotStore implements SnapshotService {
  /** 快照目录缓存（第一次用到时才建目录）。 */
  private dirCache: string | null = null
  /** 不可用原因。 */
  private readonly reason: string | null
  /** 不可用原因码。 */
  private readonly unavailableCode: SnapshotRefusal['code']

  /**
   * @param store 存储端口。
   * @param layout 路径服务。
   * @param log 日志。
   * @param options 选项。
   * @param now 取当前毫秒时间戳。
   */
  constructor(
    private readonly store: StoreLike,
    private readonly layout: PathLayoutLike | undefined,
    private readonly log: SnapshotLog,
    private readonly options: SnapshotOptions,
    private readonly now: () => number,
  ) {
    if (layout === undefined) {
      this.reason = '找不到路径服务 ondra-path-layout，无法确定快照目录，拒绝落到当前工作目录'
      this.unavailableCode = 'no-path-layout'
    } else if (!store.caps.sql || store.raw === undefined) {
      this.reason = '当前存储后端没有原始 SQL 面（内存兜底后端），快照没有意义'
      this.unavailableCode = 'sql-unsupported'
    } else {
      this.reason = null
      this.unavailableCode = 'sql-unsupported'
    }
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.reason === null
  }

  /** 不可用原因。 */
  get unavailableReason(): string | null {
    return this.reason
  }

  /** 取快照目录（首次调用时创建）。 */
  private dir(): string {
    if (this.dirCache !== null) return this.dirCache
    if (this.layout === undefined) throw new Error('路径服务缺席')
    this.dirCache = this.layout.ensure('backups', ...SNAPSHOT_DIR_SEGMENTS)
    return this.dirCache
  }

  /** 拒绝的构造助手。 */
  private refuse(code: SnapshotRefusal['code'], detail: string): SnapshotRefusal {
    return { code, detail }
  }

  /** 拼一份快照的绝对路径（**唯一入口**：创建、列表、恢复都从这里取，避免两处拼出不同结果）。 */
  private pathOf(fileName: string): string {
    if (this.layout === undefined) throw new Error('路径服务缺席')
    return this.layout.fileIn('backups', ...SNAPSHOT_DIR_SEGMENTS, fileName)
  }

  /** 组装一条记录。 */
  private toRecord(fileName: string, createdAtMs: number, sizeBytes: number, schemaVersion: number | null): SnapshotRecord {
    const filePath = this.layout === undefined ? fileName : this.pathOf(fileName)
    return {
      id: fileName.slice(0, -3),
      fileName,
      filePath,
      displayPath: this.layout === undefined ? filePath : displayOf(filePath, this.layout),
      createdAtMs,
      sizeBytes,
      schemaVersion,
    }
  }

  /** 做一份快照。 */
  create(reason?: string): SnapshotOutcome {
    if (!this.available) {
      return { ok: false, refusal: this.refuse(this.unavailableCode, this.unavailableReason ?? '快照不可用') }
    }
    const raw = this.store.raw
    if (raw === undefined) {
      return { ok: false, refusal: this.refuse('no-raw', '存储端口没有原始 SQL 面') }
    }
    try {
      const dir = this.dir()
      const ms = this.now()
      const fileName = nextFileName(dir, ms)
      // 路径从 `pathOf` 取，与列表/恢复同一条拼法——两处各拼一次迟早会不一样。
      const filePath = this.pathOf(fileName)
      vacuumInto(raw, filePath)
      const sizeBytes = statSync(filePath).size
      let schemaVersion: number | null = null
      if (this.options.verifyAfterCreate) {
        const check = checkSnapshot(raw, filePath)
        if (!check.ok) {
          // 校验不过的快照不能留在轮转里冒充「可用备份」：改名成 .corrupt 保留现场，
          // 但**不删**——它可能是唯一能说明「哪里坏了」的证据。
          const badPath = filePath.replace(/\.db$/, '.corrupt')
          try {
            renameSync(filePath, badPath)
          } catch {
            // 改名失败就让它留在原地；返回的 refusal 已经说明它不可用。
          }
          this.log.error('快照校验未通过，已改名为 .corrupt 保留现场：%s', check.detail)
          return { ok: false, refusal: this.refuse('verify-failed', check.detail) }
        }
        schemaVersion = check.schemaVersion
      }
      const record = this.toRecord(fileName, ms, sizeBytes, schemaVersion)
      this.log.info(
        '快照完成：%s（%d 字节，版本 %s）%s',
        record.displayPath,
        record.sizeBytes,
        schemaVersion === null ? '未知' : String(schemaVersion),
        reason === undefined ? '' : ` —— ${reason}`,
      )
      return { ok: true, record }
    } catch (error) {
      this.log.error('做快照失败：%s', errorMessage(error))
      return { ok: false, refusal: this.refuse('vacuum-failed', `VACUUM INTO 失败：${errorMessage(error)}`) }
    }
  }

  /** 列出全部快照（新→旧）。 */
  list(): readonly SnapshotRecord[] {
    if (!this.available) return []
    let dir: string
    try {
      dir = this.dir()
    } catch {
      return []
    }
    return listSnapshotFiles(dir).map((file) => this.toRecord(file.fileName, file.createdAtMs, file.sizeBytes, null))
  }

  /** 校验一份快照。 */
  verify(id: string): VerifyOutcome {
    if (!this.available) {
      return { ok: false, refusal: this.refuse(this.unavailableCode, this.unavailableReason ?? '快照不可用'), record: undefined }
    }
    const raw = this.store.raw
    if (raw === undefined) {
      return { ok: false, refusal: this.refuse('no-raw', '存储端口没有原始 SQL 面'), record: undefined }
    }
    const record = this.list().find((item) => item.id === id)
    if (record === undefined) {
      return { ok: false, refusal: this.refuse('not-found', `找不到快照 "${id}"`), record: undefined }
    }
    const check = checkSnapshot(raw, record.filePath)
    if (!check.ok) {
      return { ok: false, refusal: this.refuse('verify-failed', check.detail), record }
    }
    return {
      ok: true,
      record: { ...record, schemaVersion: check.schemaVersion },
      check: check.check,
    }
  }

  /** 轮转。 */
  prune(keep?: number): PruneOutcome {
    if (!this.available) {
      return {
        ok: false,
        removed: [],
        kept: [],
        refusal: this.refuse(this.unavailableCode, this.unavailableReason ?? '快照不可用'),
      }
    }
    // 最小 1：把 keep 配成 0 等于「每次备份完立刻删掉」，那不是省空间，是自欺。
    const target = Math.max(1, Math.trunc(Number.isFinite(keep) ? (keep as number) : this.options.keep))
    const records = this.list()
    if (records.length <= target) {
      return { ok: true, removed: [], kept: records.map((item) => item.fileName), refusal: undefined }
    }
    const removed: string[] = []
    for (const record of records.slice(target)) {
      if (removeFile(record.filePath)) {
        removed.push(record.fileName)
        this.log.info('轮转删除旧快照：%s', record.displayPath)
      } else {
        this.log.warn('轮转删除失败（文件可能被占用）：%s', record.displayPath)
      }
    }
    const kept = records.slice(0, target).map((item) => item.fileName)
    if (removed.length === 0) {
      return {
        ok: false,
        removed,
        kept,
        refusal: this.refuse('io-failed', '有快照超出保留份数但一个都没删掉，请检查文件权限'),
      }
    }
    return { ok: true, removed, kept, refusal: undefined }
  }

  /** 待恢复票的路径。 */
  private pendingPath(): string {
    if (this.layout === undefined) throw new Error('路径服务缺席')
    return this.layout.fileIn('user', PENDING_FILE)
  }

  /** 登记待恢复。 */
  stage(id: string): StageOutcome {
    if (!this.available) {
      return { ok: false, refusal: this.refuse(this.unavailableCode, this.unavailableReason ?? '快照不可用') }
    }
    const target = this.store.filePath
    if (target === null) {
      return { ok: false, refusal: this.refuse('io-failed', '当前存储后端没有库文件，无从恢复') }
    }
    const verified = this.verify(id)
    if (!verified.ok) return { ok: false, refusal: verified.refusal }
    const record = verified.record
    if (record === undefined) {
      return { ok: false, refusal: this.refuse('not-found', `找不到快照 "${id}"`) }
    }
    const ticket: RestoreTicket = {
      snapshotId: record.id,
      snapshotPath: record.filePath,
      targetPath: target,
      stagedAtMs: this.now(),
      sizeBytes: record.sizeBytes,
    }
    try {
      const pendingPath = this.pendingPath()
      const tempPath = `${pendingPath}.tmp`
      // 先写临时文件再改名：半截 JSON 被读到会让「有没有待恢复」变成一个随机答案。
      writeFileSync(tempPath, `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600 })
      renameSync(tempPath, pendingPath)
      this.log.warn(
        '已登记待恢复：%s → %s。**不会自动执行**，需要人工确认后调用 restore()',
        record.displayPath,
        target,
      )
      return { ok: true, ticket }
    } catch (error) {
      return { ok: false, refusal: this.refuse('io-failed', `写恢复待办失败：${errorMessage(error)}`) }
    }
  }

  /** 撤销待恢复登记。 */
  cancelStaged(): boolean {
    if (this.layout === undefined) return false
    try {
      const pendingPath = this.pendingPath()
      if (!existsSync(pendingPath)) return false
      return removeFile(pendingPath)
    } catch {
      return false
    }
  }

  /** 读待恢复票。 */
  pendingRestore(): RestoreTicket | undefined {
    if (this.layout === undefined) return undefined
    try {
      const pendingPath = this.pendingPath()
      if (!existsSync(pendingPath)) return undefined
      // 不用 JSON.parse 的返回值直接当票据：文件可能被手工改过，
      // 形状不对时必须当成「没有」，而不是让 undefined 传到恢复逻辑里。
      const parsed: unknown = JSON.parse(readFileSync(pendingPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const raw = parsed as Record<string, unknown>
      const snapshotId = raw['snapshotId']
      const snapshotPath = raw['snapshotPath']
      const targetPath = raw['targetPath']
      const stagedAtMs = raw['stagedAtMs']
      const sizeBytes = raw['sizeBytes']
      if (
        typeof snapshotId !== 'string' ||
        typeof snapshotPath !== 'string' ||
        typeof targetPath !== 'string' ||
        typeof stagedAtMs !== 'number' ||
        typeof sizeBytes !== 'number'
      ) {
        return undefined
      }
      return { snapshotId, snapshotPath, targetPath, stagedAtMs, sizeBytes }
    } catch {
      return undefined
    }
  }

  /** 显式恢复。 */
  restore(id: string, options?: { readonly confirm: 'restore' }): RestoreOutcome {
    // 第一道闸：字面量确认。少一个字都不动。
    if (options?.confirm !== 'restore') {
      return {
        ok: false,
        refusal: this.refuse(
          'confirmation-required',
          "恢复必须显式传 { confirm: 'restore' }，这是防止误触发的最小代价",
        ),
        backupPath: undefined,
      }
    }
    if (!this.available) {
      return { ok: false, refusal: this.refuse(this.unavailableCode, this.unavailableReason ?? '快照不可用'), backupPath: undefined }
    }
    // 第二道闸：库必须已关闭。换掉正在被连接持有的文件，等于把库从底下抽走。
    if (this.store.state !== 'closed') {
      return {
        ok: false,
        refusal: this.refuse(
          'store-open',
          `库当前状态为 ${this.store.state}，不能直接换文件。请先让存储插件关闭连接（或退出应用），再执行恢复。`,
        ),
        backupPath: undefined,
      }
    }
    const target = this.store.filePath
    if (target === null) {
      return { ok: false, refusal: this.refuse('io-failed', '当前存储后端没有库文件，无从恢复'), backupPath: undefined }
    }
    const record = this.list().find((item) => item.id === id)
    if (record === undefined) {
      return { ok: false, refusal: this.refuse('not-found', `找不到快照 "${id}"`), backupPath: undefined }
    }
    // 换库之前再确认一次「还是那份文件」。
    //
    // 这里**不能**用 ATTACH 做内容校验：库已经关闭，连接不可用。
    // 所以改用文件级比对——如果这份快照在 stage() 之后被动过，大小对不上就拒。
    // 真正的内容校验发生在 stage()（那时库还开着），这条只是防「中途被换文件」。
    const ticket = this.pendingRestore()
    if (ticket !== undefined && ticket.snapshotId === id && ticket.sizeBytes !== record.sizeBytes) {
      return {
        ok: false,
        refusal: this.refuse(
          'verify-failed',
          `快照大小在登记之后从 ${ticket.sizeBytes} 变成了 ${record.sizeBytes} 字节，文件已被改动，恢复中止`,
        ),
        backupPath: undefined,
      }
    }

    // 先算好归档路径（纯字符串运算，不会失败），再动文件。
    // 写成「try 里赋值、catch 里使用」会让「到底赋没赋值」变成一个要靠控制流猜的问题。
    const stamp = formatStamp(this.now())
    const backupPath =
      this.layout === undefined ? `${target}.pre-restore` : this.layout.fileIn('backups', `pre-restore-${stamp}.db`)
    try {
      renameSync(target, backupPath)
    } catch (error) {
      return {
        ok: false,
        refusal: this.refuse('io-failed', `把原库挪走失败，恢复已中止（原库未被改动）：${errorMessage(error)}`),
        backupPath: undefined,
      }
    }

    try {
      // 旧库的 -wal / -shm 必须跟着走。留在原处会让 SQLite 拿旧 WAL 去「恢复」新文件。
      for (const suffix of ['-wal', '-shm'] as const) {
        const sidecar = `${target}${suffix}`
        if (!existsSync(sidecar)) continue
        try {
          renameSync(sidecar, `${backupPath}${suffix}`)
        } catch {
          removeFile(sidecar)
        }
      }
      copyFileSync(record.filePath, target)
      this.cancelStaged()
      this.log.warn('已从快照恢复：%s → %s（原库已挪到 %s）', record.displayPath, target, backupPath)
      return { ok: true, refusal: undefined, backupPath }
    } catch (error) {
      // 复制失败：把原库挪回去，避免「库里什么都没有」这种最坏结果。
      try {
        renameSync(backupPath, target)
      } catch {
        this.log.error('恢复失败且原库无法挪回！原库仍在 %s，请手工改名回 %s', backupPath, target)
      }
      return {
        ok: false,
        refusal: this.refuse('io-failed', `复制快照失败，已尝试还原原库：${errorMessage(error)}`),
        backupPath,
      }
    }
  }

  /** 运行期统计。 */
  stats(): SnapshotStats {
    const records = this.list()
    const dir = this.available ? (this.dirCache ?? (this.layout === undefined ? null : this.layout.fileIn('backups', ...SNAPSHOT_DIR_SEGMENTS))) : null
    return {
      available: this.available,
      unavailableReason: this.unavailableReason,
      displayDir: dir === null || this.layout === undefined ? dir : displayOf(dir, this.layout),
      count: records.length,
      newestAtMs: records[0]?.createdAtMs ?? null,
      oldestAtMs: records[records.length - 1]?.createdAtMs ?? null,
      totalBytes: records.reduce((sum, item) => sum + item.sizeBytes, 0),
      pendingRestore: this.pendingRestore() !== undefined,
      keep: this.options.keep,
    }
  }
}
