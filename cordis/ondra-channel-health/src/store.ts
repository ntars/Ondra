/**
 * 记录落盘：一通道一份 `user/channels/health/<id>.json`，0600，原子写。
 *
 * ## 为什么要落盘（一句话）
 *
 * 不落盘，重启后所有通道都是 `unknown`，面板显示「一个都没数据」——
 * 与「真的一个都没跑过」长得一模一样，而这两种情况的处置完全相反。
 *
 * ## 三条实现纪律
 *
 * 1. **原子写**：先写 `.tmp` 再 `rename`。直接 `writeFileSync` 覆盖时断电，
 *    留下的是半个 JSON，下次启动解析失败 → 记录全丢。而这份记录的唯一价值
 *    就是「跨重启还在」。
 * 2. **写在节流之后**：心跳是每秒级的，每条都写盘会把磁盘磨响。
 *    调用方标脏，`flush()` 统一写。
 * 3. **写失败不抛**：探针自己写不了盘，不能让通道适配器跟着报错。
 *    连续失败到阈值就转「仅内存」，并只提示一次。
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isChannelId } from './probe.js'
import type { ChannelRecord } from './probe.js'
import { EVIDENCE_KINDS } from './types.js'
import type { EvidenceKind, LogLike } from './types.js'

/** 连续写盘失败多少次后转仅内存。 */
const MAX_WRITE_FAILURES = 3

/** 文件名后缀。 */
const FILE_SUFFIX = '.json'

/** 记录文件里实际存的字段。刻意少：只存「下次启动还用得上」的。 */
interface PersistedShape {
  readonly channelId: string
  readonly label: string
  readonly lastEventAt: number | null
  readonly lastEventKind: string | null
  readonly lastErrorAt: number | null
  readonly lastErrorCode: string | null
  readonly detail: string
  readonly counts: {
    readonly inbound: number
    readonly outbound: number
    readonly errors: number
    readonly reconnects: number
  }
  readonly reconnectTimes: readonly number[]
  readonly seenConnected: boolean
  readonly updatedAt: number
}

/** 落盘统计。 */
export interface StoreStats {
  /** 成功写盘次数。 */
  readonly persisted: number
  /** 写盘失败次数。 */
  readonly writeFailures: number
  /** 从磁盘恢复的通道数。 */
  readonly restored: number
  /** 当前是否只能待在内存里。 */
  readonly memoryOnly: boolean
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读数，非有限数一律当 0。 */
function numOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 读可空数。 */
function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 读可空字符串。 */
function nullableStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 读一条记录。任何字段不合法都退回默认，**不整条丢弃**（丢一条就等于丢了一个通道的历史）。 */
function parseRecord(raw: unknown, channelId: string): ChannelRecord | null {
  if (!isRecord(raw)) return null
  const counts = isRecord(raw['counts']) ? raw['counts'] : {}
  const kindRaw = raw['lastEventKind']
  const lastEventKind: EvidenceKind | null =
    typeof kindRaw === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as EvidenceKind)
      : null

  const timesRaw = raw['reconnectTimes']
  const reconnectTimes: number[] = []
  if (Array.isArray(timesRaw)) {
    for (const item of timesRaw) {
      if (typeof item === 'number' && Number.isFinite(item)) reconnectTimes.push(item)
    }
  }

  return {
    channelId,
    label: typeof raw['label'] === 'string' ? raw['label'] : channelId,
    lastEventAt: nullableNum(raw['lastEventAt']),
    lastEventKind,
    lastErrorAt: nullableNum(raw['lastErrorAt']),
    lastErrorCode: nullableStr(raw['lastErrorCode']),
    detail: typeof raw['detail'] === 'string' ? raw['detail'] : '',
    counts: {
      inbound: numOf(counts['inbound'], 0),
      outbound: numOf(counts['outbound'], 0),
      errors: numOf(counts['errors'], 0),
      reconnects: numOf(counts['reconnects'], 0),
    },
    reconnectTimes,
    seenConnected: raw['seenConnected'] === true,
    live: false,
    restored: true,
    updatedAt: numOf(raw['updatedAt'], 0),
  }
}

/** 记录存储。 */
export class RecordStore {
  /** 目录；空串表示仅内存。 */
  private readonly dir: string
  private readonly log: LogLike
  private readonly pending = new Map<string, ChannelRecord>()
  private readonly dirty = new Set<string>()
  private failures = 0
  private persisted = 0
  private writeFailures = 0
  private restored = 0
  private memoryOnly: boolean
  private warnedDegrade = false

  /**
   * @param dir 记录目录（绝对路径）；空串表示仅内存。
   * @param log 日志。
   */
  constructor(dir: string, log: LogLike) {
    this.dir = dir
    this.log = log
    this.memoryOnly = dir === ''
  }

  /** 目录是否可用（非仅内存）。 */
  get available(): boolean {
    return !this.memoryOnly
  }

  /** 一份通道的记录文件路径；仅内存时为空串。 */
  private pathOf(channelId: string): string {
    return this.dir === '' ? '' : join(this.dir, channelId + FILE_SUFFIX)
  }

  /**
   * 读全部记录。目录不存在/不可读时返回空数组（视为「第一次跑」）。
   */
  loadAll(): readonly ChannelRecord[] {
    if (this.dir === '') return []
    let names: readonly string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      // 目录还没建：不是错误，第一次启动就是这样。
      return []
    }

    const out: ChannelRecord[] = []
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      const channelId = name.slice(0, -FILE_SUFFIX.length)
      // 文件名可能就是别人手工塞进来的东西：不合规的 id 直接跳过，
      // 否则拼路径时会把 `..` 带进目录。
      if (!isChannelId(channelId)) continue
      try {
        const text = readFileSync(this.pathOf(channelId), 'utf8')
        const parsed: unknown = JSON.parse(text)
        const record = parseRecord(parsed, channelId)
        if (record === null) continue
        this.pending.set(channelId, record)
        out.push(record)
        this.restored += 1
      } catch {
        // 半个 JSON / 权限问题：跳过这一份，其余照读。
        this.log.warn('记录文件 %s 读不出来，已跳过（其余通道不受影响）', name)
      }
    }
    return out
  }

  /** 取一份缓存记录。 */
  get(channelId: string): ChannelRecord | undefined {
    return this.pending.get(channelId)
  }

  /**
   * 放一份记录。`dirty=true` 时等 `flush()` 统一写。
   * @param record 记录。
   * @param markDirty 是否标脏。
   */
  put(record: ChannelRecord, markDirty: boolean): void {
    this.pending.set(record.channelId, record)
    if (markDirty && !this.memoryOnly) this.dirty.add(record.channelId)
  }

  /** 丢掉一份记录（并删文件）。 */
  forget(channelId: string): boolean {
    const existed = this.pending.delete(channelId)
    this.dirty.delete(channelId)
    const target = this.pathOf(channelId)
    if (target !== '' && existed) {
      try {
        unlinkSync(target)
      } catch {
        // 文件本来就不在：正常。
      }
    }
    return existed
  }

  /** 待写的通道数（自检与面板用）。 */
  dirtyCount(): number {
    return this.dirty.size
  }

  /**
   * 把所有标脏的记录写下去。**永不抛错。**
   */
  flush(): void {
    if (this.memoryOnly || this.dirty.size === 0) return
    const ids = [...this.dirty]
    this.dirty.clear()

    for (const channelId of ids) {
      const record = this.pending.get(channelId)
      if (record === undefined) continue
      const ok = this.writeOne(record)
      // 只把**这一条**写失败的放回队列：不能因为某一条失败，
      // 把同批次里已经写成功的也重新标脏（那会变成永不停止的重复写）。
      if (!ok && !this.memoryOnly) this.dirty.add(channelId)
    }

    if (this.failures >= MAX_WRITE_FAILURES && !this.warnedDegrade) {
      this.memoryOnly = true
      this.warnedDegrade = true
      this.log.error(
        '通道探针记录连续 %d 次写盘失败，已转为仅内存：重启后会显示「从没上报过」，请检查数据目录权限',
        this.failures,
      )
    }
  }

  /**
   * 写一份。
   * @returns 是否成功。
   */
  private writeOne(record: ChannelRecord): boolean {
    const target = this.pathOf(record.channelId)
    if (target === '') return false
    const payload: PersistedShape = {
      channelId: record.channelId,
      label: record.label,
      lastEventAt: record.lastEventAt,
      lastEventKind: record.lastEventKind,
      lastErrorAt: record.lastErrorAt,
      lastErrorCode: record.lastErrorCode,
      detail: record.detail,
      counts: record.counts,
      reconnectTimes: record.reconnectTimes,
      seenConnected: record.seenConnected,
      updatedAt: record.updatedAt,
    }

    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const temp = target + '.tmp'
      // mode 0600：这份文件里有「谁在什么时候跟她说过话」的时间线，
      // 与凭据同级，不给同机其他用户看。
      writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, target)
      chmodSync(target, 0o600)
      this.failures = 0
      this.persisted += 1
      return true
    } catch {
      this.failures += 1
      this.writeFailures += 1
      return false
    }
  }

  /** 统计快照。 */
  stats(): StoreStats {
    return {
      persisted: this.persisted,
      writeFailures: this.writeFailures,
      restored: this.restored,
      memoryOnly: this.memoryOnly,
    }
  }
}
