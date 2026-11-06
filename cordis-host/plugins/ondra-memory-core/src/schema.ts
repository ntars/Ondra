/**
 * 双层表结构（手册 §2.1「已实现：memory-core 双层 memory_raw / memory_fact」）。
 *
 * 表结构**只在这里声明一次**，建表动作交给 O-006 / O-007 的 `ensureTable()`
 * ——那是它们存在的理由（WAL、外键、补列、chmod、STRICT 探测全在那边做过一遍）。
 * 本插件自己 `CREATE TABLE` 就等于绕过那些保护，属于重复造轮子。
 *
 * 三条列设计上的取舍：
 *
 * 1. **时间一律存毫秒整数**（`INTEGER`），不存 ISO 字符串。
 *    SQLite 的 `TEXT` 时间在跨时区比较时会退化成字典序，而本仓的「自然日」
 *    判定归 `ondra-clock`（日历日序号），这里只需要一个可做算术的绝对值。
 *
 * 2. **`stability_hours` 存的是「基线 S」，不是「当前 S」。**
 *    当前 S 每次读取时按 `times_said` / `hits` 重算（见 `repository.ts` 的 `toRecord`）。
 *    存当前值会让「被反复提起衰减更慢」这条永远不生效——写死的数字不会自己变，
 *    只有每次重算才会。
 *
 * 3. **`evidence` 存 JSON 字符串，不建引文表。**
 *    引文是「这条记忆的凭据」，永远跟着记忆整体读写，没有「按引文反查」的需求；
 *    为它建一张子表会引入第二个事务边界，而收益只是省几百字节。
 *    反查需求真出现时（例如 O-140 要做全库引文审计），那应当由 O-140 自己建表。
 */

import type { TableSpecLike } from './types.js'

/** 原文层表名。 */
export const TABLE_RAW = 'memory_raw'

/** 事实层表名。 */
export const TABLE_FACT = 'memory_fact'

/** 墓碑表名（`forget` 后写这里，合并时不许复活）。 */
export const TABLE_TOMBSTONE = 'memory_tombstone'

/**
 * 原文层：最近 N 轮对话**原封不动**。
 *
 * 只服务指代消解（「他」「那个」指谁），**不参与寿命计算、不进注入**。
 * 所以它没有 `salience`、没有 `stability`——放进去就等于承认它可以被衰减，
 * 而原文一旦被衰减，「逐字引文校验」就没有可信的比对源了。
 */
const RAW_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_RAW,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'turn_id', type: 'TEXT', notNull: true },
    { name: 'role', type: 'TEXT', notNull: true },
    { name: 'text', type: 'TEXT', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'meta', type: 'TEXT' },
  ]),
  indexes: Object.freeze([
    { name: 'idx_memory_raw_turn', columns: Object.freeze(['turn_id']) },
    { name: 'idx_memory_raw_created', columns: Object.freeze(['created_at']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/**
 * 事实层：提炼后的条目，带寿命、打分、引文与四态删除标记。
 *
 * `archived` 与 `sealed` 用两个独立整型而不是一个状态字符串：
 * 它们**不是互斥的**——封存（sealed）到期后仍然会被归档（archived），
 * 压成一个枚举就得在「sealed 且 archived」时二选一，而两个都成立是常态。
 */
const FACT_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_FACT,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'kind', type: 'TEXT', notNull: true },
    { name: 'category', type: 'TEXT', notNull: true },
    { name: 'channel', type: 'TEXT', notNull: true },
    { name: 'text', type: 'TEXT', notNull: true },
    { name: 'summary', type: 'TEXT' },
    { name: 'subject', type: 'TEXT' },
    { name: 'salience', type: 'REAL', notNull: true, default: '50' },
    { name: 'arousal', type: 'REAL', notNull: true, default: '0.5' },
    { name: 'stability_hours', type: 'REAL', notNull: true, default: '24' },
    { name: 'stability_mult', type: 'REAL', notNull: true, default: '1' },
    { name: 'times_said', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'hits', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'revisions', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'last_seen_at', type: 'INTEGER', notNull: true },
    { name: 'last_hit_at', type: 'INTEGER' },
    { name: 'archived', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'sealed', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'source_raw_id', type: 'TEXT' },
    { name: 'old_text', type: 'TEXT' },
    { name: 'evidence', type: 'TEXT' },
  ]),
  indexes: Object.freeze([
    { name: 'idx_memory_fact_category', columns: Object.freeze(['category']) },
    { name: 'idx_memory_fact_state', columns: Object.freeze(['archived', 'sealed']) },
    { name: 'idx_memory_fact_seen', columns: Object.freeze(['last_seen_at']) },
    { name: 'idx_memory_fact_created', columns: Object.freeze(['created_at']) },
    { name: 'idx_memory_fact_subject', columns: Object.freeze(['subject']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/**
 * 墓碑：`forget` 之后留下的「她曾经知道过」的痕迹。
 *
 * 只存 `digest`（去空白后的 SHA-256 前 32 位）与最多 200 字残文，**不存全文**——
 * 用户要求忘记，就不该在另一张表里留一份可读的副本。`digest` 的用途只有一个：
 * 将来合并/提炼时**不许复活**这条。
 */
const TOMBSTONE_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_TOMBSTONE,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'fact_id', type: 'TEXT', notNull: true },
    { name: 'digest', type: 'TEXT', notNull: true },
    { name: 'text', type: 'TEXT' },
    { name: 'reason', type: 'TEXT' },
    { name: 'deleted_at', type: 'INTEGER', notNull: true },
  ]),
  indexes: Object.freeze([{ name: 'idx_memory_tombstone_digest', columns: Object.freeze(['digest']) }]),
  strict: true,
} satisfies TableSpecLike)

/** 全部表声明。顺序即建表顺序（先原文后事实，外键语义上更自然）。 */
export const MEMORY_TABLES: readonly TableSpecLike[] = Object.freeze([
  RAW_TABLE,
  FACT_TABLE,
  TOMBSTONE_TABLE,
])
