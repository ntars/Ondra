/**
 * 人格演化的持久化面：特质声明表 + 漂移日志表 + 互动计数表。
 *
 * ## 为什么特质要分两张表
 *
 * 「出厂是多少、能动多少」是**定义**（一改就该覆盖）；
 * 「被哪几件事推动了」是**事件**（只追加，永不改写）。
 * 混成一张，回滚就得改定义行，而定义行被改之后「出厂值」不再可信。
 *
 * ## 为什么当前值不存
 *
 * 与 O-010 的 `stability_hours` 存基线是同一条纪律：
 * 存了当前值，回滚就变成「减回去」，而**夹紧不可逆**——
 * 顶到上限后又被压回一点，再减一次就减过头了。
 * 派生值天然可回滚：日志在，值就一定算得出来。
 *
 * ## 读失败按「出厂」处理
 *
 * 读不出日志时，特质回到基线、阈值回到不漂移。
 * 这比「报错导致整插件不可用」好：人格漂移是**慢变量**，
 * 一次重启丢掉几个增量，用户根本看不出来；而插件不加载会被立刻发现。
 */

import type {
  ColumnSpecLike,
  LogLike,
  RowLike,
  StoreLike,
  TableSpecLike,
  TraitDelta,
  TraitSpec,
} from './types.js'

/** 特质声明表。 */
export const TABLE_TRAIT = 'persona_trait'

/** 漂移日志表。 */
export const TABLE_DELTA = 'persona_trait_delta'

/** 互动计数表。 */
export const TABLE_INTERACTION = 'persona_interaction'

/** 单行表的主键。 */
const SINGLETON_ID = 'singleton'

/** 声明表的列声明。 */
const TRAIT_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'base', type: 'REAL', notNull: true, default: '0' },
  { name: 'min', type: 'REAL', notNull: true, default: '0' },
  { name: 'max', type: 'REAL', notNull: true, default: '1' },
  { name: 'max_drift', type: 'REAL', notNull: true, default: '0' },
  { name: 'label_zh', type: 'TEXT', notNull: true, default: "''" },
  { name: 'created_at', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'updated_at', type: 'INTEGER', notNull: true, default: '0' },
])

/** 声明表结构。 */
const TRAIT_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_TRAIT,
  columns: TRAIT_COLUMNS,
  strict: true,
})

/** 日志表的列声明。 */
const DELTA_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'trait', type: 'TEXT', notNull: true, default: "''" },
  { name: 'delta', type: 'REAL', notNull: true, default: '0' },
  { name: 'reason', type: 'TEXT', notNull: true, default: "''" },
  { name: 'source', type: 'TEXT', notNull: true, default: "''" },
  { name: 'at', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'rolled_back', type: 'INTEGER', notNull: true, default: '0' },
])

/** 日志表结构。按特质建索引：每次读特质值都要按特质过滤。 */
const DELTA_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_DELTA,
  columns: DELTA_COLUMNS,
  indexes: Object.freeze([
    Object.freeze({ name: 'idx_persona_delta_trait', columns: Object.freeze(['trait', 'at']) }),
  ]),
  strict: true,
})

/** 计数表的列声明。 */
const INTERACTION_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'count', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'updated_at', type: 'INTEGER', notNull: true, default: '0' },
])

/** 计数表结构。 */
const INTERACTION_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_INTERACTION,
  columns: INTERACTION_COLUMNS,
  strict: true,
})

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 数字列 → number。 */
function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 人格演化仓库（只管读写，不含业务判定）。 */
export class EvolveStore {
  private readonly store: StoreLike
  private readonly log: LogLike

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /** 后端标识。 */
  get provider(): string {
    return this.store.provider
  }

  /**
   * 建三张表。失败**不抛**：退化到内存态（重启回到出厂）。
   * @returns 是否成功。
   */
  ensure(): boolean {
    try {
      for (const spec of [TRAIT_TABLE, DELTA_TABLE, INTERACTION_TABLE]) {
        const result = this.store.ensureTable(spec)
        for (const issue of result.issues) {
          this.log.warn('人格演化表 %s 有问题（%s）：%s', spec.name, issue.code, issue.detail)
        }
      }
      return true
    } catch (error) {
      this.log.warn('建人格演化表失败，本次运行只在内存里记账：%s', messageOf(error))
      return false
    }
  }

  /** 读全部特质声明。 */
  loadTraits(): readonly TraitSpec[] {
    try {
      const rows: RowLike[] = this.store.select(TABLE_TRAIT, {
        orderBy: [{ column: 'id', direction: 'asc' }],
      })
      const out: TraitSpec[] = []
      for (const row of rows) {
        const id = String(row['id'] ?? '')
        if (id.length === 0) continue
        out.push(
          Object.freeze({
            id,
            labelZh: String(row['label_zh'] ?? '') || id,
            base: num(row['base']),
            min: num(row['min']),
            max: num(row['max']),
            maxDrift: num(row['max_drift']),
          }),
        )
      }
      return out
    } catch (error) {
      this.log.warn('读特质声明失败，按「出厂」处理：%s', messageOf(error))
      return []
    }
  }

  /**
   * 写一条特质声明（幂等）。
   * @param spec 声明。
   * @param at 时刻。
   */
  saveTrait(spec: TraitSpec, at: number): boolean {
    try {
      this.store.upsert(TABLE_TRAIT, {
        id: spec.id,
        base: spec.base,
        min: spec.min,
        max: spec.max,
        max_drift: spec.maxDrift,
        label_zh: spec.labelZh,
        created_at: Math.trunc(at),
        updated_at: Math.trunc(at),
      })
      return true
    } catch (error) {
      this.log.warn('写特质声明失败（%s）：%s', spec.id, messageOf(error))
      return false
    }
  }

  /** 读全部漂移日志（时间升序）。 */
  loadDeltas(): readonly TraitDelta[] {
    try {
      const rows: RowLike[] = this.store.select(TABLE_DELTA, {
        orderBy: [{ column: 'at', direction: 'asc' }],
      })
      const out: TraitDelta[] = []
      for (const row of rows) {
        const id = String(row['id'] ?? '')
        const trait = String(row['trait'] ?? '')
        if (id.length === 0 || trait.length === 0) continue
        out.push(
          Object.freeze({
            id,
            trait,
            delta: num(row['delta']),
            reason: String(row['reason'] ?? ''),
            source: String(row['source'] ?? ''),
            at: Math.trunc(num(row['at'])),
            rolledBack: num(row['rolled_back']) === 1,
          }),
        )
      }
      return out
    } catch (error) {
      this.log.warn('读漂移日志失败，按「出厂」处理：%s', messageOf(error))
      return []
    }
  }

  /**
   * 追加一条日志。
   * @param delta 条目。
   */
  insertDelta(delta: TraitDelta): boolean {
    try {
      this.store.insert(TABLE_DELTA, {
        id: delta.id,
        trait: delta.trait,
        delta: delta.delta,
        reason: delta.reason,
        source: delta.source,
        at: Math.trunc(delta.at),
        rolled_back: delta.rolledBack ? 1 : 0,
      })
      return true
    } catch (error) {
      this.log.warn('写漂移日志失败（%s）：%s', delta.id, messageOf(error))
      return false
    }
  }

  /**
   * 标记一条为已回滚。
   * @param id 条目 id。
   */
  markRolledBack(id: string): boolean {
    try {
      this.store.update(TABLE_DELTA, { id }, { rolled_back: 1 })
      return true
    } catch (error) {
      this.log.warn('回滚 %s 失败：%s', id, messageOf(error))
      return false
    }
  }

  /**
   * 标记某特质的全部未回滚条目。
   * @param trait 特质键。
   * @returns 影响条数。
   */
  markRollbackTrait(trait: string): number {
    try {
      const rows: RowLike[] = this.store.select(TABLE_DELTA, {
        where: [
          { column: 'trait', op: 'eq', value: trait },
          { column: 'rolled_back', op: 'eq', value: 0 },
        ],
      })
      let done = 0
      for (const row of rows) {
        const id = String(row['id'] ?? '')
        if (id.length === 0) continue
        this.store.update(TABLE_DELTA, { id }, { rolled_back: 1 })
        done += 1
      }
      return done
    } catch (error) {
      this.log.warn('整特质回滚失败（%s）：%s', trait, messageOf(error))
      return 0
    }
  }

  /** 读互动次数。 */
  loadInteractions(): number {
    try {
      const row: RowLike | undefined = this.store.get(TABLE_INTERACTION, { id: SINGLETON_ID })
      if (row === undefined) return 0
      const count = num(row['count'])
      return count > 0 ? Math.trunc(count) : 0
    } catch (error) {
      this.log.warn('读互动次数失败，按 0 处理：%s', messageOf(error))
      return 0
    }
  }

  /**
   * 写互动次数。
   * @param count 次数。
   * @param at 时刻。
   */
  saveInteractions(count: number, at: number): boolean {
    try {
      this.store.upsert(TABLE_INTERACTION, {
        id: SINGLETON_ID,
        count: Math.trunc(count),
        updated_at: Math.trunc(at),
      })
      return true
    } catch (error) {
      this.log.warn('写互动次数失败（下次再试）：%s', messageOf(error))
      return false
    }
  }
}
