/**
 * 门控决策日志：**回答「这句话怎么没记住」**。
 *
 * 为什么需要它：`reject` 与 `seed` 都是**不写库**的结论。用户看到的是
 * 「我明明说过这件事，她怎么不记得」，而记忆库里连一条残渣都没有——
 * 没有日志，这个疑问永远查不出来。
 *
 * 三条设计取舍：
 *
 * 1. **表归本插件所有，不写进 O-010 的表。** 门控日志是 O-140 的私有审计面；
 *    塞进 `memory_fact` 会让「记忆条数」这个数字被拒绝记录污染。
 * 2. **只留残文（默认 120 字），不留全文。** 日志是旁证，不是第二份记忆库。
 *    存全文等于在「这条不该入库」之后又留了一份可读副本——那正是这道闸要防的事。
 * 3. **日志缺席不影响门控。** 没有存储端口时 `logging=false`，判定照常——
 *    审计能力缺失是降级，不是故障。
 */

import type { Config } from './settings.js'
import type { GateAction, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 日志表名。 */
export const TABLE_EVIDENCE_GATE_LOG = 'evidence_gate_log'

/** 一条日志。 */
export interface GateLogEntry {
  /** 判定时刻。 */
  readonly at: number
  /** 结论。 */
  readonly action: GateAction
  /** 首个原因码（没有原因时为空串）。 */
  readonly code: string
  /** 主体。 */
  readonly subject: string
  /** 通道标记（可空）。 */
  readonly channel: string
  /** 正文残文。 */
  readonly text: string
  /** 存活引文数。 */
  readonly kept: number
  /** 被丢引文数。 */
  readonly dropped: number
  /** 被剥掉的数字个数。 */
  readonly digits: number
}

/** 日志表结构。时间一律存毫秒整数（与 O-010 / O-012 同口径）。 */
const LOG_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_EVIDENCE_GATE_LOG,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'at', type: 'INTEGER', notNull: true },
    { name: 'action', type: 'TEXT', notNull: true },
    { name: 'code', type: 'TEXT' },
    { name: 'subject', type: 'TEXT' },
    { name: 'channel', type: 'TEXT' },
    { name: 'text', type: 'TEXT' },
    { name: 'kept', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'dropped', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'digits', type: 'INTEGER', notNull: true, default: '0' },
  ]),
  indexes: Object.freeze([
    { name: 'idx_evidence_gate_log_at', columns: Object.freeze(['at']) },
    { name: 'idx_evidence_gate_log_action', columns: Object.freeze(['action']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读字符串字段。 */
function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 读整数字段。 */
function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 门控决策日志。 */
export class GateLog {
  private readonly store: StoreLike
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private ready = false
  private seq = 0

  /**
   * @param store 存储端口。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(store: StoreLike, settings: Config, log: LogLike, now: () => number) {
    this.store = store
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 日志是否可写。 */
  get available(): boolean {
    return this.ready
  }

  /**
   * 建表（幂等）。由 `apply()` 调一次，**不装定时器**。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(LOG_TABLE)
      for (const issue of result.issues) {
        this.log.warn('门控日志建表问题（%s）：%s', issue.code, issue.detail)
      }
      this.ready = true
    } catch (error) {
      // 建不起来不是致命：门控照常，只是事后查不到「为什么没记住」。
      this.ready = false
      this.log.warn('门控日志建表失败（门控照常，只是事后查不到拒绝记录）：%s', messageOf(error))
    }
    return this.ready
  }

  /**
   * 追加一条。
   * @param entry 日志内容。
   * @returns 是否写进去了。
   */
  append(entry: GateLogEntry): boolean {
    if (!this.ready) return false
    try {
      this.seq += 1
      const row: RowLike = {
        id: `g-${entry.at.toString(36)}-${this.seq.toString(36)}`,
        at: entry.at,
        action: entry.action,
        code: entry.code,
        subject: entry.subject,
        channel: entry.channel,
        text: [...entry.text].slice(0, this.settings.maxLogTextChars).join(''),
        kept: entry.kept,
        dropped: entry.dropped,
        digits: entry.digits,
      }
      this.store.insert(TABLE_EVIDENCE_GATE_LOG, row)
      this.prune()
      return true
    } catch (error) {
      // 日志写失败绝不冒泡：判定已经做完，日志只是旁证。
      this.log.warn('写门控日志失败（判定结果不受影响）：%s', messageOf(error))
      return false
    }
  }

  /** 行数。 */
  count(): number {
    if (!this.ready) return 0
    try {
      return this.store.count(TABLE_EVIDENCE_GATE_LOG)
    } catch {
      return 0
    }
  }

  /**
   * 最近若干条（给审计面读）。
   * @param limit 条数。
   */
  recent(limit: number): readonly GateLogEntry[] {
    if (!this.ready) return []
    try {
      const rows = this.store.select(TABLE_EVIDENCE_GATE_LOG, {
        orderBy: [{ column: 'at', direction: 'desc' }],
        limit: Math.max(1, Math.trunc(limit)),
      })
      return rows.map(row => this.toEntry(row))
    } catch (error) {
      this.log.warn('读门控日志失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 清理旧行（**分批删**，不一次删光）。
   *
   * 分批的理由与 O-012 相同：一次删几千行会在 SQLite 上产生一个长事务，
   * 而卡住的是「她正在记住一句话」这条路径。
   * @returns 本次删掉的行数。
   */
  prune(): number {
    if (!this.ready) return 0
    const limit = this.settings.logLimit
    if (limit <= 0) return 0
    try {
      const total = this.store.count(TABLE_EVIDENCE_GATE_LOG)
      if (total <= limit) return 0
      const excess = Math.min(total - limit, this.settings.logPruneBatch)
      const rows = this.store.select(TABLE_EVIDENCE_GATE_LOG, {
        orderBy: [{ column: 'at', direction: 'asc' }],
        limit: excess,
      })
      let removed = 0
      for (const row of rows) {
        const id = strOf(row['id'])
        if (id === null) continue
        removed += this.store.delete(TABLE_EVIDENCE_GATE_LOG, { id })
      }
      return removed
    } catch (error) {
      this.log.warn('清理门控日志失败（下次再试）：%s', messageOf(error))
      return 0
    }
  }

  /** 行 → 视图。 */
  private toEntry(row: RowLike): GateLogEntry {
    const action = strOf(row['action']) ?? 'reject'
    return Object.freeze({
      at: typeof row['at'] === 'number' ? row['at'] : this.now(),
      action: action as GateAction,
      code: strOf(row['code']) ?? '',
      subject: strOf(row['subject']) ?? '',
      channel: strOf(row['channel']) ?? '',
      text: strOf(row['text']) ?? '',
      kept: intOf(row['kept']),
      dropped: intOf(row['dropped']),
      digits: intOf(row['digits']),
    })
  }
}
